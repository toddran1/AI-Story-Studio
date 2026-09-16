import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getQaDashboard } from "../apps/server/catalog.js";
import { Job, JobManager } from "../apps/server/job-manager.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { emptyStoryBible, storyBibleSchema } from "../src/domain/story-bible.js";
import { Story } from "../src/domain/story.js";
import { qaStateSchema } from "../src/domain/qa.js";
import { LLMRouter } from "../src/llm/router.js";
import { buildQaState } from "../src/qa/review.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { readJsonIfExists } from "../src/storage/story-files.js";
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
  await atomicWriteJson(paths.chapterMeta, chapter);
  await atomicWrite(paths.original, "守灯人穿过庭院。".repeat(50));
  await atomicWrite(paths.english, translation);
  await atomicWrite(paths.narration, narration);
  await atomicWriteJson(paths.storyContext, {});
  if (options.bibleEntities) await atomicWriteJson(paths.bible, storyBibleSchema.parse({ ...emptyStoryBible(), canonicalEntities: options.bibleEntities }));
  let state;
  if (options.detections) {
    state = buildQaState(undefined, options.detections, { chapter: 1, translation, narration, now: NOW }).state;
    await atomicWriteJson(paths.qa, state);
  }
  return { root, story, paths, state, translation, narration };
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
    expect(result.qaStale).toBe(false);
    await operations.close();
  });

  it("supports recheck modes and reports the summary in the job result", async () => {
    const narration = "The keeper raised the Azure Flame high above the gate.";
    const { root, story } = await fixture({ detections: [detection()], translation: narration, narration });
    const openai = openaiQa();
    const { jobs, operations } = operationsWith(root, openai);
    const finished = await waitForJob(jobs, operations.startQaRecheck(story.slug, 1, { mode: "changed" }).id);
    expect(finished.status).toBe("completed");
    // Content is unchanged since the last run, so changed mode really runs.
    expect(finished.result).toMatchObject({ chapter: 1, qaOnly: true, summary: { mode: "changed", fellBackToFull: false, open: 1 } });
    expect(() => operations.startQaRecheck(story.slug, 1, { mode: "bogus" })).toThrow();
    await operations.close();
  });
});

describe("finding lifecycle endpoints", () => {
  it("fix-ai repairs the text, stales downstream, and marks the finding fixed_ai", async () => {
    const current = "The keeper crossed the quiet courtyard and counted the small blue flames.";
    const repaired = "The keeper crossed the quiet courtyard and counted the small azure flames.";
    const { root, story, paths, state } = await fixture({ detections: [detection()], translation: current, narration: current });
    const id = state!.findings[0]!.id;
    const gemini = new MockLLM("gemini", [repaired]); const openai = openaiQa();
    const { jobs, operations } = operationsWith(root, gemini, openai);
    const finished = await waitForJob(jobs, operations.startQaFindingFix(story.slug, 1, id).id);
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

  it("resolve-manual marks fixed_manual without touching downstream stage fingerprints", async () => {
    const ttsStage = { status: "complete" as const, fingerprint: "tts-input-fp", outputFingerprint: "tts-output-fp", provider: "fish", model: "s2-pro" };
    const { root, story, paths, state } = await fixture({ detections: [detection()], extraStages: { tts: ttsStage, audioMastering: { status: "complete", fingerprint: "audio-fp", outputFingerprint: "audio-out" } } });
    const id = state!.findings[0]!.id;
    const { operations } = operationsWith(root, openaiQa());
    const before = chapterSchema.parse(await readJsonIfExists(paths.chapterMeta));
    const result = await operations.resolveQaFindingManually(story.slug, 1, id, { finalText: "The keeper counted the azure flames." });
    expect(result.finding).toMatchObject({ status: "fixed_manual", resolution: { action: "manual_fix" } });
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
    expect(reopened.finding.reopenedAt).toBeTruthy();
    expect(reopened.finding.resolution).toMatchObject({ action: "dismiss", reason: "Not an issue" });
    await expect(operations.reopenQaFinding(story.slug, 1, id)).rejects.toThrow("already open");
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
        detection({ message: "Use the canonical ability name", evidence: "Azure Flame is the locked term." }),
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
    expect(dashboard.counts).toEqual({ pass: 1, warn: 0, fail: 0 });
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
});
