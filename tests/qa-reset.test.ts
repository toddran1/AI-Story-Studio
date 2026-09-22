import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobManager } from "../apps/server/job-manager.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";
import { Chapter, chapterSchema } from "../src/domain/chapter.js";
import { emptyStoryBible, storyBibleSchema } from "../src/domain/story-bible.js";
import { LLMRouter } from "../src/llm/router.js";
import { resetChapterQa, resetChapterQaBatch } from "../src/qa/reset.js";
import { buildQaState, recheckChapterQa, resolveQaFindingsByIndex } from "../src/qa/review.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { exists, readJsonIfExists } from "../src/storage/story-files.js";
import { MockLLM } from "./helpers.js";

const env = loadEnvironment({});
const NOW = "2026-09-18T12:00:00.000Z";

const mockAllCompleteStages = (qaOverride: Record<string, unknown> = {}) => ({
  ingestion: { status: "complete" as const, fingerprint: "ing_fp", outputFingerprint: "ing_out" },
  translation: { status: "complete" as const, fingerprint: "trans_fp", outputFingerprint: "trans_out", provider: "openai", model: "gpt-4o" },
  narration: { status: "complete" as const, fingerprint: "narr_fp", outputFingerprint: "narr_out", provider: "openai", model: "gpt-4o" },
  storyBible: { status: "complete" as const, fingerprint: "sb_fp", outputFingerprint: "sb_out" },
  continuity: { status: "complete" as const, fingerprint: "cont_fp", outputFingerprint: "cont_out" },
  tts: { status: "complete" as const, fingerprint: "tts_fp", outputFingerprint: "tts_out" },
  audioMastering: { status: "complete" as const, fingerprint: "am_fp", outputFingerprint: "am_out" },
  alignment: { status: "complete" as const, fingerprint: "align_fp", outputFingerprint: "align_out" },
  subtitles: { status: "complete" as const, fingerprint: "sub_fp", outputFingerprint: "sub_out" },
  scenePlanning: { status: "complete" as const, fingerprint: "scene_fp", outputFingerprint: "scene_out" },
  artwork: { status: "complete" as const, fingerprint: "art_fp", outputFingerprint: "art_out" },
  video: { status: "complete" as const, fingerprint: "vid_fp", outputFingerprint: "vid_out" },
  qa: { status: "complete" as const, fingerprint: "qa_fp", outputFingerprint: "qa_out", provider: "openai", model: "gpt-4o", completedAt: NOW, ...qaOverride },
});

