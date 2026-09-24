import { readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveMasteredAudio } from "../audio/chapter-audio.js";
import { Chapter, StageState, chapterSchema } from "../domain/chapter.js";
import { Story } from "../domain/story.js";
import { VideoError } from "../pipeline/errors.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { sceneImagePath, storyPaths } from "../storage/paths.js";
import { exists, readJsonIfExists } from "../storage/story-files.js";
import { fileIsNonEmpty, inspectSceneArtwork, inspectStageArtifact, stalePrerequisiteWarning } from "../studio/artifact-state.js";
import { fingerprint } from "../utils/hash.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { ChapterVideoInput, VideoProcessor } from "./renderer.js";
import { SceneManifest, sceneManifestSchema } from "../scenes/types.js";
import { resolveVideoSettings, VideoSettings } from "./config.js";
import { imageDimensions } from "../artwork/resolution.js";
import { enabledProductionScenes, retimeScenesToDuration } from "../scenes/production.js";

export type VideoEvent = { status: "started" | "completed" | "reused"; chapter: number; state: StageState };
export async function renderStoredChapterVideo(options: { root: string; story: Story; chapter: number; processor: VideoProcessor; force?: boolean; allowMissingSubtitles?: boolean; onEvent?: (event: VideoEvent) => void }) {
  const paths = storyPaths(options.root, options.story.slug, options.chapter); const raw = await readJsonIfExists<Chapter>(paths.chapterMeta); if (!raw) throw new VideoError(`Chapter ${options.chapter} has no pipeline metadata`); const chapter = chapterSchema.parse(raw);
  const resolved = await resolveMasteredAudio(options.root, options.story.slug, options.chapter, chapter).catch((error) => {
    throw new VideoError(error instanceof Error ? error.message : String(error), { cause: error });
  });
  chapter.audio = resolved.audio;
  const audioArtifact = await inspectStageArtifact(options.root, options.story.slug, options.chapter, "audioMastering");
  if (audioArtifact.availability !== "available" || !chapter.audio) throw new VideoError(`Chapter ${options.chapter} audio is not mastered`);
  const configuredSubtitles = options.story.video.subtitleMode !== "none";
  const subtitleArtifact = configuredSubtitles ? await inspectStageArtifact(options.root, options.story.slug, options.chapter, "subtitles") : undefined;
  const subtitleReady = subtitleArtifact?.availability === "available" && await fileIsNonEmpty(paths.subtitlesSrt);
  if (configuredSubtitles && !subtitleReady && !options.allowMissingSubtitles) throw new VideoError(`Chapter ${options.chapter} subtitles are not ready`);
  const needsSubtitles = configuredSubtitles && subtitleReady;
  const videoSettings = resolveVideoSettings(needsSubtitles ? options.story.video : { ...options.story.video, subtitleMode: "none" });
  const warnings: string[] = [];
  if (audioArtifact.freshness === "stale") warnings.push(stalePrerequisiteWarning("audioMastering"));
  if (needsSubtitles && subtitleArtifact?.freshness === "stale") warnings.push(stalePrerequisiteWarning("subtitles"));
  if (configuredSubtitles && !needsSubtitles) warnings.push("Subtitles are unavailable; rendering this Chapter without subtitles.");
  const sceneArtwork = await approvedSceneArtwork(options.root, options.story.slug, options.chapter, chapter.audio.durationSeconds); const availableCover = await findCover(options.root, options.story.slug); const cover = sceneArtwork ? undefined : options.story.video.backgroundMode === "gradient" ? undefined : availableCover; const backgroundFingerprint = sceneArtwork ? fingerprint(sceneArtwork.map((item) => ({ id: item.id, durationSeconds: item.durationSeconds, fingerprint: item.fingerprint }))) : cover ? await fileFingerprint(cover) : "generated-fallback-v1"; const audioFingerprint = await fileFingerprint(paths.audio); const subtitleFileFingerprint = needsSubtitles ? await fileFingerprint(paths.subtitlesSrt) : undefined; const inputFingerprint = videoFingerprint(audioFingerprint, subtitleFileFingerprint, backgroundFingerprint, videoSettings, chapter.translatedTitle ?? chapter.originalTitle);
  const belowTarget = sceneArtwork ? await artworkBelowCanvas(sceneArtwork, videoSettings) : false; if (belowTarget) warnings.push(`Chapter ${options.chapter} artwork is below the ${videoSettings.width}x${videoSettings.height} canvas; FFmpeg will scale it up.`);
  const currentOutput = await fileFingerprint(paths.video); if (!options.force && chapter.stages.video.status === "complete" && chapter.stages.video.fingerprint === inputFingerprint && currentOutput === chapter.stages.video.outputFingerprint && chapter.video) { options.onEvent?.({ status: "reused", chapter: options.chapter, state: chapter.stages.video }); return { chapter, reused: true, cover: Boolean(cover), scenes: sceneArtwork?.length ?? 0, warnings, belowTargetResolution: belowTarget }; }
  const started = Date.now(); chapter.video = undefined; chapter.stages.video = { status: "running", provider: "ffmpeg", model: options.processor.version, fingerprint: inputFingerprint, startedAt: new Date().toISOString() }; await persist(paths.chapterMeta, chapter); options.onEvent?.({ status: "started", chapter: options.chapter, state: chapter.stages.video }); const staged = `${paths.video}.stage-${randomUUID()}.mp4`;
  try { const input: ChapterVideoInput = { audio: paths.audio, subtitles: needsSubtitles ? paths.subtitlesSrt : undefined, cover, sceneArtwork: sceneArtwork?.map(({ path, durationSeconds }) => ({ path, durationSeconds })), storyTitle: options.story.title, chapterLabel: `Chapter ${options.chapter}`, chapterTitle: chapter.translatedTitle ?? chapter.originalTitle, audioDurationSeconds: chapter.audio.durationSeconds }; const probe = await options.processor.render(input, staged, videoSettings); await rename(staged, paths.video); const outputFingerprint = await fileFingerprint(paths.video); if (!outputFingerprint) throw new VideoError("Video renderer produced an empty output"); chapter.video = { durationSeconds: probe.durationSeconds, codec: probe.videoCodec, width: probe.width, height: probe.height }; chapter.stages.video = { ...chapter.stages.video, status: "complete", outputFingerprint, completedAt: new Date().toISOString(), durationMs: Date.now() - started }; await persist(paths.chapterMeta, chapter); options.onEvent?.({ status: "completed", chapter: options.chapter, state: chapter.stages.video }); return { chapter, reused: false, cover: Boolean(cover), scenes: sceneArtwork?.length ?? 0, warnings, belowTargetResolution: belowTarget };
  } catch (error) { await rm(staged, { force: true }); chapter.stages.video = { ...chapter.stages.video, status: "failed", durationMs: Date.now() - started, error: { message: error instanceof Error ? error.message : String(error) } }; await persist(paths.chapterMeta, chapter); throw new VideoError(`Chapter ${options.chapter} video rendering failed: ${chapter.stages.video.error?.message}`, { cause: error }); }
}
export function videoFingerprint(audio: string | undefined, subtitles: string | undefined, background: string | undefined, settings: Story["video"], title?: string) { return fingerprint({ audio, subtitles, background, settings, title, version: "chapter-video-v2" }); }
async function findCover(root: string, slug: string) { for (const name of ["cover.jpg", "cover.jpeg", "cover.png"]) { const path = join(storyPaths(root, slug, 1).story, name); if (await exists(path)) return path; } return undefined; }
async function artworkBelowCanvas(sceneArtwork: Array<{ path: string }>, settings: VideoSettings) {
  for (const item of sceneArtwork) {
    const dimensions = imageDimensions(await readFile(item.path));
    if (dimensions && (dimensions.width < settings.width || dimensions.height < settings.height)) return true;
  }
  return false;
}
async function approvedSceneArtwork(root: string, slug: string, chapter: number, durationSeconds: number) {
  const raw = await readJsonIfExists<SceneManifest>(storyPaths(root, slug, chapter).scenesManifest);
  const parsed = raw ? sceneManifestSchema.safeParse(raw) : undefined;
  if (!parsed?.success || !parsed.data.scenes.length) return undefined;
  const enabled = enabledProductionScenes(parsed.data.scenes);
  if (!enabled.length) return undefined;
  const allApproved = enabled.every((scene) => scene.artwork.review === "approved");
  if (!allApproved) return undefined;
  const timeline = retimeScenesToDuration(enabled, durationSeconds);
  const result: Array<{ id: string; path: string; durationSeconds: number; fingerprint: string }> = [];
  for (const scene of timeline) {
    if (!scene.artwork.imageFingerprint) {
      throw new VideoError(`Approved artwork for Scene ${scene.id} is missing recorded fingerprint.`);
    }
    const inspected = await inspectSceneArtwork(root, slug, chapter, scene.id, scene.artwork.imageFingerprint);
    if (inspected.availability === "missing") {
      throw new VideoError(`Approved artwork for Scene ${scene.id} is missing.`);
    }
    if (inspected.availability === "invalid") {
      if (inspected.corrupt) {
        throw new VideoError(`Approved artwork for Scene ${scene.id} is corrupt.`);
      }
      if (!inspected.matchesRecordedFingerprint) {
        throw new VideoError(`Approved artwork for Scene ${scene.id} does not match its recorded fingerprint.`);
      }
      throw new VideoError(`Approved artwork for Scene ${scene.id} is corrupt.`);
    }
    result.push({ id: scene.id, path: inspected.imagePath, durationSeconds: scene.endSeconds - scene.startSeconds, fingerprint: scene.artwork.imageFingerprint });
  }
  if (Math.abs(result.reduce((sum, item) => sum + item.durationSeconds, 0) - durationSeconds) > 0.02) throw new VideoError("Enabled scene artwork timing does not cover the mastered Chapter duration");
  return result;
}
async function persist(path: string, chapter: Chapter) { chapter.updatedAt = new Date().toISOString(); await atomicWriteJson(path, chapterSchema.parse(chapter)); }
