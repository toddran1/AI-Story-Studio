import { describe, expect, it } from "vitest";
import { parseStagesArgs } from "../apps/cli/stages.js";

describe("story:stages CLI", () => {
  it("parses a bounded range and multiple stage names", () => {
    expect(parseStagesArgs(["mark-current", "demo-story", "--from", "1", "--to", "3", "--stages", "translation,qa", "--reason", "reviewed"])).toEqual({ kind: "mark-current", story: "demo-story", chapters: [1, 2, 3], stages: ["translation", "qa"], reason: "reviewed" });
  });
  it("accepts explicit chapter lists and rejects ambiguous ranges", () => {
    expect(parseStagesArgs(["mark-current", "demo-story", "--chapters", "1,3,8", "--stages", "tts"])).toMatchObject({ chapters: [1, 3, 8], stages: ["tts"] });
    expect(() => parseStagesArgs(["mark-current", "demo-story", "--chapters", "1", "--from", "1", "--to", "2", "--stages", "qa"])).toThrow(/either/i);
  });
  it("parses multi-stage runs and compatibility prerequisite mode", () => {
    expect(parseStagesArgs(["run", "demo-story", "--chapters", "5,10,40-42", "--stages", "narration,qa", "--mode", "prerequisites", "--dry-run"])).toEqual({ kind: "run", story: "demo-story", chapters: [5, 10, 40, 41, 42], stages: ["narration", "qa"], mode: "prerequisites", force: false, dryRun: true });
    expect(parseStagesArgs(["run", "demo-story", "5", "qa", "--through"])).toMatchObject({ chapters: [5], stages: ["qa"], mode: "prerequisites" });
  });
});
