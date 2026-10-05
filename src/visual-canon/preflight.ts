import { matchingIndividualCreatureEra } from "./creature-look.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { storyPaths } from "../storage/paths.js";
import { loadStoryBibleWithCanonicalOverlay } from "../story-bible/canonical.js";
import { loadVisualProfiles } from "./profiles.js";
import { resolveVisuallyRelevantCanonicalEntities, shouldUseVisualProfileForEntity } from "./resolver.js";
import { sceneManifestSchema } from "../scenes/types.js";
import type { Scene } from "../scenes/types.js";
import { resolveVisualEntities } from "../scenes/identity.js";
import { fingerprint } from "../utils/hash.js";
import { enabledProductionScenes } from "../scenes/production.js";

export type ArtworkVisualProfileState = "approved_profile" | "draft_profile" | "missing_profile" | "skip_profile";

export type ArtworkVisualPreflightEntity = {
  entityId: string;
  name: string;
  originalName?: string;
  type: string;
  state: ArtworkVisualProfileState;
  affectedSceneIds: string[];
  profileId?: string;
  profileRevision?: number;
  policy: "prompt" | "skip";
  missingCreatureForms?: string[];
};

export type ArtworkVisualPreflight = {
  ready: boolean;
  entities: ArtworkVisualPreflightEntity[];
  requiresDecision: ArtworkVisualPreflightEntity[];
  fingerprint: string;
};

/** Run the shared Visual Profile gate against an already-selected set of
 * scenes. Summary artwork and chapter artwork use this same classification
 * and the same visually-relevant entity rules. */
export async function inspectArtworkVisualPreflightForScenes(options: {
  root: string;
  slug: string;
  candidates: readonly { id: string; scene: Scene; chapter?: number }[];
  allowUnprofiledEntityIds?: readonly string[];
  context?: { bible: Awaited<ReturnType<typeof loadStoryBibleWithCanonicalOverlay>>; visualProfiles: Awaited<ReturnType<typeof loadVisualProfiles>> };
}): Promise<ArtworkVisualPreflight> {
  const [bible, profiles] = options.context ? [options.context.bible, options.context.visualProfiles] : await Promise.all([
    loadStoryBibleWithCanonicalOverlay(options.root, options.slug),
    loadVisualProfiles(options.root, options.slug),
  ]);
  const allowed = new Set(options.allowUnprofiledEntityIds ?? []);
  const byEntity = new Map<string, ArtworkVisualPreflightEntity>();
  for (const { id, scene, chapter } of options.candidates) {
    for (const entity of resolveVisuallyRelevantCanonicalEntities(scene, bible)) {
      if (!shouldUseVisualProfileForEntity(scene, entity)) continue;
      const profile = profiles[entity.id];
      const policy = entity.visualProfilePolicy?.mode ?? "prompt";
      const groups = (scene.creatureGroups ?? []).filter(group => resolveVisualEntities([group.entity], [entity]).length > 0);
      const missingForms = groups.filter(group => {
        if (matchingIndividualCreatureEra(profile, entity, group, scene.overrides?.appearanceChapter ?? chapter, scene.overrides?.appearanceEraOverrides?.[entity.id] ?? scene.overrides?.appearanceEraOverrides?.[entity.canonicalName])) return false;
        const forms = profile?.creatureForms?.filter(form => form.status === "approved" && form.state === group.state) ?? [];
        if (group.formId) return !forms.some(form => form.id === group.formId);
        return forms.length !== 1 && !(group.state === "living" && forms.length === 0 && !profile?.creatureForms?.some(form => form.state === "living"));
      }).map(group => `${group.label} (${group.state})`);
      const state: ArtworkVisualProfileState = profile?.status === "approved" && !missingForms.length
        ? "approved_profile"
        : policy === "skip"
          ? "skip_profile"
          : profile
            ? "draft_profile"
            : "missing_profile";
      const previous = byEntity.get(entity.id);
      if (previous) { previous.affectedSceneIds.push(id); if (missingForms.length) { previous.state = policy === "skip" ? "skip_profile" : "draft_profile"; previous.missingCreatureForms = [...new Set([...(previous.missingCreatureForms ?? []),...missingForms])]; } }
      else byEntity.set(entity.id, { entityId: entity.id, name: entity.canonicalName, originalName: entity.originalName, type: entity.type, state, affectedSceneIds: [id], profileId: profile?.id, profileRevision: profile?.revision, policy, ...(missingForms.length ? { missingCreatureForms: missingForms } : {}) });
    }
  }
  const entities = [...byEntity.values()];
  const requiresDecision = entities.filter((entity) =>
    (entity.state === "missing_profile" || entity.state === "draft_profile") && !allowed.has(entity.entityId),
  );
  return {
    ready: requiresDecision.length === 0,
    entities,
    requiresDecision,
    fingerprint: fingerprint({
      candidates: options.candidates.map(({ id }) => id),
      entities: entities.map(({ entityId, state, policy, profileId, profileRevision, affectedSceneIds }) => ({ entityId, state, policy, profileId, profileRevision, affectedSceneIds })),
      allowed: [...allowed].sort(),
    }),
  };
}

/** Read-only, zero-cost artwork gate. It deliberately derives visibility from the
 * same scene resolver used by Visual Canon, rather than scanning narration. */
export async function inspectArtworkVisualPreflight(options: {
  root: string;
  slug: string;
  chapters: number[];
  sceneId?: string;
  sceneIds?: readonly string[];
  allowUnprofiledEntityIds?: readonly string[];
}): Promise<ArtworkVisualPreflight> {
  const candidates: Array<{ id: string; scene: Scene; chapter: number }> = [];
  for (const chapter of options.chapters) {
    const raw = await readJsonIfExists(storyPaths(options.root, options.slug, chapter).scenesManifest);
    if (!raw) continue;
    const manifest = sceneManifestSchema.parse(raw);
    const requestedIds = options.sceneIds ? new Set(options.sceneIds) : undefined;
    const requested = options.sceneId ? manifest.scenes.filter((scene) => scene.id === options.sceneId) : requestedIds ? manifest.scenes.filter((scene) => requestedIds.has(scene.id)) : manifest.scenes;
    if (options.sceneId && !requested.length) throw new Error(`Scene '${options.sceneId}' was not found in chapter ${chapter}`);
    const scenes = enabledProductionScenes(requested);
    for (const scene of scenes) {
      candidates.push({ id: `${chapter}:${scene.id}`, scene, chapter });
    }
  }
  return inspectArtworkVisualPreflightForScenes({ root: options.root, slug: options.slug, candidates, allowUnprofiledEntityIds: options.allowUnprofiledEntityIds });
}
