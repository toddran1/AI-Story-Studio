import { describe, expect, it } from "vitest";
import { FishAudioProvider, normalizeFishSpeechText } from "../src/tts/fish/fish-audio.provider.js";
import { disambiguateFishS2Brackets } from "../src/tts/fish/control-cues.js";
import { normalizeSpeechText } from "../src/tts/speech-normalization.js";
import { adaptPronunciationText, resolvePronunciations } from "../src/tts/pronunciation.js";
import { storyBibleSchema, emptyStoryBible, type CanonicalEntity } from "../src/domain/story-bible.js";

describe("Fish vocalization strategy", () => {
  const provider = new FishAudioProvider();

  it.each(["s2-pro", "s2.1-pro", "s2.1-pro-free"])("uses verified native tags for %s", (model) => {
    const strategy = provider.vocalizationStrategy(model);
    expect(strategy).toEqual({ kind: "native_tags", tags: { laugh: "[laugh]", chuckle: "[laugh]", throat_clear: "[cough]", sigh: "[sigh]", gasp: "[gasp]" } });
  });

  it.each(["s1", "s1-mini", "unknown-model", undefined])("falls back to safe_normalize for %s", (model) => {
    expect(provider.vocalizationStrategy(model)).toEqual({ kind: "safe_normalize" });
  });

  it("advertises expressive tags for the supported subset only", () => {
    expect(provider.vocalizationCapabilities).toEqual({ expressiveTags: true, supportedTypes: ["laugh", "chuckle", "throat_clear", "sigh", "gasp"], separateSegments: false });
  });

  it("strategy tags survive the S2 bracket disambiguator, and guessed tags never leak", () => {
    const strategy = provider.vocalizationStrategy("s2-pro");
    if (strategy.kind !== "native_tags") throw new Error("expected native_tags");
    for (const tag of Object.values(strategy.tags)) {
      expect(disambiguateFishS2Brackets(tag, "s2-pro")).toBe(tag);
    }
    // Safety net: a hallucinated tag is stripped to ordinary spoken words.
    expect(disambiguateFishS2Brackets("[laughs] he said [cackling]", "s2-pro")).toBe("laughs he said cackling");
  });

  it("renders a standalone ahem reaction as a throat clear without changing literal mentions", () => {
    const original = "“Ahem, ahem, ahem… You’re right. That makes sense!”";
    const spoken = normalizeSpeechText(original, "en-US", {}, provider.vocalizationStrategy("s2-pro"));
    expect(spoken.text).toContain("[cough] You’re right");
    expect(spoken.transformations).toContainEqual(expect.objectContaining({ kind: "vocalization", spoken: "[cough]" }));
    expect(normalizeFishSpeechText("Ahem... excuse me.", "s2-pro")).toBe("[cough] excuse me.");
    expect(normalizeFishSpeechText("He wrote the word “ahem” in the margin.", "s2-pro")).toContain("“ahem”");
    expect(original).toContain("Ahem, ahem, ahem");
  });

  it("keeps tsk text by default and offers an explicit Fish direction", () => {
    const original = "“Tsk, tsk, tsk. You lose your temper too easily.”";
    expect(normalizeFishSpeechText(original, "s2-pro")).toContain("Tsk, tsk, tsk.");
    expect(normalizeFishSpeechText(original, "s2-pro", { tskRendering: "direction" })).toContain("[clicks tongue disapprovingly] You lose");
    expect(normalizeFishSpeechText("The transcript literally contained “tsk, tsk.”", "s2-pro", { tskRendering: "direction" })).toContain("“tsk, tsk.”");
  });

  it("regularizes only leading discourse ellipses for Fish S2", () => {
    expect(normalizeFishSpeechText("“Actually… it’s not impossible.”", "s2-pro")).toContain("Actually, it’s not impossible");
    expect(normalizeFishSpeechText("Actually... it’s not impossible.", "s2-pro")).toBe("Actually, it’s not impossible.");
    expect(normalizeFishSpeechText("Well… I suppose so. Uh… maybe.", "s2-pro")).toBe("Well, I suppose so. Uh, maybe.");
    expect(normalizeFishSpeechText("His voice faded into the distance… She stared at him… then turned away.", "s2-pro"))
      .toBe("His voice faded into the distance… She stared at him… then turned away.");
    expect(normalizeFishSpeechText("Actually… it’s possible.", "s1")).toBe("Actually… it’s possible.");
  });

  it("maps a performed laugh to the approved cue but leaves a literal mention intact", () => {
    expect(normalizeFishSpeechText("“Hehe, I guessed it, didn’t I?”", "s2-pro")).toContain("[laugh] I guessed it");
    expect(normalizeFishSpeechText("Haha, I knew it.", "s2-pro")).toBe("[laugh] I knew it.");
    expect(normalizeFishSpeechText("She typed “hehe” into the chat.", "s2-pro")).toContain("“hehe”");
    const original = "“Ahem, ahem, ahem… You’re right.”";
    expect(normalizeFishSpeechText(original, "s2-pro")).toContain("[cough] You’re right");
    expect(original).toContain("Ahem, ahem, ahem");
  });
});

describe("vocalization rendering coexists with pronunciation hints (M20)", () => {
  const moXie: CanonicalEntity = storyBibleSchema.parse({
    ...emptyStoryBible(),
    canonicalEntities: [{
      id: "ent_aaaaaaaaaaaaaaaaaaaaaaaa", type: "character", canonicalName: "Mo Xie", originalName: "莫邪", aliases: [],
      firstAppearance: 1, lastKnownAppearance: 1, status: "alive",
      pronunciation: { mode: "automatic", phoneticHint: "Moh Shieh" },
    }],
  }).canonicalEntities[0]!;
  const narration = "Hahaha... Mo Xie, you're finished!";

  it("native_tags strategy: tag and phonetic hint coexist in the synthesis string", () => {
    const strategy = new FishAudioProvider().vocalizationStrategy("s2.1-pro");
    const spoken = normalizeSpeechText(narration, "en-US", {}, strategy).text;
    expect(spoken).toBe("[laugh] Mo Xie, you're finished!");
    const final = adaptPronunciationText(spoken, resolvePronunciations(spoken, [moXie]), { phoneticText: true });
    expect(final).toBe("[laugh] Moh Shieh, you're finished!");
    expect(disambiguateFishS2Brackets(final, "s2.1-pro")).toBe(final);
  });

  it("safe_normalize strategy: canonical laugh form and phonetic hint coexist", () => {
    const spoken = normalizeSpeechText("Hahahahaha! Mo Xie, you're finished!", "en-US").text;
    expect(spoken).toBe("Hahaha! Mo Xie, you're finished!");
    expect(adaptPronunciationText(spoken, resolvePronunciations(spoken, [moXie]), { phoneticText: true })).toBe("Hahaha! Moh Shieh, you're finished!");
  });
});
