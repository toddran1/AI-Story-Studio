import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { summaryIdSchema, summarySchema } from "../summaries/types.js";
import { summaryPath } from "../summaries/service.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Story } from "../domain/story.js";
import { Chapter, chapterSchema } from "../domain/chapter.js";
import { VideoError } from "../pipeline/errors.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths, videoExportPaths } from "../storage/paths.js";
import { exists, readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { FfmpegVideoTools, VideoProbe, VIDEO_PROCESSOR_VERSION } from "./ffmpeg-video.js";
import { backgroundMusicFingerprint, backgroundMusicManifest, mixBackgroundMusicVideo } from "../audio/background-music.js";
import { resolveExportMusic } from "../music/resolver.js";
import { commitMusicExport } from "../music/commit.js";
import { exportMusicSelectionSchema, musicOverridesSchema, type ExportMusicSelection } from "../music/types.js";

export const videoSummarySelectionSchema = z.object({ beginning: z.array(summaryIdSchema).max(20).default([]), ending: z.array(summaryIdSchema).max(20).default([]) }).strict();
const summaryClipSchema = z.object({ id: summaryIdSchema, title: z.string(), placement: z.enum(["beginning", "ending"]), durationSeconds: z.number().positive(), fingerprint: z.string() });
export async function selectSummaryVideo(root: string, slug: string, id: string) {
  const parsed = summarySchema.safeParse(await readJsonIfExists(summaryPath(root, slug, id)));
  const summary = parsed.success ? parsed.data : undefined;
  const path = join(summaryPath(root, slug, id).slice(0, -5), "video.mp4");
  const actual = await fileFingerprint(path);
  if (!summary || summary.video?.status !== "current" || !summary.video.durationSeconds || !actual || actual !== summary.video.outputFingerprint) throw new VideoError(`Summary "${summary?.title ?? id}" needs a current video. Render it in Summaries before building this edition.`);
  return { id, title: summary.title, path, durationSeconds: summary.video.durationSeconds, fingerprint: actual };
}
export async function listSummaryVideos(root: string, slug: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new VideoError("Invalid story slug");
  const names = await readdir(join(root, "stories", slug, "summaries")).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const result: Array<{ id: string; title: string; durationSeconds: number }> = [];
  for (const name of names) {
    const id = name.replace(/\.json$/, ""); if (!name.endsWith(".json") || !summaryIdSchema.safeParse(id).success) continue;
    try { const clip = await selectSummaryVideo(root, slug, id); result.push({ id, title: clip.title, durationSeconds: clip.durationSeconds }); } catch (error) { if (!(error instanceof VideoError)) throw error; }
  }
  return result.sort((a, b) => a.title.localeCompare(b.title));
}
export type ExportVideoChapter = { chapter: number; title: string; path: string; durationSeconds: number; fingerprint: string };
export interface VideoExportProcessor { readonly version: string; assemble(chapters: ExportVideoChapter[], output: string, title: string): Promise<VideoProbe>; }
export const videoExportManifestSchema = z.object({ version: z.literal(1), fingerprint: z.string(), outputFingerprint: z.string(), story: z.string(), from: z.number().int().positive(), to: z.number().int().positive(), createdAt: z.string(), output: z.string(), durationSeconds: z.number().positive(), chapters: z.array(z.object({ chapter: z.number().int().positive(), title: z.string(), durationSeconds: z.number().positive(), fingerprint: z.string() })), summaries: z.array(summaryClipSchema).default([]), edition: z.string().regex(/^(?:bg|sum)-[a-f0-9]{12}$/).optional(), music: z.object({ mode: z.enum(["story_default", "track", "bed"]), trackId: z.string(), trackFingerprint: z.string(), title: z.string(), gainDb: z.number(), ducking: z.boolean(), duckingStrength: z.string(), fadeInSeconds: z.number(), fadeOutSeconds: z.number(), loopMode: z.string() }).optional() });
export class FfmpegVideoExportProcessor implements VideoExportProcessor {
  readonly version = `${VIDEO_PROCESSOR_VERSION}-summary-inserts-v1`;
  constructor(private readonly tools = new FfmpegVideoTools()) {}
  async assemble(chapters: ExportVideoChapter[], output: string, title: string) {
    await this.tools.validateAvailability();
    const metadataPath = `${output}.ffmetadata`, concatPath = `${output}.ffconcat`;
    const temporary: string[] = [metadataPath, concatPath];
    try {
      let clips = chapters;
      // Normalize insert editions so clips with different render settings concatenate reliably.
      if (chapters.some((clip) => clip.chapter === 0)) {
        const base = await this.tools.probe(chapters.find((clip) => clip.chapter > 0)!.path);
        clips = [];
        for (const [index, clip] of chapters.entries()) {
          const path = `${output}.clip-${index}.mp4`; temporary.push(path);
          await this.tools.ffmpeg(["-i", clip.path, "-map", "0:v:0", "-map", "0:a:0", "-vf", `scale=${base.width}:${base.height}:force_original_aspect_ratio=decrease,pad=${base.width}:${base.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`, "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "192k", path]);
          const probe = await this.tools.probe(path); clips.push({ ...clip, path, durationSeconds: probe.durationSeconds });
        }
      }
      await atomicWrite(metadataPath, buildVideoMetadata(clips, title));
      await atomicWrite(concatPath, buildVideoConcatManifest(clips));
      await this.tools.ffmpeg(buildVideoExportArgs(concatPath, output, metadataPath));
      return await this.tools.probe(output);
    } finally { await Promise.all(temporary.map((path) => rm(path, { force: true }))); }
  }
}

export async function assembleVideoExport(options: { root: string; story: Story; from: number; to: number; processor: VideoExportProcessor; force?: boolean; summaries?: z.input<typeof videoSummarySelectionSchema>; music?: ExportMusicSelection; musicOverrides?: unknown; onProgress?: (event: { type: string; total: number }) => void }): Promise<{ manifest: z.infer<typeof videoExportManifestSchema>; reused: boolean }> {
  const summarySelection = videoSummarySelectionSchema.parse(options.summaries ?? {});
  const selection = exportMusicSelectionSchema.parse(options.music ?? { mode: "none" });
  if (selection.mode !== "none") {
    const music = await resolveExportMusic(options.root, options.story, selection, musicOverridesSchema.parse(options.musicOverrides ?? {}));
    if (!music) throw new VideoError("Background music could not be resolved");
    if (music.loopMode === "restart_chapter" && options.from !== options.to) throw new VideoError("Restarting background music at each chapter is not available yet. Choose continuous playback for this export.");
    const clean = await assembleVideoExport({ ...options, force: false, music: { mode: "none" }, musicOverrides: undefined });
    const mixKey = fingerprint({ clean: clean.manifest.outputFingerprint, music: backgroundMusicFingerprint(music), format: "mp4" });
    const edition = `bg-${mixKey.slice(0, 12)}`; const paths = videoExportPaths(options.root, options.story.slug, options.from, options.to, edition);
    const cachedRaw = await readJsonIfExists(paths.manifest).catch(() => undefined); const cached = cachedRaw ? videoExportManifestSchema.safeParse(cachedRaw) : undefined;
    if (!options.force && cached?.success && cached.data.fingerprint === mixKey && await fileFingerprint(paths.output) === cached.data.outputFingerprint) return { manifest: cached.data, reused: true };
    await mkdir(paths.directory, { recursive: true }); const staged = `${paths.output}.stage-${randomUUID()}.mp4`;
    try { const probe = await mixBackgroundMusicVideo(clean.manifest.output, staged, music); const outputFingerprint = await fileFingerprint(staged); if (!outputFingerprint) throw new VideoError("Music video export is empty"); const manifest = videoExportManifestSchema.parse({ ...clean.manifest, edition, music: backgroundMusicManifest(music), fingerprint: mixKey, output: paths.output, outputFingerprint, durationSeconds: probe.durationSeconds, createdAt: new Date().toISOString() }); await commitMusicExport(staged, paths.output, paths.manifest, manifest); return { manifest, reused: false }; }
    catch (error) { await rm(staged, { force: true }); throw new VideoError(`Background music video export failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  }
  const chapters = await selectVideoChapters(options.root, options.story, options.from, options.to);
  const summaries: z.infer<typeof summaryClipSchema>[] = []; const beginning: ExportVideoChapter[] = [], ending: ExportVideoChapter[] = [];
  for (const placement of ["beginning", "ending"] as const) for (const id of summarySelection[placement]) {
    const clip = await selectSummaryVideo(options.root, options.story.slug, id); const { path, ...record } = clip;
    summaries.push({ ...record, placement }); (placement === "beginning" ? beginning : ending).push({ ...clip, chapter: 0 });
  }
  const segments = [...beginning, ...chapters, ...ending];
  const edition = summaries.length ? `sum-${fingerprint(summaries.map(({ id, placement }) => ({ id, placement }))).slice(0, 12)}` : undefined;
  const paths = videoExportPaths(options.root, options.story.slug, options.from, options.to, edition); const inputFingerprint = fingerprint({ story: options.story.slug, title: options.story.title, processor: options.processor.version, summaries, chapters: chapters.map(({ chapter, title, fingerprint }) => ({ chapter, title, fingerprint })) }); const cachedRaw = await readJsonIfExists(paths.manifest); const cached = cachedRaw ? videoExportManifestSchema.safeParse(cachedRaw) : undefined;
  if (!options.force && cached?.success && cached.data.fingerprint === inputFingerprint && await fileFingerprint(paths.output) === cached.data.outputFingerprint) return { manifest: cached.data, reused: true };
  await mkdir(paths.directory, { recursive: true }); const staged = `${paths.output}.stage-${randomUUID()}.mp4`; options.onProgress?.({ type: "videoExport.started", total: chapters.length });
  try { const probe = await options.processor.assemble(segments, staged, options.story.title); const expected = segments.reduce((sum, chapter) => sum + chapter.durationSeconds, 0); if (probe.videoCodec !== "h264" || probe.audioCodec !== "aac" || !probe.container.toLowerCase().includes("mp4") || probe.durationSeconds < expected * .9 || probe.durationSeconds > expected * 1.1 + 1) throw new VideoError("Combined video failed H.264/AAC MP4 stream or duration validation"); await rename(staged, paths.output); const outputFingerprint = await fileFingerprint(paths.output); if (!outputFingerprint) throw new VideoError("Combined video output is empty"); const manifest = videoExportManifestSchema.parse({ version: 1, fingerprint: inputFingerprint, outputFingerprint, story: options.story.slug, from: options.from, to: options.to, createdAt: new Date().toISOString(), output: paths.output, durationSeconds: probe.durationSeconds, chapters, summaries, edition }); await atomicWriteJson(paths.manifest, manifest); options.onProgress?.({ type: "videoExport.completed", total: chapters.length }); return { manifest, reused: false }; } catch (error) { await rm(staged, { force: true }); throw new VideoError(`Combined video export failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}
export async function selectVideoChapters(root: string, story: Story, from: number, to: number) { if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw new VideoError("Video export range must satisfy from <= to"); const chaptersRoot = `${storyPaths(root, story.slug, 1).story}/chapters`; let numbers: number[] = []; try { numbers = (await readdir(chaptersRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map((entry) => Number(entry.name)).filter((chapter) => chapter >= from && chapter <= to).sort((a, b) => a - b); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } if (!numbers.length) throw new VideoError(`No chapters found in range ${from}-${to}`); const result: ExportVideoChapter[] = []; for (const chapter of numbers) { const paths = storyPaths(root, story.slug, chapter); const raw = await readJsonIfExists<Chapter>(paths.chapterMeta); const metadata = raw ? chapterSchema.parse(raw) : undefined; const actualFingerprint = await fileFingerprint(paths.video); if (!metadata || !actualFingerprint || !metadata.video) throw new VideoError(`Chapter ${chapter} has no retained video to export`); result.push({ chapter, title: metadata.translatedTitle ?? metadata.originalTitle ?? `Chapter ${chapter}`, path: paths.video, durationSeconds: metadata.video.durationSeconds, fingerprint: actualFingerprint }); } return result; }
export function buildVideoExportArgs(concatPath: string, output: string, metadata: string) { return ["-f", "concat", "-safe", "0", "-i", concatPath, "-f", "ffmetadata", "-i", metadata, "-map", "0:v", "-map", "0:a", "-map_metadata", "1", "-map_chapters", "1", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output]; }
export function buildVideoConcatManifest(chapters: ExportVideoChapter[]) { if (!chapters.length) throw new VideoError("Video export requires at least one chapter"); return `ffconcat version 1.0\n${chapters.map((chapter) => `file '${chapter.path.replaceAll("'", "'\\''")}'`).join("\n")}\n`; }
function buildVideoMetadata(chapters: ExportVideoChapter[], title: string) { let cursor = 0; const lines = [";FFMETADATA1", `title=${escapeMeta(title)}`]; for (const chapter of chapters) { const start = Math.round(cursor * 1000); cursor += chapter.durationSeconds; lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${start}`, `END=${Math.round(cursor * 1000)}`, `title=${escapeMeta(chapter.title)}`); } return `${lines.join("\n")}\n`; }
function escapeMeta(value: string) { return value.replace(/([\\;#=])/g, "\\$1").replace(/\n/g, "\\n"); }
