import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chapterSchema } from "../src/domain/chapter.js";
import { qaStateSchema } from "../src/domain/qa.js";
import { emptyStoryBible, storyBibleSchema } from "../src/domain/story-bible.js";
import { ChapterPipeline } from "../src/pipeline/chapter-pipeline.js";
import { LLMRouter } from "../src/llm/router.js";
import { LLMProvider } from "../src/llm/provider.js";
import {
  anchorFromIssue, computeFindingId, deriveIssues, matchEntityIds, migrateQaState, openFindings, qaCounts, recomputeQaSummary,
} from "../src/qa/findings.js";
import {
  buildQaState, compactFindingsContext, computeContentSpans, recheckChapterQa, reconcileQaState, resolveQaFindingsByIndex, selectChangedParagraphs,
} from "../src/qa/review.js";
import { CopyingAudioProcessor } from "../src/audio/chapter-audio.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { MockLLM, MockTTS, testStory } from "./helpers.js";

const checks = { completeness: "pass", names: "pass", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" } as const;
const NOW = "2026-09-16T12:00:00.000Z";

const namingBible = () => storyBibleSchema.parse({
  ...emptyStoryBible(),
  canonicalEntities: [{
    id: "ent_aaaaaaaaaaaaaaaaaaaaaaaa", type: "character", canonicalName: "Su Ming", originalName: "苏明", aliases: ["Ming"],
    firstAppearance: 1, lastKnownAppearance: 3, status: "alive",
  }],
});

const detection = (overrides: Partial<{ category: "names" | "numbers" | "dialogue" | "terminology"; severity: "warn" | "fail"; message: string; evidence: string }> = {}) => ({
  category: "numbers" as const, severity: "warn" as const,
  message: "A quantity changed in the narration.", evidence: `Translation says "twelve lanterns" but narration says "ten lanterns".`,
  ...overrides,
});

describe("QA state migration", () => {
  it("migrates a legacy qa.json with review dispositions into findings", () => {
    const legacy = {
      status: "warn", score: 0.93, originalScore: 0.86,
      issues: [
        { category: "dialogue", severity: "warn", message: "A threat is softened", evidence: "The intent remains intact.", review: { disposition: "dismissed", reviewedAt: "2026-09-14T18:00:00.000Z" } },
        { category: "numbers", severity: "warn", message: "A number changed", evidence: "Ten became twelve.", review: { disposition: "manually_fixed", reviewedAt: "2026-09-15T09:00:00.000Z" } },
        { category: "names", severity: "fail", message: "Wrong name", evidence: "Marcus is not Su Ming." },
      ],
      checks: { ...checks, names: "fail" },
    };
    const state = migrateQaState(legacy, { chapter: 4 });
    expect(state.findings).toHaveLength(3);
    const [dismissed, fixed, open] = state.findings;
    expect(dismissed).toMatchObject({ status: "dismissed", origin: "llm", resolution: { action: "dismiss", resolvedAt: "2026-09-14T18:00:00.000Z" } });
    expect(fixed).toMatchObject({ status: "fixed_manual", resolution: { action: "manual_fix" } });
    expect(open).toMatchObject({ status: "open" });
    expect(open!.resolution).toBeUndefined();
    for (const finding of state.findings) expect(finding.id).toMatch(/^qaf_[a-f0-9]{24}$/);
    // Compatibility projection keeps legacy consumers working.
    expect(state.issues.map((issue) => issue.review?.disposition)).toEqual(["dismissed", "manually_fixed", undefined]);
    expect(qaStateSchema.parse(JSON.parse(JSON.stringify(state)))).toBeTruthy();
  });

  it("keeps new-format states intact and re-derives issues from findings", () => {
    const state = migrateQaState({ status: "pass", score: 1, issues: [], checks }, { chapter: 1 });
    expect(state.findings).toEqual([]);
    const roundTrip = migrateQaState(migrateQaState({ status: "warn", score: 0.9, issues: [{ category: "dialogue", severity: "warn", message: "Minor wording", evidence: "No action needed." }], checks: { ...checks, dialogue: "warn" } }, { chapter: 2 }), { chapter: 2 });
    expect(roundTrip.findings).toHaveLength(1);
    expect(roundTrip.findings[0]!.status).toBe("open");
  });
});

describe("finding identity", () => {
  it("matches entity ids from message and evidence", () => {
    const ids = matchEntityIds(`Narration renames Su Ming. Evidence: "Marcus said" vs "苏明"`, namingBible().canonicalEntities);
    expect(ids).toEqual(["ent_aaaaaaaaaaaaaaaaaaaaaaaa"]);
  });

  it("produces the same id for a reworded detection of the same issue", () => {
    const first = anchorFromIssue(detection());
    const reworded = anchorFromIssue({ ...detection(), message: "The narration altered the count of lanterns." });
    expect(computeFindingId("numbers", 3, first)).toBe(computeFindingId("numbers", 3, reworded));
  });

  it("produces a different id for the same category at a different passage", () => {
    const a = computeFindingId("numbers", 3, anchorFromIssue(detection()));
    const b = computeFindingId("numbers", 3, anchorFromIssue(detection({ evidence: `Translation says "five miles" but narration says "three miles".` })));
    expect(a).not.toBe(b);
  });

  it("keeps the id stable across manual text edits when entities anchor the issue", () => {
    const entities = namingBible().canonicalEntities;
    const issue = { message: "Narration renames Su Ming to Marcus.", evidence: `"Let's go," Marcus said.` };
    const before = computeFindingId("names", 3, anchorFromIssue(issue, { canonicalEntities: entities }));
    const afterEdit = computeFindingId("names", 3, anchorFromIssue({ ...issue, evidence: `"We leave now," Marcus said.` }, { canonicalEntities: entities }));
    expect(afterEdit).toBe(before);
    // And an unrelated paragraph edit does not disturb excerpt-anchored ids either.
    const excerpt = computeFindingId("numbers", 3, anchorFromIssue(detection()));
    expect(computeFindingId("numbers", 3, anchorFromIssue(detection()))).toBe(excerpt);
  });
});

describe("reconcileQaState outcome matrix", () => {
  const baseState = () => buildQaState(undefined, [detection()], { chapter: 3, translation: "T", narration: "N", now: NOW }).state;
  const resolveFirst = (state: ReturnType<typeof baseState>, disposition: "dismissed" | "manually_fixed") =>
    resolveQaFindingsByIndex(state, [0], disposition, "2026-09-16T13:00:00.000Z", 3);

  it("keeps an unmatched open finding open", () => {
    const { findings, outcome } = reconcileQaState(baseState(), [], { chapter: 3, now: NOW });
    expect(findings[0]!.status).toBe("open");
    expect(outcome).toMatchObject({ verified: 0, reopened: 0, newFindings: 0 });
  });

  it("keeps a fixed finding fixed and counts it verified when no matching detection returns", () => {
    const { findings, outcome } = reconcileQaState(resolveFirst(baseState(), "manually_fixed"), [], { chapter: 3, now: NOW });
    expect(findings[0]!.status).toBe("fixed_manual");
    expect(findings[0]!.lastVerifiedAt).toBe(NOW);
    expect(outcome.verified).toBe(1);
  });

  it("reopens a fixed finding on a matching fresh detection, preserving resolution history", () => {
    const resolved = resolveFirst(baseState(), "manually_fixed");
    const { findings, outcome } = reconcileQaState(resolved, [detection({ message: "The count is still wrong." })], { chapter: 3, now: NOW });
    const finding = findings[0]!;
    expect(finding.status).toBe("open");
    expect(finding.reopenedAt).toBe(NOW);
    expect(finding.resolution).toEqual({ action: "manual_fix", resolvedAt: "2026-09-16T13:00:00.000Z" });
    expect(finding.id).toBe(resolved.findings[0]!.id);
    expect(outcome.reopened).toBe(1);
  });

  it("respects a dismissal when the same anchored detection returns", () => {
    const dismissed = resolveFirst(baseState(), "dismissed");
    const { findings, outcome } = reconcileQaState(dismissed, [detection()], { chapter: 3, now: NOW });
    expect(findings[0]!.status).toBe("dismissed");
    expect(findings).toHaveLength(1);
    expect(outcome.respected).toBe(1);
  });

  it("treats a materially different detection as a new finding next to the dismissal", () => {
    const dismissed = resolveFirst(baseState(), "dismissed");
    const fresh = detection({ evidence: `Translation says "five miles" but narration says "three miles".` });
    const { findings, outcome } = reconcileQaState(dismissed, [fresh], { chapter: 3, now: NOW });
    expect(findings).toHaveLength(2);
    expect(findings[0]!.status).toBe("dismissed");
    expect(findings[1]!.status).toBe("open");
    expect(outcome.newFindings).toBe(1);
  });

  it("matches an entity-anchored detection by similarity when the id drifts after a passage edit", () => {
    const entities = namingBible().canonicalEntities;
    const issue = detection({ category: "names", message: "Narration renames Su Ming to Marcus.", evidence: `"Let's go," Marcus said.` });
    const state = buildQaState(undefined, [issue], { chapter: 3, canonicalEntities: entities, translation: "Su Ming spoke.", narration: "Marcus spoke.", now: NOW }).state;
    const resolved = resolveQaFindingsByIndex(state, [0], "dismissed", "2026-09-16T13:00:00.000Z", 3);
    const edited = { ...issue, evidence: `"We leave at dawn," Marcus said.` };
    const { findings, outcome } = reconcileQaState(resolved, [edited], { chapter: 3, canonicalEntities: entities, now: NOW });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe(resolved.findings[0]!.id);
    expect(findings[0]!.status).toBe("dismissed");
    expect(outcome.respected).toBe(1);
  });

  it("marks an open finding obsolete when its anchor no longer exists in the content", () => {
    const entities = namingBible().canonicalEntities;
    const issue = detection({ category: "names", message: "Narration renames Su Ming to Marcus.", evidence: `"Let's go," Marcus said.` });
    const state = buildQaState(undefined, [issue], { chapter: 3, canonicalEntities: entities, translation: "Su Ming spoke.", narration: "Marcus spoke.", now: NOW }).state;
    const { findings, outcome } = reconcileQaState(state, [], { chapter: 3, canonicalEntities: entities, content: "The lantern keeper crossed the yard.", now: NOW });
    expect(findings[0]!.status).toBe("obsolete");
    expect(findings[0]!.resolution).toEqual({ action: "obsolete", resolvedAt: NOW });
    expect(outcome.obsoleted).toBe(1);
    expect(deriveIssues(findings)).toEqual([]);
  });

  it("obsoletes stale findings after a full rewrite even though individual excerpt words still appear", () => {
    // Regression: scattered stopwords ("su ming", "chapter", "midnight") survive any
    // rewrite; only a contiguous phrase proves the old anchor is still present.
    const oldNarration = "Chapter 5 Summary: Su Ming collects the initial surge of resources accumulated by his ability at midnight.";
    const issue = detection({ category: "numbers", message: "The narration is a brief synopsis.", evidence: `NARRATION: "${oldNarration}"` });
    const state = buildQaState(undefined, [issue], { chapter: 5, translation: oldNarration, narration: oldNarration, now: NOW }).state;
    const rewritten = "Chapter 5: Novice Dungeon. The time had come. Su Ming nervously summoned the Super System interface at midnight, then chose to withdraw the accumulated points before the assembled students.";
    const { findings, outcome } = reconcileQaState(state, [], { chapter: 5, content: rewritten, now: NOW });
    expect(findings[0]!.status).toBe("obsolete");
    expect(outcome.obsoleted).toBe(1);
  });

  it("keeps an open finding whose anchored phrase survives the edit", () => {
    const passage = "Su Ming nervously summoned the Super System interface and chose to withdraw the accumulated points.";
    const issue = detection({ category: "numbers", message: "The accumulated total is missing.", evidence: `NARRATION: "${passage}"` });
    const state = buildQaState(undefined, [issue], { chapter: 5, translation: passage, narration: passage, now: NOW }).state;
    const edited = `The time had come. ${passage} He then left the dungeon.`; // phrase survives verbatim
    const { findings, outcome } = reconcileQaState(state, [], { chapter: 5, content: edited, now: NOW });
    expect(findings[0]!.status).toBe("open");
    expect(outcome.obsoleted).toBe(0);
  });

  it("adds an unmatched fresh detection as a new open finding", () => {
    const { findings, outcome } = reconcileQaState(baseState(), [detection({ category: "dialogue", message: "A line was dropped.", evidence: "The warning is missing." })], { chapter: 3, now: NOW });
    expect(findings).toHaveLength(2);
    expect(findings[1]).toMatchObject({ status: "open", firstDetectedAt: NOW, lastVerifiedAt: NOW, origin: "llm" });
    expect(outcome.newFindings).toBe(1);
  });

  it("gates the summary on open findings only", () => {
    const resolved = resolveFirst(baseState(), "manually_fixed");
    const summary = recomputeQaSummary(resolved.findings, resolved);
    expect(summary.status).toBe("pass");
    expect(summary.checks.numbers).toBe("pass");
    expect(qaCounts({ findings: resolved.findings })).toEqual({ open: 0, resolved: 1, safeFixesAvailable: 0 });
    const reopened = reconcileQaState(resolved, [detection({ severity: "fail" })], { chapter: 3, now: NOW }).findings;
    expect(recomputeQaSummary(reopened, resolved).status).toBe("fail");
  });
});

describe("compactFindingsContext", () => {
  it("renders a bounded status-aware block", () => {
    const state = buildQaState(undefined, [detection()], { chapter: 3, translation: "T", narration: "N", now: NOW }).state;
    const resolved = resolveQaFindingsByIndex(state, [0], "dismissed", "2026-09-16T13:00:00.000Z", 3);
    const withOpen = reconcileQaState(resolved, [detection({ category: "dialogue", message: "Dropped line", evidence: "Missing warning." })], { chapter: 3, now: NOW }).findings;
    const block = compactFindingsContext({ findings: withOpen });
    expect(block).toContain("[open] dialogue (warn): Dropped line");
    expect(block).toContain("[dismissed (dismiss)] numbers");
    const many = Array.from({ length: 30 }, (_, index) => ({ ...withOpen[1]!, id: `qaf_${String(index).padStart(24, "0")}` }));
    const capped = compactFindingsContext({ findings: many });
    expect(capped.split("\n").length).toBeLessThanOrEqual(26);
    expect(capped).toContain("more previous findings");
  });
});

describe("content spans", () => {
  it("selects changed paragraphs with one neighbor on each side", () => {
    const translation = "T one.\n\nT two.\n\nT three.";
    const narration = "N one.\n\nN two.\n\nN three.\n\nN four.";
    const spans = computeContentSpans(translation, narration);
    expect(spans!.paragraphFingerprints).toHaveLength(7);
    const changed = selectChangedParagraphs(spans, translation, "N one.\n\nN two CHANGED.\n\nN three.\n\nN four.")!;
    expect(changed.changedCount).toBe(1);
    expect(changed.paragraphs.map((paragraph) => paragraph.label)).toEqual(["N1", "N2", "N3"]);
  });

  it("reports a high ratio when most paragraphs change", () => {
    const spans = computeContentSpans("A.\n\nB.", "C.\n\nD.");
    const selection = selectChangedParagraphs(spans, "A2.\n\nB2.", "C2.\n\nD2.")!;
    expect(selection.ratio).toBe(1);
  });
});

async function setupChapter(options: { translation?: string; narration?: string; qa?: unknown } = {}) {
  const translation = options.translation ?? "English translation";
  const narration = options.narration ?? "Polished narration";
  const root = await mkdtemp(join(tmpdir(), "qa-state-"));
  const story = testStory();
  const paths = storyPaths(root, story.slug, 1);
  const now = "2026-09-16T10:00:00.000Z";
  const pending = { status: "pending" } as const;
  const complete = { status: "complete", provider: "openai", model: "m", completedAt: now } as const;
  await atomicWriteJson(paths.storyConfig, story);
  await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({
    chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
    counts: { originalCharacters: 100, englishWords: 120, narrationWords: 120 }, createdAt: now, updatedAt: now,
    stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: pending, continuity: pending, tts: pending, audioMastering: pending, alignment: pending, subtitles: pending, scenePlanning: pending, artwork: pending, video: pending },
  }));
  await atomicWrite(paths.original, "第一章\n\n林遥打开了门。");
  await atomicWrite(paths.english, translation);
  await atomicWrite(paths.narration, narration);
  await atomicWriteJson(paths.storyContext, {});
  if (options.qa) await atomicWriteJson(paths.qa, options.qa);
  return { root, story, paths };
}

