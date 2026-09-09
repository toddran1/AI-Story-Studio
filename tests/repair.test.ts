import { describe, expect, it } from "vitest";
import { qaResultSchema } from "../src/domain/qa.js";
import { selectRepairStage } from "../src/qa/repair.js";

const checks = { completeness: "pass", names: "pass", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" } as const;

describe("repair stage selection", () => {
  it("regenerates translation for source fidelity issues", () => {
    const qa = qaResultSchema.parse({ status: "fail", score: 0.2, issues: [{ category: "numbers", severity: "fail", message: "Changed value", evidence: "10 became 12" }], checks: { ...checks, numbers: "fail" } });
    expect(selectRepairStage(qa)).toBe("translation");
  });
  it("regenerates narration for narration-only fidelity issues", () => {
    const qa = qaResultSchema.parse({ status: "fail", score: 0.2, issues: [{ category: "narrationFidelity", severity: "fail", message: "POV changed", evidence: "First person became third person" }], checks: { ...checks, narrationFidelity: "fail" } });
    expect(selectRepairStage(qa)).toBe("narration");
  });
});