async function createComprehensiveStoryFixture(chapterCount = 1) {
  const root = await mkdtemp(join(tmpdir(), "qa-reset-"));
  const story = defaultStory("test-realm", env);
  const pathsChapter1 = storyPaths(root, story.slug, 1);

  await atomicWriteJson(pathsChapter1.storyConfig, story);
  await atomicWriteJson(pathsChapter1.pipelineConfig, story.pipeline);

  // Story-level files
  await atomicWriteJson(pathsChapter1.bible, storyBibleSchema.parse({
    ...emptyStoryBible(),
    canonicalEntities: [{
      id: "ent_0123456789abcdef01234567",
      canonicalName: "Hero",
      type: "character",
      aliases: ["The One"],
      description: "Main character",
      firstAppearance: 1,
      lastKnownAppearance: 1,
    }],
  }));
  await atomicWriteJson(pathsChapter1.bibleManual, { manualNotes: "Protect this overlay" });
  await atomicWriteJson(pathsChapter1.qaExceptions, {
    exceptions: [{ id: "qax_0123456789abcdef01234567", category: "terminology", matchKind: "terminology", value: "Locked Ability", reason: "Special lore", createdAt: NOW }],
  });
  await atomicWriteJson(join(pathsChapter1.story, "pronunciation.json"), { terms: { Hero: "HEE-roh" } });

  for (let ch = 1; ch <= chapterCount; ch++) {
    const paths = storyPaths(root, story.slug, ch);
    const text = `Chapter ${ch} text content. The keeper raised the Azure Flame above the gate.`;
    await atomicWrite(paths.original, `原文 ${ch}`);
    await atomicWrite(paths.english, text);
    await atomicWrite(paths.narration, text);
    await atomicWriteJson(paths.storyContext, { chapter: ch, contextNotes: "Context snapshot" });

    // Dummy media and downstream artifacts
    await atomicWrite(paths.audioRaw, "RAW_AUDIO_DUMMY_DATA");
    await atomicWrite(paths.audio, "RIFF_WAV_AUDIO_DUMMY_DATA");
    await atomicWrite(paths.narrationTts, text);
    await atomicWriteJson(paths.alignment, { words: [{ word: "Chapter", start: 0, end: 0.5 }] });
    await atomicWrite(paths.subtitlesVtt, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nChapter 1\n");
    await atomicWrite(paths.subtitlesSrt, "1\n00:00:00,000 --> 00:00:01,000\nChapter 1\n");
    await atomicWriteJson(paths.scenesManifest, { scenes: [{ index: 1, heading: "Gate" }] });
    await atomicWrite(paths.video, "MP4_DUMMY_DATA");

    const chapterMeta = chapterSchema.parse({
      chapter: ch,
      sourceLanguage: story.sourceLanguage,
      outputLanguage: story.outputLanguage,
      counts: { originalCharacters: 50, englishWords: 20, narrationWords: 20 },
      createdAt: NOW,
      updatedAt: NOW,
      stages: mockAllCompleteStages(),
      quality: {
        score: 0.85,
        status: "warn",
        issueCategories: ["terminology", "names"],
      },
    });
    await atomicWriteJson(paths.chapterMeta, chapterMeta);

    const detections = [
      { category: "terminology" as const, severity: "warn" as const, message: "Terminology issue", evidence: "Azure Flame" },
      { category: "names" as const, severity: "warn" as const, message: "Name issue", evidence: "Hero" },
    ];
    const qaState = buildQaState(undefined, detections, { chapter: ch, translation: text, narration: text, now: NOW }).state;
    await atomicWriteJson(paths.qa, qaState);
  }

  return { root, story, pathsChapter1 };
}

describe("QA Data Reset — 19 Verification Scenarios (A through S)", () => {
  it("Scenario A: Completed QA result is reset cleanly with 11 non-QA stages preserved intact", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);
    const beforeMeta = chapterSchema.parse(await readJsonIfExists(pathsChapter1.chapterMeta));

    expect(await exists(pathsChapter1.qa)).toBe(true);
    expect(beforeMeta.stages.qa.status).toBe("complete");
    expect(beforeMeta.quality).toBeDefined();

    const result = await resetChapterQa(root, story.slug, 1);

    expect(result.reset).toBe(true);
    expect(result.deletedArtifacts).toContain("qa.json");
    expect(result.previousQaStatus).toBe("complete");

    // QA artifact must be deleted
    expect(await exists(pathsChapter1.qa)).toBe(false);

    const afterMeta = chapterSchema.parse(await readJsonIfExists(pathsChapter1.chapterMeta));

    // QA stage must be strictly { status: "pending" }
    expect(afterMeta.stages.qa).toEqual({ status: "pending" });
    expect(afterMeta.quality).toBeUndefined();

    // ALL 11 OTHER STAGES MUST BE DEEPLY EQUAL TO BEFORE
    expect(afterMeta.stages.ingestion).toEqual(beforeMeta.stages.ingestion);
    expect(afterMeta.stages.translation).toEqual(beforeMeta.stages.translation);
    expect(afterMeta.stages.narration).toEqual(beforeMeta.stages.narration);
    expect(afterMeta.stages.storyBible).toEqual(beforeMeta.stages.storyBible);
    expect(afterMeta.stages.continuity).toEqual(beforeMeta.stages.continuity);
    expect(afterMeta.stages.tts).toEqual(beforeMeta.stages.tts);
    expect(afterMeta.stages.audioMastering).toEqual(beforeMeta.stages.audioMastering);
    expect(afterMeta.stages.alignment).toEqual(beforeMeta.stages.alignment);
    expect(afterMeta.stages.subtitles).toEqual(beforeMeta.stages.subtitles);
    expect(afterMeta.stages.scenePlanning).toEqual(beforeMeta.stages.scenePlanning);
    expect(afterMeta.stages.artwork).toEqual(beforeMeta.stages.artwork);
    expect(afterMeta.stages.video).toEqual(beforeMeta.stages.video);
  });

  it("Scenario B: Stale QA result is reset cleanly", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);
    const meta = chapterSchema.parse(await readJsonIfExists(pathsChapter1.chapterMeta));
    meta.stages.qa = { status: "complete", staleReason: "Narration edited", fingerprint: "old_fp" };
    await atomicWriteJson(pathsChapter1.chapterMeta, meta);

    const result = await resetChapterQa(root, story.slug, 1);

    expect(result.reset).toBe(true);
    expect(result.previousQaStatus).toBe("complete");
    expect(await exists(pathsChapter1.qa)).toBe(false);

    const afterMeta = chapterSchema.parse(await readJsonIfExists(pathsChapter1.chapterMeta));
    expect(afterMeta.stages.qa).toEqual({ status: "pending" });
    expect("staleReason" in afterMeta.stages.qa).toBe(false);
  });

  it("Scenario C: Failed QA result is reset cleanly", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);
    const meta = chapterSchema.parse(await readJsonIfExists(pathsChapter1.chapterMeta));
    meta.stages.qa = { status: "failed", error: { message: "OpenAI rate limit exceeded" } };
    await atomicWriteJson(pathsChapter1.chapterMeta, meta);

    const result = await resetChapterQa(root, story.slug, 1);

    expect(result.reset).toBe(true);
    expect(result.previousQaStatus).toBe("failed");

    const afterMeta = chapterSchema.parse(await readJsonIfExists(pathsChapter1.chapterMeta));
    expect(afterMeta.stages.qa).toEqual({ status: "pending" });
    expect("error" in afterMeta.stages.qa).toBe(false);
  });

  it("Scenario D: Chapter with open findings is reset cleanly", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);
    const qaBefore = await readJsonIfExists<any>(pathsChapter1.qa);
    expect(qaBefore.findings.length).toBeGreaterThan(0);
    expect(qaBefore.findings.every((f: any) => f.status === "open")).toBe(true);

    const result = await resetChapterQa(root, story.slug, 1);
    expect(result.reset).toBe(true);
    expect(await exists(pathsChapter1.qa)).toBe(false);
  });

  it("Scenario E: Chapter with resolved findings (fixed_manual, dismissed, obsolete) is reset cleanly", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);
    let qa = await readJsonIfExists<any>(pathsChapter1.qa);
    qa = resolveQaFindingsByIndex(qa, [0], "manually_fixed", NOW, 1);
    qa = resolveQaFindingsByIndex(qa, [1], "dismissed", NOW, 1);
    await atomicWriteJson(pathsChapter1.qa, qa);

    const result = await resetChapterQa(root, story.slug, 1);
    expect(result.reset).toBe(true);
    expect(await exists(pathsChapter1.qa)).toBe(false);

    const afterMeta = chapterSchema.parse(await readJsonIfExists(pathsChapter1.chapterMeta));
    expect(afterMeta.stages.qa).toEqual({ status: "pending" });
  });

  it("Scenario F: Chapter with NO prior QA run is safe, idempotent no-op", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);
    // Remove qa.json and set stage to pending
    await rm(pathsChapter1.qa, { force: true });
    const meta = chapterSchema.parse(await readJsonIfExists(pathsChapter1.chapterMeta));
    meta.stages.qa = { status: "pending" };
    delete meta.quality;
    await atomicWriteJson(pathsChapter1.chapterMeta, meta);

    const beforeMeta = chapterSchema.parse(await readJsonIfExists(pathsChapter1.chapterMeta));

    const result = await resetChapterQa(root, story.slug, 1);
    expect(result.reset).toBe(false);
    expect(result.deletedArtifacts).toEqual([]);
    expect(result.previousQaStatus).toBe("pending");

    const afterMeta = chapterSchema.parse(await readJsonIfExists(pathsChapter1.chapterMeta));
    expect(afterMeta).toEqual(beforeMeta);
  });

  it("Scenario G: Chapter range reset (from: 1, to: 2) on a 3-chapter story", async () => {
    const { root, story } = await createComprehensiveStoryFixture(3);

    const paths1 = storyPaths(root, story.slug, 1);
    const paths2 = storyPaths(root, story.slug, 2);
    const paths3 = storyPaths(root, story.slug, 3);

    const result = await resetChapterQaBatch(root, story.slug, { type: "range", fromChapter: 1, toChapter: 2 });
    expect(result.requested).toBe(2);
    expect(result.reset).toBe(2);
    expect(result.chapters).toEqual([1, 2]);

    // Chapters 1 and 2 reset
    expect(await exists(paths1.qa)).toBe(false);
    expect(await exists(paths2.qa)).toBe(false);
    expect((await readJsonIfExists<Chapter>(paths1.chapterMeta))?.stages.qa.status).toBe("pending");
    expect((await readJsonIfExists<Chapter>(paths2.chapterMeta))?.stages.qa.status).toBe("pending");

    // Chapter 3 completely untouched
    expect(await exists(paths3.qa)).toBe(true);
    expect((await readJsonIfExists<Chapter>(paths3.chapterMeta))?.stages.qa.status).toBe("complete");
    expect((await readJsonIfExists<Chapter>(paths3.chapterMeta))?.quality).toBeDefined();
  });

  it("resets only the inclusive requested range, never the surrounding chapters", async () => {
    const { root, story } = await createComprehensiveStoryFixture(30);
    const result = await resetChapterQaBatch(root, story.slug, { type: "range", fromChapter: 4, toChapter: 20 });
    expect(result).toMatchObject({ scope: { type: "range", fromChapter: 4, toChapter: 20 }, affectedCount: 17 });
    expect(result.affectedChapterNumbers).toEqual(Array.from({ length: 17 }, (_, index) => index + 4));
    for (const chapter of [1, 3, 21, 30]) expect(await exists(storyPaths(root, story.slug, chapter).qa)).toBe(true);
    for (const chapter of [4, 12, 20]) expect(await exists(storyPaths(root, story.slug, chapter).qa)).toBe(false);
  });

  it("rejects malformed or empty reset scopes without deleting QA data", async () => {
    const { root, story } = await createComprehensiveStoryFixture(3);
    for (const scope of [{ type: "range", fromChapter: 3 }, { type: "range", toChapter: 3 }, { type: "range", fromChapter: 3, toChapter: 2 }, { type: "unknown" }, { type: "range", fromChapter: 40, toChapter: 50 }] as unknown[]) {
      await expect(resetChapterQaBatch(root, story.slug, scope as never)).rejects.toThrow();
    }
    for (const chapter of [1, 2, 3]) expect(await exists(storyPaths(root, story.slug, chapter).qa)).toBe(true);
  });

  it("Scenario H: Entire book reset (all: true) resets all chapters and leaves non-QA stages untouched", async () => {
    const { root, story } = await createComprehensiveStoryFixture(3);

    const beforeMetas = await Promise.all([1, 2, 3].map(async (ch) => {
      const p = storyPaths(root, story.slug, ch);
      return chapterSchema.parse(await readJsonIfExists(p.chapterMeta));
    }));

    const result = await resetChapterQaBatch(root, story.slug, { type: "book" });
    expect(result.requested).toBe(3);
    expect(result.reset).toBe(3);
    expect(result.chapters).toEqual([1, 2, 3]);

    for (let ch = 1; ch <= 3; ch++) {
      const p = storyPaths(root, story.slug, ch);
      expect(await exists(p.qa)).toBe(false);
      const after = chapterSchema.parse(await readJsonIfExists(p.chapterMeta));
      expect(after.stages.qa).toEqual({ status: "pending" });
      expect(after.quality).toBeUndefined();

      // Check non-QA stages
      const before = beforeMetas[ch - 1]!;
      expect(after.stages.translation).toEqual(before.stages.translation);
      expect(after.stages.narration).toEqual(before.stages.narration);
      expect(after.stages.tts).toEqual(before.stages.tts);
      expect(after.stages.video).toEqual(before.stages.video);
    }
  });

  it("Scenario I: Story-level pronunciation config & cache preserved", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);
    const pronPath = join(pathsChapter1.story, "pronunciation.json");
    const pronBefore = await readFile(pronPath, "utf8");

    await resetChapterQa(root, story.slug, 1);

    expect(await exists(pronPath)).toBe(true);
    const pronAfter = await readFile(pronPath, "utf8");
    expect(pronAfter).toBe(pronBefore);
  });

  it("Scenario J: Story Bible preserved", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);
    const bibleBefore = await readFile(pathsChapter1.bible, "utf8");
    const bibleManualBefore = await readFile(pathsChapter1.bibleManual, "utf8");
    const contextBefore = await readFile(pathsChapter1.storyContext, "utf8");

    await resetChapterQa(root, story.slug, 1);

    expect(await readFile(pathsChapter1.bible, "utf8")).toBe(bibleBefore);
    expect(await readFile(pathsChapter1.bibleManual, "utf8")).toBe(bibleManualBefore);
    expect(await readFile(pathsChapter1.storyContext, "utf8")).toBe(contextBefore);
  });

  it("Scenario K: Original, translation, narration text files preserved", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);
    const origBefore = await readFile(pathsChapter1.original, "utf8");
    const engBefore = await readFile(pathsChapter1.english, "utf8");
    const narrBefore = await readFile(pathsChapter1.narration, "utf8");

    await resetChapterQa(root, story.slug, 1);

    expect(await readFile(pathsChapter1.original, "utf8")).toBe(origBefore);
    expect(await readFile(pathsChapter1.english, "utf8")).toBe(engBefore);
    expect(await readFile(pathsChapter1.narration, "utf8")).toBe(narrBefore);
  });

  it("Scenario L: Audio and TTS artifacts preserved", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);
    const audioRawBefore = await readFile(pathsChapter1.audioRaw);
    const audioBefore = await readFile(pathsChapter1.audio);
    const narrTtsBefore = await readFile(pathsChapter1.narrationTts, "utf8");

    await resetChapterQa(root, story.slug, 1);

    expect(await readFile(pathsChapter1.audioRaw)).toEqual(audioRawBefore);
    expect(await readFile(pathsChapter1.audio)).toEqual(audioBefore);
    expect(await readFile(pathsChapter1.narrationTts, "utf8")).toBe(narrTtsBefore);
  });

  it("Scenario M: Alignment and subtitles preserved", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);
    const alignBefore = await readFile(pathsChapter1.alignment, "utf8");
    const vttBefore = await readFile(pathsChapter1.subtitlesVtt, "utf8");
    const srtBefore = await readFile(pathsChapter1.subtitlesSrt, "utf8");

    await resetChapterQa(root, story.slug, 1);

    expect(await readFile(pathsChapter1.alignment, "utf8")).toBe(alignBefore);
    expect(await readFile(pathsChapter1.subtitlesVtt, "utf8")).toBe(vttBefore);
    expect(await readFile(pathsChapter1.subtitlesSrt, "utf8")).toBe(srtBefore);
  });

  it("Scenario N: Scenes, artwork, video preserved", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);
    const scenesBefore = await readFile(pathsChapter1.scenesManifest, "utf8");
    const videoBefore = await readFile(pathsChapter1.video);

    await resetChapterQa(root, story.slug, 1);

    expect(await readFile(pathsChapter1.scenesManifest, "utf8")).toBe(scenesBefore);
    expect(await readFile(pathsChapter1.video)).toEqual(videoBefore);
  });

  it("Scenario O: QA exceptions preserved", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);
    const exceptionsBefore = await readFile(pathsChapter1.qaExceptions, "utf8");

    await resetChapterQa(root, story.slug, 1);

    expect(await readFile(pathsChapter1.qaExceptions, "utf8")).toBe(exceptionsBefore);
  });

  it("Scenario P: Historical production failure diagnostic remains historical after QA reset", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);
    // Write a production run manifest with an earlier failure
    const runsDir = join(pathsChapter1.story, "production-runs");
    const runFile = join(runsDir, "run-failed.json");
    await atomicWriteJson(runFile, {
      id: "run-failed",
      story: story.slug,
      status: "failed",
      error: "TTS rendering timed out",
      createdAt: NOW,
    });

    await resetChapterQa(root, story.slug, 1);

    // The historical production run remains intact
    const run = await readJsonIfExists<any>(runFile);
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("TTS rendering timed out");
  });

  it("Scenario Q: Subsequent QA recheck after reset behaves as clean first-ever run", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);

    await resetChapterQa(root, story.slug, 1);
    expect(await exists(pathsChapter1.qa)).toBe(false);

    // Setup MockLLM for clean QA review
    const mockQaResponse = {
      status: "pass" as const,
      score: 1,
      issues: [],
      checks: {
        completeness: "pass" as const,
        names: "pass" as const,
        numbers: "pass" as const,
        terminology: "pass" as const,
        dialogue: "pass" as const,
        storyConsistency: "pass" as const,
        narrationFidelity: "pass" as const,
      },
    };
    const mock = new MockLLM("openai", undefined, mockQaResponse);

    const recheckResult = await recheckChapterQa({
      root,
      story,
      chapter: 1,
      provider: mock,
      mode: "full",
    });

    expect(recheckResult.summary.open).toBe(0);
    expect(await exists(pathsChapter1.qa)).toBe(true);

    const newQa = await readJsonIfExists<any>(pathsChapter1.qa);
    expect(newQa.findings).toEqual([]);
    expect(newQa.score).toBe(1);
    expect(newQa.status).toBe("pass");
  });

  it("Scenario R: Downstream stage execution after reset — non-QA stages are not invalidated", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);

    const beforeMeta = chapterSchema.parse(await readJsonIfExists(pathsChapter1.chapterMeta));

    await resetChapterQa(root, story.slug, 1);

    const afterMeta = chapterSchema.parse(await readJsonIfExists(pathsChapter1.chapterMeta));

    // Non-QA stages must STILL be complete (no invalidation)
    expect(afterMeta.stages.tts.status).toBe("complete");
    expect(afterMeta.stages.alignment.status).toBe("complete");
    expect(afterMeta.stages.subtitles.status).toBe("complete");
    expect(afterMeta.stages.video.status).toBe("complete");
  });

  it("Scenario S: Partial filesystem failure handling / atomic rollback restores qa.json", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);

    const qaBefore = await readFile(pathsChapter1.qa, "utf8");

    // Replace chapter.json with a directory so atomicWriteJson(paths.chapterMeta) fails
    await rm(pathsChapter1.chapterMeta);
    const fs = await import("node:fs/promises");
    await fs.mkdir(pathsChapter1.chapterMeta); // creates directory where file was expected

    await expect(resetChapterQa(root, story.slug, 1)).rejects.toThrow();

    // Verify qa.json was restored from in-memory backup
    expect(await exists(pathsChapter1.qa)).toBe(true);
    expect(await readFile(pathsChapter1.qa, "utf8")).toBe(qaBefore);

    // Clean up directory
    await fs.rmdir(pathsChapter1.chapterMeta);
  });

  it("Operations integration: StudioOperations resetChapterQa and resetQaBatch invalidate catalog and emit audit", async () => {
    const { root, story } = await createComprehensiveStoryFixture(2);
    const jobs = new JobManager();
    const operations = new StudioOperations(root, env, jobs, { llm: new LLMRouter(new Map([["openai", new MockLLM("openai")]])) });

    try {
      const single = await operations.resetChapterQa(story.slug, 1);
      expect(single.reset).toBe(true);
      expect(single.chapter).toBe(1);

      const batch = await operations.resetQaBatch(story.slug, { type: "chapter", chapterNumber: 2 });
      expect(batch.requested).toBe(1);
      expect(batch.reset).toBe(1);
      expect(batch.chapters).toEqual([2]);
    } finally {
      await operations.close();
    }
  });
});

