import { describe, expect, it } from "vitest";
import { qaResultSchema } from "../src/domain/qa.js";
import { emptyStoryBible, storyBibleSchema } from "../src/domain/story-bible.js";
import { buildQaState } from "../src/qa/review.js";
import { captureQaRepairFindingSnapshotsFromIssues, captureQaRepairTextSnapshot, issueRepairTargets, repairQaText, repairTargets, selectRepairStage, targetOverridesByFindingId, validateQaRepairFindingSnapshots, validateQaRepairTextSnapshot } from "../src/qa/repair.js";
import { MockLLM } from "./helpers.js";

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

  it("does not guess a target for category-only findings while honoring explicit both-artifact wording", () => {
    const qa = qaResultSchema.parse({ status: "fail", score: 0.2, issues: [
      { category: "terminology", severity: "warn", message: "Wrong term", evidence: "Blade became sword" },
      { category: "narrationFidelity", severity: "fail", message: "Meaning changed", evidence: "Narration adds an event" },
    ], checks: { ...checks, terminology: "warn", narrationFidelity: "fail" } });
    expect(() => repairTargets(qa.issues)).toThrow(/Choose whether to repair translation, narration, or both/);
    expect(() => repairTargets([...qa.issues].reverse())).toThrow(/Choose whether to repair translation, narration, or both/);
    expect(issueRepairTargets({ category: "terminology", severity: "warn", message: "Wrong in both the translation and narration", evidence: "Use Flame Blade" })).toEqual(["translation", "narration"]);
  });

  it("passes selected evidence and the complete chapter to a focused repair", async () => {
    const current = "A complete corrected chapter remains long enough to pass the conservative repair guard. ".repeat(12);
    const provider = new MockLLM("openai", [current.replace("corrected", "faithful")]);
    const issue = qaResultSchema.parse({ status: "warn", score: 0.8, issues: [{ category: "terminology", severity: "warn", message: "Use canonical term", evidence: "Use Flame Blade" }], checks: { ...checks, terminology: "warn" } }).issues;
    const result = await repairQaText(provider, { provider: "openai", model: "repair-model" }, { target: "translation", chapter: 6, sourceLanguage: "zh-CN", outputLanguage: "en-US", source: "原文", translation: current, narration: current, issues: issue });
    expect(result.text).toContain("faithful");
    expect(provider.calls[0]?.input).toContain("Use Flame Blade");
    expect(provider.calls[0]?.input).toContain("CURRENT TRANSLATION");
  });

  it("rejects a suspiciously shortened repair before it can be saved", async () => {
    const provider = new MockLLM("openai", ["Short summary."]);
    const current = "Full chapter sentence. ".repeat(100);
    const issue = qaResultSchema.parse({ status: "warn", score: 0.8, issues: [{ category: "terminology", severity: "warn", message: "Fix term", evidence: "Evidence" }], checks: { ...checks, terminology: "warn" } }).issues;
    await expect(repairQaText(provider, { provider: "openai", model: "repair-model" }, { target: "translation", chapter: 6, sourceLanguage: "zh-CN", outputLanguage: "en-US", source: "原文", translation: current, narration: current, issues: issue })).rejects.toThrow("length implausibly");
  });

  it("rejects an unchanged repair instead of reporting a misleading success", async () => {
    const current = "The complete chapter preserves every important detail. ".repeat(20);
    const provider = new MockLLM("openai", [current]);
    const issue = qaResultSchema.parse({ status: "warn", score: 0.8, issues: [{ category: "narrationFidelity", severity: "warn", message: "Narration adds an unsupported detail", evidence: "The source does not mention this event." }], checks: { ...checks, narrationFidelity: "warn" } }).issues;
    await expect(repairQaText(provider, { provider: "openai", model: "repair-model" }, { target: "narration", chapter: 6, sourceLanguage: "zh-CN", outputLanguage: "en-US", source: "原文", translation: current, narration: current, issues: issue })).rejects.toThrow("unchanged narration repair");
  });

  it("guards authorized narration names, system panels, and wrong findings in repair instructions", async () => {
    const current = "Asher crossed the courtyard beneath a status window. ".repeat(20);
    const repaired = current.replace("crossed", "walked through");
    const provider = new MockLLM("openai", [repaired]);
    const context = storyBibleSchema.parse({ ...emptyStoryBible(), canonicalEntities: [{ id: "ent_aaaaaaaaaaaaaaaaaaaaaaaa", type: "character", canonicalName: "Su Ming", originalName: "苏明", aliases: [], preferredNarrationName: "Asher", aliasNarrationRules: [], firstAppearance: 1, lastKnownAppearance: 6, status: "alive" }] });
    const issue = qaResultSchema.parse({ status: "warn", score: 0.8, issues: [{ category: "narrationFidelity", severity: "warn", message: "Fault lies in the narration", evidence: "Narration: walked. Translation: crossed." }], checks: { ...checks, narrationFidelity: "warn" } }).issues;
    await repairQaText(provider, { provider: "openai", model: "repair-model" }, { target: "narration", chapter: 6, sourceLanguage: "zh-CN", outputLanguage: "en-US", source: "原文", translation: current, narration: current, issues: issue, context });
    const instructions = (provider.calls[0] as { instructions?: string })?.instructions ?? "";
    expect(instructions).toContain("AUTHORIZED NARRATION NAMING MAPPINGS");
    expect(instructions).toContain('Preferred Narration Name "Asher"');
    expect(instructions).toContain("never revert an authorized narration-name substitution");
    expect(instructions).toContain("verbatim, character for character");
    expect(instructions).toContain("make no change for that finding");
  });
});

