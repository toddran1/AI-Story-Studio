import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chapterSchema } from "../src/domain/chapter.js";
import { qaFindingSchema } from "../src/domain/qa.js";
import { emptyStoryBible, storyBibleSchema } from "../src/domain/story-bible.js";
import {
  anchorFromIssue, computeFindingId, findingVerification, migrateQaState, openFindings, qaFindingStats, recomputeQaSummary,
} from "../src/qa/findings.js";
import {
  computeQaDependencyFingerprint, computeQaDependencyFingerprints, deriveQaFreshness, loadQaDeterministicDependencies,
  projectNamingForQa, type QaDependencies,
} from "../src/qa/freshness.js";
import { QA_PROMPT_VERSION } from "../src/qa/prompts.js";
import { buildQaState, recheckChapterQa, transitionQaFinding } from "../src/qa/review.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { readJsonIfExists } from "../src/storage/story-files.js";
import { storyPaths } from "../src/storage/paths.js";
import { fingerprint } from "../src/utils/hash.js";
import { MockLLM, testStory } from "./helpers.js";

const checks = { completeness: "pass", names: "pass", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" } as const;
const NOW = "2026-09-18T12:00:00.000Z";

const baseDeps = (): QaDependencies => ({
  source: "src-fp", translation: "tr-fp", narration: "nar-fp",
  context: { canonicalEntities: [] }, config: { provider: "openai", model: "qa-model" },
  narrationSettings: { profanityMode: "preserve", includeChapterTitle: true },
  prompt: QA_PROMPT_VERSION, mode: "production",
  naming: [], pronunciation: [], exceptions: [], acceptedContinuity: [],
});

describe("QA dependency fingerprint", () => {
  it("changes when any effective dependency changes", () => {
    const base = computeQaDependencyFingerprint(baseDeps());
    const variants: QaDependencies[] = [
      { ...baseDeps(), source: "other" },
      { ...baseDeps(), translation: "other" },
      { ...baseDeps(), narration: "other" },
      { ...baseDeps(), context: { canonicalEntities: [{ id: "ent_x" }] } },
      { ...baseDeps(), config: { provider: "openai", model: "qa-model-2" } },
      { ...baseDeps(), narrationSettings: { profanityMode: "soften-strong", includeChapterTitle: true } },
      { ...baseDeps(), prompt: "9" },
      { ...baseDeps(), mode: "thorough" as const },
      { ...baseDeps(), naming: [{ id: "ent_a", canonicalName: "Feixue", originalName: "飞雪", aliases: [], aliasNarrationRules: [], canonicalNameLocked: false, preferredNarrationName: "Feixue" }] },
      { ...baseDeps(), pronunciation: [{ id: "ent_a", canonicalName: "Feixue", originalName: "飞雪", aliases: [], attempt: "attempt-fp" }] },
      { ...baseDeps(), exceptions: [{ id: "qax_aaaaaaaaaaaaaaaaaaaaaaaa", category: "names" as const, matchKind: "terminology" as const, value: "Feixue", createdAt: NOW }] },
      { ...baseDeps(), acceptedContinuity: [{ id: "cnt_1", entityIds: [], explanation: "Intentional time skip" }] },
    ];
    for (const variant of variants) expect(computeQaDependencyFingerprint(variant)).not.toBe(base);
    // Identical inputs are stable.
    expect(computeQaDependencyFingerprint(baseDeps())).toBe(base);
  });

  it("exposes per-concern sub-fingerprints so naming changes are distinguishable", () => {
    const before = computeQaDependencyFingerprints(baseDeps());
    const renamed = computeQaDependencyFingerprints({
      ...baseDeps(),
      naming: [{ id: "ent_a", canonicalName: "Feixue", originalName: "飞雪", aliases: [], aliasNarrationRules: [], canonicalNameLocked: false, preferredNarrationName: "Fei" }],
    });
    expect(renamed.naming).not.toBe(before.naming);
    expect(renamed.pronunciation).toBe(before.pronunciation);
    expect(renamed.fingerprint).not.toBe(before.fingerprint);
  });

  it("ignores story-bible fields QA never consumes", () => {
    const bible = (overrides: Record<string, unknown>) => storyBibleSchema.parse({
      ...emptyStoryBible(),
      canonicalEntities: [{
        id: "ent_aaaaaaaaaaaaaaaaaaaaaaaa", type: "character", canonicalName: "Feixue", originalName: "飞雪", aliases: [],
        preferredNarrationName: "Feixue", firstAppearance: 1, lastKnownAppearance: 3, status: "alive", ...overrides,
      }],
    });
    const before = projectNamingForQa(bible({}).canonicalEntities);
    const afterEdits = projectNamingForQa(bible({ notes: "Revised notes", status: "dead", lastKnownAppearance: 9 }).canonicalEntities);
    expect(fingerprint(afterEdits)).toBe(fingerprint(before));
    const afterNamingEdit = projectNamingForQa(bible({ preferredNarrationName: "Fei" }).canonicalEntities);
    expect(fingerprint(afterNamingEdit)).not.toBe(fingerprint(before));
  });

  it("derives freshness from the recorded fingerprint and stage status", () => {
    expect(deriveQaFreshness("abc", "abc", "complete")).toBe("current");
    expect(deriveQaFreshness("abc", "def", "complete")).toBe("needs_recheck");
    expect(deriveQaFreshness(undefined, "def", "complete")).toBe("missing");
    expect(deriveQaFreshness("abc", "abc", "failed")).toBe("failed");
    expect(deriveQaFreshness(undefined, "def")).toBe("missing");
  });
});

const feixueBible = () => storyBibleSchema.parse({
  ...emptyStoryBible(),
  canonicalEntities: [{
    id: "ent_aaaaaaaaaaaaaaaaaaaaaaaa", type: "character", canonicalName: "Feixue", originalName: "飞雪", aliases: [],
    preferredNarrationName: "Feixue", firstAppearance: 1, lastKnownAppearance: 3, status: "alive",
  }],
});

const namesIssue = (wrong: string) => ({
  category: "names" as const, severity: "warn" as const,
  message: `Narration renames Feixue to ${wrong}.`,
  evidence: `"Let's go," ${wrong} said.`,
});

async function setupChapter(options: { translation?: string; narration?: string; qa?: unknown } = {}) {
  const root = await mkdtemp(join(tmpdir(), "qa-freshness-"));
  const story = testStory();
  const paths = storyPaths(root, story.slug, 1);
  const now = "2026-09-18T10:00:00.000Z";
  const pending = { status: "pending" } as const;
  const complete = { status: "complete", provider: "openai", model: "m", completedAt: now } as const;
  await atomicWriteJson(paths.storyConfig, story);
  await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({
    chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
    counts: { originalCharacters: 100, englishWords: 120, narrationWords: 120 }, createdAt: now, updatedAt: now,
    stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: pending, continuity: pending, tts: pending, audioMastering: pending, alignment: pending, subtitles: pending, scenePlanning: pending, artwork: pending, video: pending },
  }));
  await atomicWrite(paths.original, "第一章\n\n飞雪打开了门。");
  await atomicWrite(paths.english, options.translation ?? `Feixue opened the door. "Let's go," Feixue said.`);
  await atomicWrite(paths.narration, options.narration ?? `"Let's go," Xiaoxue said. Feixue's voice trembled.`);
  await atomicWriteJson(paths.storyContext, JSON.parse(JSON.stringify(feixueBible())));
  if (options.qa) await atomicWriteJson(paths.qa, options.qa);
  return { root, story, paths };
}

