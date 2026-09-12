import { describe, expect, it } from "vitest";
import { assertUsableTranslation } from "../src/translation/translator.js";
import { TranslationError } from "../src/pipeline/errors.js";

describe("translation refusal guard", () => {
  it("rejects a provider refusal that substitutes a summary for the chapter", () => {
    expect(() => assertUsableTranslation("I am unable to provide a verbatim translation of this chapter, but I can offer a general summary of the events. Would you like a summary of the next chapter?")).toThrow(TranslationError);
  });

  it("does not reject ordinary translated prose containing an inability", () => {
    expect(() => assertUsableTranslation("Li Ye frowned. I am unable to move, he thought, as the black mist tightened around his ankles.")).not.toThrow();
  });
});
