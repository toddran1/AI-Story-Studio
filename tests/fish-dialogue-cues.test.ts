import { describe, expect, it } from "vitest";
import { directQuotedDialogue } from "../src/tts/fish/dialogue-casting.js";

describe("same voice narration cue placement", () => {
  it("puts calm before narration after the paragraph break", () => {
    expect(directQuotedDialogue('“Boom!”\n\nThe creatures burst apart.')).toBe('[soft] “Boom!”\n\n[calm] The creatures burst apart.');
  });
  it("omits the trailing cue when dialogue ends the text", () => {
    expect(directQuotedDialogue('He shouted. “Boom!”\n\n')).toBe('He shouted. [soft] “Boom!”');
  });
  it("does not insert calm between adjacent dialogue lines", () => {
    expect(directQuotedDialogue('“One.” “Two.” After.')).toBe('[soft] “One.” [soft] “Two.” [calm] After.');
  });
  it("preserves an explicit cue on the following narration", () => {
    expect(directQuotedDialogue('“One.” [angry] He stormed off.')).toBe('[soft] “One.” [angry] He stormed off.');
  });
});
