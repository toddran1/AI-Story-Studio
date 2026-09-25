import { describe, expect, it } from "vitest";
import { loadEnvironment, requireProviderKey, resolveStudioRoot } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";
import { storySchema } from "../src/domain/story.js";
import { ttsQualityMode } from "../src/domain/provider.js";

describe("configuration", () => {
  it("loads valid values and defaults", () => {
    const env = loadEnvironment({ OPENAI_API_KEY: "test", GEMINI_API_KEY: "test", FISH_AUDIO_API_KEY: "test" });
    expect(env.FISH_AUDIO_MODEL).toBe("s2.1-pro");
    expect(env.FISH_AUDIO_MP3_BITRATE).toBe(128);
  });

  it("uses an explicit FISH_AUDIO_MODEL for new stories", () => {
    const env = loadEnvironment({ FISH_AUDIO_MODEL: "s2.1-pro-free" });
    expect(env.FISH_AUDIO_MODEL).toBe("s2.1-pro-free");
    expect(defaultStory("new-story", env).pipeline.tts).toMatchObject({ model: "s2.1-pro-free", voiceMode: "same-voice-dialogue", deliveryIntensity: "restrained", qualityMode: "off", qualityGuard: false, maxCharsPerRequest: 1750 });
  });

  it("maps legacy qualityGuard stories to verification without automatic Fish repair", () => {
  it("defaults legacy stories without explicit qualityMode to off regardless of qualityGuard", () => {
    const story = defaultStory("legacy-story", loadEnvironment({}));
    const legacy = storySchema.parse({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, qualityMode: undefined, qualityGuard: true, maxQualityRetries: 2 } } });
    expect(ttsQualityMode(legacy.pipeline.tts)).toBe("verify");
    // Case A: qualityMode unset, qualityGuard: true -> "off"
    const legacyA = storySchema.parse({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, qualityMode: undefined, qualityGuard: true, maxQualityRetries: 2 } } });
    expect(ttsQualityMode(legacyA.pipeline.tts)).toBe("off");

    // Case B: qualityMode unset, qualityGuard: false -> "off"
    const legacyB = storySchema.parse({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, qualityMode: undefined, qualityGuard: false, maxQualityRetries: 2 } } });
    expect(ttsQualityMode(legacyB.pipeline.tts)).toBe("off");

    // Case C: qualityMode: "verify", qualityGuard: false -> "verify"
    const legacyC = storySchema.parse({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, qualityMode: "verify", qualityGuard: false, maxQualityRetries: 2 } } });
    expect(ttsQualityMode(legacyC.pipeline.tts)).toBe("verify");

    // Case D: qualityMode: "auto_repair", qualityGuard: false -> "auto_repair"
    const legacyD = storySchema.parse({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, qualityMode: "auto_repair", qualityGuard: false, maxQualityRetries: 2 } } });
    expect(ttsQualityMode(legacyD.pipeline.tts)).toBe("auto_repair");
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

  it("migrates an empty two-voice cast to same-voice dialogue delivery", () => {
    const story = defaultStory("new-story", loadEnvironment({}));
    const parsed = storySchema.parse({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, voiceMode: "narrator-dialogue", secondaryReferenceId: undefined } } });
    expect(parsed.pipeline.tts.voiceMode).toBe("same-voice-dialogue");
  });
});
