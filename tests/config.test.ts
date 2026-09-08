import { describe, expect, it } from "vitest";
import { loadEnvironment, requireProviderKey } from "../src/config/env.js";
import { storySchema } from "../src/domain/story.js";

describe("configuration", () => {
  it("loads valid values and defaults", () => {
    const env = loadEnvironment({ OPENAI_API_KEY: "test", GEMINI_API_KEY: "test", FISH_AUDIO_API_KEY: "test" });
    expect(env.FISH_AUDIO_MODEL).toBe("s2-pro");
    expect(env.FISH_AUDIO_MP3_BITRATE).toBe(128);
  });

  it("reports a missing provider key without revealing secrets", () => {
    const env = loadEnvironment({});
    expect(() => requireProviderKey(env, "openai")).toThrow(/OPENAI_API_KEY/);
  });

  it("rejects invalid provider names", () => {
    const result = storySchema.safeParse({
      id: "x", slug: "x", title: "X", sourceLanguage: "zh-CN", outputLanguage: "en-US", source: { type: "text" },
      pipeline: { translation: { provider: "unknown", model: "x" }, narration: { provider: "openai", model: "x" }, storyBible: { provider: "gemini", model: "x" }, tts: { provider: "fish", model: "s2-pro" } },
    });
    expect(result.success).toBe(false);
  });
});