const failingProvider: LLMProvider = {
  name: "openai",
  validateConfiguration: async () => {},
  generateText: async () => { throw new Error("provider down"); },
  generateStructured: async () => { throw new Error("provider down"); },
};

const warnQa = (message = "A number changed", evidence = "Ten became twelve.") => ({
  status: "warn" as const, score: 0.8,
  issues: [{ category: "numbers" as const, severity: "warn" as const, message, evidence }],
  checks: { ...checks, numbers: "warn" as const },
});

describe("recheckChapterQa", () => {
  it("does not re-report fixed or dismissed findings and discovers new issues", async () => {
    const issue = { category: "numbers", severity: "warn", message: "A number changed", evidence: "Ten became twelve." };
    const legacy = { status: "warn", score: 0.9, issues: [
      { ...issue, review: { disposition: "dismissed", reviewedAt: "2026-09-15T10:00:00.000Z" } },
      { category: "terminology", severity: "warn", message: "Term drift", evidence: "Bone Cage differs.", review: { disposition: "manually_fixed", reviewedAt: "2026-09-15T11:00:00.000Z" } },
    ], checks: { ...checks, numbers: "warn", terminology: "warn" } };
    const ctx = await setupChapter({ translation: "English translation", narration: "Polished narration", qa: legacy });
    const llm = new MockLLM("openai", undefined, warnQa("A number changed", "Ten became twelve."));
    const { state, summary } = await recheckChapterQa({ root: ctx.root, story: ctx.story, chapter: 1, provider: llm, now: NOW });
    const numbers = state.findings.find((finding) => finding.category === "numbers")!;
    const terminology = state.findings.find((finding) => finding.category === "terminology")!;
    expect(numbers.status).toBe("dismissed");
    expect(terminology.status).toBe("fixed_manual");
    expect(summary.respected).toBe(1);
    expect(summary.verified).toBe(1);
    expect(summary.newFindings).toBe(0);
    expect(state.status).toBe("pass");
    expect(state.contentSpans?.paragraphFingerprints.length).toBeGreaterThan(0);
    // The prompt carried the previous findings for verification.
    expect(String(llm.calls[0]?.input)).toContain("PREVIOUS QA FINDINGS");
    expect(String(llm.calls[0]?.instructions)).toContain("RECHECK MODE");
    const metadata = chapterSchema.parse(JSON.parse(await readFile(ctx.paths.chapterMeta, "utf8")));
    expect(metadata.stages.qa.status).toBe("complete");
    expect(metadata.quality).toMatchObject({ status: "pass" });
  });

  it("adds genuinely new issues from the recheck", async () => {
    const ctx = await setupChapter({});
    const llm = new MockLLM("openai", undefined, warnQa());
    const { state, summary } = await recheckChapterQa({ root: ctx.root, story: ctx.story, chapter: 1, provider: llm, now: NOW });
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]).toMatchObject({ status: "open", firstDetectedAt: NOW, origin: "llm" });
    expect(summary.newFindings).toBe(1);
    expect(summary.open).toBe(1);
  });

  it("leaves the prior qa.json byte-identical when the provider fails", async () => {
    const ctx = await setupChapter({ translation: "English translation", narration: "Polished narration", qa: warnQa() });
    const before = await readFile(ctx.paths.qa, "utf8");
    await expect(recheckChapterQa({ root: ctx.root, story: ctx.story, chapter: 1, provider: failingProvider })).rejects.toThrow("provider down");
    expect(await readFile(ctx.paths.qa, "utf8")).toBe(before);
  });

  it("changed mode sends only changed paragraphs plus neighbors", async () => {
    const narration = ["Opening scene text.", "Second beat stays.", "Third beat stays.", "Fourth beat stays.", "Fifth beat stays.", "Closing beat stays."].join("\n\n");
    const ctx = await setupChapter({ translation: "T1.\n\nT2.\n\nT3.", narration });
    await recheckChapterQa({ root: ctx.root, story: ctx.story, chapter: 1, provider: new MockLLM("openai") });
    await atomicWrite(ctx.paths.narration, narration.replace("Third beat stays.", "Third beat changed."));
    const llm = new MockLLM("openai");
    const { summary } = await recheckChapterQa({ root: ctx.root, story: ctx.story, chapter: 1, provider: llm, mode: "changed" });
    expect(summary.mode).toBe("changed");
    expect(summary.fellBackToFull).toBe(false);
    const input = String(llm.calls[0]?.input);
    expect(input).toContain("CHANGED CONTENT");
    expect(input).toContain("[N3] Third beat changed.");
    expect(input).toContain("[N2] Second beat stays.");
    expect(input).not.toContain("Closing beat stays.");
    expect(input).not.toContain(`NARRATION:\n${narration}`);
    expect(String(llm.calls[0]?.instructions)).toContain("CHANGED-CONTENT RECHECK");
  });

  it("falls back to full when more than half the paragraphs changed", async () => {
    const narration = "N one.\n\nN two.\n\nN three.\n\nN four.";
    const ctx = await setupChapter({ translation: "T one.", narration });
    await recheckChapterQa({ root: ctx.root, story: ctx.story, chapter: 1, provider: new MockLLM("openai") });
    await atomicWrite(ctx.paths.narration, "N one new.\n\nN two new.\n\nN three new.\n\nN four.");
    const llm = new MockLLM("openai");
    const { summary } = await recheckChapterQa({ root: ctx.root, story: ctx.story, chapter: 1, provider: llm, mode: "changed" });
    expect(summary.mode).toBe("full");
    expect(summary.fellBackToFull).toBe(true);
    expect(String(llm.calls[0]?.input)).toContain("NARRATION:\nN one new.");
  });

  it("falls back to full when no previous content spans exist", async () => {
    const ctx = await setupChapter({ translation: "English translation", narration: "Polished narration", qa: warnQa() });
    const llm = new MockLLM("openai");
    const { summary } = await recheckChapterQa({ root: ctx.root, story: ctx.story, chapter: 1, provider: llm, mode: "changed" });
    expect(summary.mode).toBe("full");
    expect(summary.fellBackToFull).toBe(true);
  });
});