/** Recomputes the effective dependency fingerprint exactly the way the recheck does. */
async function currentFingerprint(root: string, story: ReturnType<typeof testStory>, chapter: number) {
  const paths = storyPaths(root, story.slug, chapter);
  const [source, translation, narration, contextRaw] = await Promise.all([
    readFile(paths.original, "utf8"), readFile(paths.english, "utf8"), readFile(paths.narration, "utf8"), readJsonIfExists(paths.storyContext),
  ]);
  return computeQaDependencyFingerprint({
    source: fingerprint({ source, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage }),
    translation: fingerprint(translation),
    narration: fingerprint(narration),
    context: contextRaw ?? emptyStoryBible(),
    config: story.pipeline.qa,
    narrationSettings: { profanityMode: story.narrationSettings.profanityMode, includeChapterTitle: story.narrationSettings.includeChapterTitle },
    prompt: QA_PROMPT_VERSION,
    mode: story.qaMode,
    ...await loadQaDeterministicDependencies(root, story.slug),
  });
}

const qaWith = (issue: ReturnType<typeof namesIssue>) => ({
  status: "warn" as const, score: 0.7, issues: [issue], checks: { ...checks, names: "warn" as const },
});

describe("finding lifecycle vs verification (Feixue/Xiaoxue)", () => {
  it("retires a fixed naming problem only after a successful recheck against changed dependencies", async () => {
    const ctx = await setupChapter();
    const llm = new MockLLM("openai", undefined, qaWith(namesIssue("Xiaoxue")));
    const first = await recheckChapterQa({ root: ctx.root, story: ctx.story, chapter: 1, provider: llm, now: NOW });
    const finding = first.state.findings[0]!;
    expect(finding.status).toBe("open");
    expect(finding.provenance?.entityIds).toEqual(["ent_aaaaaaaaaaaaaaaaaaaaaaaa"]);
    const recordedFp = chapterSchema.parse(JSON.parse(await readFile(ctx.paths.chapterMeta, "utf8"))).stages.qa.fingerprint!;
    expect(recordedFp).toBe(await currentFingerprint(ctx.root, ctx.story, 1));
    expect(finding.verifiedAgainstFingerprint).toBe(recordedFp);
    expect(findingVerification(finding, recordedFp)).toBe("current");
    expect(deriveQaFreshness(recordedFp, recordedFp, "complete")).toBe("current");

    // Narration is fixed to Feixue: dependencies change, the old finding is retained and stale.
    await atomicWrite(ctx.paths.narration, `"Let's go," Feixue said. Feixue's voice trembled.`);
    const editedFp = await currentFingerprint(ctx.root, ctx.story, 1);
    expect(editedFp).not.toBe(recordedFp);
    expect(deriveQaFreshness(recordedFp, editedFp, "complete")).toBe("needs_recheck");
    expect(findingVerification(finding, editedFp)).toBe("needs_recheck");
    const retained = migrateQaState(JSON.parse(await readFile(ctx.paths.qa, "utf8")), { chapter: 1 });
    expect(openFindings(retained)).toHaveLength(1);

    // Successful recheck with no issues: verified-absent retirement to obsolete.
    const second = await recheckChapterQa({ root: ctx.root, story: ctx.story, chapter: 1, provider: new MockLLM("openai"), now: "2026-09-18T13:00:00.000Z" });
    const retired = second.state.findings[0]!;
    expect(retired.id).toBe(finding.id);
    expect(retired.status).toBe("obsolete");
    expect(retired.resolution?.action).toBe("obsolete");
    expect(retired.resolution?.reason).toContain("dependency fingerprint changed");
    expect(retired.verifiedAgainstFingerprint).toBe(editedFp);
    expect(findingVerification(retired, editedFp)).toBe("current");
    expect(openFindings(second.state)).toHaveLength(0);
    expect(second.state.status).toBe("pass");
    expect(second.state.score).toBe(1);
    const stats = qaFindingStats(second.state, editedFp);
    expect(stats.current).toMatchObject({ open: 0, score: 1, status: "pass" });
    expect(stats.history).toMatchObject({ obsolete: 1, total: 1 });
    expect(stats.needsVerification).toBe(0);
    const newRecorded = chapterSchema.parse(JSON.parse(await readFile(ctx.paths.chapterMeta, "utf8"))).stages.qa.fingerprint!;
    expect(newRecorded).toBe(editedFp);
    expect(deriveQaFreshness(newRecorded, await currentFingerprint(ctx.root, ctx.story, 1), "complete")).toBe("current");
  });

  it("gives a different naming problem about the same entity a different finding id", () => {
    const entities = feixueBible().canonicalEntities;
    const first = computeFindingId("names", 1, anchorFromIssue(namesIssue("Xiaoxue"), { canonicalEntities: entities }));
    const second = computeFindingId("names", 1, anchorFromIssue(namesIssue("Xuexue"), { canonicalEntities: entities }));
    expect(first).not.toBe(second);
    // Pure message rewording with the same wrong term keeps the id.
    const reworded = computeFindingId("names", 1, anchorFromIssue({
      ...namesIssue("Xiaoxue"), message: "The narration incorrectly calls Feixue by the name Xiaoxue, which is wrong.",
    }, { canonicalEntities: entities }));
    expect(reworded).toBe(first);
    for (const id of [first, second]) expect(id).toMatch(/^qaf_[a-f0-9]{24}$/);
  });

  it("reopens a manually fixed finding when the problem remains after recheck", async () => {
    const ctx = await setupChapter();
    const issue = namesIssue("Xiaoxue");
    const seeded = buildQaState(undefined, [issue], {
      chapter: 1, canonicalEntities: feixueBible().canonicalEntities,
      translation: "Feixue opened the door.", narration: `"Let's go," Xiaoxue said.`, now: NOW,
    }).state;
    const fixed = transitionQaFinding(seeded, seeded.findings[0]!.id, "manual_fix", { reason: "Editor corrected the name", now: "2026-09-18T11:00:00.000Z" });
    expect(fixed.findings[0]!.status).toBe("fixed_manual");
    await atomicWriteJson(ctx.paths.qa, JSON.parse(JSON.stringify(fixed)));

    const llm = new MockLLM("openai", undefined, qaWith(issue));
    const { state } = await recheckChapterQa({ root: ctx.root, story: ctx.story, chapter: 1, provider: llm, now: "2026-09-18T13:00:00.000Z" });
    const finding = state.findings[0]!;
    expect(finding.status).toBe("open");
    expect(finding.reopenedAt).toBe("2026-09-18T13:00:00.000Z");
    expect(finding.resolution).toMatchObject({ action: "manual_fix", reason: "Editor corrected the name" });
    expect(finding.verifiedAgainstFingerprint).toBe(chapterSchema.parse(JSON.parse(await readFile(ctx.paths.chapterMeta, "utf8"))).stages.qa.fingerprint);
    expect(openFindings(state)).toHaveLength(1);
  });

  it("keeps a dismissed finding dismissed and uncounted after recheck", async () => {
    const ctx = await setupChapter();
    const issue = namesIssue("Xiaoxue");
    const seeded = buildQaState(undefined, [issue], {
      chapter: 1, canonicalEntities: feixueBible().canonicalEntities,
      translation: "Feixue opened the door.", narration: `"Let's go," Xiaoxue said.`, now: NOW,
    }).state;
    const dismissed = transitionQaFinding(seeded, seeded.findings[0]!.id, "dismiss", { reason: "Intended stylization", now: "2026-09-18T11:00:00.000Z" });
    await atomicWriteJson(ctx.paths.qa, JSON.parse(JSON.stringify(dismissed)));

    const llm = new MockLLM("openai", undefined, qaWith(issue));
    const { state } = await recheckChapterQa({ root: ctx.root, story: ctx.story, chapter: 1, provider: llm, now: "2026-09-18T13:00:00.000Z" });
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]!.status).toBe("dismissed");
    expect(state.findings[0]!.resolution).toMatchObject({ action: "dismiss", reason: "Intended stylization" });
    expect(openFindings(state)).toHaveLength(0);
    expect(state.status).toBe("pass");
    expect(qaFindingStats(state).current.open).toBe(0);
  });
});

