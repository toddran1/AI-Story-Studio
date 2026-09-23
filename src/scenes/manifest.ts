import { readFile } from "node:fs/promises";
import { resolveMasteredAudio } from "../audio/chapter-audio.js";
import { Chapter, chapterSchema } from "../domain/chapter.js";
import { Story } from "../domain/story.js";
import { StoryBible } from "../domain/story-bible.js";
import { LLMProvider } from "../llm/provider.js";
import { SceneError } from "../pipeline/errors.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists, readTextIfExists } from "../storage/story-files.js";
import { inspectStageArtifact, stalePrerequisiteWarning } from "../studio/artifact-state.js";
import { fileFingerprint as streamedFileFingerprint } from "../utils/file-fingerprint.js";
import { rebuildStoryBibleBeforeChapter } from "../story-bible/rebuild.js";
import { retrieveRelevantContext } from "../story-bible/retrieval.js";
import { fingerprint } from "../utils/hash.js";
import { withRetry } from "../batch/retry.js";
import { z } from "zod";
import { retryConfigSchema } from "../batch/types.js";
import { resolveVisualEntities } from "./identity.js";
import { sceneArtworkContentState, sceneEditableState } from "./editable-state.js";
import { planScenes, SCENE_PLANNER_PROMPT_VERSION } from "./planner.js";
import { normalizeSceneTiming, validateSceneCoverage } from "./timing.js";
import { planVisualScenes } from "./planner.js";
import { sceneRegenerationModeSchema, sceneRegenerationProposalSchema, sceneProposalSourceFingerprint, sceneVisualSnapshot, sceneVisualSnapshotSchema } from "./regeneration.js";
import { loadStoryArtDirection } from "../visual-canon/art-direction.js";
import { Scene, SceneManifest, sceneManifestSchema, sceneSchema } from "./types.js";
import { loadVisualContinuityOverlay, normalizeVisualContinuityChange, persistChapterVisualContinuity, renderContinuityForPlanner, resolvePreviousVisualContinuity, visualContinuityOverlayFingerprint } from "../visual-canon/continuity.js";

