import { z } from "zod";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Scene } from "../scenes/types.js";
import { sceneArtworkContentState, sceneEditableState } from "../scenes/editable-state.js";
import { visualSceneSelectionSchema } from "../visual-canon/regeneration-selection.js";
import { storyPaths } from "../storage/paths.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { visualCheckSchema, visualCheckOutcome } from "../artwork/visual-check.js";
import { loadVisualProfiles } from "../visual-canon/profiles.js";
import { loadStoryArtDirection, resolveActiveArtDirection } from "../visual-canon/art-direction.js";
import { loadStoryBibleWithCanonicalOverlay } from "../story-bible/canonical.js";
import { loadStory } from "../config/load-config.js";
import { resolveVisualCanonPrompt } from "../visual-canon/resolver.js";
import { resolveSummarySceneArtDirection } from "../summaries/art-direction.js";
import { summarySchema } from "../summaries/types.js";
import { resolveChapterVisualContinuity, resolveVisualContinuity, renderSceneContinuity } from "../visual-canon/continuity.js";
import { sceneManifestSchema } from "../scenes/types.js";
import { visualContinuityOverlaySchema as overlaySchema } from "../visual-canon/continuity-state.js";
const importOverlay = (raw: unknown) => overlaySchema.parse(raw);
import { summaryMediaPaths } from "../summaries/media.js";

export const motionAssetIdSchema = z.string().regex(/^mov_[a-f0-9-]{36}$/);
export const motionAssetSchema = z.object({
  id: motionAssetIdSchema, kind: z.enum(["clip", "parallax"]), origin: z.enum(["import", "local", "provider"]),
  createdAt: z.string().datetime(), binding: z.string().min(1), sourceFingerprint: z.string().min(1), sampleFingerprints: z.array(z.string().min(1)).length(3),
  outputFingerprint: z.string().min(1), durationSeconds: z.number().min(1).max(12),
  width: z.number().int().positive().max(3840), height: z.number().int().positive().max(2160),
  review: z.enum(["unreviewed", "approved", "rejected"]).default("unreviewed"),
  checks: z.array(visualCheckSchema).max(3).default([]), checkedBinding: z.string().optional(),
  provider: z.string().optional(), model: z.string().optional(), instruction: z.string().max(2000).optional(),
});
export const motionAssetManifestSchema = z.object({ version: z.literal(1), selectedId: motionAssetIdSchema.optional(), assets: z.array(motionAssetSchema).max(100) });
export type MotionAsset = z.infer<typeof motionAssetSchema>;
export type MotionTarget = z.infer<typeof visualSceneSelectionSchema>;
export function newMotionAssetId() { return `mov_${randomUUID()}`; }
export function motionAssetPaths(root: string, slug: string, raw: MotionTarget, id?: string) {
  z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).parse(slug);
  const target = visualSceneSelectionSchema.parse(raw);
  if (id) motionAssetIdSchema.parse(id);
  const scope = target.chapter ? `chapter-${target.chapter}` : `summary-${target.summaryId}`;
  const directory = join(storyPaths(root, slug, 1).story, "motion-assets", scope, target.sceneId);
  return { directory, manifest: join(directory, "manifest.json"), video: join(directory, `${id}.mp4`), frame: (index: number) => join(directory, `${id}-${z.number().int().min(0).max(2).parse(index)}.png`) };
}
export async function loadMotionAssets(root: string, slug: string, target: MotionTarget) {
  return motionAssetManifestSchema.parse(await readJsonIfExists(motionAssetPaths(root, slug, target).manifest) ?? { version: 1, assets: [] });
}
export async function saveMotionAssets(root: string, slug: string, target: MotionTarget, value: z.infer<typeof motionAssetManifestSchema>) {
  const paths = motionAssetPaths(root, slug, target); await mkdir(paths.directory, { recursive: true });
  await atomicWriteJson(paths.manifest, motionAssetManifestSchema.parse(value));
}
/** Binds approval to narrative, starting image, saved designs, and inherited
 * context. Video-only camera edits do not invalidate the motion itself. */