describe("QA Reset Follow-Up — Unprocessed Chapters & Resilient Classification (Scenarios A through L)", () => {
  function makeDummyManifest(chapters: number[]) {
    const hash = "a".repeat(64);
    return {
      version: 1 as const,
      adapterVersion: "1.0.0",
      type: "text" as const,
      origin: { path: "/dummy/novel.txt", name: "novel.txt" },
      fingerprint: hash,
      importedAt: NOW,
      warnings: [],
      unnumberedSections: [],
      chapters: chapters.map((ch) => ({
        chapter: ch,
        file: `chapters/${String(ch).padStart(4, "0")}.txt`,
        fingerprint: hash,
        ref: {
          chapter: ch,
          sourceId: `sec_${ch}`,
          sourceType: "text" as const,
          metadata: {},
        },
      })),
    };
  }

  async function createMixedStoryFixture() {
    // 5 chapters total in source manifest:
    // Ch 1: QA complete
    // Ch 2: QA failed
    // Ch 3: Production metadata exists, but QA never run (status: "pending")
    // Ch 4: Source-only, no production metadata
    // Ch 5: Source-only, no production metadata
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(3);

    // Write source manifest defining chapters 1..5
    await atomicWriteJson(pathsChapter1.sourceManifest, makeDummyManifest([1, 2, 3, 4, 5]));

    // Ch 2: QA failed
    const paths2 = storyPaths(root, story.slug, 2);
    const meta2 = chapterSchema.parse(await readJsonIfExists(paths2.chapterMeta));
    meta2.stages.qa = { status: "failed", error: { message: "Rate limit" } };
    await atomicWriteJson(paths2.chapterMeta, meta2);

    // Ch 3: QA never run (already clean)
    const paths3 = storyPaths(root, story.slug, 3);
    await rm(paths3.qa, { force: true });
    const meta3 = chapterSchema.parse(await readJsonIfExists(paths3.chapterMeta));
    meta3.stages.qa = { status: "pending" };
    delete meta3.quality;
    await atomicWriteJson(paths3.chapterMeta, meta3);

    return { root, story, pathsChapter1 };
  }

  it("Scenario A: Source chapter with no production metadata returns skipped/alreadyClean with zero writes", async () => {
    const { root, story } = await createMixedStoryFixture();
    const paths4 = storyPaths(root, story.slug, 4);

    expect(await exists(paths4.chapterMeta)).toBe(false);
    expect(await exists(paths4.qa)).toBe(false);

    const result = await resetChapterQa(root, story.slug, 4);

    expect(result.reset).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no_qa_data");
    expect(result.newQaStatus).toBe("not_run");
    expect(result.deletedArtifacts).toEqual([]);

    // Zero writes invariant: chapter.json must still NOT exist!
    expect(await exists(paths4.chapterMeta)).toBe(false);
    expect(await exists(paths4.qa)).toBe(false);
  });

  it("Scenario B: Entire book containing mixed states resets only chapters with QA data and counts correctly", async () => {
    const { root, story } = await createMixedStoryFixture();

    const result = await resetChapterQaBatch(root, story.slug, { type: "book" });

    expect(result.requested).toBe(5);
    expect(result.reset).toBe(2);
    expect(result.alreadyClean).toBe(3);
    expect(result.skipped).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.resetChapters).toEqual([1, 2]);
    expect(result.skippedChapters).toEqual([3, 4, 5]);
    expect(result.chapters).toEqual([1, 2]);

    // Batch accounting invariant: requested === reset + alreadyClean + failed
    expect(result.requested).toBe(result.reset + result.alreadyClean + result.failed);
  });

  it("Scenario C: Entire book idempotency — second reset produces reset=0 and alreadyClean=total", async () => {
    const { root, story } = await createMixedStoryFixture();

    const firstRun = await resetChapterQaBatch(root, story.slug, { type: "book" });
    expect(firstRun.reset).toBe(2);
    expect(firstRun.alreadyClean).toBe(3);
    expect(firstRun.failed).toBe(0);

    const secondRun = await resetChapterQaBatch(root, story.slug, { type: "book" });
    expect(secondRun.requested).toBe(5);
    expect(secondRun.reset).toBe(0);
    expect(secondRun.alreadyClean).toBe(5);
    expect(secondRun.skipped).toBe(5);
    expect(secondRun.failed).toBe(0);
    expect(secondRun.failures).toEqual([]);
    expect(secondRun.resetChapters).toEqual([]);
    expect(secondRun.skippedChapters).toEqual([1, 2, 3, 4, 5]);
    expect(secondRun.requested).toBe(secondRun.reset + secondRun.alreadyClean + secondRun.failed);
  });

  it("Scenario D: Explicit nonexistent chapter is reported as failure", async () => {
    const { root, story } = await createMixedStoryFixture();

    // Single chapter reset throws error
    await expect(resetChapterQa(root, story.slug, 999999)).rejects.toThrow(/does not exist in story/i);

    // Batch reset records it as a failure
    await expect(resetChapterQaBatch(root, story.slug, { type: "chapter", chapterNumber: 999999 })).rejects.toThrow(/does not exist/i);
  });

  it("Scenario E: Corrupt chapter metadata is reported as failure", async () => {
    const { root, story } = await createComprehensiveStoryFixture(1);
    const paths1 = storyPaths(root, story.slug, 1);

    // Write invalid chapter.json content
    await atomicWrite(paths1.chapterMeta, JSON.stringify({ invalid: "not-a-chapter" }));

    const batchResult = await resetChapterQaBatch(root, story.slug, { type: "chapter", chapterNumber: 1 });
    expect(batchResult.requested).toBe(1);
    expect(batchResult.reset).toBe(0);
    expect(batchResult.alreadyClean).toBe(0);
    expect(batchResult.failed).toBe(1);
    expect(batchResult.failures).toHaveLength(1);
    expect(batchResult.failures[0]?.chapter).toBe(1);
    expect(batchResult.requested).toBe(batchResult.reset + batchResult.alreadyClean + batchResult.failed);
  });

  it("Scenario F: Filesystem deletion failure is reported as failure", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);

    // Make qa.json a directory containing an unwritable/locked structure, or test rm failure handling
    await rm(pathsChapter1.qa, { force: true });
    const fs = await import("node:fs/promises");
    await fs.mkdir(pathsChapter1.qa);
    const innerFile = join(pathsChapter1.qa, "cannot-delete.txt");
    await fs.writeFile(innerFile, "locked");

    const batchResult = await resetChapterQaBatch(root, story.slug, { type: "chapter", chapterNumber: 1 });
    expect(batchResult.requested).toBe(1);
    await fs.rm(pathsChapter1.qa, { recursive: true, force: true });
  });

  it("Scenario G: Metadata write failure preserves existing rollback guarantees", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);
    const qaBefore = await readFile(pathsChapter1.qa, "utf8");

    // Replace chapter.json with a directory to trigger atomic write failure
    await rm(pathsChapter1.chapterMeta);
    const fs = await import("node:fs/promises");
    await fs.mkdir(pathsChapter1.chapterMeta);

    const batchResult = await resetChapterQaBatch(root, story.slug, { type: "chapter", chapterNumber: 1 });
    expect(batchResult.failed).toBe(1);
    expect(batchResult.failures[0]?.chapter).toBe(1);

    // qa.json was restored by rollback
    expect(await exists(pathsChapter1.qa)).toBe(true);
    expect(await readFile(pathsChapter1.qa, "utf8")).toBe(qaBefore);

    await fs.rmdir(pathsChapter1.chapterMeta);
  });

  it("Scenario H: Source-only chapter isolation — no files or directories created", async () => {
    const { root, story } = await createMixedStoryFixture();
    const paths5 = storyPaths(root, story.slug, 5);

    expect(await exists(paths5.chapterMeta)).toBe(false);

    await resetChapterQa(root, story.slug, 5);

    expect(await exists(paths5.chapterMeta)).toBe(false);
    expect(await exists(paths5.qa)).toBe(false);
    expect(await exists(join(paths5.story, "chapters", "5"))).toBe(false);
  });

  it("Scenario I: Non-QA stage isolation — all 11 non-QA stages remain byte-for-byte untouched", async () => {
    const { root, story, pathsChapter1 } = await createComprehensiveStoryFixture(1);
    const beforeMeta = chapterSchema.parse(await readJsonIfExists(pathsChapter1.chapterMeta));

    await resetChapterQa(root, story.slug, 1);

    const afterMeta = chapterSchema.parse(await readJsonIfExists(pathsChapter1.chapterMeta));
    expect(afterMeta.stages.ingestion).toEqual(beforeMeta.stages.ingestion);
    expect(afterMeta.stages.translation).toEqual(beforeMeta.stages.translation);
    expect(afterMeta.stages.narration).toEqual(beforeMeta.stages.narration);
    expect(afterMeta.stages.storyBible).toEqual(beforeMeta.stages.storyBible);
    expect(afterMeta.stages.continuity).toEqual(beforeMeta.stages.continuity);
    expect(afterMeta.stages.tts).toEqual(beforeMeta.stages.tts);
    expect(afterMeta.stages.audioMastering).toEqual(beforeMeta.stages.audioMastering);
    expect(afterMeta.stages.alignment).toEqual(beforeMeta.stages.alignment);
    expect(afterMeta.stages.subtitles).toEqual(beforeMeta.stages.subtitles);
    expect(afterMeta.stages.scenePlanning).toEqual(beforeMeta.stages.scenePlanning);
    expect(afterMeta.stages.artwork).toEqual(beforeMeta.stages.artwork);
    expect(afterMeta.stages.video).toEqual(beforeMeta.stages.video);
  });

  it("Scenario J: Batch accounting invariant requested === reset + alreadyClean + failed holds for mixed batches", async () => {
    const { root, story } = await createMixedStoryFixture();

    const batch = await resetChapterQaBatch(root, story.slug, { type: "range", fromChapter: 1, toChapter: 5 });
    expect(batch.requested).toBe(5);
    expect(batch.reset).toBe(2);
    expect(batch.alreadyClean).toBe(3);
    expect(batch.skipped).toBe(3);
    expect(batch.failed).toBe(0);
    expect(batch.requested).toBe(batch.reset + batch.alreadyClean + batch.failed);
  });

  it("Scenario K & L: UI result summaries handle clean success, successful no-op, and partial failure", () => {
    function formatResetSummary(res: { requested: number; reset: number; alreadyClean: number; failed: number }) {
      if (res.failed > 0) {
        return `QA reset completed with ${res.failed} problem(s): ${res.reset} reset · ${res.alreadyClean} already had no QA data · ${res.failed} failed`;
      }
      if (res.reset === 0) {
        return `QA was already clean for all ${res.requested} chapters. Other stages were not changed.`;
      }
      if (res.alreadyClean > 0) {
        return `QA reset complete. ${res.reset} chapters reset; ${res.alreadyClean} already had no QA data. Other stages were not changed.`;
      }
      return `QA data reset for ${res.reset} chapters. Other stages were not changed.`;
    }

    // Scenario K: Complete success with skipped
    expect(formatResetSummary({ requested: 502, reset: 252, alreadyClean: 250, failed: 0 }))
      .toBe("QA reset complete. 252 chapters reset; 250 already had no QA data. Other stages were not changed.");

    // Scenario K: Successful no-op
    expect(formatResetSummary({ requested: 502, reset: 0, alreadyClean: 502, failed: 0 }))
      .toBe("QA was already clean for all 502 chapters. Other stages were not changed.");

    // Scenario L: Partial failure
    expect(formatResetSummary({ requested: 502, reset: 247, alreadyClean: 250, failed: 5 }))
      .toContain("5 problem(s)");
  });
});
