import { z } from "zod";
import type { CanonicalEntity, StoryBible } from "../domain/story-bible.js";
import type { StageModelConfig } from "../domain/provider.js";
import {
  type VisualEntityProfile,
  type VisualEntityType,
  visualProfileSchema,
} from "../domain/visual-profile.js";
import type { LLMProvider } from "../llm/provider.js";
import { fingerprint } from "../utils/hash.js";
import { getVisualProfile, updateVisualProfile } from "./profiles.js";

const characterFields = [
  "character.build", "character.faceShape", "character.hairColor", "character.hairstyle",
  "character.eyeColor", "character.defaultOutfit", "character.distinguishingFeatures",
] as const;
const locationFields = [
  "location.architecture", "location.terrain", "location.lighting", "location.colorPalette",
  "location.atmosphere", "location.recurringLandmarks",
] as const;
const fieldsByType: Partial<Record<VisualEntityType, readonly string[]>> = {
  character: characterFields,
  location: locationFields,
};

export const visualProfileProposalSchema = z.object({
  values: z.record(z.string(), z.string().trim().min(1).max(5_000)).default({}),
  rationale: z.string().trim().max(2_000).default(""),
});
export type VisualProfileProposal = z.infer<typeof visualProfileProposalSchema> & {
  entityId: string;
  visualType: VisualEntityType;
  eligibleFields: string[];
  protectedFields: string[];
  contextFingerprint: string;
  provider: string;
  model: string;
};

type Inspection = {
  entity: CanonicalEntity;
  profile: VisualEntityProfile;
  eligibleFields: string[];
  protectedFields: string[];
  coreComplete: number;
  coreTotal: number;
  context: Record<string, unknown>;
  contextFingerprint: string;
};

function blankProfile(entity: CanonicalEntity): VisualEntityProfile {
  const now = new Date().toISOString();
  const visualType: VisualEntityType = entity.type === "location" ? "location" : entity.type === "item" ? "item" : entity.type === "ability" ? "object" : "character";
  return visualProfileSchema.parse({
    id: `vprof_draft_${entity.id}`, entityId: entity.id, visualType, status: "draft", appearance: "", visualPrompt: "", negativePrompt: "", notes: "",
    variants: [], references: [], fieldProvenance: {}, revision: 0, createdAt: now, updatedAt: now,
  });
}

function fieldValue(profile: VisualEntityProfile, path: string): string | undefined {
  const [section, key] = path.split(".") as ["character" | "location", string];
  const record = profile[section] as Record<string, string | undefined> | undefined;
  return record?.[key]?.trim() || undefined;
}

/** Narrow, deterministic extraction of explicitly expressed physical facts.
 * It only protects clear statements, leaving ambiguous prose for human review. */
function explicitFacts(entity: CanonicalEntity): Record<string, string> {
  const text = `${entity.description}\n${entity.notes}`.toLowerCase();
  const result: Record<string, string> = {};
  const colors = "white|black|silver|gold|golden|blue|green|red|brown|violet|gray|grey";
  const hair = new RegExp(`\\b(${colors})\\s+hair\\b|\\bhair(?:\\s+color)?\\s*[:=-]\\s*(${colors})\\b`, "i").exec(text);
  if (hair) result["character.hairColor"] = (hair[1] || hair[2] || "").toLowerCase();
  const eyes = new RegExp(`\\b(${colors})\\s+eyes?\\b|\\beye(?:\\s+color)?\\s*[:=-]\\s*(${colors})\\b`, "i").exec(text);
  if (eyes) result["character.eyeColor"] = (eyes[1] || eyes[2] || "").toLowerCase();
  return result;
}

export async function inspectVisualProfile(
  root: string,
  slug: string,
  bible: StoryBible,
  entityId: string,
): Promise<Inspection> {
  const entity = bible.canonicalEntities.find((item) => item.id === entityId);
  if (!entity) throw new Error(`Canonical entity '${entityId}' was not found`);
  const profile = (await getVisualProfile(root, slug, entityId)) ?? blankProfile(entity);
  const fields = [...(fieldsByType[profile.visualType] ?? [])];
  const facts = explicitFacts(entity);
  const protectedFields = fields.filter((field) => Boolean(fieldValue(profile, field)) || Boolean(profile.fieldProvenance?.[field]?.locked) || Boolean(facts[field]));
  const eligibleFields = fields.filter((field) => !protectedFields.includes(field));
  const relationships = bible.canonicalRelationships
    .filter((item) => item.sourceEntityId === entityId || item.targetEntityId === entityId)
    .slice(0, 12)
    .map((item) => ({ type: item.type, otherEntityId: item.sourceEntityId === entityId ? item.targetEntityId : item.sourceEntityId }));
  const context = {
    canonicalEntity: { name: entity.canonicalName, originalName: entity.originalName, type: entity.type, description: entity.description, status: entity.status, notes: entity.notes, aliases: entity.aliases, sourceProvenance: entity.provenance },
    explicitVisualFacts: facts,
    existingVisualProfile: profile,
    relationships,
    recentStorySummaries: Object.entries(bible.chapterSummaries).slice(-5),
  };
  return { entity, profile, eligibleFields, protectedFields, coreComplete: fields.length - eligibleFields.length, coreTotal: fields.length, context, contextFingerprint: fingerprint(context) };
}

