import { describe, expect, it } from "vitest";
import { selectChapterRange } from "../src/batch/range.js";

const chapters = [1, 2, 3, 4, 5].map((chapter) => ({ chapter, filename: `${chapter}.txt`, path: `/${chapter}.txt` }));
describe("range selection", () => {
  it("supports inclusive from and to", () => expect(selectChapterRange(chapters, 2, 4).map((item) => item.chapter)).toEqual([2, 3, 4]));
  it("supports from only", () => expect(selectChapterRange(chapters, 4).map((item) => item.chapter)).toEqual([4, 5]));
  it("supports to only", () => expect(selectChapterRange(chapters, undefined, 2).map((item) => item.chapter)).toEqual([1, 2]));
  it("rejects reversed and outside ranges", () => {
    expect(() => selectChapterRange(chapters, 4, 2)).toThrow(/greater/);
    expect(() => selectChapterRange(chapters, 6, 7)).toThrow(/outside/);
  });
});
