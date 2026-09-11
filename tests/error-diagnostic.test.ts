import { describe, expect, it } from "vitest";
import { createErrorDiagnostic } from "../src/errors/diagnostic.js";
import { QualityGateError } from "../src/pipeline/errors.js";

describe("structured error diagnostics", () => {
  it("includes actionable QA evidence and execution context", () => {
    const diagnostic = createErrorDiagnostic(new QualityGateError("Chapter 12 failed QA", {
      status: "fail", score: 0.7,
      issues: [{ category: "names", severity: "fail", message: "A protected name changed", evidence: "Su Ming became Doctor Wu." }],
      checks: { completeness: "pass", names: "fail", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" },
    }), { chapter: 12, stage: "qa" });
    expect(diagnostic).toMatchObject({ chapter: 12, stage: "qa", category: "content_qa", retryable: false, summary: "Chapter 12 failed quality review" });
    expect(diagnostic.issues?.[0]).toMatchObject({ category: "names", message: "A protected name changed" });
    expect(diagnostic.id).toMatch(/^ERR-[A-F0-9]{8}$/);
  });

  it("redacts credentials from user-visible technical details", () => {
    const diagnostic = createErrorDiagnostic(new Error("Provider failed with Bearer secret-token and api_key=secret-value at postgres://user:password@localhost/db"));
    expect(JSON.stringify(diagnostic)).not.toContain("secret-token");
    expect(JSON.stringify(diagnostic)).not.toContain("secret-value");
    expect(JSON.stringify(diagnostic)).not.toContain(":password@");
  });
});
