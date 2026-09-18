import { describe, expect, it } from "vitest";
import { canonicalEntitySchema, hasActivePronunciation, pronunciationSchema } from "../src/domain/story-bible.js";
import { adaptPronunciationText, enrichPronunciation, enrichPronunciationBatch, pronunciationFingerprint, pronunciationProvider, resolvePronunciations } from "../src/tts/pronunciation.js";
import { normalizeSpeechText } from "../src/tts/speech-normalization.js";
import { ProviderError } from "../src/pipeline/errors.js";
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
  it("receives normalized speech before provider-specific pronunciation adaptation", () => {
    const written = 'Jiang Yue activates its "Worry-Free EXP" feature.';
    const spoken = normalizeSpeechText(written, "en-US").text;
    const occurrences = resolvePronunciations(spoken, [entity]);
    expect(spoken).toBe("Jiang Yue activates its Worry-Free E-X-P feature.");
    expect(adaptPronunciationText(spoken, occurrences, { phoneticText: true })).toBe("Jyang Yweh activates its Worry-Free E-X-P feature.");
    expect(written).toContain('"Worry-Free EXP"');
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

describe("active pronunciation intent", () => {
  it("defines exactly which records actively steer TTS and QA", () => {
    expect(hasActivePronunciation(undefined)).toBe(false);
    expect(hasActivePronunciation({ mode: "custom", customPronunciation: "Jyang Yweh", source: "manual" })).toBe(true);
    expect(hasActivePronunciation({ mode: "automatic", phoneticHint: "Jyang Yweh", locked: true })).toBe(true);
    // Legacy unresolved AI records (never accepted) are suggestions, not configuration.
    expect(hasActivePronunciation({ mode: "automatic", sourceLanguage: "zh-CN", confidence: 0, needsReview: true, source: "ai", locked: false })).toBe(false);
    expect(hasActivePronunciation({ mode: "automatic", phoneticHint: "Jyang Yweh", confidence: .6, needsReview: true, source: "ai" })).toBe(false);
    // Confident AI records already in effect stay active.
    expect(hasActivePronunciation({ mode: "automatic", phoneticHint: "Jyang Yweh", confidence: .95, source: "ai" })).toBe(true);
  });
  it("never resolves or fingerprints inactive pronunciation records", () => {
    const legacy = { ...entity, pronunciation: { mode: "automatic" as const, sourceLanguage: "zh-CN", confidence: 0, needsReview: true, source: "ai" as const, locked: false } };
    expect(resolvePronunciations("Jiang Yue entered.", [legacy])).toEqual([]);
    expect(resolvePronunciations("Jiang Yue entered.", [{ ...entity, pronunciation: undefined }])).toEqual([]);
    expect(pronunciationFingerprint(resolvePronunciations("Jiang Yue entered.", [legacy]))).toBeUndefined();
    // The provider wrapper is a no-op without active pronunciation.
    const tts = { name: "fake", synthesize: async (request: unknown) => request } as unknown as import("../src/tts/provider.js").TTSProvider;
    expect(pronunciationProvider(tts, [legacy])).toBe(tts);
    expect(pronunciationProvider(tts, [{ ...entity, pronunciation: undefined }])).toBe(tts);
    expect(pronunciationProvider(tts, [entity])).not.toBe(tts);
  });
});

describe("pronunciation batch enrichment resilience", () => {
  const config = { provider: "openai", model: "fake" } as const;
  const candidates = [
    { entity: { ...entity, pronunciation: undefined }, evidence: [] },
    { entity: { ...entity, id: "ent_223456789012345678901234", canonicalName: "Mo Xie", pronunciation: undefined }, evidence: [] },
  ];
  const single = (id: string) => ({ pronunciation: { mode: "automatic" as const, phoneticHint: `hint-${id}`, confidence: .8, source: "ai" as const } });
  it("falls back to per-entity enrichment when the batch response shape is invalid", async () => {
    const provider = {
      generateStructured: async (request: { schemaName: string; schema: { parse(value: unknown): unknown } }) => {
        if (request.schemaName === "entity_pronunciation_batch") {
          // Mirror the production failure: the model returned JSON without the results array.
          request.schema.parse({});
          throw new Error("parse should have failed");
        }
        const input = JSON.parse((request as unknown as { input: string }).input) as { entity: { id: string } };
        return { value: single(input.entity.id), usage: { requestId: `req-${input.entity.id}`, inputTokens: 10, outputTokens: 5 } };
      },
    } as unknown as LLMProvider;
    const result = await enrichPronunciationBatch(provider, config, candidates, "zh-CN");
    expect([...result.pronunciations.keys()].sort()).toEqual(candidates.map(item => item.entity.id).sort());
    expect(result.pronunciations.get(candidates[0]!.entity.id)?.phoneticHint).toBe(`hint-${candidates[0]!.entity.id}`);
    expect(result.usage?.inputTokens).toBe(20);
  });
  it("still propagates genuine request failures", async () => {
    const provider = { generateStructured: async () => { throw new ProviderError("Gemini structured Interactions API request failed"); } } as unknown as LLMProvider;
    await expect(enrichPronunciationBatch(provider, config, candidates, "zh-CN")).rejects.toThrow("Interactions API request failed");
  });
});