export async function proposeMissingVisualDetails(
  root: string,
  slug: string,
  bible: StoryBible,
  entityId: string,
  provider: LLMProvider,
  config: StageModelConfig,
  options: { fields?: string[]; regenerate?: boolean } = {},
): Promise<VisualProfileProposal> {
  const inspection = await inspectVisualProfile(root, slug, bible, entityId);
  const knownFields = new Set(fieldsByType[inspection.profile.visualType] ?? []);
  const requested = options.fields ? [...new Set(options.fields)] : inspection.eligibleFields;
  if (requested.some((field) => !knownFields.has(field))) throw new Error("One or more requested visual fields are not supported for this profile type");
  const facts = explicitFacts(inspection.entity);
  const eligibleFields = requested.filter((field) => options.regenerate ? !inspection.profile.fieldProvenance?.[field]?.locked && !facts[field] : inspection.eligibleFields.includes(field));
  if (!eligibleFields.length) {
    return { entityId, visualType: inspection.profile.visualType, values: {}, rationale: "No eligible visual details are missing.", eligibleFields: [], protectedFields: inspection.protectedFields, contextFingerprint: inspection.contextFingerprint, provider: provider.name, model: config.model };
  }
  const result = await provider.generateStructured({
    model: config.model,
    schemaName: "visual_profile_completion",
    schema: visualProfileProposalSchema,
    instructions: `Design only the requested missing persistent visual details for one story entity. Return only the structured response. Story Bible/source facts, manual values, locked values, and approved references are authoritative. Never contradict them or invent plot facts. Use personality, role, culture, powers, and story setting to avoid generic character design. AI inferences are visual design suggestions, not story canon. Do not include any field other than the requested paths. Do not overwrite an existing field unless explicit regeneration selected it.`,
    input: JSON.stringify({ ...inspection.context, requestedFields: eligibleFields, mode: options.regenerate ? "explicit_regeneration" : "fill_missing_only" }, null, 2),
  });
  const protectedValues = new Map<string, string>([
    ...inspection.protectedFields.flatMap((field): Array<[string, string]> => {
      const value = fieldValue(inspection.profile, field);
      return value ? [[field, value]] : [];
    }),
    ...Object.entries(facts),
  ]);
  const values = Object.fromEntries(Object.entries(result.value.values).filter(([field, value]) => {
    if (!eligibleFields.includes(field)) return false;
    const protectedValue = protectedValues.get(field);
    return !protectedValue || value.toLowerCase().includes(protectedValue.toLowerCase());
  }));
  return { entityId, visualType: inspection.profile.visualType, values, rationale: result.value.rationale, eligibleFields, protectedFields: inspection.protectedFields, contextFingerprint: inspection.contextFingerprint, provider: provider.name, model: config.model };
}

export async function applyVisualProfileProposal(
  root: string,
  slug: string,
  bible: StoryBible,
  proposal: VisualProfileProposal,
  selectedFields: string[],
): Promise<VisualEntityProfile> {
  const inspection = await inspectVisualProfile(root, slug, bible, proposal.entityId);
  if (proposal.contextFingerprint !== inspection.contextFingerprint) {
    throw new Error("The visual profile changed after this proposal was generated. Generate a fresh proposal before applying it.");
  }
  const values = Object.fromEntries(selectedFields.flatMap((field) => {
    const value = proposal.values[field];
    if (!value || !proposal.eligibleFields.includes(field) || inspection.protectedFields.includes(field)) return [];
    return [[field, value]] as const;
  }));
  const next = structuredClone(inspection.profile);
  for (const [path, value] of Object.entries(values)) {
    const [section, key] = path.split(".") as ["character" | "location", string];
    const record = { ...(next[section] ?? {}), [key]: value };
    (next as Record<string, unknown>)[section] = record;
    next.fieldProvenance ??= {};
    next.fieldProvenance[path] = { source: "ai_generated", locked: false, provider: proposal.provider, model: proposal.model, generatedAt: new Date().toISOString(), contextFingerprint: proposal.contextFingerprint };
  }
  return updateVisualProfile(root, slug, proposal.entityId, next);
}
