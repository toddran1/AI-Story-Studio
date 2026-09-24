import { describe, expect, it } from "vitest";
import { normalizeSpeechForProvider, normalizeSpeechText, speechNormalizationFingerprint, speechNormalizationSettingsFromNarration } from "../src/tts/speech-normalization.js";
import type { VocalizationRenderStrategy } from "../src/tts/vocalizations.js";

const fishS2Tags: VocalizationRenderStrategy = { kind: "native_tags", tags: { laugh: "[laugh]", chuckle: "[laugh]", sigh: "[sigh]", gasp: "[gasp]" } };
const fiendDragon = "Hahaha... Brat, once my fiend dragon comes out, all your bullshit undead are nothing but ants!";

describe("provider-neutral speech normalization", () => {
  it("speaks high-confidence English structured values naturally", () => {
    const result = normalizeSpeechText("At 23:57, she paid $12.50 for 5 km of travel. Chapter 21 reached 42% at 1,500 meters with 10 kg.", "en-US");
    expect(result.text).toBe("At eleven fifty-seven p.m., she paid twelve dollars and fifty cents for five kilometers of travel. chapter twenty-one reached forty-two percent at one thousand five hundred meters with ten kilograms.");
    expect(result.transformations.map(item => item.kind)).toEqual(["time", "currency", "percentage", "measurement", "measurement", "chapter", "number"]);
  });

  it("handles natural 12-hour clock edge cases", () => {
    expect(normalizeSpeechText("07:05. 00:00. 12:00. 14:30. 3:30 PM.", "en-US").text).toBe("seven oh five a.m. midnight. noon. two thirty p.m. three thirty p.m.");
  });

  it("can preserve or use natural 24-hour time without changing visible input", () => {
    const written = "The clock reads 23:57.";
    expect(normalizeSpeechText(written, "en-US", { timeSpeechMode: "preserve" }).text).toBe(written);
    expect(normalizeSpeechText(written, "en-US", { timeSpeechMode: "natural_24h" }).text).toBe("The clock reads twenty-three fifty-seven.");
  });

  it("avoids ratios, chapter references, years, identifiers, and non-English automatic mode", () => {
    const written = "The ratio was 3:1. John 3:16 was cited. Code A23:57 and year 2025 remain.";
    expect(normalizeSpeechText(written, "en-US").text).toBe(written);
    expect(normalizeSpeechText("23:57", "zh-CN").text).toBe("23:57");
  });

  it("keeps quoted labels continuous when they are part of a named noun phrase", () => {
    const written = 'It activates its "Worry-Free EXP" feature, the "Devour" skill, his "Shadow Step" ability, the "S-Rank Necromancer" class, an "SSS-Rank" talent, and the "Blood Moon" dungeon.';
    const result = normalizeSpeechText(written, "en-US");
    expect(written).toContain('"Worry-Free EXP"');
    expect(result.text).toBe("It activates its Worry-Free E X P feature, the Devour skill, his Shadow Step ability, the S-Rank Necromancer class, an SSS-Rank talent, and the Blood Moon dungeon.");
    expect(result.transformations.filter((item) => item.kind === "quoted-label")).toHaveLength(6);
  });

  it("does not strip dialogue or ordinary quotations", () => {
    const written = '"Worry-Free EXP," she said. He answered, "Do not call that NPC a feature."';
    expect(normalizeSpeechText(written, "en-US").text).toBe('"Worry-Free E X P," she said. He answered, "Do not call that N P C a feature."');
  });

  it("uses deterministic defaults and story overrides for abbreviations", () => {
    expect(normalizeSpeechText("EXP XP HP MP NPC", "en-US").text).toBe("E X P X P H P M P N P C");
    expect(normalizeSpeechText("EXP and HP", "en-US", { speechAbbreviations: { EXP: "experience points", HP: "health points" } }).text).toBe("experience points and health points");
  });

  it("consumes malformed EXP slashes and speaks stat values", () => {
    expect(normalizeSpeechText("EXP EXP/ EXP / EXP/100 EXP / 100", "en-US").text).toBe("E X P E X P E X P E X P: one hundred E X P: one hundred");
  });

  it("turns bounded stat panels into speech and preserves prose parentheses", () => {
    const level = normalizeSpeechText("【Level: Level 50 (EXP/)】", "en-US");
    expect(level.text).toBe("Level: Level fifty. E X P.");
    expect(level.transformations.some((item) => item.kind === "structured-block")).toBe(true);
    expect(normalizeSpeechText("【Damage Transfer (Passive) (Level Max)】", "en-US").text).toBe("Damage Transfer. Passive. Level Max.");
    expect(normalizeSpeechText("Damage Transfer (Passive) (Level Max)", "en-US").text).toBe("Damage Transfer. Passive. Level Max.");
    expect(normalizeSpeechText("Asher looked at Mo Xie (who was still laughing) and sighed.", "en-US").text).toBe("Asher looked at Mo Xie (who was still laughing) and sighed.");
  });

  it("fingerprints the spoken representation and relevant settings only", () => {
    const first = speechNormalizationFingerprint("23:57", "en-US", { mode: "automatic", timeSpeechMode: "natural_12h" });
    const same = speechNormalizationFingerprint("23:57", "en-US", { mode: "automatic", timeSpeechMode: "natural_12h" });
    const changed = speechNormalizationFingerprint("23:57", "en-US", { mode: "automatic", timeSpeechMode: "natural_24h" });
    const abbreviationsChanged = speechNormalizationFingerprint("EXP", "en-US", { speechAbbreviations: { EXP: "experience points" } });
    const ordered = speechNormalizationFingerprint("EXP and HP", "en-US", { speechAbbreviations: { EXP: "experience points", HP: "health points" } });
    const reordered = speechNormalizationFingerprint("EXP and HP", "en-US", { speechAbbreviations: { HP: "health points", EXP: "experience points" } });
    expect(first.fingerprint).toBe(same.fingerprint); expect(first.fingerprint).not.toBe(changed.fingerprint); expect(first.fingerprint).not.toBe(abbreviationsChanged.fingerprint); expect(ordered.fingerprint).toBe(reordered.fingerprint);
  });
});

