import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FfmpegTools, runCommand } from "../src/audio/ffmpeg.js";
import { importMusicTrack, listMusicTracks, deleteMusicTrack } from "../src/music/library.js";
import { bedPlaybackOrder, listMusicBeds, saveMusicBed } from "../src/music/music-bed.js";
import { musicProviderCatalog } from "../src/music/providers/registry.js";
import { ElevenLabsMusicProvider, musicGenerationTimeoutMs } from "../src/music/providers/elevenlabs.js";
import { startMusicGeneration, readMusicGeneration, listMusicGenerations, saveMusicCandidate, discardMusicCandidate } from "../src/music/generation.js";
import { resolveExportMusic } from "../src/music/resolver.js";
import { renderMusicBed } from "../src/music/render-bed.js";
import { buildStoryMusicContext, suggestMusicConcepts } from "../src/music/recommendations.js";
import { buildMusicMixPreview } from "../src/music/preview.js";
import { storyPaths } from "../src/storage/paths.js";
import { mkdir } from "node:fs/promises";
import { fileFingerprint } from "../src/utils/file-fingerprint.js";
import { testStory } from "./helpers.js";

const fakeTools = new FfmpegTools("ffmpeg", "ffprobe", async () => ({ stdout: JSON.stringify({ format: { duration: "2.5", format_name: "mp3" }, streams: [{ codec_type: "audio", codec_name: "mp3" }] }), stderr: "" }));
async function root() { return mkdtemp(join(tmpdir(), "music-phase2-")); }
const request = { prompt: "Soft dark ambient instrumental music beneath a narrator", instrumental: true, tags: ["ambient"], energy: "low" as const, purpose: "background_narration" as const, loopFriendly: true };

