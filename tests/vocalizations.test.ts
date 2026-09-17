import { describe, expect, it } from "vitest";
import { detectVocalizations, scanVocalizations, segmentSpeech } from "../src/tts/vocalizations.js";

describe("vocalization detection matrix", () => {
  const cases: [string, string, string][] = [
    // [input, expected vocalization type, expected spokenForm]
    ["Hahaha!", "laugh", "Hahaha!"],
    ["Hahaha...", "laugh", "Hahaha..."],
    ["Hahahaha!", "laugh", "Hahaha!"],
    ["Ha ha ha!", "laugh", "Hahaha!"],
    ["Hehe...", "laugh", "Hehehe..."],
    ["Heh.", "chuckle", "Heh."],
    ["Hmph!", "scoff", "Hmph!"],
    ["Hmm...", "thinking", "Hmm..."],
    ["Ugh!", "groan", "Ugh!"],
    ["Grrr!", "growl", "Grrr!"],
    ["Tsk.", "scoff", "Tsk."],
    ["Pfft!", "scoff", "Pfft!"],
  ];
  it.each(cases)("detects %s as %s", (input, vocalization, spokenForm) => {
    const scanned = scanVocalizations(input);
    expect(scanned).toHaveLength(1);
    expect(scanned[0]).toMatchObject({ type: "vocalization", vocalization, sourceText: input, spokenForm, start: 0, end: input.length });
    expect(scanned[0]!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("detectVocalizations omits the spokenForm helper field", () => {
    const [detection] = detectVocalizations("Hahaha!");
    expect(detection).toMatchObject({ vocalization: "laugh", sourceText: "Hahaha!" });
    expect(detection).not.toHaveProperty("spokenForm");
  });
});

describe("vocalization real-world dialogue", () => {
  const narration = "Hahaha... Brat, once my fiend dragon comes out, all your bullshit undead are nothing but ants!";

  it("detects the leading laugh and keeps the dialogue intact", () => {
    const [laugh] = scanVocalizations(narration);
    expect(laugh).toMatchObject({ vocalization: "laugh", sourceText: "Hahaha...", intensity: "light", position: "before", start: 0, end: 9 });
    const segments = segmentSpeech(narration);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ type: "vocalization", sourceText: "Hahaha..." });
    expect(segments[1]).toEqual({ type: "speech", text: " Brat, once my fiend dragon comes out, all your bullshit undead are nothing but ants!" });
    // The dialogue is preserved verbatim; only the interjection span is segmented out.
    expect(segments.map((segment) => segment.type === "speech" ? segment.text : segment.sourceText).join("")).toBe(narration);
  });
});

describe("vocalization false positives", () => {
  it.each(["harmony", "ahead", "grrreat", "hmmming", "aggregate", "the hahasaurus"])("leaves ordinary words untouched: %s", (word) => {
    expect(scanVocalizations(word)).toEqual([]);
  });

  it.each(["Nooooo!", "Pleeease!"])("does not detect elongated lexical words: %s", (word) => {
    expect(scanVocalizations(word)).toEqual([]);
  });
});

describe("vocalization repetition collapsing", () => {
  it.each([
    ["Hahahahahahaha!", "Hahaha!"],
    ["Grrrrrrrrrr!", "Grrr!"],
    ["Ahhhhhhhhh!", "Ahhh!"],
  ])("collapses %s to canonical %s", (input, spokenForm) => {
    expect(scanVocalizations(input)[0]).toMatchObject({ sourceText: input, spokenForm });
  });
});

describe("vocalization classification and intensity", () => {
  it("classifies a strong laugh before dialogue", () => {
    expect(scanVocalizations("Hahaha! You actually thought that would work?")[0]).toMatchObject({ vocalization: "laugh", intensity: "strong", position: "before" });
  });

  it("classifies a light chuckle", () => {
    expect(scanVocalizations("Heh. Not bad.")[0]).toMatchObject({ vocalization: "chuckle", intensity: "medium" });
  });

  it("classifies a scoff", () => {
    expect(scanVocalizations("Hmph! Who do you think you are?")[0]).toMatchObject({ vocalization: "scoff", intensity: "strong" });
  });

  it("marks inline and trailing positions", () => {
    expect(scanVocalizations("Well, heh, that went poorly.")[0]).toMatchObject({ vocalization: "chuckle", position: "inline" });
    expect(scanVocalizations("You lost. Hahaha!")[0]).toMatchObject({ vocalization: "laugh", position: "after" });
  });
});
