import { describe, expect, it } from "vitest";
import { formatChapterSelection, parseChapterSelection, selectChapterNumbers } from "../src/batch/range.js";

describe("explicit chapter selection", () => {
  it("parses ranges, removes duplicates, and sorts", () => { expect(parseChapterSelection("13, 5, 10-12, 11, 40 - 41")).toEqual([5, 10, 11, 12, 13, 40, 41]); });
  it("rejects malformed, reversed, empty, and oversized selections", () => {
    expect(() => parseChapterSelection("5,,7")).toThrow(/empty token/i); expect(() => parseChapterSelection("10-5")).toThrow(/start must be/i); expect(() => parseChapterSelection("chapter 5")).toThrow(/invalid/i); expect(() => parseChapterSelection("1-4", 3)).toThrow(/limit/i);
  });
  it("formats normalized selections compactly", () => { expect(formatChapterSelection([5, 6, 7, 10, 13, 12])).toBe("5-7, 10, 12-13"); });
  it("rejects chapter numbers absent from the imported catalog", () => { expect(() => selectChapterNumbers([{ chapter: 5 }, { chapter: 10 }] as any, [5, 7])).toThrow(/not imported.*7/i); });
});