describe("music phase 2", () => {
  it("reports only implemented adapter capabilities", () => {
    expect(new ElevenLabsMusicProvider("test").capabilities()).toEqual({
      generation: true, asyncGeneration: false, instrumentalControl: true,
      durationControl: true, loopingControl: false, structuredComposition: false,
      searchCatalog: false, commercialUseMetadata: false, maxDurationSeconds: 600,
    });
  });
  it("scales generation timeouts monotonically within safe bounds", () => {
    expect([undefined, 60, 120, 300, 600].map(musicGenerationTimeoutMs)).toEqual([300_000, 180_000, 300_000, 750_000, 900_000]);
    const durations = [-1, 0, 60, 120, 300, 600, 1000];
    const timeouts = durations.map(musicGenerationTimeoutMs);
    expect(timeouts.every((value, index) => value >= 180_000 && value <= 900_000 && (!index || value >= timeouts[index - 1]!))).toBe(true);
    expect(musicGenerationTimeoutMs(NaN)).toBe(300_000);
  });
  it("uses the duration timeout and never retries a timed-out paid request", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
      const pending = new ElevenLabsMusicProvider("test", fetcher).generate({ ...request, durationSeconds: 600 });
      const rejected = expect(pending).rejects.toThrow("not retried automatically because provider charges may already have occurred");
      await vi.advanceTimersByTimeAsync(899_999);
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("lists official provider availability without exposing keys", () => { const catalog = musicProviderCatalog({ ELEVENLABS_API_KEY: "secret", SUNO_API_KEY: "secret" }); expect(catalog[0]?.configured).toBe(true); expect(catalog[1]?.available).toBe(false); expect(JSON.stringify(catalog)).not.toContain("secret"); });
  it("uses ElevenLabs official compose request and classifies rate limit", async () => { let body: Record<string, unknown> = {}; const provider = new ElevenLabsMusicProvider("secret", async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "song-id": "song-1" } }); }); const result = await provider.generate(request); expect(body.force_instrumental).toBe(true); expect(result.providerGenerationId).toBe("song-1"); const limited = new ElevenLabsMusicProvider("secret", async () => new Response("", { status: 429 })); await expect(limited.generate(request)).rejects.toThrow("rate limit"); });
  it("keeps candidates temporary until approved and saves provenance", async () => { const dir = await root(); const provider = { id: "fake", displayName: "Fake", capabilities: () => ({ generation: true, asyncGeneration: false, instrumentalControl: true, durationControl: true, loopingControl: false, structuredComposition: false, searchCatalog: false, commercialUseMetadata: false }), generate: async () => ({ audio: new Uint8Array([1, 2, 3]), providerGenerationId: "remote-1", model: "fake-v1" }) }; const job = startMusicGeneration(dir, request, provider, fakeTools); await job.run; expect(await listMusicTracks(dir)).toHaveLength(0); expect((await readMusicGeneration(dir, job.id))?.status).toBe("complete"); const track = await saveMusicCandidate(dir, job.id, "Approved", fakeTools); expect(track.title).toBe("Approved"); expect(track.generation?.providerGenerationId).toBe("remote-1"); expect(track.generation?.prompt).toBe(request.prompt); expect(JSON.stringify(track)).not.toContain("secret"); expect(await listMusicTracks(dir)).toHaveLength(1); expect((await readMusicGeneration(dir, job.id))?.status).toBe("saved"); expect((await saveMusicCandidate(dir, job.id, "Retry", fakeTools)).id).toBe(track.id); });
  it("serializes simultaneous candidate approvals", async () => {
    const dir = await root(); const provider = { id: "fake", displayName: "Fake", capabilities: () => ({ generation: true, asyncGeneration: false, instrumentalControl: true, durationControl: true, loopingControl: false, structuredComposition: false, searchCatalog: false, commercialUseMetadata: false }), generate: async () => ({ audio: new Uint8Array([1, 2, 3]) }) };
    const job = startMusicGeneration(dir, request, provider, fakeTools); await job.run;
    const results = await Promise.allSettled([saveMusicCandidate(dir, job.id, "First", fakeTools), saveMusicCandidate(dir, job.id, "Second", fakeTools)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2); expect(await listMusicTracks(dir)).toHaveLength(1);
  });
  it("recovers interrupted jobs without automatically repeating paid generation", async () => {
    const dir = await root(); const id = "12345678-1234-4234-8234-123456789012"; const location = join(dir, "music-generation", id); await mkdir(location, { recursive: true });
    await writeFile(join(location, "manifest.json"), JSON.stringify({ id, provider: "fake", status: "generating", request, createdAt: new Date().toISOString() }));
    expect((await listMusicGenerations(dir))[0]?.status).toBe("failed"); expect((await readMusicGeneration(dir, id))?.error).toContain("interrupted");
  });
  it("does not publish invalid provider audio and permits discard", async () => { const dir = await root(); const provider = { id: "fake", displayName: "Fake", capabilities: () => ({ generation: true, asyncGeneration: false, instrumentalControl: true, durationControl: true, loopingControl: false, structuredComposition: false, searchCatalog: false, commercialUseMetadata: false }), generate: async () => ({ audio: new Uint8Array() }) }; const job = startMusicGeneration(dir, request, provider, fakeTools); await job.run; expect((await readMusicGeneration(dir, job.id))?.status).toBe("failed"); expect(await listMusicTracks(dir)).toEqual([]); await discardMusicCandidate(dir, job.id); expect(await readMusicGeneration(dir, job.id)).toBeUndefined(); });
  it("saves beds, resolves legacy and bed defaults, and blocks referenced track deletion", async () => { const dir = await root(); const file = join(dir, "source.mp3"); await writeFile(file, "fake-audio"); const track = await importMusicTrack(dir, file, "source.mp3", {}, fakeTools); const bed = await saveMusicBed(dir, { name: "Bed", tracks: [{ trackId: track.id }], playbackMode: "sequential", crossfadeSeconds: 1 }); expect(await listMusicBeds(dir)).toHaveLength(1); const story = testStory(); const legacy = await resolveExportMusic(dir, { ...story, backgroundMusic: { ...story.backgroundMusic, defaultTrackId: track.id } }, { mode: "story_default" }, {}, fakeTools); expect(legacy?.track.id).toBe(track.id); const resolved = await resolveExportMusic(dir, { ...story, backgroundMusic: { ...story.backgroundMusic, defaultSelection: { type: "bed", id: bed.id } } }, { mode: "story_default" }, {}, fakeTools); expect(resolved?.bed?.id).toBe(bed.id); await expect(deleteMusicTrack(dir, track.id)).rejects.toThrow("used by music bed"); });
  it("shuffles deterministically without adjacent repeats", async () => { const dir = await root(); const file = join(dir, "source.mp3"); await writeFile(file, "fake"); const a = await importMusicTrack(dir, file, "a.mp3", {}, fakeTools); const b = await importMusicTrack(dir, file, "b.mp3", {}, fakeTools); const bed = await saveMusicBed(dir, { name: "Shuffle", tracks: [{ trackId: a.id }, { trackId: b.id }], playbackMode: "shuffle", crossfadeSeconds: 1 }); const first = bedPlaybackOrder(bed, "story:1-10", 20); expect(bedPlaybackOrder(bed, "story:1-10", 20)).toEqual(first); expect(first.every((id, index) => index === 0 || id !== first[index - 1])).toBe(true); expect(new Set(first.slice(0, 2)).size).toBe(2); });
  it("renders every entry in a bed larger than twelve tracks", async () => {
    const dir = await root(); const source = join(dir, "source.mp3"); await writeFile(source, "fake-audio"); const base = await importMusicTrack(dir, source, "source.mp3", {}, fakeTools);
    const tracks = Array.from({ length: 15 }, (_, index) => ({ track: { ...base, id: `mus_${index.toString(16).padStart(24, "0")}` }, path: source })); let inputs = 0;
    const tools = new FfmpegTools("ffmpeg", "ffprobe", async (_command, args) => { inputs = args.filter((arg) => arg === "-i").length; return { stdout: "", stderr: "" }; });
    await renderMusicBed({ id: "bed_000000000000000000000001", name: "Large bed", fingerprint: "revision", playbackMode: "sequential", crossfadeSeconds: 1, tracks }, 3600, "seed", tools);
    expect(inputs).toBe(15);
  });
  it("renders a crossfaded bed with real FFmpeg", async () => { try { await runCommand("ffmpeg", ["-version"], 5000); } catch { return; } const dir = await root(); const file = join(dir, "source.mp3"); await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:a", "libmp3lame", "-y", file]); const a = await importMusicTrack(dir, file, "a.mp3"); const b = await importMusicTrack(dir, file, "b.mp3"); const bed = await saveMusicBed(dir, { name: "Crossfade", tracks: [{ trackId: a.id }, { trackId: b.id }], playbackMode: "sequential", crossfadeSeconds: .5 }); const music = await resolveExportMusic(dir, testStory(), { mode: "bed", bedId: bed.id }); const output = await renderMusicBed(music!.bed!, 6, "stable-seed"); expect((await stat(output)).size).toBeGreaterThan(0); expect((await new FfmpegTools().probe(output)).durationSeconds).toBeCloseTo(a.durationSeconds + b.durationSeconds - 1, 0); });
  it("caches a 30-second mix preview and preserves clean narration", async () => { try { await runCommand("ffmpeg", ["-version"], 5000); } catch { return; } const dir = await root(); const story = testStory(); const path = storyPaths(dir, story.slug, 1); await mkdir(path.chapterDir, { recursive: true }); await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=32", "-c:a", "libmp3lame", "-y", path.audio]); const musicFile = join(dir, "music.mp3"); await runCommand("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:a", "libmp3lame", "-y", musicFile]); const track = await importMusicTrack(dir, musicFile, "music.mp3"); const clean = await fileFingerprint(path.audio); const preview = await buildMusicMixPreview(dir, story, 1, { mode: "track", trackId: track.id }, {}, "middle"); expect((await new FfmpegTools().probe(preview)).durationSeconds).toBeCloseTo(30, 0); expect(await buildMusicMixPreview(dir, story, 1, { mode: "track", trackId: track.id }, {}, "middle")).toBe(preview); await writeFile(preview, "corrupted"); await buildMusicMixPreview(dir, story, 1, { mode: "track", trackId: track.id }, {}, "middle"); expect((await new FfmpegTools().probe(preview)).durationSeconds).toBeCloseTo(30, 0); expect(await fileFingerprint(path.audio)).toBe(clean); });
  it("bounds story context and returns concepts without invoking music generation", () => { const story = { ...testStory(), description: "x".repeat(5000), tags: Array.from({ length: 100 }, (_, i) => `tag-${i}`) }; expect(buildStoryMusicContext(story).description.length).toBeLessThanOrEqual(700); expect(buildStoryMusicContext(story).themes).toHaveLength(8); const concepts = suggestMusicConcepts(story); expect(concepts).toHaveLength(3); expect(concepts[0]?.prompt).toContain("No vocals"); });
});
