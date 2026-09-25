import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CanonicalEntity, StoryBible } from "../domain/story-bible.js";
import type { StageModelConfig } from "../domain/provider.js";
import { type VisualEntityProfile, type VisualEntityType, type VisualProfileConflict, visualProfileSchema } from "../domain/visual-profile.js";
import type { LLMProvider } from "../llm/provider.js";
import { storyPaths } from "../storage/paths.js";
import { fingerprint } from "../utils/hash.js";
import { getVisualProfile, updateVisualProfile } from "./profiles.js";
import { resolveEntityVisualEvidence } from "../story-bible/visual-evidence.js";

const characterFields = ["character.apparentAge", "character.gender", "character.height", "character.build", "character.skinTone", "character.faceShape", "character.hairColor", "character.hairstyle", "character.eyeColor", "character.distinguishingFeatures", "character.defaultOutfit", "character.weapons", "character.accessories"] as const;
const locationFields = ["location.architecture", "location.terrain", "location.vegetation", "location.lighting", "location.atmosphere", "location.colorPalette", "location.recurringLandmarks"] as const;
const fieldsByType: Partial<Record<VisualEntityType, readonly string[]>> = { character: characterFields, location: locationFields };

export const visualProfileProposalItemSchema = z.object({ field: z.string().trim().min(1), value: z.string().trim().min(1).max(5_000) }).strict();
export const visualProfileProposalResponseSchema = z.object({ values: z.array(visualProfileProposalItemSchema), rationale: z.string().trim().max(2_000).default("") }).strict();
export type VisualProfileProposalResponse = z.infer<typeof visualProfileProposalResponseSchema>;

export const visualProfileProposalSchema = z.object({ values: z.record(z.string(), z.string().trim().min(1).max(5_000)).default({}), rationale: z.string().trim().max(2_000).default("") });
export type VisualProfileProposal = z.infer<typeof visualProfileProposalSchema> & { entityId: string; visualType: VisualEntityType; eligibleFields: string[]; protectedFields: string[]; contextFingerprint: string; provider: string; model: string };
export type VisualProfileFieldState = { path: string; value?: string; source?: string; locked: boolean; missing: boolean; canonical: boolean; regenerable: boolean; conflict?: VisualProfileConflict };
export type Inspection = { entity: CanonicalEntity; profile: VisualEntityProfile; eligibleFields: string[]; protectedFields: string[]; fields: VisualProfileFieldState[]; conflicts: VisualProfileConflict[]; coreComplete: number; coreTotal: number; context: Record<string, unknown>; contextFingerprint: string };

