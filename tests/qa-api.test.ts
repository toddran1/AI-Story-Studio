import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getQaDashboard } from "../apps/server/catalog.js";
import { Job, JobManager } from "../apps/server/job-manager.js";
import { StudioOperations } from "../apps/server/operations.js";
import { readActivity } from "../src/studio/projects.js";
import { loadEnvironment } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { emptyStoryBible, storyBibleSchema } from "../src/domain/story-bible.js";
import { Story } from "../src/domain/story.js";
import { qaStateSchema } from "../src/domain/qa.js";
import { diagnosticIsHistorical } from "../src/errors/diagnostic.js";
import { LLMRouter } from "../src/llm/router.js";
import { buildQaState } from "../src/qa/review.js";
import { deriveIssues } from "../src/qa/findings.js";
import { computeStoredQaDependencyFingerprint } from "../src/qa/freshness.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { exists, readJsonIfExists } from "../src/storage/story-files.js";
import { fileFingerprint } from "../src/utils/file-fingerprint.js";
import { MockLLM } from "./helpers.js";

const env = loadEnvironment({});
const NOW = "2026-09-16T12:00:00.000Z";
const checks = { completeness: "pass", names: "pass", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" } as const;

function waitForJob(jobs: JobManager, id: string): Promise<Job> {
  return new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("Job timed out")), 5000); const unsubscribe = jobs.subscribe(id, (job) => { if (["completed", "failed", "paused"].includes(job.status)) { clearTimeout(timeout); unsubscribe?.(); resolve(job); } }); });
}

const detection = (overrides: Record<string, unknown> = {}) => ({
  category: "terminology" as const, severity: "warn" as const,
  message: "Use the canonical ability name", evidence: "Azure Flame is the locked term.",
  ...overrides,
});

async function fixture(options: {
  detections?: Parameters<typeof buildQaState>[1];
  narration?: string; translation?: string;
  extraStages?: Record<string, unknown>;
  bibleEntities?: Record<string, unknown>[];
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "qa-api-"));
  const story = defaultStory("night-lantern", env);
  const paths = storyPaths(root, story.slug, 1);
  await atomicWriteJson(paths.storyConfig, story); await atomicWriteJson(paths.pipelineConfig, story.pipeline);
  const now = new Date().toISOString();
  const complete = { status: "complete" as const, fingerprint: "in", outputFingerprint: "out" };
  const chapter = chapterSchema.parse({
    chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
    counts: { originalCharacters: 100, englishWords: 120, narrationWords: 120 }, createdAt: now, updatedAt: now,
    stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: { status: "pending" }, tts: { status: "pending" }, ...(options.extraStages ?? {}) },
  });
  const translation = options.translation ?? "The keeper crossed the quiet courtyard and counted the small blue flames.";
  const narration = options.narration ?? translation;
  await atomicWrite(paths.original, "守灯人穿过庭院。".repeat(50));
  await atomicWrite(paths.english, translation);
  await atomicWrite(paths.narration, narration);
  await atomicWriteJson(paths.storyContext, {});
  if (options.bibleEntities) await atomicWriteJson(paths.bible, storyBibleSchema.parse({ ...emptyStoryBible(), canonicalEntities: options.bibleEntities }));
  // Record the same authoritative dependency fingerprint the pipeline would,
  // so freshness checks see this fixture as current.
  const qaFingerprint = await computeStoredQaDependencyFingerprint(root, story, 1);
  await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({ ...chapter, stages: { ...chapter.stages, qa: { status: "complete" as const, fingerprint: qaFingerprint, outputFingerprint: "out" } } }));
  let state;
  if (options.detections) {
    state = buildQaState(undefined, options.detections, { chapter: 1, translation, narration, now: NOW, dependencyFingerprint: qaFingerprint }).state;
    await atomicWriteJson(paths.qa, state);
  }
  return { root, story, paths, state, translation, narration, qaFingerprint };
}

const openaiQa = (qaResponse?: unknown) => new MockLLM("openai", undefined, qaResponse);
const operationsWith = (root: string, ...llms: MockLLM[]) => {
  const jobs = new JobManager();
  const operations = new StudioOperations(root, env, jobs, { llm: new LLMRouter(new Map(llms.map((llm) => [llm.name, llm]))) });
  return { jobs, operations };
};
const readState = async (paths: ReturnType<typeof storyPaths>) => qaStateSchema.parse(JSON.parse(await readFile(paths.qa, "utf8")));

