import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Chapter, StageState, chapterSchema } from "../domain/chapter.js";
import { Story } from "../domain/story.js";
import { AudioError } from "../pipeline/errors.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { exists, readJsonIfExists } from "../storage/story-files.js";
import { inspectStageArtifact, stageFreshness, stalePrerequisiteWarning } from "../studio/artifact-state.js";
import { fingerprint } from "../utils/hash.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { AudioProbe, FfmpegTools } from "./ffmpeg.js";
import { AudioMasteringProcessor } from "./mastering.js";

export type AudioMasteringEvent = { status: "started" | "completed" | "reused"; chapter: number; state: StageState };
export async function masterStoredChapter(options: { root: string; story: Story; chapter: number; processor: AudioMasteringProcessor; force?: boolean; onEvent?: (event: AudioMasteringEvent) => void }) {
  const paths = storyPaths(options.root, options.story.slug, options.chapter); const raw = await readJsonIfExists<Chapter>(paths.chapterMeta);
  if (!raw) throw new AudioError(`Chapter ${options.chapter} has no pipeline metadata; run TTS first`);
  const chapter = chapterSchema.parse(raw);
  const hasRawOrSegments = (await exists(paths.audioRaw)) || (await exists(paths.segments));
  if (!hasRawOrSegments) {
    if (chapter.stages.tts.status !== "complete") throw new AudioError(`Chapter ${options.chapter} TTS is not complete`);
    throw new AudioError("Raw TTS audio is unavailable. Existing mastered audio can still be used by downstream stages, but Audio Mastering cannot be rerun without its original TTS input.");
  }
  const warnings: string[] = [];
  if (stageFreshness(chapter, "tts") === "stale") warnings.push(stalePrerequisiteWarning("tts"));
  const inputs = await masteringInputs(paths.segments, paths.audioRaw); const fp = audioMasteringFingerprint(chapter.stages.tts.outputFingerprint, options.story.audio, options.processor.version, await inputFingerprints(inputs));
  const currentOutput = await fileFingerprint(paths.audio);
  if (!options.force && chapter.stages.audioMastering.status === "complete" && chapter.stages.audioMastering.fingerprint === fp && currentOutput
    && chapter.stages.audioMastering.outputFingerprint === currentOutput && chapter.audio) {
    options.onEvent?.({ status: "reused", chapter: options.chapter, state: chapter.stages.audioMastering }); return { chapter, reused: true, probe: chapter.audio, warnings };
  }
  const started = Date.now(); chapter.audio = undefined; chapter.alignment = undefined; chapter.subtitle = undefined; chapter.video = undefined; chapter.scenes = undefined; chapter.stages.alignment = { status: "pending" }; chapter.stages.subtitles = { status: "pending" }; chapter.stages.scenePlanning = { status: "pending" }; chapter.stages.artwork = { status: "pending" }; chapter.stages.video = { status: "pending" }; chapter.stages.audioMastering = { status: "running", provider: "ffmpeg", model: options.processor.version, fingerprint: fp, startedAt: new Date().toISOString() };
  await persist(paths.chapterMeta, chapter); options.onEvent?.({ status: "started", chapter: options.chapter, state: chapter.stages.audioMastering });
  const staged = `${paths.audio}.stage-${randomUUID()}.mp3`;
  try {
    await mkdir(paths.chapterDir, { recursive: true }); const probe = await options.processor.master(inputs, staged, options.story.audio); await rename(staged, paths.audio);
    const outputFingerprint = await fileFingerprint(paths.audio); if (!outputFingerprint) throw new AudioError(`Mastering produced an empty output for Chapter ${options.chapter}`);
    chapter.audio = probe; chapter.stages.audioMastering = { ...chapter.stages.audioMastering, status: "complete", outputFingerprint,
      completedAt: new Date().toISOString(), durationMs: Date.now() - started };
    await persist(paths.chapterMeta, chapter); options.onEvent?.({ status: "completed", chapter: options.chapter, state: chapter.stages.audioMastering }); return { chapter, reused: false, probe, warnings };
  } catch (error) {
    await rm(staged, { force: true }); chapter.stages.audioMastering = { ...chapter.stages.audioMastering, status: "failed", durationMs: Date.now() - started,
      error: { message: error instanceof Error ? error.message : String(error) } }; await persist(paths.chapterMeta, chapter);
    throw new AudioError(`Chapter ${options.chapter} audio mastering failed: ${chapter.stages.audioMastering.error?.message}`, { cause: error });
  }
}

export function audioMasteringFingerprint(ttsOutputFingerprint: string | undefined, settings: Story["audio"], processorVersion: string, inputs: string[]) {
  return fingerprint({ ttsOutputFingerprint, settings, processorVersion, inputs });
}

export async function masteringInputs(segmentsDirectory: string, rawAudio: string) {
  let segments: string[] = [];
  try { segments = (await readdir(segmentsDirectory)).filter((name) => /^\d+\.mp3$/.test(name)).sort().map((name) => join(segmentsDirectory, name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (segments.length) return segments; if (await exists(rawAudio)) return [rawAudio]; throw new AudioError("TTS metadata is complete but raw audio and segments are missing");
}
export async function inputFingerprints(paths: string[]) { return Promise.all(paths.map(async (path) => { const value = await fileFingerprint(path); if (!value) throw new AudioError(`Mastering input is missing or empty: ${path}`); return value; })); }
async function persist(path: string, chapter: Chapter) { chapter.updatedAt = new Date().toISOString(); await atomicWriteJson(path, chapterSchema.parse(chapter)); }

export async function resolveMasteredAudio(root: string, story: string, chapterNumber: number, existingChapter?: Chapter): Promise<{ path: string; audio: AudioProbe }> {
  const paths = storyPaths(root, story, chapterNumber);
  const audioArtifact = await inspectStageArtifact(root, story, chapterNumber, "audioMastering");
  if (audioArtifact.availability === "missing") {
    throw new AudioError(`Chapter ${chapterNumber} mastered audio is missing (audio is not mastered)`);
  }
  if (audioArtifact.availability === "invalid") {
    throw new AudioError(`Chapter ${chapterNumber} mastered audio exists but could not be read as valid audio`);
  }
  if (existingChapter?.audio && existingChapter.audio.durationSeconds > 0) {
    return { path: paths.audio, audio: existingChapter.audio };
  }
  const meta = existingChapter ?? await readJsonIfExists<Chapter>(paths.chapterMeta);
  if (meta?.audio && meta.audio.durationSeconds > 0) {
    return { path: paths.audio, audio: meta.audio };
  }
  try {
    const probe = await new FfmpegTools().probe(paths.audio);
    if (probe && probe.durationSeconds > 0) {
      return { path: paths.audio, audio: probe };
    }
  } catch {
    // probe failed
  }
  throw new AudioError(`Chapter ${chapterNumber} audio is not mastered: duration metadata is unavailable`);
}

export class CopyingAudioProcessor implements AudioMasteringProcessor {
  readonly version = "test-copy-v1";
  async master(inputs: string[], output: string): Promise<AudioProbe> { await atomicWrite(output, await readFile(inputs[0]!)); return { durationSeconds: 1, codec: "mp3", container: "mp3" }; }
}