describe("vocalization speech normalization", () => {
  it("rewrites vocalizations to canonical short forms with safe_normalize (the default)", () => {
    const result = normalizeSpeechText('"Hahahahahahaha!" he crowed. "Grrrrrrrrrr!" came the reply.', "en-US");
    expect(result.text).toBe('"Hahaha!" he crowed. "Grrr!" came the reply.');
    expect(result.transformations).toEqual([
      { kind: "vocalization", written: "Grrrrrrrrrr!", spoken: "Grrr!", start: 30, end: 42 },
      { kind: "vocalization", written: "Hahahahahahaha!", spoken: "Hahaha!", start: 1, end: 16 },
    ]);
  });

  it("records a vocalization transformation even when the canonical form matches the written form", () => {
    const result = normalizeSpeechText(fiendDragon, "en-US");
    expect(result.text).toBe(fiendDragon);
    expect(result.transformations).toEqual([{ kind: "vocalization", written: "Hahaha...", spoken: "Hahaha...", start: 0, end: 9 }]);
  });

  it("renders mapped types as native tags and leaves unmapped types to the fallback", () => {
    const tagged = normalizeSpeechText(fiendDragon, "en-US", {}, fishS2Tags);
    expect(tagged.text).toBe("[laugh] Brat, once my fiend dragon comes out, all your bullshit undead are nothing but ants!");
    expect(tagged.transformations[0]).toMatchObject({ kind: "vocalization", written: "Hahaha...", spoken: "[laugh]" });
    // Sigh and gasp are mapped; growl has no tag and falls back to safe_normalize.
    expect(normalizeSpeechText("He sighed. Sigh. Ahhh! Grrrrr!", "en-US", {}, fishS2Tags).text).toBe("He sighed. [sigh] [gasp] Grrr!");
  });

  it("omits vocalizations cleanly under omit strategy or omit_unsupported fallback", () => {
    const omitted = normalizeSpeechText(fiendDragon, "en-US", {}, { kind: "omit" });
    expect(omitted.text).toBe("Brat, once my fiend dragon comes out, all your bullshit undead are nothing but ants!");
    expect(omitted.transformations[0]).toMatchObject({ kind: "vocalization", written: "Hahaha...", spoken: "" });
    const fallbackOmitted = normalizeSpeechText("Grrr! Leave.", "en-US", { vocalizations: { fallback: "omit_unsupported" } }, { kind: "native_tags", tags: { laugh: "[laugh]" } });
    expect(fallbackOmitted.text).toBe("Leave.");
    expect(fallbackOmitted.transformations[0]).toMatchObject({ kind: "vocalization", written: "Grrr!", spoken: "" });
  });

  it("preserve mode records the detection without changing the text; disabled mode ignores vocalizations entirely", () => {
    const preserved = normalizeSpeechText("Hahahahahahaha! He left.", "en-US", { vocalizations: { mode: "preserve" } }, fishS2Tags);
    expect(preserved.text).toBe("Hahahahahahaha! He left.");
    expect(preserved.transformations).toEqual([{ kind: "vocalization", written: "Hahahahahahaha!", spoken: "Hahahahahahaha!", start: 0, end: 15 }]);
    const disabled = normalizeSpeechText("Hahahahahahaha! He left.", "en-US", { vocalizations: { mode: "disabled" } }, fishS2Tags);
    expect(disabled.text).toBe("Hahahahahahaha! He left.");
    expect(disabled.transformations).toEqual([]);
  });

  it("fingerprints vocalization settings and strategy", () => {
    const base = speechNormalizationFingerprint(fiendDragon, "en-US");
    const same = speechNormalizationFingerprint(fiendDragon, "en-US", {}, { kind: "safe_normalize" });
    expect(base.fingerprint).toBe(same.fingerprint);
    expect(base.fingerprint).not.toBe(speechNormalizationFingerprint(fiendDragon, "en-US", {}, fishS2Tags).fingerprint);
    expect(base.fingerprint).not.toBe(speechNormalizationFingerprint(fiendDragon, "en-US", { vocalizations: { mode: "preserve" } }).fingerprint);
    expect(base.fingerprint).not.toBe(speechNormalizationFingerprint(fiendDragon, "en-US", { vocalizations: { fallback: "omit_unsupported" } }).fingerprint);
    // Existing behavior: time mode still changes the fingerprint.
    expect(base.fingerprint).not.toBe(speechNormalizationFingerprint(fiendDragon, "en-US", { timeSpeechMode: "natural_24h" }).fingerprint);
  });

  it("maps narration settings into speech-normalization settings", () => {
    expect(speechNormalizationSettingsFromNarration({
      speechNormalization: "automatic", timeSpeechMode: "natural_24h",
      speechAbbreviations: { EXP: "experience" }, speechVocalizations: { mode: "preserve", fallback: "omit_unsupported" },
    })).toEqual({ mode: "automatic", timeSpeechMode: "natural_24h", speechAbbreviations: { EXP: "experience" }, vocalizations: { mode: "preserve", fallback: "omit_unsupported" } });
    expect(speechNormalizationSettingsFromNarration({})).toEqual({ mode: undefined, timeSpeechMode: undefined, speechAbbreviations: undefined, vocalizations: undefined });
  });

  it("normalizeSpeechForProvider uses the provider strategy and defaults to safe_normalize without one", () => {
    const narrationSettings = { speechNormalization: "automatic" as const, speechVocalizations: { mode: "automatic" as const, fallback: "safe_normalize" as const } };
    const neutral = normalizeSpeechForProvider("Hahahahahahaha! He left.", "en-US", narrationSettings);
    expect(neutral.normalized.text).toBe("Hahaha! He left.");
    const fakeFish = {
      name: "fish" as const,
      vocalizationStrategy: () => fishS2Tags,
      validateConfiguration: async () => {},
      synthesize: async () => { throw new Error("not called"); },
    };
    const tagged = normalizeSpeechForProvider("Hahahahahahaha! He left.", "en-US", narrationSettings, fakeFish, "s2-pro");
    expect(tagged.normalized.text).toBe("[laugh] He left.");
    expect(tagged.fingerprint).not.toBe(neutral.fingerprint);
  });
});
