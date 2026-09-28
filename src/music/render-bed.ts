import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { FfmpegTools } from "../audio/ffmpeg.js";
import type { ResolvedExportMusic } from "./types.js";
import { bedPlaybackOrder, type MusicBed } from "./music-bed.js";

export async function renderMusicBed(bed: NonNullable<ResolvedExportMusic["bed"]>, targetDuration: number, seed: string, tools = new FfmpegTools()) {
  if (!Number.isFinite(targetDuration) || targetDuration <= 0 || !bed.tracks.length) throw new Error("Invalid music bed duration or empty track list");
  // Render a complete cycle. Long exports loop this local cycle; never omit later entries.
  const order = bedPlaybackOrder({ id: bed.id, name: bed.name, revision: bed.fingerprint, playbackMode: bed.playbackMode, crossfadeSeconds: bed.crossfadeSeconds, tracks: bed.tracks.map((item) => ({ trackId: item.track.id })), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } satisfies MusicBed, seed, bed.tracks.length);
  const selected = order.map((id) => bed.tracks.find((item) => item.track.id === id)!);
  const output = join(tmpdir(), `music-bed-${randomUUID()}.flac`);
  const wrap = selected.length > 1 ? Math.min(bed.crossfadeSeconds, selected[0]!.track.durationSeconds / 3, selected.at(-1)!.track.durationSeconds / 3) : 0;
  const args: string[] = []; const filters: string[] = []; selected.forEach((item, i) => { args.push("-i", item.path); const normalized = `[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo`; if (i === 0 && wrap > 0) { filters.push(`${normalized},asplit=2[first][wrapraw]`, `[first]atrim=start=${wrap},asetpts=PTS-STARTPTS[a0]`, `[wrapraw]atrim=end=${wrap},asetpts=PTS-STARTPTS[wraphead]`); } else filters.push(`${normalized}[a${i}]`); });
  let previous = "a0"; for (let i = 1; i < selected.length; i++) { const duration = Math.min(bed.crossfadeSeconds, selected[i - 1]!.track.durationSeconds / 3, selected[i]!.track.durationSeconds / 3); const next = `x${i}`; filters.push(duration > 0 ? `[${previous}][a${i}]acrossfade=d=${duration}:c1=tri:c2=tri[${next}]` : `[${previous}][a${i}]concat=n=2:v=0:a=1[${next}]`); previous = next; }
  if (wrap > 0) { filters.push(`[${previous}][wraphead]acrossfade=d=${wrap}:c1=tri:c2=tri[wrapped]`); previous = "wrapped"; }
  try { await tools.ffmpeg([...args, "-filter_complex", filters.join(";"), "-map", `[${previous}]`, "-c:a", "flac", output]); return output; }
  catch (error) { await rm(output, { force: true }); throw error; }
}
