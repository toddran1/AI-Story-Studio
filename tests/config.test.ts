import { describe, expect, it } from "vitest";
import { loadEnvironment, requireProviderKey, resolveStudioRoot } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";
import { storySchema } from "../src/domain/story.js";

describe("configuration", () => {
  it("loads valid values and defaults", () => {
    const env = loadEnvironment({ OPENAI_API_KEY: "test", GEMINI_API_KEY: "test", FISH_AUDIO_API_KEY: "test" });
    expect(env.FISH_AUDIO_MODEL).toBe("s2.1-pro");
    expect(env.FISH_AUDIO_MP3_BITRATE).toBe(128);
  });

  it("uses an explicit FISH_AUDIO_MODEL for new stories", () => {
    const env = loadEnvironment({ FISH_AUDIO_MODEL: "s2.1-pro-free" });
    expect(env.FISH_AUDIO_MODEL).toBe("s2.1-pro-free");
    expect(defaultStory("new-story", env).pipeline.tts.model).toBe("s2.1-pro-free");
  });

  it("reports a missing provider key without revealing secrets", () => {
    const env = loadEnvironment({});
    expect(() => requireProviderKey(env, "openai")).toThrow(/OPENAI_API_KEY/);
  });

  it("resolves persistent data independently from the source checkout", () => {
    expect(resolveStudioRoot(loadEnvironment({ STUDIO_DATA_ROOT: "../studio-data" }), "/project/app")).toBe("/project/studio-data");
    expect(resolveStudioRoot(loadEnvironment({ STUDIO_DATA_ROOT: "/Volumes/Studio/data" }), "/project/app")).toBe("/Volumes/Studio/data");
  });

  it("rejects invalid provider names", () => {
    const result = storySchema.safeParse({
      id: "x", slug: "x", title: "X", sourceLanguage: "zh-CN", outputLanguage: "en-US", source: { type: "text" },
      pipeline: { translation: { provider: "unknown", model: "x" }, narration: { provider: "openai", model: "x" }, storyBible: { provider: "gemini", model: "x" }, tts: { provider: "fish", model: "s2-pro" } },
    });
    expect(result.success).toBe(false);
  });
});