describe("stable QA repair selection", () => {
  const stateWithTwo = () => buildQaState(undefined, [
    { category: "terminology", severity: "warn", message: "Translation contains the wrong red blade term", evidence: "Translation uses crimson blade where source says azure blade." },
    { category: "numbers", severity: "fail", message: "Translation contains the wrong quantity", evidence: "Translation says twelve when the source says ten." },
  ], { chapter: 12, translation: "Translation uses crimson blade and says twelve.", narration: "Translation uses crimson blade and says twelve." }).state;

  it("maps a legacy public issue to the exact matching open persistent finding", () => {
    const state = stateWithTwo();
    const snapshots = captureQaRepairFindingSnapshotsFromIssues(state.issues, state.findings, [1]);
    expect(snapshots.map(({ id }) => id)).toEqual([state.findings[1]!.id]);
    expect(snapshots.every(({ id }) => id.startsWith("qaf_") )).toBe(true);
  });

  it("does not let an obsolete finding before the issue shift its identity", () => {
    const state = stateWithTwo();
    const obsolete = { ...state.findings[0]!, id: "qaf_aaaaaaaaaaaaaaaaaaaaaaaa", message: "Obsolete old finding", status: "obsolete" as const };
    const findings = [state.findings[0]!, obsolete, state.findings[1]!];
    expect(captureQaRepairFindingSnapshotsFromIssues(state.issues, findings, [1])).toEqual([
      { id: state.findings[1]!.id, fingerprint: state.findings[1]!.fingerprint },
    ]);
  });

  it.each(["dismissed", "fixed_manual", "fixed_ai"] as const)("maps past a prior %s finding without relying on its position", (status) => {
    const state = stateWithTwo();
    const findings = [{ ...state.findings[0]!, status }, state.findings[1]!];
    expect(captureQaRepairFindingSnapshotsFromIssues(state.issues, findings, [1]).map(({ id }) => id)).toEqual([state.findings[1]!.id]);
  });

  it("rejects legacy issue mappings that are missing or ambiguous", () => {
    const state = stateWithTwo();
    expect(() => captureQaRepairFindingSnapshotsFromIssues(state.issues, [state.findings[0]!], [1])).toThrowError(expect.objectContaining({ code: "QA_FINDING_STALE_SELECTION" }));
    expect(() => captureQaRepairFindingSnapshotsFromIssues(state.issues, [state.findings[0]!, state.findings[0]!], [0])).toThrowError(expect.objectContaining({ code: "QA_FINDING_STALE_SELECTION" }));
  });

  it("reselects the originally captured finding after issue ordering changes", () => {
    const state = stateWithTwo(); const snapshots = captureQaRepairFindingSnapshotsFromIssues(state.issues, state.findings, [0]);
    const reordered = { ...state, findings: [...state.findings].reverse() };
    expect(validateQaRepairFindingSnapshots(reordered, snapshots)[0]!.id).toBe(snapshots[0]!.id);
    expect(reordered.findings[0]!.id).not.toBe(snapshots[0]!.id);
  });

  it.each([
    ["disappears", (state: ReturnType<typeof stateWithTwo>) => ({ ...state, findings: state.findings.slice(0, 1) })],
    ["becomes resolved", (state: ReturnType<typeof stateWithTwo>) => ({ ...state, findings: state.findings.map((finding, index) => index === 1 ? { ...finding, status: "fixed_manual" as const } : finding) })],
    ["changes materially", (state: ReturnType<typeof stateWithTwo>) => ({ ...state, findings: state.findings.map((finding, index) => index === 1 ? { ...finding, message: "A different defect", fingerprint: "changed-fingerprint" } : finding) })],
  ])("rejects a selected finding that %s", (_label, update) => {
    const state = stateWithTwo(); const snapshots = captureQaRepairFindingSnapshotsFromIssues(state.issues, state.findings, [1]);
    expect(() => validateQaRepairFindingSnapshots(update(state), snapshots)).toThrowError(expect.objectContaining({ code: "QA_FINDING_STALE_SELECTION" }));
  });

  it("keeps a legacy index target override attached to its resolved finding ID", () => {
    const state = stateWithTwo(); const indexes = [1, 0]; const snapshots = captureQaRepairFindingSnapshotsFromIssues(state.issues, state.findings, indexes);
    expect(targetOverridesByFindingId(indexes, snapshots, { "0": "narration", "1": "translation" })).toEqual({
      [state.findings[1]!.id]: "translation", [state.findings[0]!.id]: "narration",
    });
  });
});

