import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalEntitySchema } from "../src/domain/story-bible.js";
import { pronunciationDictionarySchema } from "../src/domain/pronunciation-dictionary.js";
import { buildPronunciationDictionary } from "../src/tts/pronunciation-dictionary.js";
import { renderFishPronunciationDictionary } from "../src/tts/fish/pronunciation-dictionary.js";
import { FishAudioProvider } from "../src/tts/fish/fish-audio.provider.js";
import { createEffectiveTtsProvider } from "../src/tts/effective-provider.js";
import type { TTSRequest } from "../src/tts/types.js";

const entity = (canonicalName = "Zhang Qitian", originalName = "张启天", extra: Record<string, unknown> = {}) => canonicalEntitySchema.parse({ id: "ent_0123456789abcdef01234567", type: "character", canonicalName, originalName, firstAppearance: 1, lastKnownAppearance: 1, ...extra });
const policy = { sourceLanguage: "zh-CN" };
const base: TTSRequest = { text: "Zhang Qitian arrived.", model: "s2.1-pro-free", speed: 1, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 500 };
const phoneme = (text: string) => `<|phoneme_start|>${text}<|phoneme_end|>`;
const mockFish = () => {
  const bodies: any[] = [];
  const fetcher = vi.fn(async (_url: any, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }); });
  return { bodies, fetcher, provider: new FishAudioProvider("fake-key", fetcher as typeof fetch) };
};