describe("score and count semantics", () => {
  it("derives the current score from open findings only, ignoring resolution history", () => {
    const detection = { category: "numbers" as const, severity: "warn" as const, message: "A quantity changed.", evidence: `Translation says "twelve lanterns" but narration says "ten lanterns".` };
    const options = { chapter: 3, translation: "T", narration: "N", now: NOW };
    const onlyOpen = buildQaState(undefined, [detection], options).state;
    // Same open finding, plus a long resolution history of other findings.
    let historical = buildQaState(undefined, [
      detection,
      { category: "dialogue" as const, severity: "fail" as const, message: "A line was dropped.", evidence: "The warning is missing." },
      { category: "terminology" as const, severity: "warn" as const, message: "Term drift.", evidence: "Bone Cage differs." },
    ], options).state;
    for (const finding of historical.findings.filter((candidate) => candidate.category !== "numbers")) {
      historical = transitionQaFinding(historical, finding.id, "manual_fix", { now: "2026-09-18T11:00:00.000Z" });
    }
    expect(qaFindingStats(historical).history.fixedManual).toBe(2);
    expect(recomputeQaSummary(historical.findings, historical).score).toBe(recomputeQaSummary(onlyOpen.findings, onlyOpen).score);
    expect(recomputeQaSummary(historical.findings, historical).status).toBe("warn");
    expect(historical.score).toBe(onlyOpen.score);
    // A clean pass scores 1, not the original LLM score.
    const resolved = transitionQaFinding(onlyOpen, onlyOpen.findings[0]!.id, "manual_fix", { now: "2026-09-18T11:00:00.000Z" });
    expect(resolved.score).toBe(1);
    expect(resolved.status).toBe("pass");
    expect(resolved.originalScore).toBe(1);
  });
});

describe("migration", () => {
  it("loads findings without verifiedAgainstFingerprint and preserves ids", () => {
    const seeded = buildQaState(undefined, [{ category: "numbers" as const, severity: "warn" as const, message: "A quantity changed.", evidence: `Translation says "twelve lanterns" but narration says "ten lanterns".` }], {
      chapter: 3, translation: "T", narration: "N", now: NOW, dependencyFingerprint: "fp-1",
    }).state;
    const raw = JSON.parse(JSON.stringify(seeded)) as { findings: Array<Record<string, unknown>> };
    delete raw.findings[0]!["verifiedAgainstFingerprint"];
    const migrated = migrateQaState(raw, { chapter: 3 });
    expect(migrated.findings[0]!.id).toBe(seeded.findings[0]!.id);
    expect(migrated.findings[0]!.verifiedAgainstFingerprint).toBeUndefined();
    expect(findingVerification(migrated.findings[0]!, "fp-1")).toBe("needs_recheck");
    expect(qaFindingSchema.parse(JSON.parse(JSON.stringify(migrated.findings[0])))).toBeTruthy();
  });
});
