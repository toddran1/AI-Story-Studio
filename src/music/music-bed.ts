import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { getMusicTrack } from "./library.js";
import { storiesUsingMusic } from "./default-usage.js";
import { musicTrackIdSchema } from "./types.js";

export const musicBedIdSchema = z.string().regex(/^bed_[a-f0-9]{24}$/);
export const musicBedSchema = z.object({ id: musicBedIdSchema, name: z.string().trim().min(1).max(200), tracks: z.array(z.object({ trackId: musicTrackIdSchema, weight: z.number().positive().optional() })).min(1).max(30), playbackMode: z.enum(["sequential", "shuffle"]).default("sequential"), crossfadeSeconds: z.number().min(0).max(10).default(3), revision: z.string(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export type MusicBed = z.infer<typeof musicBedSchema>;
export const musicBedInputSchema = musicBedSchema.pick({ name: true, tracks: true, playbackMode: true, crossfadeSeconds: true });
function manifest(root: string) { return join(root, "music-library", "music-beds.json"); }
export async function listMusicBeds(root: string): Promise<MusicBed[]> { const raw = await readJsonIfExists(manifest(root)); return z.object({ version: z.literal(1), beds: z.array(musicBedSchema) }).parse(raw ?? { version: 1, beds: [] }).beds; }
let mutation = Promise.resolve();
function serialized<T>(task: () => Promise<T>) { const result = mutation.then(task); mutation = result.then(() => undefined, () => undefined); return result; }
export function saveMusicBed(root: string, raw: unknown, id?: string) { return serialized(async () => { const input = musicBedInputSchema.parse(raw); for (const entry of input.tracks) if (!await getMusicTrack(root, entry.trackId)) throw new Error(`Music bed track ${entry.trackId} does not exist`); const beds = await listMusicBeds(root); const index = id ? beds.findIndex((item) => item.id === musicBedIdSchema.parse(id)) : -1; if (id && index < 0) throw new Error("Music bed not found"); const now = new Date().toISOString(); const bed = musicBedSchema.parse({ ...input, id: id ?? `bed_${randomBytes(12).toString("hex")}`, revision: fingerprint({ input, now }), createdAt: index < 0 ? now : beds[index]!.createdAt, updatedAt: now }); if (index < 0) beds.push(bed); else beds[index] = bed; await atomicWriteJson(manifest(root), { version: 1, beds }); return bed; }); }
export function deleteMusicBed(root: string, id: string) { return serialized(async () => { musicBedIdSchema.parse(id); const using = await storiesUsingMusic(root, "bed", id); if (using.length) throw new Error(`Bed is the story default for ${using.join(", ")}. Change the default first.`); const beds = await listMusicBeds(root); if (!beds.some((item) => item.id === id)) throw new Error("Music bed not found"); await atomicWriteJson(manifest(root), { version: 1, beds: beds.filter((item) => item.id !== id) }); }); }
export function bedPlaybackOrder(bed: MusicBed, seed: string, count: number): string[] { const ids = bed.tracks.map((item) => item.trackId); if (!ids.length) return []; const out: string[] = []; let state = Number.parseInt(fingerprint({ seed, revision: bed.revision }).slice(0, 8), 16) || 1; for (let i = 0; i < count; i++) { if (bed.playbackMode === "sequential") { out.push(ids[i % ids.length]!); continue; } state ^= state << 13; state ^= state >>> 17; state ^= state << 5; let index = (state >>> 0) % ids.length; if (ids.length > 1 && ids[index] === out.at(-1)) index = (index + 1) % ids.length; out.push(ids[index]!); } return out; }