describe("chapter QA state endpoint", () => {
  it("returns the migrated state with counts and stale flag", async () => {
    const { root, story, state } = await fixture({ detections: [detection()] });
    const { operations } = operationsWith(root, openaiQa());
    const result = await operations.getChapterQa(story.slug, 1);
    expect(result.counts).toEqual({ open: 1, resolved: 0, safeFixesAvailable: 0 });
    expect(result.state.findings[0]!.id).toBe(state!.findings[0]!.id);
    expect(result.artifacts).toEqual({ translationAvailable: true, narrationAvailable: true });
    expect(result.repairPrerequisites?.storyContextValid).toBe(true);
    expect(result.qaStale).toBe(false);
    await operations.close();
  });

  it("reports missing text artifacts and excludes repairs that need them", async () => {
    const { root, story, paths } = await fixture({ detections: [detection({ safeToFix: true, provenance: { stage: "narration" } })] });
    const { operations } = operationsWith(root, openaiQa());
    await rm(paths.english); await rm(paths.narration);
    const result = await operations.getChapterQa(story.slug, 1);
    expect(result.artifacts).toEqual({ translationAvailable: false, narrationAvailable: false });
    expect(result.counts.safeFixesAvailable).toBe(0);
    await operations.close();
  });

  it("does not turn non-ENOENT chapter text read failures into empty text", async () => {
    const { root, story, paths } = await fixture({ detections: [detection()] });
    const { operations } = operationsWith(root, openaiQa());
    await rm(paths.english); await mkdir(paths.english);
    await expect(operations.getChapterQa(story.slug, 1)).rejects.toMatchObject({ code: "EISDIR" });
    await operations.close();
  });

  it("blocks Safe Fix before provider or writes when existing Story Context is malformed", async () => {
    const { root, story, paths } = await fixture({ detections: [detection({ safeToFix: true, provenance: { stage: "translation" } })] });
    const llm = openaiQa(); const { operations } = operationsWith(root, llm);
    const beforeTranslation = await readFile(paths.english, "utf8"); const beforeNarration = await readFile(paths.narration, "utf8"); const beforeQa = await readFile(paths.qa);
    await atomicWrite(paths.storyContext, "{ definitely not json");
    const presentation = await operations.getChapterQa(story.slug, 1);
    expect(presentation.repairPrerequisites).toMatchObject({ storyContextValid: false });
    expect(presentation.counts.safeFixesAvailable).toBe(0);
    await expect(operations.applyQaSafeFixes(story.slug, 1)).rejects.toMatchObject({ code: "QA_CONTEXT_INVALID" });
    expect(llm.calls).toHaveLength(0);
    expect(await readFile(paths.english, "utf8")).toBe(beforeTranslation);
    expect(await readFile(paths.narration, "utf8")).toBe(beforeNarration);
    expect(await readFile(paths.qa)).toEqual(beforeQa);
    await operations.close();
  });

  it("queues selected repair by finding ID, not index, when QA ordering changes", async () => {
    const { root, story, paths } = await fixture({ detections: [
      detection({ message: "Translation contains the unsupported red blade term", evidence: "Translation says red blade; source says blue blade.", provenance: { stage: "translation" } }),
      detection({ category: "numbers", message: "Translation contains the wrong quantity", evidence: "Translation says twelve where source says ten.", provenance: { stage: "translation" } }),
    ] });
    const before = await readState(paths); const selectedId = before.findings[0]!.id; const selectedMessage = before.findings[0]!.message;
    const jobs = new JobManager(); const gemini = new MockLLM("gemini", ["The keeper crossed the calm courtyard and counted the small blue flames."]);
    const openai = openaiQa(); let queuedRunner: Parameters<JobManager["create"]>[2] | undefined;
    const now = new Date().toISOString();
    vi.spyOn(jobs, "create").mockImplementation((type, jobStory, runner, payload) => {
      queuedRunner = runner;
      return { id: "deferred-qa-repair", type, story: jobStory, status: "queued", createdAt: now, updatedAt: now, payload };
    });
    const operations = new StudioOperations(root, env, jobs, { llm: new LLMRouter(new Map([["openai", openai], ["gemini", gemini]])) });
    const queued = await operations.startQaRepair(story.slug, 1, { issueIndexes: [0], targetOverrides: { "0": "translation" } });
    expect(queued.payload).toMatchObject({ findingSelections: [{ id: selectedId }], targetOverridesByFindingId: { [selectedId]: "translation" } });
    const reordered = { ...before, findings: [...before.findings].reverse() };
    await atomicWriteJson(paths.qa, { ...reordered, issues: deriveIssues(reordered.findings) });
    const result = await queuedRunner!({ update() {}, setPause() {} });
    expect(result).toMatchObject({ findingIds: [selectedId], repaired: ["translation"] });
    expect(gemini.calls).toHaveLength(1);
    expect(gemini.calls[0]?.input).toContain(selectedMessage);
    expect(gemini.calls[0]?.input).not.toContain(before.findings[1]!.message);
    expect(openai.calls).toHaveLength(0);
    await operations.close();
  });

  it("rejects queued selected repair when chapter text changes after selection", async () => {
    const { root, story, paths } = await fixture({ detections: [detection({ provenance: { stage: "translation" } })] });
    const beforeQa = await readFile(paths.qa); const beforeNarration = await readFile(paths.narration, "utf8"); const findingId = (await readState(paths)).findings[0]!.id;
    const llm = new MockLLM("gemini", ["A repaired translation with every chapter detail retained.".repeat(2)]);
    const jobs = new JobManager(); let queuedRunner: Parameters<JobManager["create"]>[2] | undefined;
    vi.spyOn(jobs, "create").mockImplementation((type, jobStory, runner) => {
      queuedRunner = runner;
      return { id: "deferred-stale-text-repair", type, story: jobStory, status: "queued", createdAt: NOW, updatedAt: NOW };
    });
    const operations = new StudioOperations(root, env, jobs, { llm: new LLMRouter(new Map([["gemini", llm]])) });
    await operations.startQaRepair(story.slug, 1, { findingIds: [findingId], targetOverridesByFindingId: { [findingId]: "translation" } });
    await atomicWrite(paths.english, "Translation changed while the selected QA repair was waiting for its story lock.");
    const afterTranslation = await readFile(paths.english, "utf8");
    await expect(queuedRunner!({ update() {}, setPause() {} })).rejects.toMatchObject({ code: "QA_FINDING_STALE_SELECTION" });
    expect(llm.calls).toHaveLength(0);
    expect(await readFile(paths.english, "utf8")).toBe(afterTranslation);
    expect(await readFile(paths.narration, "utf8")).toBe(beforeNarration);
    expect(await readFile(paths.qa)).toEqual(beforeQa);
    expect(await readActivity(root, story.slug)).toHaveLength(0);
    await operations.close();
  });

  it("rejects malformed Story Context in queued batch repair before provider calls or writes", async () => {
    const { root, story, paths } = await fixture({ detections: [detection({ safeToFix: true, provenance: { stage: "translation" } })] });
    const llm = openaiQa(["A repaired chapter with all original details retained. ".repeat(3)]); const { jobs, operations } = operationsWith(root, llm);
    const beforeTranslation = await readFile(paths.english, "utf8"); const beforeNarration = await readFile(paths.narration, "utf8"); const beforeQa = await readFile(paths.qa);
    await atomicWrite(paths.storyContext, "{ malformed");
    const findingId = (await readState(paths)).findings[0]!.id;
    const job = await operations.startQaRepair(story.slug, 1, { findingIds: [findingId], targetOverridesByFindingId: { [findingId]: "translation" } });
    const finished = await waitForJob(jobs, job.id);
    expect(finished.status).toBe("failed"); expect(finished.diagnostic?.code).toBe("QA_CONTEXT_INVALID");
    expect(llm.calls).toHaveLength(0);
    expect(await readFile(paths.english, "utf8")).toBe(beforeTranslation);
    expect(await readFile(paths.narration, "utf8")).toBe(beforeNarration);
    expect(await readFile(paths.qa)).toEqual(beforeQa);
    await operations.close();
  });

  it("blocks single-finding AI repair on malformed Story Context before provider calls or writes", async () => {
    const { root, story, paths } = await fixture({ detections: [detection({ provenance: { stage: "translation" } })] });
    const llm = openaiQa(); const { jobs, operations } = operationsWith(root, llm); const findingId = (await readState(paths)).findings[0]!.id;
    const beforeTranslation = await readFile(paths.english, "utf8"); const beforeNarration = await readFile(paths.narration, "utf8"); const beforeQa = await readFile(paths.qa);
    await atomicWrite(paths.storyContext, "{ malformed");
    const job = await operations.startQaFindingFix(story.slug, 1, findingId, { target: "translation" });
    const finished = await waitForJob(jobs, job.id);
    expect(finished.status).toBe("failed"); expect(finished.diagnostic?.code).toBe("QA_CONTEXT_INVALID");
    expect(llm.calls).toHaveLength(0);
    expect(await readFile(paths.english, "utf8")).toBe(beforeTranslation);
    expect(await readFile(paths.narration, "utf8")).toBe(beforeNarration);
    expect(await readFile(paths.qa)).toEqual(beforeQa);
    await operations.close();
  });

  it("derives qaStale from the authoritative dependency fingerprint", async () => {
    const { root, story, paths, qaFingerprint } = await fixture({ detections: [detection()] });
    const { operations } = operationsWith(root, openaiQa());
    const current = await operations.getChapterQa(story.slug, 1);
    expect(current.freshness).toBe("current");
    expect(current.qaStale).toBe(false);
    expect(current.currentFingerprint).toBe(qaFingerprint);
    expect(current.stats?.needsVerification).toBe(0);
    // A failure diagnostic recorded now becomes historical once a dependency changes.
    expect(diagnosticIsHistorical({ qaDependencyFingerprint: qaFingerprint! }, current.currentFingerprint)).toBe(false);
    // Change a QA dependency (the narration text) without re-running QA.
    await atomicWrite(paths.narration, "The keeper crossed the noisy courtyard and counted the small blue flames.");
    const stale = await operations.getChapterQa(story.slug, 1);
    expect(stale.freshness).toBe("needs_recheck");
    expect(stale.qaStale).toBe(true);
    expect(stale.currentFingerprint).not.toBe(qaFingerprint);
    expect(stale.stats?.needsVerification).toBe(1);
    expect(diagnosticIsHistorical({ qaDependencyFingerprint: qaFingerprint! }, stale.currentFingerprint)).toBe(true);
    const dashboard = await getQaDashboard(root, story.slug);
    expect(dashboard.counts.needsVerification).toBe(1);
    expect(dashboard.chapters[0]).toMatchObject({ stale: true, needsVerification: 1 });
    await operations.close();
  });

  it("supports recheck modes and reports the summary in the job result", async () => {
    const narration = "The keeper raised the Azure Flame high above the gate.";
    // Anchor the prior finding to a phrase that genuinely survives in the content;
    // scattered shared words no longer count as presence.
    const anchored = detection({ evidence: `Narration says "The keeper raised the Azure Flame" at dusk.` });
    const { root, story } = await fixture({ detections: [anchored], translation: narration, narration });
    const openai = openaiQa();
    const { jobs, operations } = operationsWith(root, openai);
    const finished = await waitForJob(jobs, operations.startQaRecheck(story.slug, 1, { mode: "changed" }).id);
    expect(finished.status).toBe("completed");
    // Legacy QA without a dependency snapshot cannot prove a text-only edit, so it falls back conservatively.
    expect(finished.result).toMatchObject({ chapter: 1, qaOnly: true, summary: { mode: "full", fellBackToFull: true, open: 1 } });
    expect(() => operations.startQaRecheck(story.slug, 1, { mode: "bogus" })).toThrow();
    await operations.close();
  });
});

