import { describe, expect, it } from "vitest";
import { normalizeSpeechText, speechNormalizationFingerprint } from "../src/tts/speech-normalization.js";

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
    expect(result.text).toBe("It activates its Worry-Free E-X-P feature, the Devour skill, his Shadow Step ability, the S-Rank Necromancer class, an SSS-Rank talent, and the Blood Moon dungeon.");
    expect(result.transformations.filter((item) => item.kind === "quoted-label")).toHaveLength(6);
  });

  it("does not strip dialogue or ordinary quotations", () => {
    const written = '"Worry-Free EXP," she said. He answered, "Do not call that NPC a feature."';
    expect(normalizeSpeechText(written, "en-US").text).toBe('"Worry-Free E-X-P," she said. He answered, "Do not call that N-P-C a feature."');
  });

  it("uses deterministic defaults and story overrides for abbreviations", () => {
    expect(normalizeSpeechText("EXP XP HP MP NPC", "en-US").text).toBe("E-X-P X-P H-P M-P N-P-C");
    expect(normalizeSpeechText("EXP and HP", "en-US", { speechAbbreviations: { EXP: "experience points", HP: "health points" } }).text).toBe("experience points and health points");
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