describe("pipeline QA reconciliation", () => {
  it("preserves a prior dismissal when the pipeline QA stage reruns", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-pipeline-"));
    const input = join(root, "chapter.txt");
    await writeFile(input, "第一章\n\n林遥打开了门。", "utf8");
    const qa = warnQa();
    const gemini = new MockLLM("gemini", ["English translation"]);
    const openai = new MockLLM("openai", ["Polished narration"], qa);
    const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), new MockTTS(), new CopyingAudioProcessor());
    const story = testStory();
    const paths = storyPaths(root, story.slug, 1);
    await pipeline.run({ root, story, chapter: 1, inputPath: input, stopAfter: "qa" });
    let state = qaStateSchema.parse(JSON.parse(await readFile(paths.qa, "utf8")));
    expect(state.findings).toHaveLength(1);
    expect(state.status).toBe("warn");
    // Dismiss the finding, then rerun the QA stage: the dismissal must survive.
    await atomicWriteJson(paths.qa, resolveQaFindingsByIndex(state, [0], "dismissed", "2026-09-16T11:00:00.000Z", 1));
    const rerun = await pipeline.run({ root, story, chapter: 1, inputPath: input, force: "qa", stopAfter: "qa" });
    state = qaStateSchema.parse(JSON.parse(await readFile(paths.qa, "utf8")));
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]).toMatchObject({ status: "dismissed", resolution: { action: "dismiss" } });
    expect(state.status).toBe("pass");
    expect(rerun.quality).toMatchObject({ status: "pass", issueCategories: [] });
  });

  it("still gates the pipeline on open fail findings", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-pipeline-"));
    const input = join(root, "chapter.txt");
    await writeFile(input, "第一章\n\n林遥打开了门。", "utf8");
    const qa = { status: "fail", score: 0.3, issues: [{ category: "numbers", severity: "fail", message: "A value changed.", evidence: "Source says 100; output says 10." }], checks: { ...checks, numbers: "fail" } };
    const gemini = new MockLLM("gemini", ["English translation"]);
    const openai = new MockLLM("openai", ["Polished narration"], qa);
    const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), new MockTTS(), new CopyingAudioProcessor());
    await expect(pipeline.run({ root, story: testStory(), chapter: 1, inputPath: input })).rejects.toThrow("failed QA");
    const state = qaStateSchema.parse(JSON.parse(await readFile(storyPaths(root, "demo-story", 1).qa, "utf8")));
    expect(state.findings[0]).toMatchObject({ status: "open", severity: "fail" });
  });
});
