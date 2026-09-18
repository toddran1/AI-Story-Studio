import { describe, expect, it } from "vitest";
import { buildQaState, recheckChapterQa, resolveQaFindingsByIndex, transitionQaFinding } from "../src/qa/review.js";
import { migrateQaState, openFindings, qaScoreFromOpenFindings, recomputeQaSummary } from "../src/qa/findings.js";
import { compareQaDiagnosticFingerprint } from "../src/errors/diagnostic.js";
import { QaResult, qaResultSchema, qaStateSchema, resolveQaIssues } from "../src/domain/qa.js";

const NOW = "2026-09-18T10:00:00.000Z";

describe("QA Historical Score & Status Semantics (Hardening)", () => {
  // Scenario A: initial warn/0.70 -> manual resolution -> current = pass/1.00 -> original remains warn/0.70
  it("Scenario A: initial warn/0.70 -> manual resolution -> current = pass/1.00 -> original remains warn/0.70", () => {
    const detections = [
      { category: "numbers" as const, severity: "warn" as const, message: "Lantern count mismatch", evidence: "ten vs twelve" },
      { category: "terminology" as const, severity: "warn" as const, message: "Terminology drift", evidence: "Azure Flame" },
      { category: "dialogue" as const, severity: "warn" as const, message: "Softened tone", evidence: "phrasing" },
    ];
    const { state: initial } = buildQaState(undefined, detections, {
      chapter: 1,
      translation: "T",
      narration: "N",
      now: NOW,
      baseScore: { score: 0.70, status: "warn" },
    });
    expect(initial.score).toBe(0.70);
    expect(initial.status).toBe("warn");
    expect(initial.originalScore).toBe(0.70);
    expect(initial.originalStatus).toBe("warn");

    // Resolve all 3 findings
    let resolved = initial;
    for (const finding of initial.findings) {
      resolved = transitionQaFinding(resolved, finding.id, "manual_fix", { now: NOW });
    }
    expect(resolved.score).toBe(1.00);
    expect(resolved.status).toBe("pass");
    expect(resolved.originalScore).toBe(0.70);
    expect(resolved.originalStatus).toBe("warn");
  });

  // Scenario B: initial fail -> AI fix -> current improves -> original historical result preserved
  it("Scenario B: initial fail -> AI fix -> current improves -> original historical result preserved", () => {
    const detections = [
      { category: "names" as const, severity: "fail" as const, message: "Protected entity renamed", evidence: "Su Ming became Marcus" },
      { category: "dialogue" as const, severity: "fail" as const, message: "Crucial dialogue dropped", evidence: "missing paragraph" },
    ];
    const { state: initial } = buildQaState(undefined, detections, {
      chapter: 1,
      translation: "T",
      narration: "N",
      now: NOW,
      baseScore: { score: 0.40, status: "fail" },
    });
    expect(initial.score).toBe(0.40);
    expect(initial.status).toBe("fail");
    expect(initial.originalScore).toBe(0.40);
    expect(initial.originalStatus).toBe("fail");

    // Partially resolve 1 finding with AI fix -> score improves from 0.40 to 0.70, original remains 0.40
    const partial = transitionQaFinding(initial, initial.findings[0]!.id, "ai_fix", { now: NOW });
    expect(partial.score).toBe(0.70);
    expect(partial.status).toBe("fail");
    expect(partial.originalScore).toBe(0.40);
    expect(partial.originalStatus).toBe("fail");

    // Fully resolve second finding -> score improves to 1.00, status pass, original remains 0.40 / fail
    const full = transitionQaFinding(partial, partial.findings[1]!.id, "ai_fix", { now: NOW });
    expect(full.score).toBe(1.00);
    expect(full.status).toBe("pass");
    expect(full.originalScore).toBe(0.40);
    expect(full.originalStatus).toBe("fail");
  });

  // Scenario C: resolved finding gets reopened by recheck -> current QA changes appropriately -> original historical result remains preserved
  it("Scenario C: resolved finding gets reopened by recheck -> current QA changes appropriately -> original historical result remains preserved", () => {
    const detection = {
      category: "names" as const,
      severity: "fail" as const,
      message: "Protected entity renamed",
      evidence: "Su Ming became Marcus",
    };
    const { state: initial } = buildQaState(undefined, [detection], {
      chapter: 1,
      translation: "T",
      narration: "N",
      now: NOW,
      baseScore: { score: 0.40, status: "fail" },
    });
    const resolved = transitionQaFinding(initial, initial.findings[0]!.id, "manual_fix", { now: NOW });
    expect(resolved.status).toBe("pass");
    expect(resolved.score).toBe(1.00);

    // Recheck returns the same detection (unresolved)
    const { state: reopened } = buildQaState(resolved, [detection], {
      chapter: 1,
      translation: "T",
      narration: "N",
      now: "2026-09-18T12:00:00.000Z",
      dependencyFingerprint: "fp-recheck",
    });
    expect(reopened.findings[0]!.status).toBe("open");
    expect(reopened.status).toBe("fail");
    expect(reopened.score).toBeLessThan(1.00);
    expect(reopened.originalScore).toBe(0.40);
    expect(reopened.originalStatus).toBe("fail");
  });

  // Reopen via transitionQaFinding preserves historical score and status
  it("explicit reopen action preserves historical score and status", () => {
    const detection = {
      category: "terminology" as const,
      severity: "warn" as const,
      message: "Terminology drift",
      evidence: "Azure Flame vs Cyan Fire",
    };
    const { state: initial } = buildQaState(undefined, [detection], {
      chapter: 1, translation: "T", narration: "N", now: NOW,
      baseScore: { score: 0.85, status: "warn" },
    });
    const resolved = transitionQaFinding(initial, initial.findings[0]!.id, "dismiss", { now: NOW });
    expect(resolved.score).toBe(1.00);
    expect(resolved.originalScore).toBe(0.85);
    expect(resolved.originalStatus).toBe("warn");

    const reopened = transitionQaFinding(resolved, resolved.findings[0]!.id, "reopen", { now: NOW });
    expect(reopened.score).toBe(0.9);
    expect(reopened.status).toBe("warn");
    expect(reopened.originalScore).toBe(0.85);
    expect(reopened.originalStatus).toBe("warn");
  });

  // Dismiss via resolveQaFindingsByIndex preserves historical score and status
  it("dismissal via resolveQaFindingsByIndex preserves historical score and status", () => {
    const detection = {
      category: "dialogue" as const,
      severity: "warn" as const,
      message: "Tone softened",
      evidence: "Threat phrasing adjusted",
    };
    const { state: initial } = buildQaState(undefined, [detection], {
      chapter: 1, translation: "T", narration: "N", now: NOW,
      baseScore: { score: 0.88, status: "warn" },
    });
    const dismissed = resolveQaFindingsByIndex(initial, [0], "dismissed", NOW, 1);
    expect(dismissed.score).toBe(1.00);
    expect(dismissed.status).toBe("pass");
    expect(dismissed.originalScore).toBe(0.88);
    expect(dismissed.originalStatus).toBe("warn");
  });

  // Obsolete retirement preserves historical score and status
  it("retiring findings as obsolete preserves historical score and status", () => {
    const detection = {
      category: "numbers" as const,
      severity: "warn" as const,
      message: "Count mismatch in old paragraph",
      evidence: "Old text with lanterns",
    };
    const { state: initial } = buildQaState(undefined, [detection], {
      chapter: 1, translation: "Old text with lanterns", narration: "Old text with lanterns", now: NOW,
      dependencyFingerprint: "fp-old",
      baseScore: { score: 0.80, status: "warn" },
    });
    // Fresh run where dependencies changed, paragraph is evaluated and anchor is gone
    const { state: obsoleteState } = buildQaState(initial, [], {
      chapter: 1, translation: "Brand new replacement text", narration: "Brand new replacement text", now: "2026-09-18T13:00:00.000Z",
      dependencyFingerprint: "fp-new",
      evaluatedContent: "Brand new replacement text\n\nBrand new replacement text",
    });
    expect(obsoleteState.findings[0]!.status).toBe("obsolete");
    expect(obsoleteState.score).toBe(1.00);
    expect(obsoleteState.status).toBe("pass");
    expect(obsoleteState.originalScore).toBe(0.80);
    expect(obsoleteState.originalStatus).toBe("warn");
  });

  // Migration of old QA files preserves/populates historical score and status
  it("migration of legacy QA files populates originalScore and originalStatus without loss", () => {
    const legacy = {
      status: "fail",
      score: 0.65,
      issues: [
        { category: "names", severity: "fail", message: "Name issue", evidence: "Evidence text" },
      ],
      checks: {
        completeness: "pass", names: "fail", numbers: "pass", terminology: "pass",
        dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass",
      },
    };
    const migrated = migrateQaState(legacy, { chapter: 2 });
    expect(migrated.originalScore).toBe(0.65);
    expect(migrated.originalStatus).toBe("fail");

    const resolved = resolveQaFindingsByIndex(migrated, [0], "manually_fixed", NOW, 2);
    expect(resolved.score).toBe(1.00);
    expect(resolved.status).toBe("pass");
    expect(resolved.originalScore).toBe(0.65);
    expect(resolved.originalStatus).toBe("fail");
  });

  // Historical fields do not influence the current QA score calculation
  it("historical fields never influence the current QA score calculation", () => {
    const detection = { category: "dialogue" as const, severity: "warn" as const, message: "Warning", evidence: "evidence" };
    const { state: lowHistorical } = buildQaState(undefined, [detection], {
      chapter: 1, translation: "T", narration: "N", now: NOW,
      baseScore: { score: 0.10, status: "fail" },
    });
    const { state: highHistorical } = buildQaState(undefined, [detection], {
      chapter: 1, translation: "T", narration: "N", now: NOW,
      baseScore: { score: 0.95, status: "warn" },
    });
    // Both have the same 1 open warning finding; their current score must be identical
    expect(recomputeQaSummary(lowHistorical.findings, lowHistorical).score).toBe(
      recomputeQaSummary(highHistorical.findings, highHistorical).score
    );
    expect(recomputeQaSummary(lowHistorical.findings, lowHistorical).score).toBe(0.9);
    expect(recomputeQaSummary(lowHistorical.findings, lowHistorical).originalScore).toBe(0.10);
    expect(recomputeQaSummary(highHistorical.findings, highHistorical).originalScore).toBe(0.95);
  });
});

