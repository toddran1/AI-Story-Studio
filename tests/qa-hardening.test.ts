import { mkdtemp, readFile, mkdir, rm } from "node:fs/promises";
import { mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { qaStateSchema } from "../src/domain/qa.js";
import { canonicalEntitySchema, emptyStoryBible } from "../src/domain/story-bible.js";
import { computeContentSpans, decideQaRecheckMode, prepareQaDetections } from "../src/qa/review.js";
import { computeQaDependencyFingerprints, deriveChapterQaFreshness, qaDependencySnapshot, resolveStoredQaContext } from "../src/qa/freshness.js";
import { filterExceptedFindings, validateExceptionSpecificity } from "../src/qa/exceptions.js";
import { loadAcceptedContinuity } from "../src/qa/deterministic.js";
import { inferQaRepairTargets } from "../src/qa/repair.js";
import { QaExceptionTooBroadError, QaPrerequisiteError } from "../src/qa/errors.js";
import { persistQaStateWithMetadata } from "../src/qa/persistence.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { fileFingerprint } from "../src/utils/file-fingerprint.js";
import { testStory } from "./helpers.js";

const emptyState = qaStateSchema.parse({ status: "pass", score: 1, issues: [], checks: { completeness: "pass", names: "pass", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" }, findings: [] });
const deps = () => ({ source: "source", translation: "text-v1", narration: "voice-v1", context: { entities: [] }, config: { mode: "production" }, narrationSettings: {}, prompt: "p1", mode: "production" as const, naming: [], pronunciation: [], exceptions: [], acceptedContinuity: [] });

describe("QA hardening", () => {
  it("uses changed-only only for a small text-only change and forces full for global dependencies", () => {
    const translation = "First paragraph stays.\n\nSecond paragraph changed.\n\nThird paragraph stays.";
    const narration = "Narration remains as written.";
    const fingerprints = computeQaDependencyFingerprints(deps());
    const prior = qaStateSchema.parse({ ...emptyState, contentSpans: computeContentSpans("First paragraph stays.\n\nSecond paragraph old.\n\nThird paragraph stays.", narration), dependencySnapshot: qaDependencySnapshot(fingerprints) });
    const snapshot = { ...qaDependencySnapshot(fingerprints), text: "text-updated" };
    expect(decideQaRecheckMode({ requestedMode: "changed", previous: prior, currentSnapshot: snapshot, translation, narration }).reason).toBe("changed_text_only");
    expect(decideQaRecheckMode({ requestedMode: "changed", previous: prior, currentSnapshot: { ...snapshot, naming: "changed" }, translation, narration })).toMatchObject({ effectiveMode: "full", reason: "global_dependency_changed", globalDependencyChanges: ["naming"], dependencyChanges: { textChanged: true, namingChanged: true } });
    for (const key of ["source", "naming", "pronunciation", "exceptions", "acceptedContinuity", "context", "config", "narrationSettings", "prompt", "mode"] as const) {
      expect(decideQaRecheckMode({ requestedMode: "changed", previous: prior, currentSnapshot: { ...snapshot, [key]: `changed-${key}` }, translation, narration }).effectiveMode).toBe("full");
    }
    expect(decideQaRecheckMode({ requestedMode: "changed", previous: emptyState, currentSnapshot: snapshot, translation, narration }).reason).toBe("missing_prior_spans");
  });

  it("anchors entity findings before entity exception filtering and does not match unrelated IDs", () => {
    const entity = canonicalEntitySchema.parse({ id: "ent_aaaaaaaaaaaaaaaaaaaaaaaa", type: "character", canonicalName: "Su Ming", originalName: "苏铭", aliases: [], firstAppearance: 1, lastKnownAppearance: 2 });
    const detections = prepareQaDetections([{ category: "names", severity: "warn", message: "Name use for Su Ming is inconsistent", evidence: "Su Ming appears here.", origin: "llm" }], { canonicalEntities: [entity], translation: "Su Ming appears here.", narration: "Su Ming appears here." });
    expect(detections[0]?.entityIds).toContain(entity.id);
    expect(filterExceptedFindings(detections, [{ id: "qax_aaaaaaaaaaaaaaaaaaaaaaaa", category: "names", matchKind: "entity", value: entity.id, createdAt: new Date().toISOString() }])).toHaveLength(0);
    expect(filterExceptedFindings(detections, [{ id: "qax_bbbbbbbbbbbbbbbbbbbbbbbb", category: "names", matchKind: "entity", value: "ent_bbbbbbbbbbbbbbbbbbbbbbbb", createdAt: new Date().toISOString() }])).toHaveLength(1);
    const sameName = canonicalEntitySchema.parse({ ...entity, id: "ent_bbbbbbbbbbbbbbbbbbbbbbbb" });
    const ambiguous = prepareQaDetections([{ category: "names", severity: "warn", message: "Name use for Su Ming is inconsistent", evidence: "Su Ming appears here.", origin: "llm" }], { canonicalEntities: [entity, sameName], translation: "Su Ming appears here.", narration: "Su Ming appears here." });
    expect(filterExceptedFindings(ambiguous, [{ id: "qax_aaaaaaaaaaaaaaaaaaaaaaaa", category: "names", matchKind: "entity", value: entity.id, createdAt: new Date().toISOString() }])).toHaveLength(1);
  });

  it("matches exception phrases by normalized boundaries and rejects generic suppressors", () => {
    const finding = { category: "terminology" as const, severity: "warn" as const, message: "The Kingfisher arrived", evidence: "The Kingfisher entered town." };
    expect(filterExceptedFindings([finding], [{ id: "qax_aaaaaaaaaaaaaaaaaaaaaaaa", category: "terminology", matchKind: "terminology", value: "King", createdAt: new Date().toISOString() }])).toHaveLength(1);
    expect(filterExceptedFindings([finding], [{ id: "qax_bbbbbbbbbbbbbbbbbbbbbbbb", category: "terminology", matchKind: "terminology", value: "Kingfisher", createdAt: new Date().toISOString() }])).toHaveLength(0);
    expect(() => validateExceptionSpecificity("other", "city")).toThrow(QaExceptionTooBroadError);
  });

  it("infers repair artifact from evidence and keeps ambiguous comparison findings unresolved", () => {
    const common = { category: "dialogue" as const, message: "The wording is changed.", provenance: undefined, origin: "llm" as const };
    expect(inferQaRepairTargets({ ...common, evidence: "Translation contains a unique line here." }, { translation: "A unique line here.", narration: "Other natural words." }).targets).toEqual(["translation"]);
    expect(inferQaRepairTargets({ ...common, evidence: "Narration contains a unique spoken line here." }, { translation: "Different words entirely.", narration: "A unique spoken line here." }).targets).toEqual(["narration"]);
    expect(inferQaRepairTargets({ ...common, evidence: "Translation/narration comparison: meaning differs." }, { translation: "One version.", narration: "Another version." }).confidence).toBe("ambiguous");
  });

  it("fails closed on malformed existing Story Context and Continuity Review, but allows missing continuity", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-prerequisite-"));
    const storyContext = join(root, "context.json");
    await expect(resolveStoredQaContext({ storyContext })).resolves.toMatchObject({ parsed: emptyStoryBible() });
    await atomicWrite(storyContext, "{bad json");
    await expect(resolveStoredQaContext({ storyContext })).rejects.toMatchObject({ code: "QA_CONTEXT_INVALID" });
    expect(await loadAcceptedContinuity(root, "sample-story")).toEqual([]);
    const continuityPath = join(root, "stories", "sample-story", "continuity-review.json");
    await mkdir(join(root, "stories", "sample-story"), { recursive: true });
    await atomicWriteJson(continuityPath, { version: 1, findings: "broken" });
    await expect(loadAcceptedContinuity(root, "sample-story")).rejects.toMatchObject({ code: "QA_CONTINUITY_INVALID" });
    const story = testStory();
    const storyDirectory = join(root, "stories", story.slug);
    await mkdir(storyDirectory, { recursive: true });
    await atomicWriteJson(join(storyDirectory, "continuity-review.json"), { version: 1, findings: "broken" });
    expect(await deriveChapterQaFreshness(root, story, 1, { status: "complete", fingerprint: "old" })).toMatchObject({ freshness: "needs_recheck" });
    expect(QaPrerequisiteError).toBeDefined();
  });

  it("rolls QA bytes back when metadata update fails and fingerprints the successful persisted state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-transaction-"));
    const paths = { qa: join(dir, "qa.json"), chapterMeta: join(dir, "chapter.json") };
    const oldState = qaStateSchema.parse({ ...emptyState, score: 0.8 });
    const nextState = qaStateSchema.parse({ ...emptyState, score: 0.9 });
    const metadata = { chapter: 1, updatedAt: "old", stages: { qa: { status: "complete" } } } as never;
    await atomicWriteJson(paths.qa, oldState); await atomicWriteJson(paths.chapterMeta, metadata);
    const beforeQa = await readFile(paths.qa); const beforeMeta = await readFile(paths.chapterMeta);
    await expect(persistQaStateWithMetadata(paths, nextState, metadata as never, () => { throw new Error("simulated metadata update failure"); })).rejects.toThrow("simulated metadata update failure");
    expect(await readFile(paths.qa)).toEqual(beforeQa); expect(await readFile(paths.chapterMeta)).toEqual(beforeMeta);
    const result = await persistQaStateWithMetadata(paths, nextState, metadata as never, (outputFingerprint, prior) => ({ ...prior, updatedAt: "new", stages: { ...prior.stages, qa: { ...prior.stages.qa, outputFingerprint } } }));
    expect(result.outputFingerprint).toBe(await fileFingerprint(paths.qa));

    const damaged = { qa: join(dir, "rollback-qa.json"), chapterMeta: join(dir, "rollback-chapter.json") };
    await atomicWriteJson(damaged.qa, oldState); await atomicWriteJson(damaged.chapterMeta, metadata);
    await expect(persistQaStateWithMetadata(damaged, nextState, metadata as never, () => {
      unlinkSync(damaged.qa); mkdirSync(damaged.qa); throw new Error("simulated metadata failure");
    })).rejects.toMatchObject({ code: "QA_PERSISTENCE_ROLLBACK_FAILED" });
    await rm(damaged.qa, { recursive: true, force: true });
  });
});