export async function motionAssetBinding(root: string, slug: string, target: MotionTarget, scene: Scene) {
  const paths = storyPaths(root, slug, target.chapter ?? 1);
  const [profiles, direction, bible, story] = await Promise.all([
    loadVisualProfiles(root, slug), loadStoryArtDirection(root, slug), loadStoryBibleWithCanonicalOverlay(root, slug), loadStory(paths.storyConfig),
  ]);
  let continuity: import("../visual-canon/continuity-state.js").ResolvedSceneContinuity | undefined;
  let chapter = target.chapter;
  let artDirection = resolveActiveArtDirection(direction, scene.overrides?.artDirectionPresetId);
  let effectiveScene = scene;
  if (target.chapter) {
    const manifest = sceneManifestSchema.parse(await readJsonIfExists(paths.scenesManifest));
    continuity = (await resolveChapterVisualContinuity({ root, slug, chapter: target.chapter, manifest })).resolved.perScene.find(s => s.sceneId === scene.id);
  } else {
    const directory = summaryMediaPaths(root, slug, target.summaryId!).directory;
    const summary = summarySchema.parse(await readJsonIfExists(`${directory}.json`));
    chapter = Math.min(...summary.chapters);
    const effectiveDirection = resolveSummarySceneArtDirection(direction, summary.artDirectionOverride, scene);
    artDirection = effectiveDirection.preset;
    if (effectiveDirection.source === "disabled") effectiveScene = { ...scene, direction: { ...scene.direction!, useStoryArtDirection: false } };
    const overlay = await readJsonIfExists(join(directory, "visual-continuity-manual.json"));
    continuity = resolveVisualContinuity({ scenes: summary.scenePlan!.scenes.filter(s => !s.disabled).map(s => ({ id: s.id, sequence: s.sequence, appearanceChapter: s.overrides?.appearanceChapter, location: s.location, visualChanges: s.visualChanges, contentFingerprint: fingerprint(sceneEditableState(s)) })), manualOverrides: overlay ? importOverlay(overlay) : undefined }).perScene.find(s => s.sceneId === scene.id);
  }
  const resolved = resolveVisualCanonPrompt({ scene: effectiveScene, story, bible, visualProfiles: profiles, artDirection, chapter, frameState: continuity?.endState, visualContinuity: continuity ? renderSceneContinuity(continuity) : undefined });
  return fingerprint({ version: "motion-binding-v1", scene: sceneArtworkContentState(scene), narration: scene.narrationText, source: scene.artwork.imageFingerprint, resolved: resolved.resolvedPromptFingerprint });
}
export function motionAssetReady(asset: MotionAsset, binding: string) {
  return asset.review === "approved" && asset.binding === binding && asset.checkedBinding === binding && asset.checks.length === 3 && asset.checks.every((check, index) => check.imageFingerprint === asset.sampleFingerprints[index] && visualCheckOutcome(check) === "ready");
}
export async function selectedMotionAsset(root: string, slug: string, target: MotionTarget, scene: Scene) {
  const manifest = await loadMotionAssets(root, slug, target);
  if (!manifest.selectedId) return undefined;
  const asset = manifest.assets.find(a => a.id === manifest.selectedId);
  const binding = await motionAssetBinding(root, slug, target, scene);
  if (!asset || scene.artwork.review !== "approved" || !motionAssetReady(asset, binding)) throw new Error(`${scene.id}: selected motion needs current continuity checks and approval. Review it or use the still artwork.`);
  const path = motionAssetPaths(root, slug, target, asset.id).video;
  if (await fileFingerprint(path) !== asset.outputFingerprint) throw new Error(`${scene.id}: selected motion is missing or damaged. Restore it or use the still artwork.`);
  return { path, fingerprint: asset.outputFingerprint, durationSeconds: asset.durationSeconds, width: asset.width, height: asset.height, id: asset.id };
}

/** Adapter boundary. A provider returns bytes, never an arbitrary download URL.
 * The caller supplies only a human-approved starting frame. */
export interface MotionClipProvider {
  readonly name: string; readonly version: string;
  generate(request: { model: string; source: Buffer; prompt: string; durationSeconds: number; signal: AbortSignal }): Promise<{ data: Buffer }>;
}
