import { getOutputsPage } from "../apps/server/catalog.js";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FfmpegTools, runCommand, type CommandRunner } from "../src/audio/ffmpeg.js";
import { assembleAudiobook, FfmpegAudiobookProcessor } from "../src/audio/audiobook.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { buildBackgroundMusicAudioArgs, buildBackgroundMusicVideoArgs, backgroundMusicFingerprint } from "../src/audio/background-music.js";
import { importMusicTrack, listMusicTracks, musicTrackPath, updateMusicTrack, deleteMusicTrack } from "../src/music/library.js";
import { invalidateStoryForConfigChange } from "../src/studio/projects.js";
import { commitMusicExport } from "../src/music/commit.js";
import { resolveExportMusic } from "../src/music/resolver.js";
import { exportSummaryWithMusic, listSummaryMusicExports, summaryMusicExportPath } from "../src/music/summary-export.js";
import { summaryMediaPaths } from "../src/summaries/media.js";
import { summaryPath } from "../src/summaries/service.js";
import { saveMusicBed } from "../src/music/music-bed.js";
import { buildMusicMixPreviewFromSource } from "../src/music/preview.js";
import { exportChapterWithMusic } from "../src/music/chapter-export.js";
import { storyPaths } from "../src/storage/paths.js";
import { atomicWrite } from "../src/storage/atomic-write.js";
import { fileFingerprint } from "../src/utils/file-fingerprint.js";
import { testStory } from "./helpers.js";

const fakeProbeRunner: CommandRunner = async () => ({ stdout: JSON.stringify({ format: { duration: "2.5", format_name: "mp3" }, streams: [{ codec_type: "audio", codec_name: "mp3", sample_rate: "44100" }] }), stderr: "" });
const tools = new FfmpegTools("ffmpeg", "ffprobe", fakeProbeRunner);

async function fixture() { const root = await mkdtemp(join(tmpdir(), "story-music-")); const source = join(root, "outside.mp3"); await writeFile(source, Buffer.from("fake-audio")); return { root, source, story: testStory() }; }

