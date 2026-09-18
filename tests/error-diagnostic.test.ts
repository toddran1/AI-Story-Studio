import { describe, expect, it } from "vitest";
import { createErrorDiagnostic, diagnosticIsHistorical, compareQaDiagnosticFingerprint } from "../src/errors/diagnostic.js";
import { QualityGateError } from "../src/pipeline/errors.js";

const passingChecks = { completeness: "pass", names: "fail", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" } as const;

describe("structured error diagnostics", () => {
  it("includes actionable QA evidence and execution context", () => {
    const diagnostic = createErrorDiagnostic(new QualityGateError("Chapter 12 failed QA", {
      status: "fail", score: 0.7,
      issues: [{ category: "names", severity: "fail", message: "A protected name changed", evidence: "Su Ming became Doctor Wu." }],
      checks: { ...passingChecks },
    }), { chapter: 12, stage: "qa" });
    expect(diagnostic).toMatchObject({ chapter: 12, stage: "qa", category: "content_qa", retryable: false, summary: "Chapter 12 failed quality review" });
    expect(diagnostic.issues?.[0]).toMatchObject({ category: "names", message: "A protected name changed" });
    expect(diagnostic.id).toMatch(/^ERR-[A-F0-9]{8}$/);
  });

  it("includes only active open findings, never reviewed history", () => {
    const diagnostic = createErrorDiagnostic(new QualityGateError("Chapter 3 failed QA", {
      status: "fail", score: 0.5,
      issues: [
        { category: "names", severity: "fail", message: "Still open", evidence: "Su Ming became Doctor Wu." },
        { category: "numbers", severity: "warn", message: "Already fixed", evidence: "Ten became twelve.", review: { disposition: "manually_fixed", reviewedAt: "2026-01-01T00:00:00.000Z" } },
        { category: "terminology", severity: "warn", message: "Already dismissed", evidence: "Azure Flame.", review: { disposition: "dismissed", reviewedAt: "2026-01-01T00:00:00.000Z" } },
      ],
      checks: { ...passingChecks },
    }, { dependencyFingerprint: "fp-failure-time" }), { chapter: 3 });
    expect(diagnostic.issues?.map((issue) => issue.message)).toEqual(["Still open"]);
    expect(diagnostic.qaDependencyFingerprint).toBe("fp-failure-time");
  });

  it("diagnosticIsHistorical compares the failure-time fingerprint against the current one", () => {
    expect(diagnosticIsHistorical({ qaDependencyFingerprint: "a" }, "a")).toBe(false);
    expect(diagnosticIsHistorical({ qaDependencyFingerprint: "a" }, "b")).toBe(true);
    expect(diagnosticIsHistorical({}, "b")).toBeUndefined();
    expect(diagnosticIsHistorical({ qaDependencyFingerprint: "a" }, undefined)).toBeUndefined();
  });

  it("compareQaDiagnosticFingerprint categorizes current, historical, and legacy diagnostics", () => {
    expect(compareQaDiagnosticFingerprint({ qaDependencyFingerprint: "fp-match" }, "fp-match")).toBe("current");
    expect(compareQaDiagnosticFingerprint({ qaDependencyFingerprint: "fp-old" }, "fp-new")).toBe("historical");
    expect(compareQaDiagnosticFingerprint({}, "fp-new")).toBe("unknown_legacy");
    expect(compareQaDiagnosticFingerprint({ qaDependencyFingerprint: "fp-old" }, undefined)).toBe("unknown_legacy");
    expect(compareQaDiagnosticFingerprint({}, undefined)).toBe("unknown_legacy");
  });

  it("redacts credentials from user-visible technical details", () => {
    const diagnostic = createErrorDiagnostic(new Error("Provider failed with Bearer secret-token and api_key=secret-value at postgres://user:password@localhost/db"));
    expect(JSON.stringify(diagnostic)).not.toContain("secret-token");
    expect(JSON.stringify(diagnostic)).not.toContain("secret-value");
    expect(JSON.stringify(diagnostic)).not.toContain(":password@");
  });
});
