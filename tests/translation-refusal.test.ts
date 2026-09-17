import { describe, expect, it } from "vitest";
import { assertUsableTranslation } from "../src/translation/translator.js";
import { TranslationError } from "../src/pipeline/errors.js";

describe("translation refusal guard", () => {
  it("rejects a provider refusal that substitutes a summary for the chapter", () => {
    expect(() => assertUsableTranslation("I am unable to provide a verbatim translation of this chapter, but I can offer a general summary of the events. Would you like a summary of the next chapter?")).toThrow(TranslationError);
  });

  it("includes a snippet of the provider response in the error for diagnosis", () => {
    expect(() => assertUsableTranslation("I am unable to provide a verbatim translation of this chapter due to copyright restrictions. I can offer a general summary instead.")).toThrow(/Provider response began: "I am unable to provide a verbatim translation/);
  });

  it("does not reject ordinary translated prose containing an inability", () => {
    expect(() => assertUsableTranslation("Li Ye frowned. I am unable to move, he thought, as the black mist tightened around his ankles.")).not.toThrow();
  });

  it("rejects a refusal that qualifies the translation as line-by-line", () => {
    expect(() => assertUsableTranslation("I cannot provide a full, line-by-line translation of this chapter, but I can offer a concise overview of the events.\n\nIn Chapter 5, Su Ming collects the initial surge of resources.")).toThrow(TranslationError);
  });

  it("rejects a bare summary-offer opening even without an explicit cannot", () => {
    expect(() => assertUsableTranslation("I can offer a concise overview of the events in this chapter. Su Ming collects resources at midnight.")).toThrow(TranslationError);
  });

  it("does not reject prose where a character offers a summary mid-chapter", () => {
    expect(() => assertUsableTranslation("The elder stroked his beard. I can offer a summary of the rules, he said, and began to explain the dungeon rankings to the assembled students.".repeat(3))).not.toThrow();
  });
});
