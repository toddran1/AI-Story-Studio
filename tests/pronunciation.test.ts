import { describe, expect, it } from "vitest";
import { canonicalEntitySchema, pronunciationSchema } from "../src/domain/story-bible.js";
import { adaptPronunciationText, enrichPronunciation, pronunciationFingerprint, resolvePronunciations } from "../src/tts/pronunciation.js";
import type { LLMProvider } from "../src/llm/provider.js";

const entity = canonicalEntitySchema.parse({ id: "ent_123456789012345678901234", type: "character", canonicalName: "Jiang Yue", originalName: "江月", aliases: ["Mr. Jiang"], firstAppearance: 1, lastKnownAppearance: 2,
  pronunciation: { mode: "automatic", sourceLanguage: "zh-CN", romanization: "Jiāng Yuè", phoneticHint: "Jyang Yweh", confidence: .9 } });

describe("provider-neutral pronunciation foundation", () => {
  it("reuses location roots and keeps translated place suffixes audible", () => {
    const location = { ...entity, type: "location" as const, canonicalName: "Jiangcheng City", originalName: "江城", aliases: [], pronunciation: { mode: "automatic" as const, phoneticHint: "Jyang cheng", confidence: .9 } };
    const text = "Jiangcheng City was quiet. Jiangcheng slept.";
    const references = resolvePronunciations(text, [location]); expect(references).toHaveLength(2);
    expect(adaptPronunciationText(text, references, { phoneticText: true })).toBe("Jyang cheng City was quiet. Jyang cheng slept.");
  });
  it("does not apply speculative low-confidence hints", () => {
    const low = { ...entity, pronunciation: { ...entity.pronunciation!, confidence: .2 } };
    expect(adaptPronunciationText("Jiang Yue", resolvePronunciations("Jiang Yue", [low]), { phoneticText: true })).toBe("Jiang Yue");
  });
  it("resolves aliases and possessives to one identity without changing visible text", () => {
    const text = "Jiang Yue’s sword. Mr. Jiang replied. NotJiang Yue.";
    const occurrences = resolvePronunciations(text, [entity]);
    expect(occurrences.map(item => item.surfaceText)).toEqual(["Jiang Yue", "Mr. Jiang"]);
    expect(new Set(occurrences.map(item => item.entityId)).size).toBe(1);
    expect(adaptPronunciationText(text, occurrences, { phoneticText: true })).toBe("Jyang Yweh’s sword. Mr. Jyang replied. NotJiang Yue.");
    expect(text).toContain("Jiang Yue’s");
    expect(adaptPronunciationText(text, occurrences, {})).toBe(text);
  });
  it.each(["character", "location", "organization", "ability", "item", "concept"] as const)("supports %s identities", type => {
    expect(resolvePronunciations("Jiang Yue", [{ ...entity, type }])[0]?.pronunciation.sourceLanguage).toBe("zh-CN");
  });
  it("does not apply automatic foreign hints to localized English names", () => {
    const localized = { ...entity, localizedNaming: { locale: "en-US", fullName: "Malakai Sterling", shortName: "Malakai", usageMode: "ai_contextual" as const } };
    expect(resolvePronunciations("Malakai Sterling greeted Malakai.", [localized])).toEqual([]);
    expect(resolvePronunciations("Malakai", [{ ...localized, pronunciation: { mode: "custom", customPronunciation: "MAL uh kai" } }])).toHaveLength(1);
  });
  it("leaves ambiguous aliases alone", () => {
    expect(resolvePronunciations("Mr. Jiang", [entity, { ...entity, id: "ent_223456789012345678901234" }])).toEqual([]);
  });
  it("fingerprints only referenced sound fields, retaining legacy absence", () => {
    expect(pronunciationFingerprint([])).toBeUndefined();
    const fp = pronunciationFingerprint(resolvePronunciations("Jiang Yue", [entity]));
    expect(pronunciationFingerprint(resolvePronunciations("Jiang Yue", [{ ...entity, pronunciation: { ...entity.pronunciation!, locked: true, confidence: .8 } }]))).toBe(fp);
    expect(pronunciationFingerprint(resolvePronunciations("Jiang Yue", [{ ...entity, pronunciation: { ...entity.pronunciation!, phoneticHint: "different" } }]))).not.toBe(fp);
  });
  it("rejects incomplete custom overrides", () => {
    expect(pronunciationSchema.safeParse({ mode: "custom" }).success).toBe(false);
  });
  it("protects locked enrichment without contacting a provider", async () => {
    const provider = { generateStructured: () => { throw new Error("must not call"); } } as unknown as LLMProvider;
    const locked = { ...entity, pronunciation: { ...entity.pronunciation!, locked: true } };
    expect((await enrichPronunciation(provider, { provider: "openai", model: "fake" }, locked, "zh-CN")).pronunciation).toEqual(locked.pronunciation);
  });
});