describe("finding lifecycle endpoints", () => {
  it("fixes a narration-attributed finding without asking for a target and verifies the selected issue", async () => {
    const translation = "The keeper yelled, 'Get him!' before crossing the courtyard.";
    const narration = "The keeper yelled, 'Get that bastard!' before crossing the courtyard.";
    const repaired = translation;
    const issue = detection({
      category: "narrationFidelity", severity: "fail",
      message: "The fault lies in the NARRATION: it adds an insult absent from the approved translation.",
      evidence: `Translation: "${translation}" Narration: "${narration}"`,
    });
    const { root, story, paths, state } = await fixture({ detections: [issue], translation, narration });
    const id = state!.findings[0]!.id;
    const openai = new MockLLM("openai", [repaired]);
    const { jobs, operations } = operationsWith(root, openai);
    const finished = await waitForJob(jobs, (await operations.startQaFindingFix(story.slug, 1, id)).id);
    expect(finished.status).toBe("completed");
    expect(finished.result).toMatchObject({ findingId: id, repaired: ["narration"], fixed: true });
    expect(await readFile(paths.english, "utf8")).toBe(translation);
    expect(await readFile(paths.narration, "utf8")).toBe(repaired);
    expect((await readState(paths)).findings.find((finding) => finding.id === id)?.status).toBe("fixed_ai");
    expect(openai.calls.filter((call) => call.structured)).toHaveLength(1);
    await operations.close();
  });

  it("fix-ai repairs the text, stales downstream, and marks the finding fixed_ai", async () => {
    const current = "The keeper crossed the quiet courtyard and counted the small blue flames.";
    const repaired = "The keeper crossed the quiet courtyard and counted the small azure flames.";
    const { root, story, paths, state } = await fixture({ detections: [detection()], translation: current, narration: current });
    const id = state!.findings[0]!.id;
    const gemini = new MockLLM("gemini", [repaired]); const openai = openaiQa();
    const { jobs, operations } = operationsWith(root, gemini, openai);
    const fixJob = await operations.startQaFindingFix(story.slug, 1, id, { target: "translation" });
    const finished = await waitForJob(jobs, fixJob.id);
    expect(finished.status).toBe("completed");
    expect(finished.result).toMatchObject({ chapter: 1, findingId: id, repaired: ["translation"], fixed: true });
    const after = await readState(paths);
    const finding = after.findings.find((candidate) => candidate.id === id)!;
    expect(finding).toMatchObject({ status: "fixed_ai", resolution: { action: "ai_fix" } });
    expect(finding.resolution?.finalTextFingerprint).toBeTruthy();
    const metadata = chapterSchema.parse(await readJsonIfExists(paths.chapterMeta));
    expect(metadata.stages.translation).toMatchObject({ provider: "manual", model: "studio-editor" });
    expect(metadata.stages.tts.status).toBe("pending");
    expect(metadata.stages.qa.status).toBe("complete");
    await operations.close();
  });

  it("keeps the selected finding open when QA still detects the defect after repair", async () => {
    const current = "The keeper crossed the quiet courtyard and counted the small blue flames.";
    const repaired = "The keeper crossed the quiet courtyard and counted the small azure flames.";
    const issue = detection();
    const { root, story, paths, state } = await fixture({ detections: [issue], translation: current, narration: current });
    const id = state!.findings[0]!.id;
    const qaResponse = { status: "warn", score: 0.8, issues: [issue], checks: { ...checks, terminology: "warn" } };
    const gemini = new MockLLM("gemini", [repaired]);
    const { jobs, operations } = operationsWith(root, gemini, openaiQa(qaResponse));
    const finished = await waitForJob(jobs, (await operations.startQaFindingFix(story.slug, 1, id, { target: "translation" })).id);
    expect(finished.status).toBe("completed");
    expect(finished.result).toMatchObject({ findingId: id, fixed: false });
    expect((await readState(paths)).findings.find((finding) => finding.id === id)?.status).toBe("open");
    await operations.close();
  });

  it("keeps a saved single-finding repair when final QA recheck fails and permits QA-only retry", async () => {
    const current = "The keeper crossed the quiet courtyard and counted the small blue flames.";
    const repaired = "The keeper crossed the quiet courtyard and counted the small azure flames.";
    const { root, story, paths, state } = await fixture({ detections: [detection()], translation: current, narration: current });
    const id = state!.findings[0]!.id;
    const gemini = new MockLLM("gemini", [repaired]); const failingQa = openaiQa();
    vi.spyOn(failingQa, "generateStructured").mockRejectedValue(new Error("QA provider unavailable"));
    const { jobs, operations } = operationsWith(root, gemini, failingQa);
    const fixJob = await operations.startQaFindingFix(story.slug, 1, id, { target: "translation" });
    const finished = await waitForJob(jobs, fixJob.id);
    expect(finished.status).toBe("completed");
    expect(finished.result).toMatchObject({ status: "repair_applied_recheck_failed", findingId: id, repaired: ["translation"], fixed: false, requiresQaRecheck: true, recheck: { attempted: true, success: false, error: "QA provider unavailable" } });
    expect(await readFile(paths.english, "utf8")).toBe(repaired);
    expect((await readState(paths)).findings.find((finding) => finding.id === id)).toMatchObject({ status: "open" });
    expect((await operations.getChapterQa(story.slug, 1)).freshness).toBe("needs_recheck");
    expect((await readActivity(root, story.slug))[0]?.message).toMatch(/saved.*verification failed/i);
    expect(gemini.calls).toHaveLength(1);

    const qaOnly = openaiQa();
    const retryOperations = new StudioOperations(root, env, jobs, { llm: new LLMRouter(new Map([["openai", qaOnly], ["gemini", gemini]])) });
    const retry = await waitForJob(jobs, retryOperations.startQaRecheck(story.slug, 1, { mode: "full" }).id);
    expect(retry.status).toBe("completed");
    expect(qaOnly.calls).toHaveLength(1);
    expect(gemini.calls).toHaveLength(1);
    await operations.close(); await retryOperations.close();
  });

  it("resolve-manual marks fixed_manual without touching downstream stage fingerprints", async () => {
    const ttsStage = { status: "complete" as const, fingerprint: "tts-input-fp", outputFingerprint: "tts-output-fp", provider: "fish", model: "s2-pro" };
    const { root, story, paths, state } = await fixture({ detections: [detection()], extraStages: { tts: ttsStage, audioMastering: { status: "complete", fingerprint: "audio-fp", outputFingerprint: "audio-out" } } });
    const id = state!.findings[0]!.id;
    const { operations } = operationsWith(root, openaiQa());
    const before = chapterSchema.parse(await readJsonIfExists(paths.chapterMeta));
    const result = await operations.resolveQaFindingManually(story.slug, 1, id, { finalText: "The keeper counted the azure flames." });
    expect(result.finding).toMatchObject({ status: "fixed_manual", resolution: { action: "manual_fix" } });
    expect(result.presentation).toMatchObject({ counts: { open: 0, resolved: 1 }, state: { findings: [expect.objectContaining({ id, status: "fixed_manual" })] } });
    expect(result.finding.resolution?.finalTextFingerprint).toBeTruthy();
    const after = chapterSchema.parse(await readJsonIfExists(paths.chapterMeta));
    expect(after.stages.tts).toEqual(before.stages.tts);
    expect(after.stages.audioMastering).toEqual(before.stages.audioMastering);
    expect(after.stages.translation).toEqual(before.stages.translation);
    expect(after.stages.qa.outputFingerprint).toBe(await fileFingerprint(paths.qa));
    expect(after.quality).toMatchObject({ status: "pass" });
    await operations.close();
  });

  it("dismiss with remember creates an exception and future rechecks suppress matching detections", async () => {
    const { root, story, paths, state } = await fixture({ detections: [detection()] });
    const id = state!.findings[0]!.id;
    const { operations } = operationsWith(root, openaiQa());
    const dismissed = await operations.dismissQaFinding(story.slug, 1, id, { reason: "Author-approved term", remember: { matchKind: "terminology", value: "Azure Flame" } });
    expect(dismissed.finding).toMatchObject({ status: "dismissed", resolution: { action: "dismiss", reason: "Author-approved term" } });
    expect(dismissed.presentation).toMatchObject({ counts: { open: 0, resolved: 1 }, state: { findings: [expect.objectContaining({ id, status: "dismissed" })] } });
    expect(dismissed.exception).toMatchObject({ category: "terminology", matchKind: "terminology", value: "Azure Flame" });
    await operations.close();
    // A materially reworded re-detection would normally be a new finding; the
    // remembered exception suppresses it and the dismissal is respected.
    const reworded = { status: "warn", score: 0.8, issues: [{ category: "terminology", severity: "warn", message: "The narration drifts from the established term.", evidence: "The keeper invokes the Blue Flame instead of Azure Flame here." }], checks: { ...checks, terminology: "warn" } };
    const openai = openaiQa(reworded);
    const { jobs, operations: operations2 } = operationsWith(root, openai);
    const finished = await waitForJob(jobs, operations2.startQaRecheck(story.slug, 1, { mode: "full" }).id);
    expect(finished.status).toBe("completed");
    const after = await readState(paths);
    expect(after.findings).toHaveLength(1);
    expect(after.findings[0]).toMatchObject({ id, status: "dismissed" });
    expect(finished.result).toMatchObject({ summary: { respected: 1, newFindings: 0 } });
    expect(String(openai.calls[0]?.input)).toContain("APPROVED QA EXCEPTIONS");
    expect(String(openai.calls[0]?.input)).toContain('"Azure Flame"');
    await operations2.close();
  });

  it("reopens a dismissed finding while preserving its resolution history", async () => {
    const { root, story, state } = await fixture({ detections: [detection()] });
    const id = state!.findings[0]!.id;
    const { operations } = operationsWith(root, openaiQa());
    await operations.dismissQaFinding(story.slug, 1, id, { reason: "Not an issue" });
    const reopened = await operations.reopenQaFinding(story.slug, 1, id);
    expect(reopened.finding.status).toBe("open");
    expect(reopened.presentation).toMatchObject({ counts: { open: 1, resolved: 0 }, state: { findings: [expect.objectContaining({ id, status: "open" })] } });
    expect(reopened.finding.reopenedAt).toBeTruthy();
    expect(reopened.finding.resolution).toMatchObject({ action: "dismiss", reason: "Not an issue" });
    await expect(operations.reopenQaFinding(story.slug, 1, id)).rejects.toMatchObject({ code: "QA_FINDING_ALREADY_OPEN" });
    await operations.close();
  });
});

