import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { FfmpegTools } from "../audio/ffmpeg.js";
import type { ResolvedExportMusic } from "./types.js";
import { bedPlaybackOrder, type MusicBed } from "./music-bed.js";

export async function renderMusicBed(bed: NonNullable<ResolvedExportMusic["bed"]>, targetDuration: number, seed: string, tools = new FfmpegTools()) {
  const order = bedPlaybackOrder({ id: bed.id, name: bed.name, revision: bed.fingerprint, playbackMode: bed.playbackMode, crossfadeSeconds: bed.crossfadeSeconds, tracks: bed.tracks.map((item) => ({ trackId: item.track.id })), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } satisfies MusicBed, seed, Math.max(2, Math.min(12, Math.ceil(targetDuration / Math.max(1, Math.min(...bed.tracks.map((item) => item.track.durationSeconds)))) + 1)));
  const selected = order.map((id) => bed.tracks.find((item) => item.track.id === id)!);
  const output = join(tmpdir(), `music-bed-${randomUUID()}.flac`);
  const args: string[] = []; const filters: string[] = []; selected.forEach((item, i) => { args.push("-i", item.path); filters.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`); });
  let previous = "a0"; for (let i = 1; i < selected.length; i++) { const duration = Math.min(bed.crossfadeSeconds, selected[i - 1]!.track.durationSeconds / 3, selected[i]!.track.durationSeconds / 3); const next = `x${i}`; filters.push(duration > 0 ? `[${previous}][a${i}]acrossfade=d=${duration}:c1=tri:c2=tri[${next}]` : `[${previous}][a${i}]concat=n=2:v=0:a=1[${next}]`); previous = next; }
  try { await tools.ffmpeg([...args, "-filter_complex", filters.join(";"), "-map", `[${previous}]`, "-c:a", "flac", output]); return output; }
  catch (error) { await rm(output, { force: true }); throw error; }
}
