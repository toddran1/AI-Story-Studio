import { describe, expect, it } from "vitest";
import { audioRegenerationInputSchema } from "../src/tts/regeneration-selection.js";
describe("bulk audio regeneration selection", () => {
  it("sorts chapters and deduplicates segment numbers", () => {
    expect(audioRegenerationInputSchema.parse({ selections: [{ chapter: 322, segments: [3,1,3] }, { chapter: 310 }] })).toEqual({ rebuildMasters: true, selections: [{ chapter: 310 }, { chapter: 322, segments: [1,3] }] });
  });
  it("rejects duplicate chapters and empty or invalid selections", () => {
    for (const selections of [[], [{ chapter: 1 }, { chapter: 1, segments: [2] }], [{ chapter: 1, segments: [] }], [{ chapter: 1, segments: [0] }]]) expect(audioRegenerationInputSchema.safeParse({ selections }).success).toBe(false);
  });
});