describe("background music library and exports", () => {
  it("owns a safe copy, stores metadata, and leaves completed exports untouched on deletion", async () => {
    const { root, source } = await fixture();
    const first = await importMusicTrack(root, source, "../../unsafe.mp3", { title: "Quiet Loop", license: "Licensed", tags: ["ambient"] }, tools);
    const second = await importMusicTrack(root, source, "../../unsafe.mp3", {}, tools);
    expect(first.filename).toMatch(/^mus_[a-f0-9]{24}\.mp3$/); expect(second.filename).not.toBe(first.filename);
    expect(first.durationSeconds).toBe(2.5); expect(first.fingerprint).toBe(await fileFingerprint(musicTrackPath(root, first)));
    expect((await readFile(musicTrackPath(root, first))).toString()).toBe("fake-audio");
    const updated = await updateMusicTrack(root, first.id, { title: "Renamed", attribution: "Artist" });
    expect(updated.title).toBe("Renamed"); expect(updated.attribution).toBe("Artist"); expect(updated.tags).toEqual(["ambient"]);
    const exportFile = join(root, "finished.mp3"); await writeFile(exportFile, "export");
    await deleteMusicTrack(root, first.id);
    expect(await listMusicTracks(root)).toHaveLength(1); expect((await readFile(exportFile)).toString()).toBe("export");
  });

  it("keeps both tracks when imports arrive concurrently", async () => {
    const { root, source } = await fixture();
    await Promise.all([importMusicTrack(root, source, "one.mp3", {}, tools), importMusicTrack(root, source, "two.mp3", {}, tools)]);
    expect(await listMusicTracks(root)).toHaveLength(2);
  });

  it("rejects unsafe extensions and invalid audio before publishing a track", async () => {
    const { root, source } = await fixture();
    await expect(importMusicTrack(root, source, "../../script.sh", {}, tools)).rejects.toThrow("Unsupported music format");
    await expect(importMusicTrack(root, source, "bad.mp3", {}, new FfmpegTools("ffmpeg", "ffprobe", async () => ({ stdout: "{}", stderr: "" })))).rejects.toThrow();
    expect(await listMusicTracks(root)).toEqual([]);
  });

  it("resolves explicit and default choices, fails on missing music, and fingerprints mix settings", async () => {
    const { root, source, story } = await fixture(); const track = await importMusicTrack(root, source, "track.mp3", {}, tools);
    expect(await resolveExportMusic(root, story, { mode: "none" }, {}, tools)).toBeUndefined();
    await expect(resolveExportMusic(root, story, { mode: "story_default" }, {}, tools)).rejects.toThrow("no default");
    const direct = await resolveExportMusic(root, story, { mode: "track", trackId: track.id }, {}, tools);
    expect(direct?.gainDb).toBe(-14); expect(direct?.ducking.enabled).toBe(true);
    const storyPreset = await resolveExportMusic(root, { ...story, backgroundMusic: { ...story.backgroundMusic, level: "present", fadeInSeconds: 4 } }, { mode: "track", trackId: track.id }, {}, tools);
    expect(storyPreset?.gainDb).toBe(-6); expect(storyPreset?.fadeInSeconds).toBe(4);
    const withDefault = { ...story, backgroundMusic: { ...story.backgroundMusic, defaultTrackId: track.id } };
    const custom = await resolveExportMusic(root, withDefault, { mode: "story_default" }, { level: "custom", customGainDb: -30, ducking: { enabled: false } }, tools);
    expect(custom?.gainDb).toBe(-30); expect(custom?.ducking.enabled).toBe(false);
    expect(backgroundMusicFingerprint(custom!)).not.toEqual(backgroundMusicFingerprint(direct!));
    expect(buildBackgroundMusicAudioArgs("clean.mp3", "mix.mp3", "mp3", 12, direct!).join(" ")).toContain("-stream_loop -1");
    expect(buildBackgroundMusicVideoArgs("clean.mp4", "mix.mp4", 12, direct!).join(" ")).toContain("-c:v copy");
    await deleteMusicTrack(root, track.id);
    await expect(resolveExportMusic(root, withDefault, { mode: "story_default" }, {}, tools)).rejects.toThrow("no longer available");
  });

  it("keeps a quiet music track audible under narration with the default preset and ducking", async () => {
    try { await runCommand("ffmpeg", ["-version"], 5_000); } catch { return; }
    const { root, source, story } = await fixture();
    const paths = storyPaths(root, story.slug, 1); await mkdir(paths.chapterDir, { recursive: true });
    await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=1000:duration=4", "-af", "volume=2", "-c:a", "libmp3lame", "-y", paths.audio]);
    await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=4", "-af", "volume=0.1", "-c:a", "libmp3lame", "-y", source]);
    const track = await importMusicTrack(root, source, "quiet.mp3");
    const result = await exportChapterWithMusic({ root, story, chapter: 1, kind: "audio", music: { mode: "track", trackId: track.id }, musicOverrides: { fadeInSeconds: 0, fadeOutSeconds: 0 } });
    // Isolate the music frequency to measure actual contribution, not merely
    // confirm that a music input appears in the FFmpeg command.
    const measured = await runCommand("ffmpeg", ["-hide_banner", "-i", result.output, "-af", "bandpass=f=220:width_type=h:w=20,volumedetect", "-f", "null", "-"]);
    const level = Number(/mean_volume: (-?[\d.]+) dB/.exec(measured.stderr)?.[1]);
    expect(Number.isFinite(level)).toBe(true);
    expect(level).toBeGreaterThan(-38);
  });

  it("mixes separate chapter audio and video variants while preserving clean masters", async () => {
    try { await runCommand("ffmpeg", ["-version"], 5_000); } catch { return; }
    const { root, source, story } = await fixture(); const paths = storyPaths(root, story.slug, 1); await mkdir(paths.chapterDir, { recursive: true });
    await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", "-y", paths.audio]);
    await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2:r=24", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", paths.video]);
    await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=1", "-c:a", "libmp3lame", "-y", source]);
    const track = await importMusicTrack(root, source, "loop.mp3");
    const cleanAudio = await fileFingerprint(paths.audio); const cleanVideo = await fileFingerprint(paths.video);
    const music = { mode: "track" as const, trackId: track.id };
    const audio = await exportChapterWithMusic({ root, story, chapter: 1, kind: "audio", music });
    const video = await exportChapterWithMusic({ root, story, chapter: 1, kind: "video", music });
    expect(audio.edition).toMatch(/^bg-/); expect(video.edition).toMatch(/^bg-/);
    expect(audio.output).not.toBe(paths.audio); expect(video.output).not.toBe(paths.video);
    expect(await fileFingerprint(paths.audio)).toBe(cleanAudio); expect(await fileFingerprint(paths.video)).toBe(cleanVideo);
    expect((await exportChapterWithMusic({ root, story, chapter: 1, kind: "audio", music })).reused).toBe(true);
    const changed = await exportChapterWithMusic({ root, story, chapter: 1, kind: "audio", music, musicOverrides: { level: "present" } });
    expect(changed.edition).not.toBe(audio.edition);
    expect(await fileFingerprint(audio.output)).toBeTruthy();
  });

  it("exports summary audio and video with reusable music beds without changing clean media", async () => {
    const { root, source, story } = await fixture();
    const id = "sum_12345678-1234-1234-1234-123456789abc";
    const paths = summaryMediaPaths(root, story.slug, id);
    await mkdir(paths.directory, { recursive: true });
    const videoPath = join(paths.directory, "video.mp4");
    await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", "-y", paths.audio]);
    await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2:r=24", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", videoPath]);
    await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=1", "-c:a", "libmp3lame", "-y", source]);
    const track = await importMusicTrack(root, source, "summary-bed.mp3");
    const bed = await saveMusicBed(root, { name: "Summary bed", tracks: [{ trackId: track.id }], playbackMode: "sequential", crossfadeSeconds: 0 });
    const music = { mode: "bed" as const, bedId: bed.id };
    const audioFp = await fileFingerprint(paths.audio), videoFp = await fileFingerprint(videoPath);
    const record = { id, storyId: story.slug, title: "Recap", chapters: [1], summaryType: "brief", sourceMode: "translated", targetLength: { words: 100 }, text: "Recap text", status: "complete", origin: "manual", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), provenance: { model: { provider: "openai", model: "fake" }, promptVersion: "test", chapterSources: [], levels: [] }, audio: { status: "current", inputFingerprint: "test", outputFingerprint: audioFp }, video: { status: "current", inputFingerprint: "test", outputFingerprint: videoFp } };
    await atomicWriteJson(summaryPath(root, story.slug, id), record);
    const recordBefore = await readFile(summaryPath(root, story.slug, id), "utf8");
    const options = { root, story, summaryId: id, music };
    const audio = await exportSummaryWithMusic({ ...options, kind: "audio" });
    const video = await exportSummaryWithMusic({ ...options, kind: "video" });
    expect(audio.output).not.toBe(paths.audio); expect(video.output).not.toBe(videoPath);
    expect((await exportSummaryWithMusic({ ...options, kind: "audio" })).reused).toBe(true);
    expect((await exportSummaryWithMusic({ ...options, kind: "audio", musicOverrides: { level: "present" } })).edition).not.toBe(audio.edition);
    expect(await listSummaryMusicExports(root, story.slug, id)).toHaveLength(3);
    const outputs = await getOutputsPage(root, story.slug, "summaryMedia", 1, 10);
    expect(outputs.items).toHaveLength(5);
    expect(outputs.items.every((item) => item.title === "Recap" && item.downloadUrl?.includes(`/summaries/${id}/`))).toBe(true);
    expect(await fileFingerprint(paths.audio)).toBe(audioFp); expect(await fileFingerprint(videoPath)).toBe(videoFp);
    expect(await readFile(summaryPath(root, story.slug, id), "utf8")).toBe(recordBefore);
    expect((await exportSummaryWithMusic({ ...options, kind: "audio", music: { mode: "none" } })).output).toBe(paths.audio);
    const preview = await buildMusicMixPreviewFromSource(root, story, paths.audio, music, {});
    expect(await fileFingerprint(preview)).toBeTruthy();
    await writeFile(audio.output, "damaged");
    expect(await listSummaryMusicExports(root, story.slug, id)).toHaveLength(2);
    expect((await exportSummaryWithMusic({ ...options, kind: "audio" })).reused).toBe(false);
    await writeFile(paths.audio, "damaged master");
    await expect(exportSummaryWithMusic({ ...options, kind: "audio" })).rejects.toThrow("missing or damaged");
    expect(() => summaryMusicExportPath(root, story.slug, "../bad", "audio", "bg-123456789abc")).toThrow();
  });

  it("keeps a clean audiobook cached while distinct music settings create separate editions", async () => {
    try { await runCommand("ffmpeg", ["-version"], 5_000); } catch { return; }
    const { root, source, story } = await fixture();
    for (const chapter of [1, 2]) {
      const paths = storyPaths(root, story.slug, chapter); await mkdir(paths.chapterDir, { recursive: true });
      await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=${chapter * 330}:duration=2`, "-c:a", "libmp3lame", "-y", paths.audio]);
      const now = new Date().toISOString(); const complete = { status: "complete" as const, fingerprint: "input", outputFingerprint: "output" };
      const meta = chapterSchema.parse({ chapter, originalTitle: `Chapter ${chapter}`, translatedTitle: `Chapter ${chapter}`, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
        counts: { originalCharacters: 1, englishWords: 1, narrationWords: 1 }, createdAt: now, updatedAt: now,
        stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, tts: complete, audioMastering: complete },
        audio: { durationSeconds: 2, codec: "mp3", container: "mp3" } });
      await atomicWriteJson(paths.chapterMeta, meta);
    }
    await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=1", "-c:a", "libmp3lame", "-y", source]);
    const track = await importMusicTrack(root, source, "loop.mp3"); const processor = new FfmpegAudiobookProcessor();
    const clean = await assembleAudiobook({ root, story, from: 1, to: 2, format: "m4b", processor });
    const mixed = await assembleAudiobook({ root, story, from: 1, to: 2, format: "m4b", processor, music: { mode: "track", trackId: track.id } });
    const louder = await assembleAudiobook({ root, story, from: 1, to: 2, format: "m4b", processor, music: { mode: "track", trackId: track.id }, musicOverrides: { level: "present" } });
    expect(mixed.manifest.output).not.toBe(clean.manifest.output); expect(louder.manifest.output).not.toBe(mixed.manifest.output);
    expect(mixed.manifest.chapters).toEqual(clean.manifest.chapters);
    expect(Math.abs(mixed.manifest.durationSeconds - clean.manifest.durationSeconds)).toBeLessThan(1);
    expect((await assembleAudiobook({ root, story, from: 1, to: 2, format: "m4b", processor })).reused).toBe(true);
    expect(await fileFingerprint(clean.manifest.output)).toBe(clean.manifest.outputFingerprint);
  });

  it("restores the prior completed edition when manifest commit fails", async () => {
    const { root } = await fixture(); const output = join(root, "edition.mp3"); const manifest = `${output}.json`; const staged = join(root, "staged.mp3");
    await writeFile(output, "previous"); await writeFile(manifest, '{"version":1}'); await writeFile(staged, "replacement");
    const circular: Record<string, unknown> = {}; circular.self = circular;
    await expect(commitMusicExport(staged, output, manifest, circular)).rejects.toThrow();
    expect((await readFile(output)).toString()).toBe("previous"); expect((await readFile(manifest)).toString()).toBe('{"version":1}');
  });

  it("does not mark chapter stages stale when only story music preferences change", async () => {
    const { root, story } = await fixture(); const paths = storyPaths(root, story.slug, 1);
    await atomicWriteJson(paths.chapterMeta, { chapter: 1, stages: { audioMastering: { status: "complete", fingerprint: "clean" }, video: { status: "complete", fingerprint: "video" } } });
    const before = await readFile(paths.chapterMeta);
    await invalidateStoryForConfigChange(root, story.slug, story, { ...story, backgroundMusic: { ...story.backgroundMusic, level: "present" } });
    expect(await readFile(paths.chapterMeta)).toEqual(before);
  });

  it("returns the canonical chapter master instantly for no-music export", async () => {
    const { root, story } = await fixture(); const paths = storyPaths(root, story.slug, 1); await atomicWrite(paths.audio, Buffer.from("clean-master"));
    const before = await fileFingerprint(paths.audio);
    const result = await exportChapterWithMusic({ root, story, chapter: 1, kind: "audio", music: { mode: "none" } });
    expect(result.output).toBe(paths.audio); expect(result.edition).toBeUndefined(); expect(await fileFingerprint(paths.audio)).toBe(before);
  });
});
