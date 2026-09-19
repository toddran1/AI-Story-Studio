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
import { retryConfigSchema } from "../batch/types.js";
import { resolveVisualEntities } from "./identity.js";
import { planScenes, SCENE_PLANNER_PROMPT_VERSION } from "./planner.js";
import { normalizeSceneTiming, validateSceneCoverage } from "./timing.js";
import { Scene, SceneManifest, sceneManifestSchema, sceneSchema } from "./types.js";

export async function planStoredScenes(options: { root: string; story: Story; chapter: number; provider: LLMProvider; force?: boolean }) {
  const paths = storyPaths(options.root, options.story.slug, options.chapter); const rawChapter = await readJsonIfExists<Chapter>(paths.chapterMeta); if (!rawChapter) throw new SceneError(`Chapter ${options.chapter} has no pipeline metadata`); const chapter = chapterSchema.parse(rawChapter);
  const narrationArtifact = await inspectStageArtifact(options.root, options.story.slug, options.chapter, "narration");
  if (narrationArtifact.availability !== "available") throw new SceneError(`Chapter ${options.chapter} narration is missing`);
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
  const inputFingerprint = scenePlanningFingerprint(fingerprint(narration), fingerprint(bible), audioFileFingerprint, options.story.scenes, config.provider, config.model);
  const cachedRaw = await readJsonIfExists<SceneManifest>(paths.scenesManifest); const cached = cachedRaw ? sceneManifestSchema.safeParse(cachedRaw) : undefined;
  if (!options.force && cached?.success && cached.data.planningFingerprint === inputFingerprint && chapter.stages.scenePlanning.status === "complete") return { manifest: cached.data, reused: true, warnings };
  const started = Date.now(); chapter.stages.scenePlanning = { status: "running", provider: config.provider, model: config.model, promptVersion: SCENE_PLANNER_PROMPT_VERSION, fingerprint: inputFingerprint, startedAt: new Date().toISOString() }; await persistChapter(paths.chapterMeta, chapter);
  try {
    const result = await withRetry(() => planScenes(options.provider, config, { chapter: options.chapter, title: chapter.translatedTitle ?? chapter.originalTitle, narration, durationSeconds: audioDurationSeconds, bible, settings: options.story.scenes }), retryConfigSchema.parse({}));
    const scenes = normalizeSceneTiming(result.value.scenes.map((scene) => ({
      ...scene,
      location: scene.location ?? undefined,
      entityIds: resolveVisualEntities(scene.characters, fullBible.canonicalEntities).map((e) => e.id),
    })), audioDurationSeconds, options.story.scenes);
    const previousById = new Map(cached?.success ? cached.data.scenes.map((scene) => [scene.id, scene]) : []);
    for (const scene of scenes) { const previous = previousById.get(scene.id); if (previous && sceneContentFingerprint(previous) === sceneContentFingerprint(scene)) scene.artwork = previous.artwork; }
    validateSceneCoverage(scenes, audioDurationSeconds, options.story.scenes); const now = new Date().toISOString(); const manifest = sceneManifestSchema.parse({ version: 1, chapter: options.chapter, durationSeconds: audioDurationSeconds, planningFingerprint: inputFingerprint, planner: { provider: config.provider, model: config.model, promptVersion: SCENE_PLANNER_PROMPT_VERSION }, manualRevision: 0, manuallyEdited: false, createdAt: cached?.success ? cached.data.createdAt : now, updatedAt: now, scenes });
    await atomicWriteJson(paths.scenesManifest, manifest); const outputFingerprint = await fileFingerprint(paths.scenesManifest); chapter.stages.scenePlanning = { ...chapter.stages.scenePlanning, status: "complete", outputFingerprint, completedAt: now, durationMs: Date.now() - started, usage: result.usage }; chapter.scenes = { total: scenes.length, generated: scenes.filter((scene) => scene.artwork.status === "complete").length, approved: scenes.filter((scene) => scene.artwork.review === "approved").length }; chapter.stages.artwork = { status: "pending" }; chapter.stages.video = { status: "pending" }; chapter.video = undefined; await persistChapter(paths.chapterMeta, chapter); return { manifest, reused: false, warnings };
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
  const incoming = sceneSchema.array().length(manifest.scenes.length).parse(options.scenes); const previous = new Map(manifest.scenes.map((scene) => [scene.id, scene])); const ids = new Set<string>();
  const scenes = incoming.map((scene) => { if (ids.has(scene.id) || !previous.has(scene.id)) throw new SceneError("Scene IDs must remain unique and stable"); ids.add(scene.id); const before = previous.get(scene.id)!; return { ...scene, artwork: sceneContentFingerprint(before) === sceneContentFingerprint(scene) ? before.artwork : { ...before.artwork, status: "pending" as const, review: "unreviewed" as const } }; });
  validateSceneCoverage(scenes, manifest.durationSeconds, options.story.scenes); const updated = sceneManifestSchema.parse({ ...manifest, scenes, manuallyEdited: true, manualRevision: manifest.manualRevision + 1, updatedAt: new Date().toISOString() }); await atomicWriteJson(paths.scenesManifest, updated); await invalidateAfterSceneEdit(paths.chapterMeta, updated); return updated;
}

export function scenePlanningFingerprint(narration: string, bible: string, audio: string | undefined, settings: Story["scenes"], provider: string, model: string) { return fingerprint({ narration, bible, audio, settings, provider, model, promptVersion: SCENE_PLANNER_PROMPT_VERSION }); }
export function productionSceneFingerprint(plan: { scenes: Scene[]; [key: string]: unknown } | undefined) {
  if (!plan) return fingerprint(undefined);
  return fingerprint({ ...plan, updatedAt: undefined, scenes: plan.scenes.map(({ artwork, ...scene }) => scene) });
}
export function sceneContentFingerprint(scene: Pick<Scene, "summary" | "startSeconds" | "endSeconds" | "characters" | "location" | "visualPrompt" | "importance"> & { direction?: Scene["direction"]; overrides?: Scene["overrides"] }) {
  return fingerprint({ summary: scene.summary, startSeconds: scene.startSeconds, endSeconds: scene.endSeconds, characters: scene.characters, location: scene.location, visualPrompt: scene.visualPrompt, importance: scene.importance, direction: scene.direction, overrides: scene.overrides });
}
async function invalidateAfterSceneEdit(path: string, manifest: SceneManifest) { const raw = await readJsonIfExists<Chapter>(path); if (!raw) return; const chapter = chapterSchema.parse(raw); chapter.scenes = { total: manifest.scenes.length, generated: manifest.scenes.filter((scene) => scene.artwork.status === "complete").length, approved: manifest.scenes.filter((scene) => scene.artwork.review === "approved").length }; chapter.stages.artwork = { status: "pending" }; chapter.stages.video = { status: "pending" }; chapter.video = undefined; await persistChapter(path, chapter); }
async function fileFingerprint(path: string) { const data = await readFile(path); return fingerprint(data.toString("base64")); }
async function persistChapter(path: string, chapter: Chapter) { chapter.updatedAt = new Date().toISOString(); await atomicWriteJson(path, chapterSchema.parse(chapter)); }
