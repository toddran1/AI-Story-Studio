import { describe, expect, it, vi } from "vitest";
import { FishAudioProvider } from "../src/tts/fish/fish-audio.provider.js";
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

  it("uses Fish's documented S2.1 production controls for the paid and free S2.1 models", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    const provider = new FishAudioProvider("test-key", fetcher as typeof fetch);
    await provider.synthesize({ text: "Hello", model: "s2.1-pro-free", speed: 1, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 500 });
    const body = JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({ temperature: .7, top_p: .7, chunk_length: 300, repetition_penalty: 1.2, condition_on_previous_chunks: true });
  });

  it("rejects empty and non-audio success responses", async () => {
    const request: TTSRequest = { text: "Hello", model: "s2-pro", speed: 1, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 500 };
    const empty = new FishAudioProvider("test-key", vi.fn(async () => new Response(new Uint8Array(), { status: 200, headers: { "content-type": "audio/mpeg" } })) as typeof fetch);
    await expect(empty.synthesize(request)).rejects.toThrow(/empty audio/);
    const json = new FishAudioProvider("test-key", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch);
    await expect(json.synthesize(request)).rejects.toThrow(/unexpected content type/);
  });
});