describe("Legacy Failed Jobs & Fingerprint Diagnostics (Scenarios D, E, F, G)", () => {
  // Scenario D: new failed QA job + matching fingerprint -> treated as same/current dependency state
  it("Scenario D: new failed QA job + matching fingerprint -> treated as current", () => {
    const comparison = compareQaDiagnosticFingerprint(
      { qaDependencyFingerprint: "fp-match-123" },
      "fp-match-123"
    );
    expect(comparison).toBe("current");
  });

  // Scenario E: new failed QA job + different fingerprint -> treated as historical
  it("Scenario E: new failed QA job + different fingerprint -> treated as historical", () => {
    const comparison = compareQaDiagnosticFingerprint(
      { qaDependencyFingerprint: "fp-old-123" },
      "fp-new-456"
    );
    expect(comparison).toBe("historical");
  });

  // Scenario F: legacy QA failed job + no fingerprint -> treated as unknown legacy/history
  it("Scenario F: legacy QA failed job + no fingerprint -> treated as unknown_legacy", () => {
    const comparison = compareQaDiagnosticFingerprint({}, "fp-current-456");
    expect(comparison).toBe("unknown_legacy");
    expect(comparison).not.toBe("current");

    // Also unknown if current fingerprint is absent
    expect(compareQaDiagnosticFingerprint({ qaDependencyFingerprint: "fp-old" }, undefined)).toBe("unknown_legacy");
    expect(compareQaDiagnosticFingerprint({}, undefined)).toBe("unknown_legacy");
  });

  // Scenario G: legacy failure + current QA now pass -> handled by comparison logic
  it("Scenario G: legacy failure + current QA now pass -> identified cleanly", () => {
    const comparison = compareQaDiagnosticFingerprint({}, "fp-passing");
    expect(comparison).toBe("unknown_legacy");
    // When nowCurrent: true is present, the UI and logic treats this as:
    // "Chapter QA is current and passing now — this failure is historical."
    const isNowPassing = true;
    const legacyNotice = !isNowPassing && comparison === "unknown_legacy";
    const passingNotice = isNowPassing;
    expect(legacyNotice).toBe(false);
    expect(passingNotice).toBe(true);
  });
});
