import { readJsonIfExists } from "../storage/story-files.js";
import { storyPaths } from "../storage/paths.js";
import { loadStoryBibleWithCanonicalOverlay } from "../story-bible/canonical.js";
import { loadVisualProfiles } from "./profiles.js";
import { resolveVisuallyRelevantCanonicalEntities, shouldUseVisualProfileForEntity } from "./resolver.js";
import { sceneManifestSchema } from "../scenes/types.js";
import type { Scene } from "../scenes/types.js";
import { fingerprint } from "../utils/hash.js";
import { enabledProductionScenes } from "../scenes/production.js";

export type ArtworkVisualProfileState = "approved_profile" | "draft_profile" | "missing_profile" | "skip_profile";

export type ArtworkVisualPreflightEntity = {
  entityId: string;
  name: string;
  type: string;
  state: ArtworkVisualProfileState;
  affectedSceneIds: string[];
  profileId?: string;
  profileRevision?: number;
  policy: "prompt" | "skip";
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
  candidates: readonly { id: string; scene: Scene }[];
  allowUnprofiledEntityIds?: readonly string[];
}): Promise<ArtworkVisualPreflight> {
  const [bible, profiles] = await Promise.all([
    loadStoryBibleWithCanonicalOverlay(options.root, options.slug),
    loadVisualProfiles(options.root, options.slug),
  ]);
  const allowed = new Set(options.allowUnprofiledEntityIds ?? []);
  const byEntity = new Map<string, ArtworkVisualPreflightEntity>();
  for (const { id, scene } of options.candidates) {
    for (const entity of resolveVisuallyRelevantCanonicalEntities(scene, bible)) {
      if (!shouldUseVisualProfileForEntity(scene, entity)) continue;
      const profile = profiles[entity.id];
      const policy = entity.visualProfilePolicy?.mode ?? "prompt";
      const state: ArtworkVisualProfileState = profile?.status === "approved"
        ? "approved_profile"
        : policy === "skip"
          ? "skip_profile"
          : profile
            ? "draft_profile"
            : "missing_profile";
      const previous = byEntity.get(entity.id);
      if (previous) previous.affectedSceneIds.push(id);
      else byEntity.set(entity.id, { entityId: entity.id, name: entity.canonicalName, type: entity.type, state, affectedSceneIds: [id], profileId: profile?.id, profileRevision: profile?.revision, policy });
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
  const candidates: Array<{ id: string; scene: Scene }> = [];
  for (const chapter of options.chapters) {
    const raw = await readJsonIfExists(storyPaths(options.root, options.slug, chapter).scenesManifest);
    if (!raw) continue;
    const manifest = sceneManifestSchema.parse(raw);
    const requestedIds = options.sceneIds ? new Set(options.sceneIds) : undefined;
    const requested = options.sceneId ? manifest.scenes.filter((scene) => scene.id === options.sceneId) : requestedIds ? manifest.scenes.filter((scene) => requestedIds.has(scene.id)) : manifest.scenes;
    if (options.sceneId && !requested.length) throw new Error(`Scene '${options.sceneId}' was not found in chapter ${chapter}`);
    const scenes = enabledProductionScenes(requested);
    for (const scene of scenes) {
      candidates.push({ id: `${chapter}:${scene.id}`, scene });
    }
  }
  return inspectArtworkVisualPreflightForScenes({ root: options.root, slug: options.slug, candidates, allowUnprofiledEntityIds: options.allowUnprofiledEntityIds });
}
