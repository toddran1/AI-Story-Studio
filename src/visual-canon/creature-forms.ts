import { fingerprint } from "../utils/hash.js";
import { matchingIndividualCreatureEra } from "./creature-look.js";
import type { StoryBible } from "../domain/story-bible.js";
import { visualProfileSchema, creatureFormSchema } from "../domain/visual-profile.js";
import type { Scene } from "../scenes/types.js";
import { resolveVisualEntities } from "../scenes/identity.js";
import { resolveVisualEntityType } from "./fields.js";
import { loadVisualProfiles, saveVisualProfiles } from "./profiles.js";

/** Caller holds the story lock. Proposals never generate images or approve looks. */
export async function prepareCreatureForms(root: string, slug: string, bible: StoryBible, scenes: Scene[], chapter?: number, sourceScope?: string) {
  const profiles = await loadVisualProfiles(root, slug); let changed = false;
  const scope = sourceScope ?? (chapter ? `chapter:${chapter}` : undefined);
  const sourceFingerprint = (entityId: string, state: string) => fingerprint(scenes.flatMap(scene => (scene.creatureGroups ?? []).filter(group => group.state === state && resolveVisualEntities([group.entity], bible.canonicalEntities)[0]?.id === entityId).map(group => ({ scene: scene.id, state: group.state, appearance: group.appearance, excerpt: group.excerpt }))));
  for (const profile of Object.values(profiles)) for (const form of profile.creatureForms ?? []) if (scope && form.detectedSource?.scope === scope && !form.detectedSource.needsReview && form.detectedSource.fingerprint !== sourceFingerprint(profile.entityId, form.state)) {
    form.detectedSource.needsReview = true; profile.revision++; profile.updatedAt = new Date().toISOString(); changed = true;
  }
  for (const group of scenes.flatMap(scene => scene.creatureGroups ?? [])) {
    const entity = resolveVisualEntities([group.entity], bible.canonicalEntities)[0];
    if (!entity || resolveVisualEntityType(entity) !== "creature" || entity.visualProfilePolicy?.mode === "skip") continue;
    const multiple = scenes.some(scene => {
      const groups = (scene.creatureGroups ?? []).filter(item => resolveVisualEntities([item.entity], [entity]).length > 0);
      return groups.some(item => (item.count ?? 0) > 1) || new Set(groups.map(item => item.state)).size > 1;
    });
    const now = new Date().toISOString();
    const profile = profiles[entity.id] ?? visualProfileSchema.parse({ id: `vprof_${entity.id}`, entityId: entity.id, visualType: "creature", creatureIdentity: entity.visualIdentityKind ?? (multiple ? "template" : undefined), createdAt: now, updatedAt: now });
    if (!profile.creatureIdentity && (entity.visualIdentityKind || multiple)) { profile.creatureIdentity = entity.visualIdentityKind ?? "template"; profiles[entity.id] = profile; changed = true; }
    if (matchingIndividualCreatureEra(profile, entity, group, chapter)) continue;
    if (profile.creatureForms?.some(form => form.state === group.state)) continue;
    const id = `form_${group.state}`;
    if (profile.dismissedAppearanceEraIds?.includes(id)) continue;
    const form = creatureFormSchema.parse({ id, name: `${entity.canonicalName} · ${group.state}`, state: group.state, status: "draft",
      appearance: group.appearance || `${entity.canonicalName} in ${group.state} form. Preserve only features supported by this form's source evidence.`, visualPrompt: "", referenceIds: [],
      sourceExcerpts: group.excerpt ? [group.excerpt] : [], detectedSource: scope ? { scope, fingerprint: sourceFingerprint(entity.id, group.state), needsReview: false } : undefined,
    });
    profiles[entity.id] = visualProfileSchema.parse({ ...profile, creatureForms: [...(profile.creatureForms ?? []), form], revision: profile.revision+1, updatedAt: now }); changed = true;
  }
  if (changed) await saveVisualProfiles(root, slug, profiles);
}