describe("story-wide pronunciation dictionary", () => {
  it("derives consistent Mandarin names and surname guidance from matching source characters", () => {
    const rules = buildPronunciationDictionary([entity()], policy);
    expect(rules).toContainEqual({ text: "Zhang Qitian", alphabet: "pinyin", phonemes: "zhang1 qi3 tian1" });
    expect(rules).toContainEqual({ text: "Zhang", alphabet: "pinyin", phonemes: "zhang1" });
    expect(renderFishPronunciationDictionary("Master Zhang replied.", rules, base.model)).toBe(`Master ${phoneme("zhang1")} replied.`);
  });
  it("keeps localized names, translated terms, uncertain spellings and unsupported dialects untouched", () => {
    expect(buildPronunciationDictionary([entity("Asher Sterling", "苏铭", { localizedNaming: { locale: "en-US", fullName: "Asher Sterling", shortName: "Asher", usageMode: "always_full" } })], policy)).toEqual([]);
    expect(buildPronunciationDictionary([entity("Undead Summoning", "亡灵召唤")], policy)).toEqual([]);
    expect(buildPronunciationDictionary([entity("Zhang Qitian", "unknown")], policy)).toEqual([]);
    expect(buildPronunciationDictionary([entity()], { sourceLanguage: "ja" })).toEqual([]);
    expect(buildPronunciationDictionary([entity("Zhang Qitian", "张启天", { pronunciation: { mode: "automatic", sourceLanguage: "yue" } })], policy)).toEqual([]);
    expect(buildPronunciationDictionary([entity()], { ...policy, sourceLanguagePronunciation: false })).toEqual([]);
  });
  it("uses source-backed guidance when an AI hint is unresolved and inactive", () => {
    const rules = buildPronunciationDictionary([entity("Zhang Qitian", "张启天", { pronunciation: { mode: "automatic", source: "ai", phoneticHint: "uncertain", needsReview: true, confidence: .2 } })], policy);
    expect(rules.some(rule => rule.text === "Zhang Qitian")).toBe(true);
  });
  it("does not infer a bare English word from a Chinese surname", () => {
    const rules = buildPronunciationDictionary([entity("He Ming", "何明")], policy);
    expect(rules.some(rule => rule.text === "He")).toBe(false);
    expect(renderFishPronunciationDictionary("He walked home.", rules, base.model)).toBe("He walked home.");
  });
  it("lets an explicit surname rule override longer derived full-name rules", () => {
    const rules = buildPronunciationDictionary([entity()], { ...policy, pronunciationDictionary: [{ text: "Zhang", alphabet: "arpabet", phonemes: "JH AA1 NG" }] });
    expect(renderFishPronunciationDictionary(base.text, rules, base.model)).toBe(`${phoneme("JH AA1 NG")} Qitian arrived.`);
  });
  it("matches whole words, chooses longer phrases and protects existing controls", () => {
    const rules = pronunciationDictionarySchema.parse([{ text: "Li", alphabet: "pinyin", phonemes: "li3" }, { text: "Li Ming", alphabet: "pinyin", phonemes: "li3 ming2" }]);
    const output = renderFishPronunciationDictionary("Little Li met Li Ming. [Li]", rules, base.model);
    expect(output).toBe(`Little ${phoneme("li3")} met ${phoneme("li3")}${phoneme("ming2")}. [Li]`);
    expect(renderFishPronunciationDictionary(phoneme("li3"), rules, base.model)).toBe(phoneme("li3"));
  });
  it("rejects duplicate keys, malformed phonemes and injected provider tags", () => {
    for (const rules of [
      [{ text: "Zhang", alphabet: "pinyin", phonemes: "zhang" }],
      [{ text: "Zhang", alphabet: "arpabet", phonemes: "INVALID" }],
      [{ text: "Zhang", alphabet: "pinyin", phonemes: "[shouting]" }],
      [{ text: "Zhang", alphabet: "pinyin", phonemes: "zhang1" }, { text: "zhang", alphabet: "pinyin", phonemes: "zhang4" }],
    ]) expect(pronunciationDictionarySchema.safeParse(rules).success).toBe(false);
  });
  it("preserves explicitly configured entity pronunciations over dictionary defaults", async () => {
    const fish = mockFish();
    const { provider } = createEffectiveTtsProvider({ baseProvider: fish.provider, pronunciationEntities: [entity("Zhang Qitian", "张启天", { pronunciation: { mode: "custom", source: "manual", customPronunciation: "Zhang Chee Tyan" } })], pronunciationPolicy: { ...policy, pronunciationDictionary: [{ text: "Zhang", alphabet: "pinyin", phonemes: "zhang1" }] } });
    await provider.synthesize(base);
    expect(fish.bodies[0].text).toBe("Zhang Chee Tyan arrived.");
  });
  it("sends the same guidance on each chunk and on exact manual regeneration without modifying review text", async () => {
    const fish = mockFish();
    const { provider } = createEffectiveTtsProvider({ baseProvider: fish.provider, pronunciationEntities: [entity()], pronunciationPolicy: policy });
    const paragraph = "Zhang Qitian arrived. " + "The battle continued. ".repeat(14);
    const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    const result = await provider.synthesize({ ...base, text });
    expect(fish.bodies).toHaveLength(3);
    for (const body of fish.bodies) expect(body.text).toContain(phoneme("zhang1"));
    expect(result.segmentTexts?.every(text => text.includes("Zhang Qitian") && !text.includes("phoneme_start"))).toBe(true);
    await provider.synthesize({ ...base, text: result.segmentTexts![1]!, exactChunk: true, singleAttempt: true });
    expect(fish.bodies).toHaveLength(4);
    expect(fish.bodies[3].text).toContain(phoneme("qi3"));
  });
  it("retains phoneme guidance through an automatic quality retry", async () => {
    const fish = mockFish();
    const transcriber = { name: "fake", validateConfiguration: async () => {}, transcribe: async () => [{ text: "unrelated incorrect words", start: 0, end: 1, confidence: 1 }] };
    const { provider } = createEffectiveTtsProvider({ baseProvider: fish.provider, pronunciationEntities: [entity()], pronunciationPolicy: policy, qualityMode: "auto_repair", maxQualityRetries: 1, language: "en-US", transcriber });
    await provider.synthesize(base);
    expect(fish.bodies).toHaveLength(2);
    expect(fish.bodies.every(body => body.text.includes(phoneme("zhang1")) && body.text.includes(phoneme("qi3")))).toBe(true);
  });
  it("preserves localized names from derived surnames but allows explicit dictionary corrections", async () => {
    const fish = mockFish();
    const localized = entity("Original Name", "原名", { id: "ent_abcdef0123456789abcdef01", localizedNaming: { locale: "en-US", fullName: "Zhang Smith", shortName: "Zhang", usageMode: "always_full" } });
    const rules = buildPronunciationDictionary([entity(), localized], policy);
    expect(renderFishPronunciationDictionary("Zhang Smith arrived.", rules, base.model)).toBe("Zhang Smith arrived.");
    const { provider } = createEffectiveTtsProvider({ baseProvider: fish.provider, pronunciationEntities: [localized], pronunciationPolicy: { ...policy, pronunciationDictionary: [{ text: "Zhang Smith", alphabet: "arpabet", phonemes: "JH AA1 NG S M IH1 TH" }] } });
    await provider.synthesize({ ...base, text: "Zhang Smith arrived." });
    expect(fish.bodies[0].text).toBe(`${phoneme("JH AA1 NG S M IH1 TH")} arrived.`);
  });
  it("invalidates chunk checkpoints when a pronunciation rule changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dictionary-checkpoint-"));
    try {
      const fish = mockFish();
      const first = [{ text: "Zhang", alphabet: "pinyin" as const, phonemes: "zhang1" }];
      await fish.provider.synthesize({ ...base, text: "Zhang arrived.", checkpointDir: root, pronunciationDictionary: first });
      const reused = await fish.provider.synthesize({ ...base, text: "Zhang arrived.", checkpointDir: root, pronunciationDictionary: first });
      expect(reused.reusedChunks).toBe(1);
      await fish.provider.synthesize({ ...base, text: "Zhang arrived.", checkpointDir: root, pronunciationDictionary: [{ ...first[0]!, phonemes: "zhang4" }] });
      expect(fish.bodies).toHaveLength(2);
      expect(fish.bodies[1].text).toContain(phoneme("zhang4"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("only fingerprints rules referenced by the narration", () => {
    const fish = mockFish();
    const { provider } = createEffectiveTtsProvider({ baseProvider: fish.provider, pronunciationEntities: [entity()], pronunciationPolicy: policy });
    expect(provider.pronunciationFingerprint?.("The battle continued.")).toBeUndefined();
    expect(provider.pronunciationFingerprint?.(base.text)).toBeTruthy();
  });
});
