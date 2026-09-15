import { describe, expect, it } from "vitest";
import type { LLMProvider } from "../src/llm/provider.js";
import { polishNarration } from "../src/narration/narration-editor.js";
import { bleepStrongProfanityForTts, containsStrongProfanity, softenStrongProfanity } from "../src/narration/profanity.js";
import { narrationInstructions } from "../src/narration/prompts.js";
import { qaInstructionsFor } from "../src/qa/prompts.js";

describe("narration profanity preference", () => {
  it("preserves narration byte-for-byte when the preference is off", () => {
    const text = "What the fuck? This is damn hard as hell, you bitch.";
    expect(softenStrongProfanity(text, "preserve")).toBe(text);
  });

  it("softens strong terms while retaining allowed mild words", () => {
    const text = "What the fuck? Fuck you, bitch. This shit is damn hard as hell and hurts my ass.";
    const result = softenStrongProfanity(text, "soften-strong");
    expect(result).toBe("What the hell? Screw you, jerk. This crap is damn hard as hell and hurts my ass.");
    expect(containsStrongProfanity(result)).toBe(false);
  });

  it("preserves useful capitalization", () => {
    expect(softenStrongProfanity("FUCK YOU! That BITCH lied.", "soften-strong")).toBe("SCREW YOU! That JERK lied.");
  });

  it("bleeps only strong terms in a hidden TTS script", () => {
    const narration = "Fuck that bitch and her bullshit. This is damn hard as hell and hurts my ass.";
    expect(bleepStrongProfanityForTts(narration, true)).toBe("Bleep that bleep and her bleep. This is damn hard as hell and hurts my ass.");
    expect(bleepStrongProfanityForTts(narration, false)).toBe(narration);
  });

  it("instructs narration and QA to treat the enabled change as narration-only", () => {
    const narration = narrationInstructions("English", "fish", "s2.1-pro", "soften-strong");
    expect(narration).toMatch(/narration only/i);
    expect(narration).toMatch(/ass.*hell.*damn/i);
    expect(narration).toMatch(/preserve the hostility.*emotion.*meaning/i);
    const qa = qaInstructionsFor("soften-strong");
    expect(qa).toMatch(/do not flag a natural strong-to-mild/i);
    expect(qa).toMatch(/source and translation are not covered/i);
  });

  it("applies a deterministic final check without changing the input translation", async () => {
    let request: any;
    const provider: LLMProvider = {
      name: "openai",
      validateConfiguration: async () => undefined,
      generateText: async (value) => { request = value; return { text: "What the fuck, you bitch?" }; },
      generateStructured: async () => { throw new Error("unused"); },
    };
    const translation = "What the fuck, you bitch?";
    const result = await polishNarration(provider, { provider: "openai", model: "test" }, translation, "English", {}, "fish", "s2.1-pro", "soften-strong");
    expect(result.text).toBe("What the hell, you jerk?");
    expect(translation).toBe("What the fuck, you bitch?");
    expect(request.input).toContain(translation);
  });

  it("can omit only the leading Markdown chapter title from narration", async () => {
    const provider: LLMProvider = {
      name: "openai",
      validateConfiguration: async () => undefined,
      generateText: async () => ({ text: "# Chapter 397: The Good Show Is About to Begin\n\nThe battle had already reached a fever pitch." }),
      generateStructured: async () => { throw new Error("unused"); },
    };
    const translation = "# Chapter 397: The Good Show Is About to Begin\n\nThe battle had already reached a fever pitch.";
    const result = await polishNarration(provider, { provider: "openai", model: "test" }, translation, "English", {}, "fish", "s2.1-pro", "preserve", "restrained", false);
    expect(result.text).toBe("The battle had already reached a fever pitch.");
    expect(translation).toMatch(/^# Chapter 397:/);
    expect(narrationInstructions("English", "fish", "s2.1-pro", "preserve", "restrained", false)).toMatch(/omit the chapter title/i);
    expect(qaInstructionsFor("preserve", false)).toMatch(/omission from the narration alone is intentional/i);
  });
});
