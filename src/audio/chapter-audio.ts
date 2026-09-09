import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Chapter, StageState, chapterSchema } from "../domain/chapter.js";
import { Story } from "../domain/story.js";
import { AudioError } from "../pipeline/errors.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { exists, readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { AudioProbe } from "./ffmpeg.js";
import { AudioMasteringProcessor } from "./mastering.js";

export type AudioMasteringEvent = { status: "started" | "completed" | "reused"; chapter: number; state: StageState };

export async function masterStoredChapter(options: { root: string; story: Story; chapter: number; processor: AudioMasteringProcessor; force?: boolean; onEvent?: (event: AudioMasteringEvent) => void }) {
  const paths = storyPaths(options.root, options.story.slug, options.chapter); const raw = await readJsonIfExists<Chapter>(paths.chapterMeta);
  if (!raw) throw new AudioError(`Chapter ${options.chapter} has no pipeline metadata; run TTS first`);
  const chapter = chapterSchema.parse(raw); if (chapter.stages.tts.status !== "complete") throw new AudioError(`Chapter ${options.chapter} TTS is not complete`);
  if (!(await exists(paths.audioRaw)) && await exists(paths.audio) && chapter.stages.audioMastering.status !== "complete") await atomicWrite(paths.audioRaw, await readFile(paths.audio));
  const inputs = await masteringInputs(paths.segments, paths.audioRaw); const fp = audioMasteringFingerprint(chapter.stages.tts.outputFingerprint, options.story.audio, options.processor.version, await inputFingerprints(inputs));
  const currentOutput = await fileFingerprint(paths.audio);
  if (!options.force && chapter.stages.audioMastering.status === "complete" && chapter.stages.audioMastering.fingerprint === fp && currentOutput
    && chapter.stages.audioMastering.outputFingerprint === currentOutput && chapter.audio) {
    options.onEvent?.({ status: "reused", chapter: options.chapter, state: chapter.stages.audioMastering }); return { chapter, reused: true, probe: chapter.audio };
  }
  const started = Date.now(); chapter.audio = undefined; chapter.subtitle = undefined; chapter.video = undefined; chapter.stages.subtitles = { status: "pending" }; chapter.stages.video = { status: "pending" }; chapter.stages.audioMastering = { status: "running", provider: "ffmpeg", model: options.processor.version, fingerprint: fp, startedAt: new Date().toISOString() };
  await persist(paths.chapterMeta, chapter); options.onEvent?.({ status: "started", chapter: options.chapter, state: chapter.stages.audioMastering });
  const staged = `${paths.audio}.stage-${randomUUID()}.mp3`;
  try {
    await mkdir(paths.chapterDir, { recursive: true }); const probe = await options.processor.master(inputs, staged, options.story.audio); await rename(staged, paths.audio);
    const outputFingerprint = await fileFingerprint(paths.audio); if (!outputFingerprint) throw new AudioError(`Mastering produced an empty output for Chapter ${options.chapter}`);
    chapter.audio = probe; chapter.stages.audioMastering = { ...chapter.stages.audioMastering, status: "complete", outputFingerprint,
      completedAt: new Date().toISOString(), durationMs: Date.now() - started };
    await persist(paths.chapterMeta, chapter); options.onEvent?.({ status: "completed", chapter: options.chapter, state: chapter.stages.audioMastering }); return { chapter, reused: false, probe };
  } catch (error) {
    await rm(staged, { force: true }); chapter.stages.audioMastering = { ...chapter.stages.audioMastering, status: "failed", durationMs: Date.now() - started,
      error: { message: error instanceof Error ? error.message : String(error) } }; await persist(paths.chapterMeta, chapter);
    throw new AudioError(`Chapter ${options.chapter} audio mastering failed: ${chapter.stages.audioMastering.error?.message}`, { cause: error });
  }
}

export function audioMasteringFingerprint(ttsOutputFingerprint: string | undefined, settings: Story["audio"], processorVersion: string, inputs: string[]) {
  return fingerprint({ ttsOutputFingerprint, settings, processorVersion, inputs });
}

async function masteringInputs(segmentsDirectory: string, rawAudio: string) {
  let segments: string[] = [];
  try { segments = (await readdir(segmentsDirectory)).filter((name) => /^\d+\.mp3$/.test(name)).sort().map((name) => join(segmentsDirectory, name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (segments.length) return segments; if (await exists(rawAudio)) return [rawAudio]; throw new AudioError("TTS metadata is complete but raw audio and segments are missing");
}
async function inputFingerprints(paths: string[]) { return Promise.all(paths.map(async (path) => fingerprint((await readFile(path)).toString("base64")))); }
async function fileFingerprint(path: string) { try { const data = await readFile(path); return data.length ? fingerprint(data.toString("base64")) : undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
async function persist(path: string, chapter: Chapter) { chapter.updatedAt = new Date().toISOString(); await atomicWriteJson(path, chapterSchema.parse(chapter)); }

export class CopyingAudioProcessor implements AudioMasteringProcessor {
  readonly version = "test-copy-v1";
  async master(inputs: string[], output: string): Promise<AudioProbe> { await atomicWrite(output, await readFile(inputs[0]!)); return { durationSeconds: 1, codec: "mp3", container: "mp3" }; }
}
