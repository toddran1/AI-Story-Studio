import { describe, expect, it } from "vitest";
import { normalizeQaResult, qaResultSchema } from "../src/domain/qa.js";

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
});
