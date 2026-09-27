import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { FfmpegTools } from "../audio/ffmpeg.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { musicLibrarySchema, musicTrackSchema, musicTrackIdSchema, type MusicTrack } from "./types.js";

let libraryMutation = Promise.resolve();
function withLibraryMutation<T>(action: () => Promise<T>): Promise<T> {
  const current = libraryMutation.then(action);
  libraryMutation = current.then(() => undefined, () => undefined);
  return current;
}

const supportedExtensions = new Set([".mp3", ".wav", ".m4a", ".flac", ".ogg"]);
export function musicLibraryPaths(root: string) { const directory = join(root, "music-library"); return { directory, manifest: join(directory, "music-library.json"), tracks: join(directory, "tracks") }; }
export function musicTrackPath(root: string, track: MusicTrack) { musicTrackSchema.parse(track); return join(musicLibraryPaths(root).tracks, track.filename); }
export async function listMusicTracks(root: string) { const raw = await readJsonIfExists(musicLibraryPaths(root).manifest); return musicLibrarySchema.parse(raw ?? { version: 1, tracks: [] }).tracks; }
export async function getMusicTrack(root: string, id: string) { musicTrackIdSchema.parse(id); return (await listMusicTracks(root)).find((item) => item.id === id); }
export const musicMetadataPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(), source: z.string().max(500).optional(), sourceUrl: z.string().url().optional(),
  license: z.string().max(500).optional(), attribution: z.string().max(1000).optional(), commercialUse: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
}).strict();
export function importMusicTrack(root: string, sourcePath: string, originalFilename: string, rawMetadata: unknown = {}, tools = new FfmpegTools()) {
  return withLibraryMutation(() => importMusicTrackUnlocked(root, sourcePath, originalFilename, rawMetadata, tools));
}
async function importMusicTrackUnlocked(root: string, sourcePath: string, originalFilename: string, rawMetadata: unknown, tools: FfmpegTools) {
  const metadata = musicMetadataPatchSchema.parse(rawMetadata); const safeOriginalName = basename(originalFilename.replaceAll("\\", "/")); const extension = extname(safeOriginalName).toLowerCase();
  if (!supportedExtensions.has(extension)) throw new Error("Unsupported music format. Use MP3, WAV, M4A, FLAC, or OGG.");
  const id = `mus_${randomBytes(12).toString("hex")}`; const filename = `${id}${extension}`; const paths = musicLibraryPaths(root);
  await mkdir(paths.tracks, { recursive: true }); const staged = join(paths.tracks, `${id}.stage${extension}`); const destination = join(paths.tracks, filename);
  try {
    await copyFile(sourcePath, staged); const probe = await tools.probe(staged); if (!(probe.durationSeconds > 0)) throw new Error("Music file has no valid audio stream");
    const fp = await fileFingerprint(staged); if (!fp) throw new Error("Music file is empty");
    const now = new Date().toISOString(); const track = musicTrackSchema.parse({ id, filename, title: metadata.title ?? basename(safeOriginalName, extension).slice(0, 200),
      durationSeconds: probe.durationSeconds, fingerprint: fp, tags: [], ...metadata, createdAt: now, updatedAt: now });
    const tracks = await listMusicTracks(root); await rename(staged, destination); await atomicWriteJson(paths.manifest, { version: 1, tracks: [...tracks, track] }); return track;
  } catch (error) { await Promise.all([rm(staged, { force: true }), rm(destination, { force: true })]); throw error; }
}
export function updateMusicTrack(root: string, id: string, raw: unknown) { return withLibraryMutation(() => updateMusicTrackUnlocked(root, id, raw)); }
async function updateMusicTrackUnlocked(root: string, id: string, raw: unknown) { musicTrackIdSchema.parse(id); const patch = musicMetadataPatchSchema.parse(raw); const paths = musicLibraryPaths(root); const tracks = await listMusicTracks(root); const index = tracks.findIndex((item) => item.id === id); if (index < 0) throw new Error("Music track not found"); const updated = musicTrackSchema.parse({ ...tracks[index], ...patch, updatedAt: new Date().toISOString() }); tracks[index] = updated; await atomicWriteJson(paths.manifest, { version: 1, tracks }); return updated; }
export function deleteMusicTrack(root: string, id: string) { return withLibraryMutation(() => deleteMusicTrackUnlocked(root, id)); }
async function deleteMusicTrackUnlocked(root: string, id: string) { musicTrackIdSchema.parse(id); const paths = musicLibraryPaths(root); const tracks = await listMusicTracks(root); const track = tracks.find((item) => item.id === id); if (!track) throw new Error("Music track not found"); await atomicWriteJson(paths.manifest, { version: 1, tracks: tracks.filter((item) => item.id !== id) }); await rm(musicTrackPath(root, track), { force: true }); return { deleted: id }; }
