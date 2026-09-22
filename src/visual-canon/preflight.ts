import { readJsonIfExists } from "../storage/story-files.js";
import { storyPaths } from "../storage/paths.js";
import { loadStoryBibleWithCanonicalOverlay } from "../story-bible/canonical.js";
import { loadVisualProfiles } from "./profiles.js";
import { resolveVisuallyRelevantCanonicalEntities } from "./resolver.js";
import { sceneManifestSchema } from "../scenes/types.js";
import { fingerprint } from "../utils/hash.js";

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

/** Read-only, zero-cost artwork gate. It deliberately derives visibility from the
 * same scene resolver used by Visual Canon, rather than scanning narration. */
export async function inspectArtworkVisualPreflight(options: {
  root: string;
  slug: string;
  chapters: number[];
  sceneId?: string;
  allowUnprofiledEntityIds?: readonly string[];
}): Promise<ArtworkVisualPreflight> {
  const [bible, profiles] = await Promise.all([
    loadStoryBibleWithCanonicalOverlay(options.root, options.slug),
    loadVisualProfiles(options.root, options.slug),
  ]);
  const allowed = new Set(options.allowUnprofiledEntityIds ?? []);
  const byEntity = new Map<string, ArtworkVisualPreflightEntity>();

  for (const chapter of options.chapters) {
    const raw = await readJsonIfExists(storyPaths(options.root, options.slug, chapter).scenesManifest);
    if (!raw) continue;
    const manifest = sceneManifestSchema.parse(raw);
    const scenes = options.sceneId ? manifest.scenes.filter((scene) => scene.id === options.sceneId) : manifest.scenes;
    if (options.sceneId && !scenes.length) throw new Error(`Scene '${options.sceneId}' was not found in chapter ${chapter}`);
    for (const scene of scenes) {
      for (const entity of resolveVisuallyRelevantCanonicalEntities(scene, bible)) {
        const profile = profiles[entity.id];
        const policy = entity.visualProfilePolicy?.mode ?? "prompt";
        const state: ArtworkVisualProfileState = profile?.status === "approved"
          ? "approved_profile"
          : policy === "skip"
            ? "skip_profile"
            : profile
              ? "draft_profile"
              : "missing_profile";
        const existing = byEntity.get(entity.id);
        if (existing) {
          existing.affectedSceneIds.push(`${chapter}:${scene.id}`);
        } else {
          byEntity.set(entity.id, {
            entityId: entity.id,
            name: entity.canonicalName,
            type: entity.type,
            state,
            affectedSceneIds: [`${chapter}:${scene.id}`],
            profileId: profile?.id,
            profileRevision: profile?.revision,
            policy,
          });
        }
      }
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
      chapters: options.chapters,
      sceneId: options.sceneId,
      entities: entities.map(({ entityId, state, policy, profileId, profileRevision, affectedSceneIds }) => ({ entityId, state, policy, profileId, profileRevision, affectedSceneIds })),
      allowed: [...allowed].sort(),
    }),
  };
}
