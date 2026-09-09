import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Story } from "../domain/story.js";
import { Chapter, chapterSchema } from "../domain/chapter.js";
import { AudioError } from "../pipeline/errors.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { exportPaths, storyPaths } from "../storage/paths.js";
import { exists, readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { AudioSettings } from "./config.js";
import { AUDIO_PROCESSOR_VERSION, AudioProbe, FfmpegTools } from "./ffmpeg.js";

export type AudiobookFormat = "mp3" | "m4b";
export type AudiobookChapter = { chapter: number; title: string; path: string; durationSeconds: number; fingerprint: string };
export type AudiobookMetadata = { title: string; author?: string; chapters: Array<{ chapter: number; title: string; startMs: number; endMs: number }> };
export interface AudiobookProcessor { readonly version: string; assemble(chapters: AudiobookChapter[], output: string, format: AudiobookFormat, settings: AudioSettings, metadata: AudiobookMetadata, cover?: string): Promise<AudioProbe>; }

export const exportManifestSchema = z.object({
  version: z.literal(1), fingerprint: z.string(), story: z.string(), from: z.number().int().positive(), to: z.number().int().positive(), format: z.enum(["mp3", "m4b"]),
  createdAt: z.string(), output: z.string(), outputFingerprint: z.string(), durationSeconds: z.number().positive(), codec: z.string(), container: z.string(),
  chapters: z.array(z.object({ chapter: z.number().int().positive(), title: z.string(), durationSeconds: z.number().positive(), fingerprint: z.string() })),
});
export type AudiobookManifest = z.infer<typeof exportManifestSchema>;

export class FfmpegAudiobookProcessor implements AudiobookProcessor {
  readonly version = AUDIO_PROCESSOR_VERSION;
  constructor(private readonly tools = new FfmpegTools()) {}
  async assemble(chapters: AudiobookChapter[], output: string, format: AudiobookFormat, settings: AudioSettings, metadata: AudiobookMetadata, cover?: string) {
    await this.tools.validateAvailability(); const metadataPath = `${output}.ffmetadata`; await atomicWrite(metadataPath, buildFfmetadata(metadata));
    try {
      const args = buildAudiobookArgs(chapters, output, format, settings, metadataPath, cover); await this.tools.ffmpeg(args); const probe = await this.tools.probe(output);
      validateAudiobook(probe, format, expectedDuration(chapters, settings.chapterGapSeconds)); return probe;
    } finally { await rm(metadataPath, { force: true }); }
  }
}

export async function assembleAudiobook(options: { root: string; story: Story; from: number; to: number; format: AudiobookFormat; processor: AudiobookProcessor; force?: boolean; onProgress?: (event: { type: string; chapter?: number; index?: number; total?: number }) => void }) {
  const chapters = await selectExportChapters(options.root, options.story, options.from, options.to); const paths = exportPaths(options.root, options.story.slug, options.from, options.to, options.format);
  const fp = fingerprint({ story: options.story.slug, title: options.story.title, author: options.story.author, format: options.format, settings: options.story.audio,
    processor: options.processor.version, chapters: chapters.map((chapter) => ({ chapter: chapter.chapter, fingerprint: chapter.fingerprint, title: chapter.title })) });
  const cachedRaw = await readJsonIfExists(paths.manifest); const cached = cachedRaw ? exportManifestSchema.safeParse(cachedRaw) : undefined;
  if (!options.force && cached?.success && cached.data.fingerprint === fp && await fileFingerprint(paths.output) === cached.data.outputFingerprint) return { manifest: cached.data, reused: true };
  await mkdir(paths.directory, { recursive: true }); const staged = `${paths.output}.stage-${randomUUID()}.${options.format}`;
  options.onProgress?.({ type: "audiobook.started", total: chapters.length });
  try {
    const metadata = audiobookMetadata(options.story, chapters); const cover = await findCover(options.root, options.story.slug);
    const probe = await options.processor.assemble(chapters, staged, options.format, options.story.audio, metadata, cover); await rename(staged, paths.output);
    const outputFingerprint = await fileFingerprint(paths.output); if (!outputFingerprint) throw new AudioError("Audiobook assembly produced an empty output");
    const manifest = exportManifestSchema.parse({ version: 1, fingerprint: fp, story: options.story.slug, from: options.from, to: options.to, format: options.format,
      createdAt: new Date().toISOString(), output: paths.output, outputFingerprint, durationSeconds: probe.durationSeconds, codec: probe.codec, container: probe.container,
      chapters: chapters.map(({ chapter, title, durationSeconds, fingerprint }) => ({ chapter, title, durationSeconds, fingerprint })) });
    await atomicWriteJson(paths.manifest, manifest); options.onProgress?.({ type: "audiobook.completed", total: chapters.length }); return { manifest, reused: false };
  } catch (error) { await rm(staged, { force: true }); throw new AudioError(`Audiobook assembly failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}

export async function selectExportChapters(root: string, story: Story, from: number, to: number): Promise<AudiobookChapter[]> {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw new AudioError("Export range must contain positive chapter numbers with from <= to");
  const chaptersRoot = join(storyPaths(root, story.slug, 1).story, "chapters"); let chapterNumbers: number[];
  try { chapterNumbers = (await readdir(chaptersRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map((entry) => Number(entry.name)).filter((chapter) => chapter >= from && chapter <= to).sort((a, b) => a - b); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") chapterNumbers = []; else throw error; }
  if (!chapterNumbers.length) throw new AudioError(`No chapters were found in export range ${from}-${to}`);
  const chapters: AudiobookChapter[] = [];
  for (const chapter of chapterNumbers) {
    const paths = storyPaths(root, story.slug, chapter); const raw = await readJsonIfExists<Chapter>(paths.chapterMeta); if (!raw) throw new AudioError(`Chapter ${chapter} has not been processed`);
    const metadata = chapterSchema.parse(raw); const stage = metadata.stages.audioMastering;
    if (stage.status !== "complete" || !stage.outputFingerprint || !metadata.audio || !(await exists(paths.audio))) throw new AudioError(`Chapter ${chapter} is not mastered`);
    chapters.push({ chapter, title: metadata.translatedTitle ?? metadata.originalTitle ?? `Chapter ${chapter}`, path: paths.audio, durationSeconds: metadata.audio.durationSeconds, fingerprint: stage.outputFingerprint });
  }
  return chapters;
}

export function audiobookMetadata(story: Story, chapters: AudiobookChapter[]): AudiobookMetadata {
  let cursor = 0; const markers = chapters.map((chapter, index) => {
    const startMs = Math.round(cursor * 1000); cursor += chapter.durationSeconds; const endMs = Math.round(cursor * 1000);
    if (index < chapters.length - 1) cursor += story.audio.chapterGapSeconds;
    return { chapter: chapter.chapter, title: chapter.title, startMs, endMs };
  });
  return { title: story.title, author: story.author, chapters: markers };
}

export function buildFfmetadata(metadata: AudiobookMetadata) {
  const lines = [";FFMETADATA1", `title=${escapeMetadata(metadata.title)}`]; if (metadata.author) lines.push(`artist=${escapeMetadata(metadata.author)}`);
  for (const chapter of metadata.chapters) lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${chapter.startMs}`, `END=${chapter.endMs}`, `title=${escapeMetadata(chapter.title)}`);
  return `${lines.join("\n")}\n`;
}

export function buildAudiobookArgs(chapters: AudiobookChapter[], output: string, format: AudiobookFormat, settings: AudioSettings, metadataPath: string, cover?: string) {
  if (!chapters.length) throw new AudioError("Audiobook requires at least one mastered chapter"); const args: string[] = [];
  for (const chapter of chapters) args.push("-i", chapter.path); const metadataIndex = chapters.length; args.push("-f", "ffmetadata", "-i", metadataPath);
  const coverIndex = cover ? metadataIndex + 1 : undefined; if (cover) args.push("-i", cover);
  const filters: string[] = []; const labels: string[] = [];
  chapters.forEach((_, index) => { filters.push(`[${index}:a]aresample=${settings.sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo[c${index}]`); labels.push(`[c${index}]`);
    if (index < chapters.length - 1 && settings.chapterGapSeconds > 0) { filters.push(`anullsrc=r=${settings.sampleRate}:cl=stereo:d=${settings.chapterGapSeconds}[gap${index}]`); labels.push(`[gap${index}]`); } });
  filters.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[book]`); args.push("-filter_complex", filters.join(";"), "-map", "[book]", "-map_metadata", String(metadataIndex), "-map_chapters", String(metadataIndex));
  if (format === "m4b") {
    if (coverIndex !== undefined) args.push("-map", `${coverIndex}:v`, "-c:v", "copy", "-disposition:v", "attached_pic");
    args.push("-c:a", "aac", "-b:a", settings.bitrate, "-ar", String(settings.sampleRate), "-movflags", "+faststart", "-f", "mp4", output);
  } else args.push("-c:a", "libmp3lame", "-b:a", settings.bitrate, "-ar", String(settings.sampleRate), output);
  return args;
}

function validateAudiobook(probe: AudioProbe, format: AudiobookFormat, expected: number) {
  if (format === "mp3" && probe.codec !== "mp3") throw new AudioError(`Expected MP3 audiobook, received ${probe.codec}`);
  if (format === "m4b" && probe.codec !== "aac") throw new AudioError(`Expected AAC audio in M4B, received ${probe.codec}`);
  if (probe.durationSeconds < expected * 0.8 || probe.durationSeconds > expected * 1.2 + 2) throw new AudioError(`Audiobook duration ${probe.durationSeconds.toFixed(2)}s is implausible for ${expected.toFixed(2)}s of chapters`);
}
function expectedDuration(chapters: AudiobookChapter[], gap: number) { return chapters.reduce((sum, chapter) => sum + chapter.durationSeconds, 0) + gap * Math.max(0, chapters.length - 1); }
function escapeMetadata(value: string) { return value.replace(/([\\;#=])/g, "\\$1").replace(/\n/g, "\\n"); }
async function findCover(root: string, slug: string) { for (const name of ["cover.jpg", "cover.jpeg", "cover.png"]) { const path = join(storyPaths(root, slug, 1).story, name); if (await exists(path)) return path; } return undefined; }
async function fileFingerprint(path: string) { try { const data = await readFile(path); return data.length ? fingerprint(data.toString("base64")) : undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