function blankProfile(entity: CanonicalEntity): VisualEntityProfile {
  const now = new Date().toISOString();
  const visualType: VisualEntityType = entity.type === "location" ? "location" : entity.type === "item" ? "item" : entity.type === "ability" ? "object" : "character";
  return visualProfileSchema.parse({ id: `vprof_draft_${entity.id}`, entityId: entity.id, visualType, status: "draft", appearance: "", visualPrompt: "", negativePrompt: "", notes: "", variants: [], references: [], fieldProvenance: {}, conflicts: [], revision: 0, createdAt: now, updatedAt: now });
}
function fieldValue(profile: VisualEntityProfile, path: string): string | undefined { const [section, key] = path.split(".") as ["character" | "location", string]; const record = profile[section] as Record<string, string | undefined> | undefined; return record?.[key]?.trim() || undefined; }
const colour = "white|black|silver|gold(?:en)?|blue|green|red|brown|violet|purple|gray|grey|amber|hazel|emerald|crimson";
const visualMatchers: Array<[string, RegExp]> = [
  ["character.apparentAge", /\b(?:appears?|looks?)\s+(?:to be\s+)?([^.,;]{1,80}\b(?:years? old|young|middle-aged|elderly|child|teen(?:ager)?))\b/i], ["character.gender", /\b(?:gender|sex|presentation)\s*[:=-]\s*([^.,;]{1,80})/i], ["character.height", /\b((?:very |quite )?(?:tall|short|average[- ]height)|\d(?:\.\d+)?\s*(?:feet|foot|ft|cm|centimeters?))\b/i], ["character.build", /\b((?:slender|lean|muscular|athletic|stocky|broad[- ]shouldered|lithe|frail|burly|well-built)[^.,;]{0,90})\b/i],
  ["character.skinTone", new RegExp(`\\b(${colour}|pale|dark|tan|bronze)\\s+(?:skin|complexion)\\b|\\b(?:skin|complexion)\\s*[:=-]\\s*([^.,;]{1,100})`, "i")], ["character.faceShape", /\b((?:oval|round|square|heart-shaped|angular|sharp|soft)\s+(?:face|jaw(?:line)?|features?))\b/i], ["character.hairColor", new RegExp(`\\b(${colour})\\s+hair\\b|\\bhair(?:\\s+color)?\\s*[:=-]\\s*(${colour})\\b`, "i")], ["character.hairstyle", /\b((?:long|short|shoulder-length|waist-length|tied|braided|ponytail|bun|loose|cropped|spiky|curly|straight)[^.,;]{0,80}\s+hair)\b/i], ["character.eyeColor", new RegExp(`\\b(${colour})\\s+eyes?\\b|\\beye(?:\\s+color)?\\s*[:=-]\\s*(${colour})\\b`, "i")], ["character.distinguishingFeatures", /\b((?:scar|birthmark|tattoo|missing (?:eye|arm|hand|finger)|prosthetic|horns?|fangs?|pointed ears?|wings?)[^.,;]{0,140})\b/i], ["character.defaultOutfit", /\b(?:wears?|dressed in|clad in|outfit|armor)\s+([^.;]{2,240})/i], ["character.weapons", /\b(?:wields?|carries?|armed with|weapon)\s+([^.;]{2,240})/i], ["character.accessories", /\b(?:wears?|has)\s+([^.;]{0,160}\b(?:ring|necklace|amulet|earrings?|glasses|mask|cloak)\b[^.;]{0,120})/i],
  ["location.architecture", /\b(?:architecture|built with|tower|palace|temple|fortress|walls?)\s*[:=-]?\s*([^.;]{2,240})/i], ["location.terrain", /\b(?:terrain|mountains?|forest|valley|desert|plains?|cave|river)\s*[:=-]?\s*([^.;]{2,240})/i], ["location.lighting", /\b(?:lighting|lit by|moonlight|sunlight|torchlight|glow)\s*[:=-]?\s*([^.;]{2,240})/i],
];
function compact(value: string) { return value.trim().replace(/\s+/g, " "); }
function canonicalValue(value: string) { return compact(value).toLowerCase().replace(/[.,;:]/g, ""); }
function entityAnchors(entity: CanonicalEntity) { return [entity.canonicalName, entity.originalName, ...entity.aliases].filter((value): value is string => Boolean(value?.trim())).sort((a, b) => b.length - a.length).slice(0, 12); }
type SourceEvidence = { chapter: number; text: string; visualSignalScore: number };

/** Raw prose is valuable context, but it is not automatically story canon.
 * Only explicit structured fields or labelled Story Bible descriptions lock a
 * profile field; source excerpts remain candidate evidence for the proposal. */