export async function planStoredScenes(options: { root: string; story: Story; chapter: number; provider: LLMProvider; force?: boolean }) {
  const paths = storyPaths(options.root, options.story.slug, options.chapter); const rawChapter = await readJsonIfExists<Chapter>(paths.chapterMeta); if (!rawChapter) throw new SceneError(`Chapter ${options.chapter} has no pipeline metadata`); const chapter = chapterSchema.parse(rawChapter);
  const narrationArtifact = await inspectStageArtifact(options.root, options.story.slug, options.chapter, "narration");
  if (narrationArtifact.availability === "missing") throw new SceneError(`Chapter ${options.chapter} narration is missing`);
  if (narrationArtifact.availability === "invalid") throw new SceneError(`Chapter ${options.chapter} narration exists but is invalid`);
  const resolved = await resolveMasteredAudio(options.root, options.story.slug, options.chapter, chapter).catch((error) => {
    throw new SceneError(error instanceof Error ? error.message : String(error), { cause: error });
  });
  chapter.audio = resolved.audio;
  const audioArtifact = await inspectStageArtifact(options.root, options.story.slug, options.chapter, "audioMastering");
  if (audioArtifact.availability !== "available" || !chapter.audio) throw new SceneError(`Chapter ${options.chapter} audio is not mastered`);
  const warnings: string[] = [];
  if (narrationArtifact.freshness === "stale") warnings.push(stalePrerequisiteWarning("narration"));
  if (audioArtifact.freshness === "stale") warnings.push(stalePrerequisiteWarning("audioMastering"));
  const audioDurationSeconds = chapter.audio.durationSeconds;
  const narration = (await readTextIfExists(paths.narration))!; const audioFileFingerprint = await streamedFileFingerprint(paths.audio);
  const fullBible = await rebuildStoryBibleBeforeChapter(options.root, options.story.slug, options.chapter + 1); const bible = retrieveRelevantContext(fullBible, narration, options.chapter + 1, { recentSummaryCount: options.story.context.recentChapterSummaries }); const config = options.story.pipeline.scenePlanner;
  const previousContinuity = await resolvePreviousVisualContinuity(options.root, options.story.slug, options.chapter); const continuityOverlay = await loadVisualContinuityOverlay(options.root, options.story.slug, options.chapter);
  const continuityInput = previousContinuity || continuityOverlay.entries.length ? fingerprint({ handoff: previousContinuity?.stateFingerprint ?? "none", overlay: visualContinuityOverlayFingerprint(continuityOverlay) }) : "none";
  const inputFingerprint = scenePlanningFingerprint(fingerprint(narration), fingerprint(bible), audioFileFingerprint, options.story.scenes, config.provider, config.model, continuityInput);
  const cachedRaw = await readJsonIfExists<SceneManifest>(paths.scenesManifest); const cached = cachedRaw ? sceneManifestSchema.safeParse(cachedRaw) : undefined;
  if (!options.force && cached?.success && cached.data.planningFingerprint === inputFingerprint && chapter.stages.scenePlanning.status === "complete") { await persistChapterVisualContinuity({ root: options.root, slug: options.story.slug, chapter: options.chapter, manifest: cached.data }); return { manifest: cached.data, reused: true, warnings }; }
  const started = Date.now(); chapter.stages.scenePlanning = { status: "running", provider: config.provider, model: config.model, promptVersion: SCENE_PLANNER_PROMPT_VERSION, fingerprint: inputFingerprint, startedAt: new Date().toISOString() }; await persistChapter(paths.chapterMeta, chapter);
  try {
    const result = await withRetry(() => planScenes(options.provider, config, { chapter: options.chapter, title: chapter.translatedTitle ?? chapter.originalTitle, narration, durationSeconds: audioDurationSeconds, bible, settings: options.story.scenes, visualContinuity: previousContinuity ? renderContinuityForPlanner(previousContinuity.state) : undefined }), retryConfigSchema.parse({}));
    const scenes = normalizeSceneTiming(result.value.scenes.map((scene) => ({
      ...scene,
      location: scene.location ?? undefined,
      visualChanges: normalizeVisualContinuityChange(scene.visualChanges),
      entityIds: resolveVisualEntities(scene.characters, fullBible.canonicalEntities).map((e) => e.id),
    })), audioDurationSeconds, options.story.scenes);
    const previousById = new Map(cached?.success ? cached.data.scenes.map((scene) => [scene.id, scene]) : []);
    for (const scene of scenes) { const previous = previousById.get(scene.id); if (previous && fingerprint(sceneArtworkContentState(previous)) === fingerprint(sceneArtworkContentState(scene))) scene.artwork = previous.artwork; }
    validateSceneCoverage(scenes, audioDurationSeconds, options.story.scenes); const now = new Date().toISOString(); const manifest = sceneManifestSchema.parse({ version: 1, chapter: options.chapter, durationSeconds: audioDurationSeconds, planningFingerprint: inputFingerprint, planner: { provider: config.provider, model: config.model, promptVersion: SCENE_PLANNER_PROMPT_VERSION }, manualRevision: 0, manuallyEdited: false, createdAt: cached?.success ? cached.data.createdAt : now, updatedAt: now, scenes });
    await atomicWriteJson(paths.scenesManifest, manifest); const outputFingerprint = await fileFingerprint(paths.scenesManifest); chapter.stages.scenePlanning = { ...chapter.stages.scenePlanning, status: "complete", outputFingerprint, completedAt: now, durationMs: Date.now() - started, usage: result.usage }; chapter.scenes = { total: scenes.length, generated: scenes.filter((scene) => scene.artwork.status === "complete").length, approved: scenes.filter((scene) => scene.artwork.review === "approved").length }; chapter.stages.artwork = { status: "pending" }; chapter.stages.video = { status: "pending" }; chapter.video = undefined; await persistChapter(paths.chapterMeta, chapter); await persistChapterVisualContinuity({ root: options.root, slug: options.story.slug, chapter: options.chapter, manifest }); return { manifest, reused: false, warnings };
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    chapter.stages.scenePlanning = {
      ...chapter.stages.scenePlanning,
      status: "failed",
      durationMs: Date.now() - started,
      error: {
        message: errMessage,
        cause: (error as any)?.code ? `code=${(error as any).code}` : undefined,
      },
    };
    await persistChapter(paths.chapterMeta, chapter);
    throw new SceneError(`Chapter ${options.chapter} scene planning failed: ${errMessage}`, { cause: error });
  }
}

