import { describe, expect, it } from "vitest";
import { stripFishLeadingHehe, normalizeSpeechForProvider } from "../src/tts/speech-normalization.js";
import { normalizeFishSpeechText } from "../src/tts/fish/speech-normalizer.js";
import type { TTSProvider } from "../src/tts/provider.js";

describe("Fish opening hehe laughter", () => {
  it.each(["Hehe,", "Hehe...", "hehe,", "HEHE…", "Hehehe!", "Hehe hehe..."])("omits %s while preserving dialogue", laughter => {
    const text = `corpses would be worth a pretty penny!\n\n“${laughter} Someone else might, but I believe you wouldn’t.”\n\nAsher shook his head with a smile.`;
    expect(stripFishLeadingHehe(text)).toBe(text.replace(`${laughter} `, ""));
    for (const model of ["s2-pro", "s1"]) {
      const speech = normalizeFishSpeechText(text, model);
      expect(speech).not.toMatch(/hehe|\[laughing\]/i);
      expect(speech).toContain("Someone else might");
      expect(speech).toContain("Asher shook his head with a smile.");
    }
  });
  it("keeps literal mentions, names and laughter inside prose intact", () => {
    const text = 'He typed "hehe". The word hehe, appeared twice. Heheland is a place.';
    expect(stripFishLeadingHehe(text)).toBe(text);
  });
  it("omits laughter before shared provider rendering can expand or tag it", () => {
    const provider = { name: "fish", vocalizationStrategy: () => ({ kind: "native_tags", tags: { laugh: "[laughing]" } }) } as unknown as TTSProvider;
    const text = '“Hehe... Someone else might.”';
    expect(normalizeSpeechForProvider(text, "en-US", {}, provider, "s2-pro").normalized.text).toBe('“Someone else might.”');
    expect(text).toContain("Hehe...");
  });
});
