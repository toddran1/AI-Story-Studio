import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Story } from "../domain/story.js";
import { FfmpegTools } from "../audio/ffmpeg.js";
import { backgroundMusicFingerprint, mixBackgroundMusicAudio } from "../audio/background-music.js";
import { storyPaths } from "../storage/paths.js";
import { exists } from "../storage/story-files.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { fingerprint } from "../utils/hash.js";
import { resolveExportMusic } from "./resolver.js";
import type { ExportMusicSelection } from "./types.js";

export async function buildMusicMixPreview(root: string, story: Story, chapter: number, selection: ExportMusicSelection, overrides: unknown, position: "beginning" | "middle" = "middle", tools = new FfmpegTools()) {
  const source = storyPaths(root, story.slug, chapter).audio; const sourceFp = await fileFingerprint(source); if (!sourceFp) throw new Error("Clean chapter narration is missing"); const music = await resolveExportMusic(root, story, selection, overrides, tools); if (!music) throw new Error("Choose music for preview");
  const probe = await tools.probe(source); const duration = Math.min(30, probe.durationSeconds); const start = position === "middle" ? Math.max(0, (probe.durationSeconds - duration) / 2) : 0;
  const key = fingerprint({ sourceFp, music: backgroundMusicFingerprint(music), start, duration, version: 1 }); const dir = join(root, "music-previews"); const output = join(dir, `${key}.mp3`); if (await exists(output)) return output;
  await mkdir(dir, { recursive: true }); const clip = join(dir, `.clip-${randomUUID()}.mp3`); const mixed = join(dir, `.mixed-${randomUUID()}.mp3`);
  try { await tools.ffmpeg(["-ss", String(start), "-i", source, "-t", String(duration), "-c:a", "libmp3lame", "-b:a", "192k", clip]); await mixBackgroundMusicAudio(clip, mixed, "mp3", music, tools); await rename(mixed, output); return output; }
  finally { await rm(clip, { force: true }); await rm(mixed, { force: true }); }
}
