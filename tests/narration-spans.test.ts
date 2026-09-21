import { describe, expect, it } from "vitest";
import { bindNarrationSpans } from "../src/scenes/narration-spans.js";
import type { Scene } from "../src/scenes/types.js";

const narration = "one two three four five six seven eight nine ten";

function scene(startWord: number | undefined, endWord: number | undefined, overrides: Partial<Scene> = {}): Scene {
  return {
    id: "scene-001", summary: "beat", startSeconds: 0, endSeconds: 10, characters: [], visualPrompt: "frame",
    importance: "standard", narrationStartWord: startWord, narrationEndWord: endWord, ...overrides,
  } as Scene;
}

describe("bindNarrationSpans", () => {
  it("uses valid supplied spans unchanged", () => {
    const bound = bindNarrationSpans([scene(0, 4), scene(4, 8), scene(8, 10)], narration);
    expect(bound.map((s) => [s.narrationStartWord, s.narrationEndWord])).toEqual([[0, 4], [4, 8], [8, 10]]);
    expect(bound[0]!.narrationText).toBe("one two three four");
    expect(bound[2]!.narrationText).toBe("nine ten");
  });

  it("closes gaps between supplied spans", () => {
    const bound = bindNarrationSpans([scene(0, 4), scene(6, 9), scene(9, 10)], narration);
    expect(bound.map((s) => [s.narrationStartWord, s.narrationEndWord])).toEqual([[0, 4], [4, 9], [9, 10]]);
    expect(bound[1]!.narrationText).toContain("five six");
  });

  it("trims overlapping supplied spans", () => {
    const bound = bindNarrationSpans([scene(0, 5), scene(3, 8), scene(8, 10)], narration);
    expect(bound.map((s) => [s.narrationStartWord, s.narrationEndWord])).toEqual([[0, 5], [5, 8], [8, 10]]);
  });

  it("clamps out-of-range ends and forces the final scene to the last word", () => {
    const bound = bindNarrationSpans([scene(0, 6), scene(6, 999)], narration);
    expect(bound.map((s) => [s.narrationStartWord, s.narrationEndWord])).toEqual([[0, 6], [6, 10]]);
  });

  it("keeps at least one word per scene when supplied ends collapse", () => {
    const bound = bindNarrationSpans([scene(0, 2), scene(2, 2), scene(2, 10)], narration);
    const spans = bound.map((s) => [s.narrationStartWord!, s.narrationEndWord!]);
    spans.forEach(([start, end], index) => {
      expect(end).toBeGreaterThan(start);
      if (index) expect(start).toBe(spans[index - 1]![1]);
    });
    expect(spans.at(-1)![1]).toBe(10);
  });

  it("computes proportional spans when none are supplied", () => {
    const bound = bindNarrationSpans([scene(undefined, undefined, { endSeconds: 5 }), scene(undefined, undefined, { endSeconds: 10 })], narration);
    expect(bound[0]!.narrationStartWord).toBe(0);
    expect(bound[1]!.narrationEndWord).toBe(10);
    expect(bound[1]!.narrationStartWord).toBe(bound[0]!.narrationEndWord);
  });

  it("still rejects when scenes outnumber narration words", () => {
    expect(() => bindNarrationSpans([scene(0, 1), scene(1, 2), scene(2, 3)], "one two")).toThrow(/word count/);
  });
});