describe("QA repair text snapshots", () => {
  it("allow unchanged text and distinguish missing, empty, and present artifacts", () => {
    const snapshot = captureQaRepairTextSnapshot("", undefined);
    expect(() => validateQaRepairTextSnapshot(snapshot, "", undefined)).not.toThrow();
    expect(() => validateQaRepairTextSnapshot(snapshot, undefined, "")).toThrowError(expect.objectContaining({ code: "QA_FINDING_STALE_SELECTION" }));
    expect(() => validateQaRepairTextSnapshot(snapshot, "text", undefined)).toThrowError(expect.objectContaining({ code: "QA_FINDING_STALE_SELECTION" }));
  });

  it("rejects a change to either selected text artifact but ignores unrelated QA timestamps", () => {
    const snapshot = captureQaRepairTextSnapshot("translation", "narration");
    expect(() => validateQaRepairTextSnapshot(snapshot, "translation changed", "narration")).toThrowError(expect.objectContaining({ code: "QA_FINDING_STALE_SELECTION" }));
    expect(() => validateQaRepairTextSnapshot(snapshot, "translation", "narration changed")).toThrowError(expect.objectContaining({ code: "QA_FINDING_STALE_SELECTION" }));
    // Snapshot inputs deliberately contain only the two chapter text artifacts;
    // QA timestamps/state mutations cannot affect their identity.
    expect(() => validateQaRepairTextSnapshot(snapshot, "translation", "narration")).not.toThrow();
  });
});
