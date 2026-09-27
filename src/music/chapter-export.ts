import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Story } from "../domain/story.js";
import { mixBackgroundMusicAudio, mixBackgroundMusicVideo, backgroundMusicFingerprint, backgroundMusicManifest } from "../audio/background-music.js";
import { commitMusicExport } from "./commit.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { fingerprint } from "../utils/hash.js";
import { resolveExportMusic } from "./resolver.js";
import { exportMusicSelectionSchema, musicOverridesSchema, type ExportMusicSelection } from "./types.js";

export const chapterMusicExportManifestSchema = z.object({
  version: z.literal(1), story: z.string(), chapter: z.number().int().positive(), kind: z.enum(["audio", "video"]),
  edition: z.string().regex(/^bg-[a-f0-9]{12}$/), fingerprint: z.string(), sourceFingerprint: z.string(), outputFingerprint: z.string(),
  output: z.string(), durationSeconds: z.number().positive(), createdAt: z.string(), music: z.object({ mode: z.enum(["story_default", "track"]), trackId: z.string(), trackFingerprint: z.string(), title: z.string(), gainDb: z.number(), ducking: z.boolean(), duckingStrength: z.string(), fadeInSeconds: z.number(), fadeOutSeconds: z.number(), loopMode: z.string() }),
});

export function chapterMusicExportPath(root: string, slug: string, chapter: number, kind: "audio" | "video", edition: string) {
  if (!/^bg-[a-f0-9]{12}$/.test(edition) || !Number.isInteger(chapter) || chapter < 1) throw new Error("Invalid chapter music export path");
  const directory = join(storyPaths(root, slug, chapter).story, "exports");
  const extension = kind === "audio" ? "mp3" : "mp4";
  const output = join(directory, `${slug}-${String(chapter).padStart(3, "0")}-${kind}-${edition}.${extension}`);
  return { directory, output, manifest: `${output}.json` };
}

export async function exportChapterWithMusic(options: { root: string; story: Story; chapter: number; kind: "audio" | "video"; music: ExportMusicSelection; musicOverrides?: unknown; force?: boolean }) {
  const selection = exportMusicSelectionSchema.parse(options.music);
  const source = storyPaths(options.root, options.story.slug, options.chapter)[options.kind === "audio" ? "audio" : "video"];
  const sourceFingerprint = await fileFingerprint(source);
  if (!sourceFingerprint) throw new Error(`Chapter ${options.chapter} has no retained ${options.kind} master`);
  if (selection.mode === "none") return { output: source, edition: undefined, reused: true };
  const music = await resolveExportMusic(options.root, options.story, selection, musicOverridesSchema.parse(options.musicOverrides ?? {}));
  if (!music) throw new Error("Background music could not be resolved");
  const key = fingerprint({ sourceFingerprint, music: backgroundMusicFingerprint(music), kind: options.kind });
  const edition = `bg-${key.slice(0, 12)}`;
  const paths = chapterMusicExportPath(options.root, options.story.slug, options.chapter, options.kind, edition);
  const raw = await readJsonIfExists(paths.manifest).catch(() => undefined);
  const cached = raw ? chapterMusicExportManifestSchema.safeParse(raw) : undefined;
  if (!options.force && cached?.success && cached.data.fingerprint === key && await fileFingerprint(paths.output) === cached.data.outputFingerprint) return { manifest: cached.data, output: paths.output, edition, reused: true };
  await mkdir(paths.directory, { recursive: true });
  const staged = `${paths.output}.stage-${randomUUID()}.${options.kind === "audio" ? "mp3" : "mp4"}`;
  try {
    const probe = options.kind === "audio" ? await mixBackgroundMusicAudio(source, staged, "mp3", music) : await mixBackgroundMusicVideo(source, staged, music);
    const outputFingerprint = await fileFingerprint(staged);
    if (!outputFingerprint) throw new Error("Music export is empty");
    const manifest = chapterMusicExportManifestSchema.parse({ version: 1, story: options.story.slug, chapter: options.chapter, kind: options.kind, edition,
      fingerprint: key, sourceFingerprint, outputFingerprint, output: paths.output, durationSeconds: probe.durationSeconds, createdAt: new Date().toISOString(), music: backgroundMusicManifest(music) });
    await commitMusicExport(staged, paths.output, paths.manifest, manifest);
    return { manifest, output: paths.output, edition, reused: false };
  } catch (error) { await rm(staged, { force: true }); throw error; }
}