function explicitFacts(entity: CanonicalEntity, profile: VisualEntityProfile): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [path, provenance] of Object.entries(profile.fieldProvenance ?? {})) { const value = fieldValue(profile, path); if (value && ["source_text", "story_bible", "continuity", "manual_override"].includes(provenance.source)) result[path] = value; }
  const evidence = resolveEntityVisualEvidence(entity, entity.lastKnownAppearance);
  for (const [path, observation] of Object.entries(evidence.values)) if (!result[path]) result[path] = observation.value;
  const text = [entity.description, entity.notes].filter(Boolean).join("\n");
  // Labelled Story Bible facts are an explicit editorial statement, unlike a
  // loose match in narrative prose (for example, temporary battle armor).
  for (const [path, pattern] of visualMatchers) {
    if (result[path]) continue;
    const key = path.split(".")[1]!.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`).trim();
    const labelled = new RegExp(`(?:^|\\n)\\s*${key.replace(/ /g, "\\s+")}\\s*[:=-]\\s*([^\\n.;]{1,500})`, "i").exec(text)?.[1];
    if (labelled) result[path] = compact(labelled);
    else if (path === "character.hairColor" || path === "character.eyeColor") {
      const value = pattern.exec(text)?.slice(1).find(Boolean);
      if (value && /(?:hair|eyes?)\s*[:=-]/i.test(text)) result[path] = compact(value);
    }
  }
  return result;
}
const visualSignals = /\b(?:hair|eyes?|face|skin|complexion|height|build|body|scar|tattoo|clothing|robe|coat|armor|weapon|accessor(?:y|ies)|appearance|looked|wore|dressed|physique)\b|头发|眼睛|面容|皮肤|身高|体格|伤疤|纹身|衣|袍|甲|武器|佩戴|容貌/gi;
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function signalScore(text: string) { return [...text.matchAll(visualSignals)].length; }
async function sourceEvidence(root: string, slug: string, entity: CanonicalEntity): Promise<SourceEvidence[]> {
  const anchors = entityAnchors(entity); const chapters = [...new Set(entity.provenance.map((item) => item.chapter))].sort((a, b) => b - a).slice(0, 8); const evidence: SourceEvidence[] = [];
  for (const chapter of chapters) {
    const paths = storyPaths(root, slug, chapter); const text = await readFile(paths.english, "utf8").catch(() => readFile(paths.original, "utf8").catch(() => ""));
    const starts = anchors.flatMap((anchor) => [...text.matchAll(new RegExp(escapeRegex(anchor), "gi"))].map((match) => match.index ?? 0));
    const windows = starts.sort((a, b) => a - b).map((start) => ({ start: Math.max(0, start - 400), end: Math.min(text.length, start + 900) })).filter((window, index, all) => index === 0 || window.start > all[index - 1]!.end);
    const ranked = windows.map((window) => ({ chapter, text: compact(text.slice(window.start, window.end)), visualSignalScore: signalScore(text.slice(window.start, window.end)) })).sort((left, right) => right.visualSignalScore - left.visualSignalScore || left.text.length - right.text.length).slice(0, 3);
    evidence.push(...ranked);
  }
  return evidence.sort((left, right) => right.visualSignalScore - left.visualSignalScore || right.chapter - left.chapter).slice(0, 8);
}
function relevantSummaries(bible: StoryBible, entity: CanonicalEntity, relationships: Array<{ otherEntityId: string }>) {
  const anchors = entityAnchors(entity).map((item) => item.toLowerCase()); const relatedNames = relationships.map((r) => bible.canonicalEntities.find((item) => item.id === r.otherEntityId)?.canonicalName.toLowerCase()).filter((item): item is string => Boolean(item));
  return Object.entries(bible.chapterSummaries).map(([chapter, summary]) => ({ chapter: Number(chapter), summary, score: anchors.reduce((sum, anchor) => sum + (summary.toLowerCase().includes(anchor) ? 4 : 0), 0) + relatedNames.reduce((sum, name) => sum + (summary.toLowerCase().includes(name) ? 1 : 0), 0) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || b.chapter - a.chapter).slice(0, 6).map(({ chapter, summary }) => ({ chapter, summary }));
}
function detectConflicts(profile: VisualEntityProfile, facts: Record<string, string>): VisualProfileConflict[] {
  const open = profile.conflicts ?? []; const detected: VisualProfileConflict[] = [];
  for (const [field, canonical] of Object.entries(facts)) { const visual = fieldValue(profile, field); const provenance = profile.fieldProvenance?.[field]; if (!visual || canonicalValue(visual) === canonicalValue(canonical)) continue; const existing = open.find((item) => item.field === field && canonicalValue(item.canonicalValue) === canonicalValue(canonical) && canonicalValue(item.visualValue) === canonicalValue(visual)); if (existing?.status === "resolved") continue; if (provenance?.source !== "ai_generated") continue; detected.push(existing ?? { id: `vconf_${fingerprint({ field, canonical, visual }).slice(0, 24)}`, field, canonicalValue: canonical, visualValue: visual, visualProvenance: provenance, detectedAt: new Date().toISOString(), status: "needs_review" }); }
  return [...open.filter((item) => item.status === "resolved"), ...detected];
}

export async function inspectVisualProfile(root: string, slug: string, bible: StoryBible, entityId: string): Promise<Inspection> {
  const entity = bible.canonicalEntities.find((item) => item.id === entityId); if (!entity) throw new Error(`Canonical entity '${entityId}' was not found`);
  const profile = (await getVisualProfile(root, slug, entityId)) ?? blankProfile(entity); const fields = [...(fieldsByType[profile.visualType] ?? [])];
  const relationships = bible.canonicalRelationships.filter((item) => item.sourceEntityId === entityId || item.targetEntityId === entityId).slice(0, 12).map((item) => ({ type: item.type, otherEntityId: item.sourceEntityId === entityId ? item.targetEntityId : item.sourceEntityId }));
  const sources = await sourceEvidence(root, slug, entity); const facts = explicitFacts(entity, profile); const conflicts = detectConflicts(profile, facts);
  const protectedFields = fields.filter((field) => Boolean(fieldValue(profile, field)) || Boolean(profile.fieldProvenance?.[field]?.locked) || Boolean(facts[field])); const eligibleFields = fields.filter((field) => !protectedFields.includes(field));
  const fieldStates = fields.map((path) => { const provenance = profile.fieldProvenance?.[path]; const value = fieldValue(profile, path); const canonical = Boolean(facts[path]); const conflict = conflicts.find((item) => item.status === "needs_review" && item.field === path); return { path, value, source: canonical ? "source-backed" : provenance?.source, locked: Boolean(provenance?.locked), missing: !value && !canonical, canonical, regenerable: Boolean(value && provenance?.source === "ai_generated" && !provenance.locked && !canonical), conflict }; });
  const activeReferences = [...profile.references].filter((ref) => ref.approved).sort((left, right) => Number(right.role === "primary_reference") - Number(left.role === "primary_reference"));
  const resolvedEvidence = resolveEntityVisualEvidence(entity, entity.lastKnownAppearance);
  const compactEvidence = { values: Object.fromEntries(Object.entries(resolvedEvidence.values).map(([path, item]) => [path, { ...item, provenance: item.provenance.slice(-8) }])), conflicts: Object.fromEntries(Object.entries(resolvedEvidence.conflicts).map(([path, items]) => [path, items.map((item) => ({ ...item, provenance: item.provenance.slice(-8) }))])) };
  const context = { canonicalEntity: { name: entity.canonicalName, originalName: entity.originalName, type: entity.type, description: entity.description, status: entity.status, notes: entity.notes, aliases: entity.aliases, sourceProvenance: entity.provenance }, explicitVisualFacts: facts, storyBibleVisualEvidence: compactEvidence, sourceEvidence: sources, existingVisualProfile: profile, fieldStates, approvedReferences: activeReferences.map((ref) => ({ id: ref.id, role: ref.role, source: ref.source, prompt: ref.prompt, provenance: ref.provenance })), relationships: relationships.map((relationship) => ({ ...relationship, otherName: bible.canonicalEntities.find((item) => item.id === relationship.otherEntityId)?.canonicalName })), relevantContinuity: bible.entityTimeline.filter((event) => event.entityId === entityId).slice(-10), relevantStorySummaries: relevantSummaries(bible, entity, relationships) };
  return { entity, profile, eligibleFields, protectedFields, fields: fieldStates, conflicts, coreComplete: fields.length - eligibleFields.length, coreTotal: fields.length, context, contextFingerprint: fingerprint(context) };
}
export async function synchronizeVisualProfileConflicts(root: string, slug: string, bible: StoryBible, entityId: string): Promise<Inspection> { let inspection = await inspectVisualProfile(root, slug, bible, entityId); const stored = inspection.profile.conflicts ?? []; if (JSON.stringify(stored) !== JSON.stringify(inspection.conflicts) && inspection.profile.revision > 0) { await updateVisualProfile(root, slug, entityId, { conflicts: inspection.conflicts, fieldProvenance: inspection.profile.fieldProvenance }); inspection = await inspectVisualProfile(root, slug, bible, entityId); } return inspection; }
export async function resolveVisualProfileConflict(root: string, slug: string, bible: StoryBible, entityId: string, conflictId: string, action: "accept_canonical" | "retain_manual_override") {
  const inspection = await synchronizeVisualProfileConflicts(root, slug, bible, entityId); const conflict = (inspection.profile.conflicts ?? []).find((item) => item.id === conflictId && item.status === "needs_review"); if (!conflict) throw new Error("Visual profile conflict was not found or is already resolved"); const next = structuredClone(inspection.profile); const [section, key] = conflict.field.split(".") as ["character" | "location", string]; if (action === "accept_canonical") { (next as Record<string, unknown>)[section] = { ...(next[section] ?? {}), [key]: conflict.canonicalValue }; next.fieldProvenance ??= {}; next.fieldProvenance[conflict.field] = { source: "story_bible", locked: true }; } else { next.fieldProvenance ??= {}; next.fieldProvenance[conflict.field] = { source: "manual_override", locked: true }; } next.conflicts = (next.conflicts ?? []).map((item) => item.id === conflictId ? { ...item, status: "resolved" as const, resolution: action, resolvedAt: new Date().toISOString() } : item); return updateVisualProfile(root, slug, entityId, next);
}
export async function proposeMissingVisualDetails(root: string, slug: string, bible: StoryBible, entityId: string, provider: LLMProvider, config: StageModelConfig, options: { fields?: string[]; regenerate?: boolean } = {}): Promise<VisualProfileProposal> {
  const inspection = await synchronizeVisualProfileConflicts(root, slug, bible, entityId);
  const knownFields = new Set(fieldsByType[inspection.profile.visualType] ?? []);
  const requested = options.fields ? [...new Set(options.fields)] : inspection.eligibleFields;
  if (requested.some((field) => !knownFields.has(field))) throw new Error("One or more requested visual fields are not supported for this profile type");
  if (options.regenerate && !options.fields?.length) throw new Error("Choose one or more AI-generated fields to regenerate");
  const eligibleFields = requested.filter((field) => {
    const state = inspection.fields.find((item) => item.path === field);
    return options.regenerate ? Boolean(state?.regenerable || state?.missing) : inspection.eligibleFields.includes(field);
  });
  if (!eligibleFields.length) return { entityId, visualType: inspection.profile.visualType, values: {}, rationale: "No selected visual details can be safely generated.", eligibleFields: [], protectedFields: inspection.protectedFields, contextFingerprint: inspection.contextFingerprint, provider: provider.name, model: config.model };
  const result = await provider.generateStructured({
    model: config.model,
    schemaName: "visual_profile_completion",
    schema: visualProfileProposalResponseSchema,
    instructions: "Design only the requested persistent visual details for this one entity. Source evidence, Story Bible facts, manual/locked fields, and approved primary references are authoritative. Never overwrite or contradict them. Do not use temporary injuries, scene action, current weather, one-off emotions, or short-lived clothing as persistent identity. Use role, relationships, culture, powers, occupation, equipment, faction, history, and entity-relevant summaries only when they support a durable visual suggestion. AI output is a proposal, not story canon. Return only the requested visual fields. For each proposed field, return an item in values where 'field' is exactly one of the requested field paths and 'value' is the proposed persistent visual description. Do not return unrequested fields, do not rename field paths, and do not return nested profile objects.",
    input: JSON.stringify({ ...inspection.context, requestedFields: eligibleFields, mode: options.regenerate ? "explicit_selected_regeneration" : "fill_missing_only" }, null, 2)
  });
  const values: Record<string, string> = {};
  const rawValues = Array.isArray(result.value?.values) ? result.value.values : [];
  for (const item of rawValues) {
    if (!item || typeof item !== "object") continue;
    const field = typeof item.field === "string" ? item.field.trim() : "";
    const value = typeof item.value === "string" ? item.value.trim() : "";
    if (!field || !value) continue;
    if (!eligibleFields.includes(field)) continue;
    if (field in values) continue;
    values[field] = value;
  }
  return {
    entityId,
    visualType: inspection.profile.visualType,
    values,
    rationale: result.value.rationale ?? "",
    eligibleFields,
    protectedFields: inspection.protectedFields,
    contextFingerprint: inspection.contextFingerprint,
    provider: provider.name,
    model: config.model,
  };
}
export async function applyVisualProfileProposal(root: string, slug: string, bible: StoryBible, proposal: VisualProfileProposal, selectedFields: string[]): Promise<VisualEntityProfile> {
  const inspection = await synchronizeVisualProfileConflicts(root, slug, bible, proposal.entityId); if (proposal.contextFingerprint !== inspection.contextFingerprint) throw new Error("The visual profile changed after this proposal was generated. Generate a fresh proposal before applying it."); const next = structuredClone(inspection.profile);
  for (const path of selectedFields) { const value = proposal.values[path]; if (!value || !proposal.eligibleFields.includes(path)) continue; const state = inspection.fields.find((item) => item.path === path); if (!state || state.canonical || state.locked || (!state.missing && !state.regenerable)) continue; const [section, key] = path.split(".") as ["character" | "location", string]; (next as Record<string, unknown>)[section] = { ...(next[section] ?? {}), [key]: value }; next.fieldProvenance ??= {}; next.fieldProvenance[path] = { source: "ai_generated", locked: false, provider: proposal.provider, model: proposal.model, generatedAt: new Date().toISOString(), contextFingerprint: proposal.contextFingerprint }; }
  return updateVisualProfile(root, slug, proposal.entityId, next);
}
