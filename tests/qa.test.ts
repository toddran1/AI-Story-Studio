import { describe, expect, it } from "vitest";
import { activeQaIssues, dismissQaIssues, normalizeQaResult, qaResultSchema } from "../src/domain/qa.js";

const checks = { completeness: "pass", names: "pass", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" } as const;
describe("QA result", () => {
  it("validates structured output", () => { expect(qaResultSchema.parse({ status: "pass", score: 0.96, issues: [], checks }).score).toBe(0.96); });
  it("rejects invalid scores and categories", () => {
    expect(qaResultSchema.safeParse({ status: "pass", score: 2, issues: [], checks }).success).toBe(false);
    expect(qaResultSchema.safeParse({ status: "warn", score: 0.5, issues: [{ category: "style", severity: "warn", message: "x" }], checks }).success).toBe(false);
  });
  it("promotes understated model status to the worst check", () => {
    expect(normalizeQaResult({ status: "pass", score: 0.5, issues: [], checks: { ...checks, numbers: "fail" } }).status).toBe("fail");
  });
  it("retains dismissed evidence while removing it from the active decision", () => {
    const result = dismissQaIssues({ status: "warn", score: 0.86, issues: [
      { category: "dialogue", severity: "warn", message: "A threat is softened", evidence: "The intent remains intact." },
      { category: "numbers", severity: "warn", message: "A number changed", evidence: "Ten became twelve." },
    ], checks: { ...checks, dialogue: "warn", numbers: "warn" } }, [0], "2026-09-14T18:00:00.000Z");
    expect(result.status).toBe("warn");
    expect(result.checks.dialogue).toBe("pass");
    expect(result.issues[0]?.review).toEqual({ disposition: "dismissed", reviewedAt: "2026-09-14T18:00:00.000Z" });
    expect(activeQaIssues(result).map((issue) => issue.category)).toEqual(["numbers"]);
    expect(result.score).toBe(0.86);
  });
  it("marks the chapter pass when its only warning is dismissed", () => {
    const result = dismissQaIssues({ status: "warn", score: 0.9, issues: [
      { category: "dialogue", severity: "warn", message: "Minor wording", evidence: "No action needed." },
    ], checks: { ...checks, dialogue: "warn" } }, [0]);
    expect(result.status).toBe("pass");
    expect(result.checks.dialogue).toBe("pass");
    expect(activeQaIssues(result)).toEqual([]);
  });
});
