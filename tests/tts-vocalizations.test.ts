import { describe, expect, it } from "vitest";
import { FishAudioProvider, normalizeFishSpeechText } from "../src/tts/fish/fish-audio.provider.js";
import { directQuotedDialogue } from "../src/tts/fish/dialogue-casting.js";
import { disambiguateFishS2Brackets } from "../src/tts/fish/control-cues.js";
import { normalizeSpeechText, normalizeSpeechForProvider } from "../src/tts/speech-normalization.js";
import { adaptPronunciationText, resolvePronunciations } from "../src/tts/pronunciation.js";
import { storyBibleSchema, emptyStoryBible, type CanonicalEntity } from "../src/domain/story-bible.js";

describe("Fish vocalization strategy", () => {
  const provider = new FishAudioProvider();

  it.each([
    "Asher let out a long sigh and plopped back down in his camping chair, utterly dejected.",
    "He gave a sigh of relief.",
    "Sigh of relief was the phrase he used.",
    "She wrote the word ‘sigh’.",
  ])("preserves the spoken word sigh in prose: %s", (text) => {
    const strategy = provider.vocalizationStrategy("s2.1-pro-free");
    const spoken = normalizeSpeechText(text, "en-US", {}, strategy).text;
    expect(spoken).toBe(text);
    expect(normalizeFishSpeechText(spoken, "s2.1-pro-free")).toBe(text);
  });

  it.each(["Sigh!", "“Sigh…”", "Sigh", "[sigh] He sat down."])("preserves deliberate sigh reactions: %s", (text) => {
    const spoken = normalizeSpeechText(text, "en-US", {}, provider.vocalizationStrategy("s2.1-pro-free")).text;
    expect(spoken).toContain("[sigh]");
  });

  it.each(["s2-pro", "s2.1-pro", "s2.1-pro-free"])("uses verified native tags for %s", (model) => {
    const strategy = provider.vocalizationStrategy(model);
    expect(strategy).toEqual({ kind: "native_tags", tags: { laugh: "[laughing]", chuckle: "[chuckle]", throat_clear: "[cough]", sigh: "[sigh]", gasp: "[gasp]", scream: "[shouting] Ah!" } });
  });

  it.each(["s1", "s1-mini", "unknown-model", undefined])("falls back to safe_normalize for %s", (model) => {
    expect(provider.vocalizationStrategy(model)).toEqual({ kind: "safe_normalize" });
  });

  it("advertises expressive tags for the supported subset only", () => {
    expect(provider.vocalizationCapabilities).toEqual({ expressiveTags: true, supportedTypes: ["laugh", "chuckle", "throat_clear", "sigh", "gasp", "scream"], separateSegments: false });
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

  it("renders an emphatic scream rather than a gasp and avoids conflicting soft direction", () => {
    const original = "King Issar swung his sword again.\n\n“Ahhhhh!”\n\nTheir anguished screams rang through the night.";
    const spoken = normalizeSpeechText(original, "en-US", {}, provider.vocalizationStrategy("s2.1-pro-free")).text;
    expect(spoken).toContain("“[shouting] Ah!”");
    expect(spoken).not.toContain("[gasp]");
    const directed = directQuotedDialogue(normalizeFishSpeechText(spoken, "s2.1-pro-free"));
    expect(directed).not.toContain("[soft]");
    expect(directed).toContain("[calm] Their anguished screams");
    expect(normalizeFishSpeechText("“Ahhhhh!”", "s2.1-pro-free")).toBe("“[shouting] Ah!”");
    expect(original).toContain("Ahhhhh!");
  });

  it("prepares the Alters laughter excerpt without added punctuation in either entry path", () => {
    const text = "【The government says the cameras are down!】\n\n【Haha! Now the skies will be bluer!】\n\nGlobal surveillance was down!";
    const generic = normalizeSpeechText(text, "en-US", {}, provider.vocalizationStrategy("s2.1-pro-free")).text;
    const fromVoice = provider.prepareSegments({ text: generic, model: "s2.1-pro-free", voiceMode: "same-voice-dialogue", speed: 1, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 1750 });
    expect(fromVoice).toEqual(["The government says the cameras are down!\n\n[laughing] Now the skies will be bluer!\n\nGlobal surveillance was down!"]);
    expect(normalizeFishSpeechText(text, "s2.1-pro-free")).toBe(fromVoice[0]);
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
      .toBe("His voice faded into the distance, She stared at him, then turned away.");
    expect(normalizeFishSpeechText("Actually… it’s possible.", "s1")).toBe("Actually, it’s possible.");
  });

  it.each([["Ha...", "[chuckle]"], ["Haha...", "[laughing]"], ["Hahaha...", "[laughing]"], ["Hahahaha!", "[laughing]"], ["Haha haha!", "[laughing]"]])("renders the native laughter cue for %s", (input, expected) => {
    expect(normalizeFishSpeechText(input, "s2.1-pro")).toBe(expected);
    const strategy = new FishAudioProvider().vocalizationStrategy("s2.1-pro");
    expect(normalizeFishSpeechText(normalizeSpeechText(input, "en-US", {}, strategy).text, "s2.1-pro")).toBe(expected);
  });

  it("maps a performed laugh to the approved cue but leaves a literal mention intact", () => {
    expect(normalizeFishSpeechText("“Hehe, I guessed it, didn’t I?”", "s2-pro")).toContain("I guessed it");
    expect(normalizeFishSpeechText("Haha, I knew it.", "s2-pro")).toBe("[laughing] I knew it.");
    expect(normalizeFishSpeechText("“Heh heh heh... Don’t worry.”", "s2-pro")).toBe("“[laughing] Don’t worry.”");
    expect(normalizeFishSpeechText("She typed “hehe” into the chat.", "s2-pro")).toContain("“hehe”");
    const original = "“Ahem, ahem, ahem… You’re right.”";
    expect(normalizeFishSpeechText(original, "s2-pro")).toContain("[cough] You’re right");
    expect(original).toContain("Ahem, ahem, ahem");
  });

  it("uses explicit laughter for the reported Hahahaha line and legacy laugh cues", () => {
    for (const model of ["s2-pro", "s2.1-pro", "s2.1-pro-free"]) {
      expect(normalizeFishSpeechText("“Hahahaha… Mr. Sterling, sayonara!”", model)).toBe("“[laughing] Mister Sterling, sayonara!”");
      expect(normalizeFishSpeechText("[laugh] [laughing] Goodbye!", model)).toBe("[laughing] Goodbye!");
    }
  });

  it("sends the reported single Heh reaction as a chuckle, never a cough", () => {
    const text = "“Heh… Wait, are you saying you called me here just to tell me where Asher is?”";
    for (const model of ["s2-pro", "s2.1-pro", "s2.1-pro-free"]) {
      expect(normalizeFishSpeechText(text, model)).toBe("“[chuckle] Wait, are you saying you called me here just to tell me where Asher is?”");
      expect(disambiguateFishS2Brackets("[chuckle] Wait.", model)).toBe("[chuckle] Wait.");
    }
  });

  it("renders a leading single heh as a supported cue without an open ellipsis", () => {
    const narration = "Zhou Ao looked serious and spoke earnestly, showing no sign of letting his guard down.\n\n“Heh... then you’d better do your best!”\n\nGhost Sakura said with a smile.";
    expect(normalizeFishSpeechText(narration, "s2.1-pro")).toBe("Zhou Ao looked serious and spoke earnestly, showing no sign of letting his guard down.\n\n“[chuckle] then you’d better do your best!”\n\nGhost Sakura said with a smile.");
    expect(normalizeFishSpeechText("She wrote “Heh...” in the margin.", "s2.1-pro")).toContain("“Heh,”");
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
    expect(spoken).toBe("[laughing] Mo Xie, you're finished!");
    const final = adaptPronunciationText(spoken, resolvePronunciations(spoken, [moXie]), { phoneticText: true });
    expect(final).toBe("[laughing] Moh Shieh, you're finished!");
    expect(disambiguateFishS2Brackets(final, "s2.1-pro")).toBe(final);
  });

  it("safe_normalize strategy: canonical laugh form and phonetic hint coexist", () => {
    const spoken = normalizeSpeechText("Hahahahaha! Mo Xie, you're finished!", "en-US").text;
    expect(spoken).toBe("Hahaha! Mo Xie, you're finished!");
    expect(adaptPronunciationText(spoken, resolvePronunciations(spoken, [moXie]), { phoneticText: true })).toBe("Hahaha! Moh Shieh, you're finished!");
  });
});

 describe("silent system panels", () => {
  it.each(["!", "!!", "?!", "！？", "“!”", '"?!"', "！ ! ？"])("removes standalone reaction punctuation %s from speech only", (punctuation) => {
    const original = `And the result?\n\n${punctuation}\n\nHe was the punchline all along!`;
    const prepared = normalizeSpeechForProvider(original, "en-US", {}, new FishAudioProvider(), "s2.1-pro-free").normalized.text;
    expect(prepared).not.toContain(`\n${punctuation}\n`);
    expect(normalizeFishSpeechText(original, "s2.1-pro-free")).toBe("And the result?\n\nHe was the punchline all along!");
    expect(normalizeFishSpeechText(prepared, "s2.1-pro-free")).toBe("And the result?\n\nHe was the punchline all along!");
    expect(original).toContain(punctuation);
  });
  it.each(["【…】", "【..】", "【……】", "【...】", "【 … … 】", "【？？？】"])("removes %s without losing spoken system messages", (panel) => {
    const input = `【Successfully killed Skeleton Soldier. Gained 5,500 EXP.】\n\n${panel}\n\nThere were still a thousand of them, giving him another 5.5 million EXP!`;
    const spoken = normalizeFishSpeechText(input, "s2.1-pro");
    expect(spoken).toContain("Gained five thousand five hundred E X P.");
    expect(spoken).toContain("5.5 million E X P!");
    expect(spoken).not.toMatch(/[【】…？]/u);
    expect(spoken).not.toContain("...");
    expect(normalizeFishSpeechText("【Wait… more enemies are coming!】", "s2.1-pro")).toContain("Wait, more enemies");
  });
});

it("uses comma pauses for repeated periods after words", () => {
  for (const dots of ["..", "...", "......", "…", "……"]) {
    expect(normalizeFishSpeechText(`Wait${dots} I know.`, "s2.1-pro")).toBe("Wait, I know.");
    expect(normalizeFishSpeechText(`“Wait${dots}”`, "s2.1-pro")).toBe("“Wait,”");
  }
  expect(normalizeFishSpeechText("Worth 5.5 million.", "s2.1-pro")).toBe("Worth 5.5 million.");
});