export async function updateStoredSceneManifest(options: { root: string; story: Story; chapter: number; scenes: unknown }) {
  const paths = storyPaths(options.root, options.story.slug, options.chapter); const raw = await readJsonIfExists<SceneManifest>(paths.scenesManifest); if (!raw) throw new SceneError(`Chapter ${options.chapter} has no scene plan`); const manifest = sceneManifestSchema.parse(raw);
  const incoming = sceneSchema.array().min(1).max(100).parse(options.scenes); const previous = new Map(manifest.scenes.map((scene) => [scene.id, scene])); const ids = new Set<string>();
  if (incoming.every((scene) => scene.disabled)) throw new SceneError("At least one scene must remain enabled");
  const changedCharacters = incoming.some((scene) => { const before = previous.get(scene.id); return before && JSON.stringify(before.characters) !== JSON.stringify(scene.characters); });
  const canonicalEntities = changedCharacters
    ? (await rebuildStoryBibleBeforeChapter(options.root, options.story.slug, options.chapter + 1)).canonicalEntities
    : undefined;
  const scenes = incoming.map((scene) => {
    if (ids.has(scene.id) || !previous.has(scene.id)) throw new SceneError("Scene IDs must remain unique and stable");
    ids.add(scene.id);
    const before = previous.get(scene.id)!;
    const entityIds = JSON.stringify(before.characters) !== JSON.stringify(scene.characters)
      ? resolveVisualEntities(scene.characters, canonicalEntities ?? []).map((entity) => entity.id)
      : before.entityIds ?? [];
    const next = { ...scene, entityIds, artwork: fingerprint(sceneArtworkContentState(before)) === fingerprint(sceneArtworkContentState({ ...scene, entityIds })) ? before.artwork : { ...before.artwork, status: "pending" as const, review: "unreviewed" as const } };
    return next;
  });
  validateSceneCoverage(scenes, manifest.durationSeconds, options.story.scenes); const updated = sceneManifestSchema.parse({ ...manifest, scenes, manuallyEdited: true, manualRevision: manifest.manualRevision + 1, updatedAt: new Date().toISOString() }); await atomicWriteJson(paths.scenesManifest, updated); await invalidateAfterSceneEdit(options.root, options.story.slug, options.chapter, paths.chapterMeta, updated); await persistChapterVisualContinuity({ root: options.root, slug: options.story.slug, chapter: options.chapter, manifest: updated }); return updated;
}

/** Persist one visual beat without accepting unrelated drafts or structural edits. */
export async function updateStoredScene(options: { root: string; story: Story; chapter: number; sceneId: string; scene: unknown; expectedFingerprint: string }) {
  const paths = storyPaths(options.root, options.story.slug, options.chapter);
  const raw = await readJsonIfExists<SceneManifest>(paths.scenesManifest);
  if (!raw) throw new SceneError(`Chapter ${options.chapter} has no scene plan`);
  const manifest = sceneManifestSchema.parse(raw);
  const index = manifest.scenes.findIndex((item) => item.id === options.sceneId);
  if (index < 0) throw new SceneError(`Scene ${options.sceneId} was not found`);
  const previous = manifest.scenes[index]!;
  if (sceneContentFingerprint(previous) !== options.expectedFingerprint) throw new SceneError("Scene changed since it was opened. Refresh before saving this scene.");
  const input = sceneSchema.parse(options.scene);
  if (input.id !== options.sceneId) throw new SceneError("Scene ID cannot change during a single-scene edit");
  const replacement = sceneSchema.parse({
    ...previous,
    summary: input.summary, startSeconds: input.startSeconds, endSeconds: input.endSeconds,
    characters: input.characters, entityIds: previous.entityIds ?? [], location: input.location, visualPrompt: input.visualPrompt,
    importance: input.importance, disabled: input.disabled, direction: input.direction,
    overrides: input.overrides, visualChanges: input.visualChanges,
  });
  const scenes = manifest.scenes.map((item, position) => position === index ? replacement : item);
  return updateStoredSceneManifest({ ...options, scenes });
}