describe("safe fixes", () => {
  const namingEntity = {
    id: "ent_aaaaaaaaaaaaaaaaaaaaaaaa", type: "character", canonicalName: "Suming", originalName: "", aliases: [] as string[],
    preferredNarrationName: "Asher", firstAppearance: 1, lastKnownAppearance: 1, status: "alive",
  };

  it("applies mechanical fixes only to open safeToFix findings", async () => {
    const narration = "Suming opened the heavy door and listened for a long quiet moment.";
    const { root, story, paths } = await fixture({
      narration, bibleEntities: [namingEntity],
      detections: [
        detection({ category: "names", message: `Narration uses "Suming" but the authorized narration rendering is "Asher".`, evidence: `Narration contains "Suming" but never "Asher".`, origin: "deterministic", safeToFix: true, entityIds: ["ent_aaaaaaaaaaaaaaaaaaaaaaaa"] }),
        detection({ message: "Use the canonical ability name", evidence: `Narration says "the heavy door" but the locked term is required.` }),
      ],
    });
    const state = await readState(paths);
    const safeId = state.findings.find((finding) => finding.safeToFix === true)!.id;
    const unsafeId = state.findings.find((finding) => finding.category === "terminology")!.id;
    const { jobs, operations } = operationsWith(root, openaiQa());
    const finished = await waitForJob(jobs, operations.startQaSafeFixes(story.slug, 1).id);
    expect(finished.status).toBe("completed");
    expect(finished.result).toMatchObject({ chapter: 1, fixed: [safeId], failed: [] });
    expect(await readFile(paths.narration, "utf8")).toContain("Asher");
    const after = await readState(paths);
    expect(after.findings.find((finding) => finding.id === safeId)).toMatchObject({ status: "fixed_ai", resolution: { action: "ai_fix" } });
    expect(after.findings.find((finding) => finding.id === unsafeId)!.status).toBe("open");
    await operations.close();
  });
});

