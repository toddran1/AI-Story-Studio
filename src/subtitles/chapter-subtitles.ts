import { readFile } from "node:fs/promises";
import { Chapter, StageState, chapterSchema } from "../domain/chapter.js";
import { Story } from "../domain/story.js";
import { SubtitleError } from "../pipeline/errors.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { toSrt } from "./srt.js";
import { generateSubtitleTiming, SUBTITLE_GENERATOR_VERSION } from "./timing.js";
import { toVtt } from "./vtt.js";

export type SubtitleEvent = { status: "started" | "completed" | "reused"; chapter: number; state: StageState };
export async function generateStoredSubtitles(options: { root: string; story: Story; chapter: number; force?: boolean; onEvent?: (event: SubtitleEvent) => void }) {
  const paths = storyPaths(options.root, options.story.slug, options.chapter); const raw = await readJsonIfExists<Chapter>(paths.chapterMeta); if (!raw) throw new SubtitleError(`Chapter ${options.chapter} has no pipeline metadata`);
  const chapter = chapterSchema.parse(raw); if (chapter.stages.audioMastering.status !== "complete" || !chapter.audio) throw new SubtitleError(`Chapter ${options.chapter} audio is not mastered`);
  const narration = await readFile(paths.narration, "utf8").catch(() => { throw new SubtitleError(`Chapter ${options.chapter} narration is missing`); }); const masteredAudio = await readFile(paths.audio).catch(() => { throw new SubtitleError(`Chapter ${options.chapter} mastered audio is missing`); });
  const inputFingerprint = subtitleFingerprint(fingerprint(narration), fingerprint(masteredAudio.toString("base64")), options.story.subtitles);
  const outputFingerprint = await outputsFingerprint(paths.subtitlesSrt, paths.subtitlesVtt);
  if (!options.force && chapter.stages.subtitles.status === "complete" && chapter.stages.subtitles.fingerprint === inputFingerprint && chapter.stages.subtitles.outputFingerprint === outputFingerprint && chapter.subtitle) { options.onEvent?.({ status: "reused", chapter: options.chapter, state: chapter.stages.subtitles }); return { chapter, reused: true }; }
  const started = Date.now(); chapter.subtitle = undefined; chapter.video = undefined; chapter.stages.video = { status: "pending" }; chapter.stages.subtitles = { status: "running", provider: "local", model: SUBTITLE_GENERATOR_VERSION, fingerprint: inputFingerprint, startedAt: new Date().toISOString() }; await persist(paths.chapterMeta, chapter); options.onEvent?.({ status: "started", chapter: options.chapter, state: chapter.stages.subtitles });
  try { const document = generateSubtitleTiming(narration, chapter.audio.durationSeconds, options.story.subtitles); await atomicWrite(paths.subtitlesSrt, toSrt(document)); await atomicWrite(paths.subtitlesVtt, toVtt(document)); const produced = await outputsFingerprint(paths.subtitlesSrt, paths.subtitlesVtt); if (!produced) throw new SubtitleError("Subtitle generation produced empty files"); chapter.subtitle = { cueCount: document.cues.length, durationSeconds: document.durationSeconds }; chapter.stages.subtitles = { ...chapter.stages.subtitles, status: "complete", outputFingerprint: produced, completedAt: new Date().toISOString(), durationMs: Date.now() - started }; await persist(paths.chapterMeta, chapter); options.onEvent?.({ status: "completed", chapter: options.chapter, state: chapter.stages.subtitles }); return { chapter, reused: false };
  } catch (error) { chapter.stages.subtitles = { ...chapter.stages.subtitles, status: "failed", durationMs: Date.now() - started, error: { message: error instanceof Error ? error.message : String(error) } }; await persist(paths.chapterMeta, chapter); throw new SubtitleError(`Chapter ${options.chapter} subtitle generation failed: ${chapter.stages.subtitles.error?.message}`, { cause: error }); }
}
export function subtitleFingerprint(narration: string | undefined, masteredAudio: string | undefined, settings: Story["subtitles"]) { return fingerprint({ narration, masteredAudio, settings, version: SUBTITLE_GENERATOR_VERSION }); }
async function outputsFingerprint(...paths: string[]) { try { const data = await Promise.all(paths.map((path) => readFile(path))); return data.every((value) => value.length) ? fingerprint(data.map((value) => value.toString("base64"))) : undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
async function persist(path: string, chapter: Chapter) { chapter.updatedAt = new Date().toISOString(); await atomicWriteJson(path, chapterSchema.parse(chapter)); }