export async function previewStoredSceneRegeneration(options: { root: string; story: Story; chapter: number; sceneId: string; mode: unknown; provider: LLMProvider }) {
  const mode = sceneRegenerationModeSchema.parse(options.mode);
  const paths = storyPaths(options.root, options.story.slug, options.chapter);
  const manifest = sceneManifestSchema.parse(await readJsonIfExists<SceneManifest>(paths.scenesManifest));
  const scene = manifest.scenes.find((item) => item.id === options.sceneId);
  if (!scene) throw new SceneError(`Scene ${options.sceneId} was not found`);
  const narration = await readTextIfExists(paths.narration);
  if (!narration?.trim()) throw new SceneError("Chapter narration is required to regenerate a scene");
  const bible = await rebuildStoryBibleBeforeChapter(options.root, options.story.slug, options.chapter + 1);
  const context = retrieveRelevantContext(bible, narration, options.chapter + 1, { recentSummaryCount: options.story.context.recentChapterSummaries });
  const config = options.story.pipeline.scenePlanner;
  const artDirection = await loadStoryArtDirection(options.root, options.story.slug);
  const continuityOverlay = await loadVisualContinuityOverlay(options.root, options.story.slug, options.chapter);
  const continuityState = continuityOverlay.entries.find((entry) => entry.sceneId === scene.id);
  const current = sceneVisualSnapshot(scene);
  const visualDirectionContext = JSON.stringify({
    storyArtDirection: artDirection,
    direction: scene.direction, overrides: scene.overrides, visualChanges: scene.visualChanges, continuityState,
  });
  let proposed: typeof current;
  if (mode === "image_prompt") {
    await options.provider.validateConfiguration();
    const result = await options.provider.generateStructured({ model: config.model,
      schemaName: "chapter_scene_image_prompt_proposal",
      schema: z.object({ visualPrompt: z.string().trim().min(1).max(8000) }).strict(),
      instructions: "Rewrite only the image prompt for this saved chapter scene. Keep the visual beat, characters, location, importance, narration timing, identities, and saved art direction unchanged. Honor references, wardrobe, negative prompt, and continuity as editorial constraints. Return only visualPrompt.",
      input: JSON.stringify({ scene: current, visualDirectionContext, sceneNarration: scene.narrationText ?? scene.summary, chapterContext: narration.slice(0, 8000), canonicalEntities: context.canonicalEntities.map((entity) => ({ id: entity.id, name: entity.canonicalName, description: entity.description })) }),
    });
    proposed = { ...current, visualPrompt: result.value.visualPrompt };
  } else {
    const planned = await planVisualScenes(options.provider, config, {
      sourceType: "chapter", sourceId: String(options.chapter), sourceLabel: `CHAPTER ${options.chapter}: regenerate ${scene.id} only`,
      narration: scene.narrationText ?? scene.summary, durationSeconds: scene.endSeconds - scene.startSeconds,
      bible: context, settings: options.story.scenes, targetSceneCount: 1, visualDirectionContext,
    });
    if (planned.value.scenes.length !== 1) throw new SceneError("Individual scene regeneration must return exactly one scene");
    const next = planned.value.scenes[0]!;
    proposed = sceneVisualSnapshotSchema.parse({ summary: next.summary, visualPrompt: next.visualPrompt, characters: next.characters,
      entityIds: resolveVisualEntities(next.characters, bible.canonicalEntities).map((entity) => entity.id), location: next.location ?? undefined, importance: next.importance });
  }
  return sceneRegenerationProposalSchema.parse({ sceneId: scene.id, mode, sourceFingerprint: sceneProposalSourceFingerprint(scene, continuityState), current, proposed, provider: config.provider, model: config.model });
}

