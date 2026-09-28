import { FfmpegTools } from "./ffmpeg.js";
import { FfmpegVideoTools } from "../video/ffmpeg-video.js";
import { type ResolvedExportMusic } from "../music/types.js";
import { renderMusicBed } from "../music/render-bed.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { fingerprint } from "../utils/hash.js";

export const BACKGROUND_MUSIC_PROCESSOR_VERSION = "background-music-v3";
export function backgroundMusicFingerprint(music: ResolvedExportMusic) {
  return { version: BACKGROUND_MUSIC_PROCESSOR_VERSION, mode: music.mode, trackId: music.track.id, trackFingerprint: music.track.fingerprint, bed: music.bed ? { id: music.bed.id, revision: music.bed.fingerprint, tracks: music.bed.tracks.map((item) => [item.track.id, item.track.fingerprint]), playbackMode: music.bed.playbackMode, crossfadeSeconds: music.bed.crossfadeSeconds } : undefined,
    gainDb: music.gainDb, ducking: music.ducking, fadeInSeconds: music.fadeInSeconds, fadeOutSeconds: music.fadeOutSeconds, loopMode: music.loopMode };
}
export function backgroundMusicManifest(music: ResolvedExportMusic) {
  return { mode: music.mode, trackId: music.track.id, trackFingerprint: music.track.fingerprint, title: music.bed?.name ?? music.track.title, gainDb: music.gainDb,
    ducking: music.ducking.enabled, duckingStrength: music.ducking.strength, fadeInSeconds: music.fadeInSeconds, fadeOutSeconds: music.fadeOutSeconds, loopMode: music.loopMode };
}
export function buildBackgroundMusicFilter(duration: number, music: ResolvedExportMusic) {
  if (!(duration > 0) || !Number.isFinite(duration)) throw new Error("Invalid export duration");
  const fadeIn = Math.min(music.fadeInSeconds, duration / 2); const fadeOut = Math.min(music.fadeOutSeconds, duration / 2);
  const voice = "[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
  const voiceFilter = music.ducking.enabled ? `${voice},asplit=2[voice][key]` : `${voice}[voice]`;
  const fade = `[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${music.gainDb}dB${fadeIn > 0 ? `,afade=t=in:st=0:d=${fadeIn}` : ""}${fadeOut > 0 ? `,afade=t=out:st=${Math.max(0, duration - fadeOut)}:d=${fadeOut}` : ""}[bed]`;
  const strengths = { gentle: { ratio: 2, threshold: .05 }, normal: { ratio: 3, threshold: .035 }, strong: { ratio: 5, threshold: .025 } };
  const ducked = music.ducking.enabled ? `[bed][key]sidechaincompress=threshold=${strengths[music.ducking.strength].threshold}:ratio=${strengths[music.ducking.strength].ratio}:attack=250:release=1200[music]` : "[bed]anull[music]";
  return `${voiceFilter};${fade};${ducked};[voice][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.89[out]`;
}
export function buildBackgroundMusicAudioArgs(input: string, output: string, format: "mp3" | "m4b", duration: number, music: ResolvedExportMusic) {
  const args = ["-i", input, "-stream_loop", "-1", "-i", music.path, "-filter_complex", buildBackgroundMusicFilter(duration, music), "-map", "[out]", "-map_metadata", "0", "-map_chapters", "0", "-t", String(duration)];
  if (format === "m4b") args.push("-map", "0:v?", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4", output);
  else args.push("-c:a", "libmp3lame", "-b:a", "192k", output);
  return args;
}
export function buildBackgroundMusicVideoArgs(input: string, output: string, duration: number, music: ResolvedExportMusic) {
  return ["-i", input, "-stream_loop", "-1", "-i", music.path, "-filter_complex", buildBackgroundMusicFilter(duration, music), "-map", "0:v:0", "-map", "[out]", "-map", "0:s?", "-map_metadata", "0", "-map_chapters", "0", "-c:v", "copy", "-c:s", "copy", "-c:a", "aac", "-b:a", "192k", "-t", String(duration), "-movflags", "+faststart", output];
}
export async function mixBackgroundMusicAudio(input: string, output: string, format: "mp3" | "m4b", music: ResolvedExportMusic, tools = new FfmpegTools()) {
  const before = await tools.probe(input); const bed = music.bed ? await renderMusicBed(music.bed, before.durationSeconds, fingerprint({ source: await fileFingerprint(input), music: backgroundMusicFingerprint(music) }), tools) : undefined;
  try { await tools.ffmpeg(buildBackgroundMusicAudioArgs(input, output, format, before.durationSeconds, bed ? { ...music, path: bed } : music)); } finally { if (bed) { const { rm } = await import("node:fs/promises"); await rm(bed, { force: true }); } } const after = await tools.probe(output);
  if (Math.abs(after.durationSeconds - before.durationSeconds) > Math.max(1, before.durationSeconds * .002)) throw new Error("Music export duration differs from clean audio");
  return after;
}
export async function mixBackgroundMusicVideo(input: string, output: string, music: ResolvedExportMusic, tools = new FfmpegVideoTools()) {
  const before = await tools.probe(input); const bed = music.bed ? await renderMusicBed(music.bed, before.durationSeconds, fingerprint({ source: await fileFingerprint(input), music: backgroundMusicFingerprint(music) })) : undefined;
  try { await tools.ffmpeg(buildBackgroundMusicVideoArgs(input, output, before.durationSeconds, bed ? { ...music, path: bed } : music)); } finally { if (bed) { const { rm } = await import("node:fs/promises"); await rm(bed, { force: true }); } } const after = await tools.probe(output);
  if (after.videoCodec !== before.videoCodec || after.width !== before.width || after.height !== before.height || after.audioCodec !== "aac" || Math.abs(after.durationSeconds - before.durationSeconds) > Math.max(1, before.durationSeconds * .002)) throw new Error("Music video export changed the source streams or duration");
  return after;
}
