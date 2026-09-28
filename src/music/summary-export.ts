import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Story } from "../domain/story.js";
import { mixBackgroundMusicAudio, mixBackgroundMusicVideo, backgroundMusicFingerprint, backgroundMusicManifest } from "../audio/background-music.js";
import { commitMusicExport } from "./commit.js";
import { summaryMediaPaths } from "../summaries/media.js";
import { summaryPath } from "../summaries/service.js";
import { summaryIdSchema, summarySchema } from "../summaries/types.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { fingerprint } from "../utils/hash.js";
import { resolveExportMusic } from "./resolver.js";
import { exportMusicSelectionSchema, musicOverridesSchema, type ExportMusicSelection } from "./types.js";

export const summaryMusicExportManifestSchema = z.object({
  version: z.literal(1), story: z.string(), summaryId: summaryIdSchema, kind: z.enum(["audio", "video"]),
  edition: z.string().regex(/^bg-[a-f0-9]{12}$/), fingerprint: z.string(), sourceFingerprint: z.string(), outputFingerprint: z.string(),
  output: z.string(), durationSeconds: z.number().positive(), createdAt: z.string(), music: z.object({ mode: z.enum(["story_default", "track", "bed"]), trackId: z.string(), trackFingerprint: z.string(), title: z.string(), gainDb: z.number(), ducking: z.boolean(), duckingStrength: z.string(), fadeInSeconds: z.number(), fadeOutSeconds: z.number(), loopMode: z.string() }),
});

export function summaryMusicExportPath(root: string, slug: string, summaryId: string, kind: "audio" | "video", edition: string) {
  if (!/^bg-[a-f0-9]{12}$/.test(edition) || !summaryIdSchema.safeParse(summaryId).success) throw new Error("Invalid summary music export path");
  const directory = join(summaryMediaPaths(root, slug, summaryId).directory, "exports");
  const extension = kind === "audio" ? "mp3" : "mp4";
  const output = join(directory, `${slug}-${summaryId}-${kind}-${edition}.${extension}`);
  return { directory, output, manifest: `${output}.json` };
}

export async function exportSummaryWithMusic(options: { root: string; story: Story; summaryId: string; kind: "audio" | "video"; music: ExportMusicSelection; musicOverrides?: unknown; force?: boolean }) {
  const selection = exportMusicSelectionSchema.parse(options.music);
  const summary = summarySchema.parse(await readJsonIfExists(summaryPath(options.root, options.story.slug, options.summaryId)));
  const source = options.kind === "audio" ? summaryMediaPaths(options.root, options.story.slug, options.summaryId).audio : join(summaryMediaPaths(options.root, options.story.slug, options.summaryId).directory, "video.mp4");
  const sourceFingerprint = await fileFingerprint(source);
  if (!sourceFingerprint || sourceFingerprint !== summary[options.kind]?.outputFingerprint) throw new Error(`Summary ${options.kind} is missing or damaged; generate it first`);
  if (selection.mode === "none") return { output: source, edition: undefined, reused: true };
  const music = await resolveExportMusic(options.root, options.story, selection, musicOverridesSchema.parse(options.musicOverrides ?? {}));
  if (!music) throw new Error("Background music could not be resolved");
  const key = fingerprint({ sourceFingerprint, music: backgroundMusicFingerprint(music), kind: options.kind });
  const edition = `bg-${key.slice(0, 12)}`;
  const paths = summaryMusicExportPath(options.root, options.story.slug, options.summaryId, options.kind, edition);
  const raw = await readJsonIfExists(paths.manifest).catch(() => undefined);
  const cached = raw ? summaryMusicExportManifestSchema.safeParse(raw) : undefined;
  if (!options.force && cached?.success && cached.data.fingerprint === key && await fileFingerprint(paths.output) === cached.data.outputFingerprint) return { manifest: cached.data, output: paths.output, edition, reused: true };
  await mkdir(paths.directory, { recursive: true });
  const staged = `${paths.output}.stage-${randomUUID()}.${options.kind === "audio" ? "mp3" : "mp4"}`;
  try {
    const probe = options.kind === "audio" ? await mixBackgroundMusicAudio(source, staged, "mp3", music) : await mixBackgroundMusicVideo(source, staged, music);
    const outputFingerprint = await fileFingerprint(staged);
    if (!outputFingerprint) throw new Error("Music export is empty");
    const manifest = summaryMusicExportManifestSchema.parse({ version: 1, story: options.story.slug, summaryId: options.summaryId, kind: options.kind, edition,
      fingerprint: key, sourceFingerprint, outputFingerprint, output: paths.output, durationSeconds: probe.durationSeconds, createdAt: new Date().toISOString(), music: backgroundMusicManifest(music) });
    await commitMusicExport(staged, paths.output, paths.manifest, manifest);
    return { manifest, output: paths.output, edition, reused: false };
  } catch (error) { await rm(staged, { force: true }); throw error; }
}

export async function listSummaryMusicExports(root: string, slug: string, summaryId: string) {
  const dir = join(summaryMediaPaths(root, slug, summaryId).directory, "exports");
  let files: string[];
  try { files = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const editions = [];
  for (const name of files.filter((name) => /-bg-[a-f0-9]{12}\.(mp3|mp4)\.json$/.test(name))) {
    const parsed = summaryMusicExportManifestSchema.safeParse(await readJsonIfExists(join(dir, name)).catch(() => undefined));
    if (!parsed.success || parsed.data.story !== slug || parsed.data.summaryId !== summaryId) continue;
    const manifest = parsed.data;
    const paths = summaryMusicExportPath(root, slug, summaryId, manifest.kind, manifest.edition);
    if (await fileFingerprint(paths.output) !== manifest.outputFingerprint) continue;
    editions.push({ kind: manifest.kind, edition: manifest.edition, createdAt: manifest.createdAt, musicTitle: manifest.music.title, url: `/api/stories/${slug}/summaries/${summaryId}/${manifest.kind}-exports/${manifest.edition}.${manifest.kind === "audio" ? "mp3" : "mp4"}` });
  }
  return editions.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