export async function applyStoredSceneRegeneration(options: { root: string; story: Story; chapter: number; sceneId: string; proposal: unknown }) {
  const proposal = sceneRegenerationProposalSchema.parse(options.proposal);
  if (proposal.sceneId !== options.sceneId) throw new SceneError("Proposal scene ID does not match the selected scene");
  const paths = storyPaths(options.root, options.story.slug, options.chapter);
  const manifest = sceneManifestSchema.parse(await readJsonIfExists<SceneManifest>(paths.scenesManifest));
  const scene = manifest.scenes.find((item) => item.id === options.sceneId);
  if (!scene) throw new SceneError(`Scene ${options.sceneId} was not found`);
  const continuityOverlay = await loadVisualContinuityOverlay(options.root, options.story.slug, options.chapter);
  const continuityState = continuityOverlay.entries.find((entry) => entry.sceneId === scene.id);
  if (sceneProposalSourceFingerprint(scene, continuityState) !== proposal.sourceFingerprint) throw new SceneError("This scene changed since the proposal was generated. Generate a new proposal before applying it.");
  const proposed = proposal.mode === "image_prompt" ? { visualPrompt: proposal.proposed.visualPrompt } : proposal.proposed;
  const replacement = sceneSchema.parse({ ...scene, ...proposed });
  return updateStoredScene({ ...options, scene: replacement, expectedFingerprint: sceneContentFingerprint(scene) });
}

export function scenePlanningFingerprint(narration: string, bible: string, audio: string | undefined, settings: Story["scenes"], provider: string, model: string, continuity = "none") { return fingerprint({ narration, bible, audio, settings, provider, model, continuity, promptVersion: SCENE_PLANNER_PROMPT_VERSION }); }
export function productionSceneFingerprint(plan: { scenes: Scene[]; [key: string]: unknown } | undefined) {
  if (!plan) return fingerprint(undefined);
  return fingerprint({ ...plan, updatedAt: undefined, scenes: plan.scenes.map(({ artwork, ...scene }) => scene) });
}
export function sceneContentFingerprint(scene: Scene) { return fingerprint(sceneEditableState(scene)); }
async function invalidateAfterSceneEdit(root: string, slug: string, chapterNumber: number, path: string, manifest: SceneManifest) {
  const raw = await readJsonIfExists<Chapter>(path); if (!raw) return;
  const chapter = chapterSchema.parse(raw);
  chapter.scenes = { total: manifest.scenes.length, generated: manifest.scenes.filter((scene) => scene.artwork.status === "complete").length, approved: manifest.scenes.filter((scene) => scene.artwork.review === "approved").length };
  const artwork = await inspectStageArtifact(root, slug, chapterNumber, "artwork");
  if (artwork.availability === "available") {
    chapter.stages.artwork = { ...chapter.stages.artwork, status: "complete", error: undefined, staleReason: undefined, completedAt: chapter.stages.artwork.completedAt ?? new Date().toISOString() };
  } else chapter.stages.artwork = { status: "pending" };
  chapter.stages.video = { status: "pending" }; chapter.video = undefined; await persistChapter(path, chapter);
}
async function fileFingerprint(path: string) { const data = await readFile(path); return fingerprint(data.toString("base64")); }
async function persistChapter(path: string, chapter: Chapter) { chapter.updatedAt = new Date().toISOString(); await atomicWriteJson(path, chapterSchema.parse(chapter)); }
