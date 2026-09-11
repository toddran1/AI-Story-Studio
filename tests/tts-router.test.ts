import { describe, expect, it } from "vitest";
import { TTSProvider } from "../src/tts/provider.js";
import { TTSProviderRouter } from "../src/tts/router.js";

function provider(name: string): TTSProvider {
  return { name, validateConfiguration: async () => undefined, synthesize: async () => ({ audio: new Uint8Array([1]), segments: [new Uint8Array([1])] }) };
}

describe("TTS provider router", () => {
  it("resolves providers by stable provider ID", () => {
    const fish = provider("fish"); const future = provider("future-audio");
    const router = new TTSProviderRouter(new Map([[fish.name, fish], [future.name, future]]));
    expect(router.forName("fish")).toBe(fish); expect(router.forName("future-audio")).toBe(future);
    expect(router.names()).toEqual(["fish", "future-audio"]);
  });

  it("fails clearly when a saved provider is not installed", () => {
    const router = new TTSProviderRouter(provider("fish"));
    expect(() => router.forName("missing")).toThrow(/not installed.*fish/i);
  });
});