describe("QA exceptions endpoints", () => {
  it("adds, lists, and removes story-level exceptions", async () => {
    const { root, story } = await fixture();
    const { operations } = operationsWith(root, openaiQa());
    const added = await operations.addQaException(story.slug, { category: "terminology", matchKind: "terminology", value: "Azure Flame", reason: "Approved" });
    expect(added.created).toBe(true);
    expect((await operations.listQaExceptions(story.slug)).exceptions).toHaveLength(1);
    const removed = await operations.removeQaException(story.slug, added.exception.id);
    expect(removed.removed).toBe(true);
    await expect(operations.removeQaException(story.slug, added.exception.id)).rejects.toThrow("not found");
    await operations.close();
  });
});

describe("dashboard and legacy compatibility", () => {
  it("dashboard counts only open findings", async () => {
    const { root, story, state } = await fixture({ detections: [detection()] });
    const { operations } = operationsWith(root, openaiQa());
    await operations.dismissQaFinding(story.slug, 1, state!.findings[0]!.id, {});
    const dashboard = await getQaDashboard(root, story.slug);
    expect(dashboard.counts).toEqual({ pass: 1, warn: 0, fail: 0, needsVerification: 0 });
    expect(dashboard.categories).toEqual({});
    expect(dashboard.chapters[0]).toMatchObject({ chapter: 1, status: "pass", issues: [] });
    await operations.close();
  });

  it("dashboard lists open findings and excludes dismissed, fixed, and obsolete ones", async () => {
    const narration = "The keeper raised the Azure Flame high above the gate.";
    const { root, story, paths } = await fixture({
      translation: narration, narration,
      detections: [
        detection({ category: "names", message: "A name drifted", evidence: "Su Ming became Marcus." }),
        detection({ category: "terminology", message: "Use the canonical ability name", evidence: "Azure Flame is the locked term." }),
        detection({ category: "numbers", message: "A count changed", evidence: "Ten became twelve." }),
      ],
    });
    const written = await readState(paths);
    const byCategory = (category: string) => written.findings.find((finding) => finding.category === category)!;
    // One dismissed, one fixed, one manually marked obsolete, one stays open.
    const { operations } = operationsWith(root, openaiQa());
    await operations.dismissQaFinding(story.slug, 1, byCategory("terminology").id, {});
    await operations.resolveQaFindingManually(story.slug, 1, byCategory("names").id, {});
    const current = await readState(paths);
    const obsoleted = { ...current, findings: current.findings.map((finding) => finding.category === "numbers"
      ? { ...finding, status: "obsolete" as const, resolution: { action: "obsolete" as const, resolvedAt: NOW } }
      : finding) };
    await atomicWriteJson(paths.qa, { ...obsoleted, issues: obsoleted.issues.filter((issue) => issue.category !== "numbers") });
    const dashboard = await getQaDashboard(root, story.slug);
    expect(dashboard.categories).toEqual({});
    expect(dashboard.chapters[0]!.issues).toEqual([]);
    // Reopen the names finding: it alone must reappear in the dashboard.
    await operations.reopenQaFinding(story.slug, 1, byCategory("names").id);
    const reopened = await getQaDashboard(root, story.slug);
    expect(reopened.categories).toEqual({ names: 1 });
    expect(reopened.chapters[0]!.issues.map((issue) => issue.category)).toEqual(["names"]);
    expect(reopened.chapters[0]!.issues[0]).not.toHaveProperty("review");
    await operations.close();
  });

  it("legacy index-based dismiss still resolves findings", async () => {
    const { root, story, paths, state } = await fixture({ detections: [detection()] });
    const { operations } = operationsWith(root, openaiQa());
    const result = await operations.dismissQaFindings(story.slug, 1, { issueIndexes: [0], disposition: "manually_fixed" });
    expect(result.qa.status).toBe("pass");
    expect(result.qa.issues[0]?.review?.disposition).toBe("manually_fixed");
    const after = await readState(paths);
    expect(after.findings.find((finding) => finding.id === state!.findings[0]!.id)).toMatchObject({ status: "fixed_manual", resolution: { action: "manual_fix" } });
    await operations.close();
  });

  it("resetChapterQa removes qa.json and resets stage to pending without modifying other stages", async () => {
    const { root, story, paths } = await fixture({ detections: [detection()] });
    const { operations } = operationsWith(root, openaiQa());
    expect(await exists(paths.qa)).toBe(true);

    const result = await operations.resetChapterQa(story.slug, 1);
    expect(result.reset).toBe(true);
    expect(result.deletedArtifacts).toContain("qa.json");
    expect(await exists(paths.qa)).toBe(false);

    // After reset, getChapterQa throws "does not have a QA result"
    await expect(operations.getChapterQa(story.slug, 1)).rejects.toThrow(/does not have a QA result/i);
    await operations.close();
  });

  it("resetQaBatch resets requested chapters across batch", async () => {
    const { root, story, paths } = await fixture({ detections: [detection()] });
    const { operations } = operationsWith(root, openaiQa());

    const result = await operations.resetQaBatch(story.slug, { type: "chapter", chapterNumber: 1 });
    expect(result.requested).toBe(1);
    expect(result.reset).toBe(1);
    expect(result.chapters).toEqual([1]);
    expect(await exists(paths.qa)).toBe(false);
    await operations.close();
  });
});
