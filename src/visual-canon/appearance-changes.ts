import { fingerprint } from "../utils/hash.js";
import { proposedCreatureState } from "./creature-look.js";
import type { CanonicalEntity, StoryBible } from "../domain/story-bible.js";
import { visualProfileSchema, visualAppearanceEraSchema, characterVisualDetailsSchema, creatureVisualDetailsSchema, type VisualEntityProfile, type VisualAppearanceEra } from "../domain/visual-profile.js";
import { resolveVisualEntityType, validVisualField, writeVisualField } from "./fields.js";
import { loadVisualProfiles, saveVisualProfiles } from "./profiles.js";

export function appearanceEvidenceFingerprint(evidence: NonNullable<CanonicalEntity["visualEvidence"]>) { return fingerprint(evidence.map(item => ({ id: item.id, field: item.field, value: item.value, chapter: item.chapter, persistence: item.persistence, status: item.status, confidence: item.confidence, provenance: item.provenance }))); }

/** Source-backed drafts only. Approval and image generation remain explicit actions. */
export function proposeAppearanceChanges(entity: CanonicalEntity, profile: VisualEntityProfile): VisualAppearanceEra[] {
  if (!["character", "creature"].includes(profile.visualType) || (profile.creatureIdentity ?? entity.visualIdentityKind) === "template") return [];
  const dismissed = new Set(entity.visualEvidenceDecisions?.filter(decision => decision.action === "dismiss").map(decision => decision.evidenceId));
  const evidence = (entity.visualEvidence ?? []).filter(item => !dismissed.has(item.id) && item.persistence === "changed" && item.status !== "conflict" && item.confidence >= .8 && validVisualField(profile.visualType, item.field));
  const chapters = [...new Set(evidence.map(item => item.chapter))].sort((a,b) => a-b);
  let accumulated: Record<string,string> = {};
  let fullReplacement = false;
  let contributing: NonNullable<CanonicalEntity["visualEvidence"]> = [];
  return chapters.flatMap((chapter, index) => {
    const id = `detected_${entity.id}_${chapter}`;
    const changes = evidence.filter(item => item.chapter === chapter);
    // Conflicting values in one chapter need editorial review, not a guessed era.
    if (changes.some(item => changes.some(other => other.field === item.field && other.normalizedValue !== item.normalizedValue))) return [];
    const replacement = changes.some(item => ["creature.anatomy", "creature.species", "character.additionalAppearanceNotes"].includes(item.field));
    if (replacement) { accumulated = {}; contributing = []; fullReplacement = true; }
    contributing.push(...changes);
    const shapes = profile.visualType === "character" ? characterVisualDetailsSchema.removeDefault().shape : creatureVisualDetailsSchema.removeDefault().shape;
    for (const change of changes) {
      const key = change.field.split(".")[1]!;
      const validator = (shapes as Record<string, { safeParse: (value: unknown) => { success: boolean } }>)[key];
      if (validator?.safeParse(change.value).success) accumulated[key] = change.value;
    }
    if (profile.appearanceEras?.some(era => era.id === id || era.startChapter === chapter) || profile.dismissedAppearanceEraIds?.includes(id)) return [];
    const traits = { ...accumulated };
    const description = Object.entries(traits).map(([field,value]) => `${field}: ${value}`).join("; ").slice(0, 10000);
    const candidate = visualAppearanceEraSchema.safeParse({ id, name: `Appearance change · chapter ${chapter}`, startChapter: chapter,
      endChapter: chapters[index+1] ? chapters[index+1]! - 1 : undefined, status: "draft" as const,
      creatureState: profile.visualType === "creature" ? proposedCreatureState(description) : undefined,
      appearance: fullReplacement ? description : "", visualPrompt: "", referenceIds: [],
      ...(profile.visualType === "character" ? { character: traits } : { creature: traits }),
      detectedChange: { sourceFingerprint: appearanceEvidenceFingerprint(contributing), evidenceIds: contributing.map(item => item.id), confidence: Math.min(...contributing.map(item => item.confidence)), excerpts: [...new Set(contributing.flatMap(item => item.provenance.map(source => source.excerpt)))] },
    });
    return candidate.success && Object.keys(traits).length ? [candidate.data] : [];
  });
}

/** Caller holds the story lock. Existing profiles and edited eras are preserved. */
export async function syncAppearanceChanges(root: string, slug: string, bible: StoryBible): Promise<void> {
  const profiles = await loadVisualProfiles(root, slug); let changed = false;
  for (const entity of bible.canonicalEntities) {
    if (entity.visualProfilePolicy?.mode === "skip") continue;
    const existing = profiles[entity.id]; const now = new Date().toISOString();
    const profile = existing ?? visualProfileSchema.parse({ id: `vprof_${entity.id}`, entityId: entity.id, visualType: resolveVisualEntityType(entity), creatureIdentity: entity.visualIdentityKind, createdAt: now, updatedAt: now });
    let reconciled = false;
    for (const era of profile.appearanceEras ?? []) {
      if (!era.detectedChange) continue;
      const source = (entity.visualEvidence ?? []).filter(item => era.detectedChange!.evidenceIds.includes(item.id));
      const current = appearanceEvidenceFingerprint(source);
      const changedSource = source.length !== era.detectedChange.evidenceIds.length || source.some(item => item.persistence !== "changed" || item.status === "conflict" || item.confidence < .8 || entity.visualEvidenceDecisions?.some(decision => decision.evidenceId === item.id && decision.action === "dismiss")) || (era.detectedChange.sourceFingerprint !== undefined && current !== era.detectedChange.sourceFingerprint);
      if (changedSource && !era.detectedChange.needsReview) { era.detectedChange.needsReview = true; reconciled = true; }
      if (!era.detectedChange.sourceFingerprint) { era.detectedChange.sourceFingerprint = current; reconciled = true; }
    }
    const eras = proposeAppearanceChanges(entity, profile); if (!eras.length && !reconciled) continue;
    if (!existing) {
      const first = Math.min(...eras.map(era => era.startChapter));
      for (const item of entity.visualEvidence ?? []) if (item.persistence === "persistent" && item.chapter < first && item.status !== "conflict") {
        const candidate = structuredClone(profile); writeVisualField(candidate, item.field, item.value);
        if (visualProfileSchema.safeParse(candidate).success) writeVisualField(profile, item.field, item.value);
      }
    }
    profiles[entity.id] = visualProfileSchema.parse({ ...profile, appearanceEras: [...(profile.appearanceEras ?? []), ...eras], revision: profile.revision+1, updatedAt: now }); changed = true;
  }
  if (changed) await saveVisualProfiles(root, slug, profiles);
}
