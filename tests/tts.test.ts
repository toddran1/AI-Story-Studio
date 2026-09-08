import { describe, expect, it, vi } from "vitest";
import { FishAudioProvider } from "../src/tts/fish/fish-audio.provider.js";
import { splitForTTS } from "../src/tts/split-text.js";

describe("Fish TTS", () => {
  it("splits on natural boundaries", () => {
    const chunks = splitForTTS(`${"First sentence. ".repeat(40)}\n\n${"Second paragraph. ".repeat(40)}`, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
  });

  it("uses mocked Fish responses and combines segments", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "x-request-id": "req" } }));
    const provider = new FishAudioProvider("test-key", fetcher as typeof fetch);
    const result = await provider.synthesize({ text: `${"Sentence. ".repeat(150)}`, model: "s2-pro", speed: 1, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 500 });
    expect(fetcher).toHaveBeenCalled();
    expect(result.segments.length).toBeGreaterThan(1);
    expect(result.audio.length).toBe(result.segments.reduce((sum, value) => sum + value.length, 0));
  });
});
