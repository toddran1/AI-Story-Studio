import { describe, expect, it, vi } from "vitest";
import { FishAudioProvider, normalizeFishReferenceId, normalizeFishSpeechText } from "../src/tts/fish/fish-audio.provider.js";
import { splitForTTS } from "../src/tts/split-text.js";
import { TTSRequest } from "../src/tts/types.js";

describe("Fish TTS", () => {
  it("splits on natural boundaries", () => {
    const chunks = splitForTTS(`${"First sentence. ".repeat(40)}\n\n${"Second paragraph. ".repeat(40)}`, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
  });

  it("uses mocked Fish responses and combines segments", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "x-request-id": "req", "content-type": "audio/mpeg" } }));
    const provider = new FishAudioProvider("test-key", fetcher as typeof fetch);
    const result = await provider.synthesize({ text: `${"Sentence. ".repeat(150)}`, model: "s2-pro", speed: 1, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 500 });
    expect(fetcher).toHaveBeenCalled();
    expect(result.segments.length).toBeGreaterThan(1);
    expect(result.audio.length).toBe(result.segments.reduce((sum, value) => sum + value.length, 0));
  });

  it("uses the configured environment voice when a story has no voice override", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    const provider = new FishAudioProvider("test-key", fetcher as typeof fetch, 120_000, "environment-voice");
    await provider.synthesize({ text: "Hello", model: "s2-pro", speed: 1.2, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 500 });
    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body)).reference_id).toBe("environment-voice");
  });

  it("accepts public Fish model URLs anywhere a reference ID is accepted", () => {
    expect(normalizeFishReferenceId("https://fish.audio/app/m/f6c4a7319c314423839db215b5b29ec3")).toBe("f6c4a7319c314423839db215b5b29ec3");
    expect(normalizeFishReferenceId("65f323abd1b643e8b4270b9c50d20877")).toBe("65f323abd1b643e8b4270b9c50d20877");
  });

  it("uses Fish's documented S2.1 production controls for the paid and free S2.1 models", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    const provider = new FishAudioProvider("test-key", fetcher as typeof fetch);
    await provider.synthesize({ text: "Hello", model: "s2.1-pro-free", speed: 1, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 500 });
    const body = JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({ temperature: .7, top_p: .7, chunk_length: 300, repetition_penalty: 1.2, condition_on_previous_chunks: true });
  });

  it("does not send Markdown emphasis asterisks to Fish as spoken text", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    const provider = new FishAudioProvider("test-key", fetcher as typeof fetch);
    await provider.synthesize({ text: "**Important:** *whisper this.* [sad] 2 * 2", model: "s2.1-pro", speed: 1, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 500 });
    const body = JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.text).toBe("Important: whisper this. [sad] 2 * 2");
    expect(provider.inputNormalizationVersion).toBe("fish-speech-normalization-v3");
  });

  it("keeps approved S2 cues but makes bracketed story notifications ordinary speech", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } }));
    const provider = new FishAudioProvider("test-key", fetcher as typeof fetch);
    await provider.synthesize({ text: "[sad] [Goblin Undead Information Extraction Complete] [pause]", model: "s2.1-pro-free", speed: 1, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 500 });
    const body = JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.text).toBe("[sad] Goblin Undead Information Extraction Complete [pause]");
  });

  it("normalizes fiction abbreviations, titles, values, and units for speech", () => {
    const script = normalizeFishSpeechText("**Dr. Lin** reached Lv. 12 with 80% HP at 8:00 PM. The NPC gained 5 EXP in 30°C heat.");
    expect(script).toBe("Doctor Lin reached Level 12 with 80 percent H.P. at 8 o'clock P.M. The N.P.C. gained 5 E.X.P. in 30 degrees Celsius heat.");
  });

  it("removes speech-hostile markup, links, and emoji while preserving Fish cues and ambiguous names", () => {
    const script = normalizeFishSpeechText("## Scene\n[sad] Prof. Vale met St. John. [Source](https://example.com) ✨ 2 * 2.");
    expect(script).toBe("Scene\n[sad] Professor Vale met St. John. Source 2 * 2.");
  });

  it("sends normalized hidden text to Fish without changing the caller's narration", async () => {
    const narration = "Capt. Rao has 50% HP.";
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } }));
    const provider = new FishAudioProvider("test-key", fetcher as typeof fetch);
    await provider.synthesize({ text: narration, model: "s2.1-pro", speed: 1, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 500 });
    expect(JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body)).text).toBe("Captain Rao has 50 percent H.P.");
    expect(narration).toBe("Capt. Rao has 50% HP.");
  });

  it("rejects input that contains no speakable text after normalization", async () => {
    const provider = new FishAudioProvider("test-key", vi.fn() as typeof fetch);
    const request: TTSRequest = { text: "![cover](https://example.com/cover.png)", model: "s2-pro", speed: 1, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 500 };
    await expect(provider.synthesize(request)).rejects.toThrow(/empty after speech normalization/);
  });

  it("rejects empty and non-audio success responses", async () => {
    const request: TTSRequest = { text: "Hello", model: "s2-pro", speed: 1, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 500 };
    const empty = new FishAudioProvider("test-key", vi.fn(async () => new Response(new Uint8Array(), { status: 200, headers: { "content-type": "audio/mpeg" } })) as typeof fetch);
    await expect(empty.synthesize(request)).rejects.toThrow(/empty audio/);
    const json = new FishAudioProvider("test-key", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch);
    await expect(json.synthesize(request)).rejects.toThrow(/unexpected content type/);
  });
});
