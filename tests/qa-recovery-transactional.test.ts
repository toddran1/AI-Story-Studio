import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadEnvironment } from "../src/config/env.js";
import { ChapterPipeline } from "../src/pipeline/chapter-pipeline.js";
import { QualityGateError } from "../src/pipeline/errors.js";
import { LLMRouter } from "../src/llm/router.js";
import { TTSProviderRouter } from "../src/tts/router.js";
import { createBlankStory } from "../src/studio/projects.js";
import { storyPaths } from "../src/storage/paths.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { readTextIfExists } from "../src/storage/story-files.js";
import { Chapter } from "../src/domain/chapter.js";
import { MockLLM, MockTTS } from "./helpers.js";
import { QaResult, qaIssueSchema } from "../src/domain/qa.js";

type QaIssue = z.infer<typeof qaIssueSchema>;

const makeIssues = (count: number, severity: "warn" | "fail" = "warn"): QaIssue[] =>
  Array.from({ length: count }, (_, i) => ({
    category: "terminology",
    severity,
    message: `Issue number ${i + 1}`,
    evidence: `Evidence for issue ${i + 1}`,
  }));

const makeBadQa = (count = 5): QaResult => ({
  status: "warn",
  score: 0.7,
  issues: makeIssues(count, "warn"),
  checks: {
    completeness: "warn",
    names: "pass",
    numbers: "pass",
    terminology: "warn",
    dialogue: "pass",
    storyConsistency: "pass",
    narrationFidelity: "pass",
  },
});

const makeGoodQa = (): QaResult => ({
  status: "pass",
  score: 1.0,
  issues: [],
  checks: {
    completeness: "pass",
    names: "pass",
    numbers: "pass",
    terminology: "pass",
    dialogue: "pass",
    storyConsistency: "pass",
    narrationFidelity: "pass",
  },
});

describe("transactional QA auto-recovery", () => {
  it("A. Translation recovery failure: restores all 4 old artifacts, full chapter metadata snapshot, word counts, and downstream stages", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-recovery-test-a-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "QA Story", slug: "qa-story" });
    const paths = storyPaths(root, story.slug, 1);

    const initialSource = "第一章 初始内容";
    await atomicWrite(paths.original, initialSource);

    let qaCallCount = 0;
    let textCallCount = 0;
    const llm = new MockLLM("gemini", [
      "Initial translation 1", // Run 1 translation
      "Initial narration 1",   // Run 1 narration
    ]);

    const originalGenerateStructured = llm.generateStructured.bind(llm);
    llm.generateStructured = async (request) => {
      if (request.schemaName === "chapter_qa") {
        qaCallCount++;
        // Run 1: clean QA pass
        if (qaCallCount === 1) {
          return { value: request.schema.parse(makeGoodQa()), usage: { inputTokens: 10, outputTokens: 5 } };
        }
        // Run 2: bad QA triggering recovery
        return { value: request.schema.parse(makeBadQa(5)), usage: { inputTokens: 10, outputTokens: 5 } };
      }
      return originalGenerateStructured(request);
    };

    const originalGenerateText = llm.generateText.bind(llm);
    llm.generateText = async (request) => {
      textCallCount++;
      // Call 3 is recovery translation attempt in Run 2
      if (textCallCount === 3) {
        throw new Error("Translation provider rate limited during recovery");
      }
      return originalGenerateText(request);
    };

    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", new MockTTS()]])));

    // Step 1: Run initially through QA cleanly
    await pipeline.run({
      root,
      story,
      chapter: 1,
      inputPath: paths.original,
      stopAfter: "qa",
    });

    // Seed downstream completed stages into chapterMeta
    const metaBeforeRun2: Chapter = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    metaBeforeRun2.stages.tts = { status: "complete", outputFingerprint: "fp-tts-1" };
    metaBeforeRun2.stages.audioMastering = { status: "complete", outputFingerprint: "fp-audio-1" };
    metaBeforeRun2.stages.scenePlanning = { status: "complete", outputFingerprint: "fp-scene-1" };
    metaBeforeRun2.stages.artwork = { status: "complete", outputFingerprint: "fp-art-1" };
    metaBeforeRun2.stages.video = { status: "complete", outputFingerprint: "fp-vid-1" };
    await atomicWriteJson(paths.chapterMeta, metaBeforeRun2);

    // Step 2: Force QA. QA will return 5 issues, trigger recovery, and recovery translation will throw!
    await expect(
      pipeline.run({
        root,
        story,
        chapter: 1,
        inputPath: paths.original,
        force: "qa",
        stopAfter: "qa",
      })
    ).rejects.toThrow("Translation provider rate limited during recovery");

    // All four artifacts restored
    expect(await readFile(paths.english, "utf8")).toBe("Initial translation 1");
    expect(await readFile(paths.narration, "utf8")).toBe("Initial narration 1");
    expect(await readFile(paths.narrationTts, "utf8")).toBe("Initial narration 1");
    expect(JSON.parse(await readFile(paths.qa, "utf8")).status).toBe("warn");

    // Metadata restored
    const meta: Chapter = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    expect(meta.counts.englishWords).toBe(3);
    expect(meta.counts.narrationWords).toBe(3);
    expect(meta.stages.translation.status).toBe("complete");
    expect(meta.stages.narration.status).toBe("complete");
    // Downstream stages must NOT be left stale/pending due to failed recovery
    expect(meta.stages.tts.status).toBe("complete");
    expect(meta.stages.audioMastering.status).toBe("complete");
    expect(meta.stages.scenePlanning.status).toBe("complete");
    expect(meta.stages.artwork.status).toBe("complete");
    expect(meta.stages.video.status).toBe("complete");
    // QA stage failed with diagnostic, but previous artifact identity remains
    expect(meta.stages.qa.status).toBe("failed");
    expect(meta.stages.qa.outputFingerprint).toBeDefined();
    expect(meta.stages.qa.error?.message).toContain("Translation provider rate limited during recovery");
  });

  it("B. Narration recovery failure: restores old translation, narration, and QA when narration fails after translation succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-recovery-test-b-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "QA Story", slug: "qa-story" });
    const paths = storyPaths(root, story.slug, 1);

    await atomicWrite(paths.original, "第一章 初始内容");

    let textCallCount = 0;
    const llm = new MockLLM("gemini", [
      "Initial translation 1", // Call 1
      "Initial narration 1",   // Call 2
      "Recovered translation 2", // Call 3 (recovery translation succeeds!)
    ], makeBadQa(5));

    const originalGenerateText = llm.generateText.bind(llm);
    llm.generateText = async (request) => {
      textCallCount++;
      if (textCallCount === 4) {
        // Call 4 is recovery narration
        throw new Error("Narration service threw 503 during recovery");
      }
      return originalGenerateText(request);
    };

    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", new MockTTS()]])));

    await expect(
      pipeline.run({
        root,
        story,
        chapter: 1,
        inputPath: paths.original,
        stopAfter: "qa",
      })
    ).rejects.toThrow("Narration service threw 503 during recovery");

    // Old translation must be restored (not "Recovered translation 2")
    expect(await readFile(paths.english, "utf8")).toBe("Initial translation 1");
    expect(await readFile(paths.narration, "utf8")).toBe("Initial narration 1");
    expect(await readFile(paths.narrationTts, "utf8")).toBe("Initial narration 1");
    expect(JSON.parse(await readFile(paths.qa, "utf8")).status).toBe("warn");

    const meta: Chapter = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    expect(meta.stages.translation.status).toBe("complete");
    expect(meta.stages.narration.status).toBe("complete");
    expect(meta.stages.qa.status).toBe("failed");
    expect(meta.stages.qa.error?.message).toContain("Narration service threw 503 during recovery");
  });

  it("C. QA #2 execution failure: restores all artifacts and metadata when QA #2 LLM call throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-recovery-test-c-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "QA Story", slug: "qa-story" });
    const paths = storyPaths(root, story.slug, 1);

    await atomicWrite(paths.original, "第一章 初始内容");

    let qaCallCount = 0;
    const llm = new MockLLM("gemini", [
      "Initial translation 1",
      "Initial narration 1",
      "Recovered translation 2",
      "Recovered narration 2",
    ]);

    const originalGenerateStructured = llm.generateStructured.bind(llm);
    llm.generateStructured = async (request) => {
      if (request.schemaName === "chapter_qa") {
        qaCallCount++;
        if (qaCallCount === 1) {
          // Pre-recovery QA call
          return { value: request.schema.parse(makeBadQa(5)), usage: { inputTokens: 10, outputTokens: 5 } };
        }
        // Recovery QA #2 throws an execution failure
        throw new Error("QA validation LLM endpoint connection reset");
      }
      return originalGenerateStructured(request);
    };

    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", new MockTTS()]])));

    await expect(
      pipeline.run({
        root,
        story,
        chapter: 1,
        inputPath: paths.original,
        stopAfter: "qa",
      })
    ).rejects.toThrow("QA validation LLM endpoint connection reset");

    // All original files restored
    expect(await readFile(paths.english, "utf8")).toBe("Initial translation 1");
    expect(await readFile(paths.narration, "utf8")).toBe("Initial narration 1");
    expect(await readFile(paths.narrationTts, "utf8")).toBe("Initial narration 1");
    expect(JSON.parse(await readFile(paths.qa, "utf8")).status).toBe("warn");

    const meta: Chapter = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    expect(meta.stages.qa.status).toBe("failed");
    expect(meta.stages.qa.error?.message).toContain("QA validation LLM endpoint connection reset");
  });

  it("D. QA #2 QualityGateError: does NOT rollback when QA #2 legitimately runs and fails with QualityGateError", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-recovery-test-d-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "QA Story", slug: "qa-story" });
    const paths = storyPaths(root, story.slug, 1);

    await atomicWrite(paths.original, "第一章 初始内容");

    let qaCallCount = 0;
    const llm = new MockLLM("gemini", [
      "Initial translation 1",
      "Initial narration 1",
      "Recovered translation 2",
      "Recovered narration 2",
    ]);

    const persistentFailQa: QaResult = {
      status: "fail",
      score: 0.3,
      issues: makeIssues(6, "fail"),
      checks: {
        completeness: "fail",
        names: "pass",
        numbers: "pass",
        terminology: "fail",
        dialogue: "pass",
        storyConsistency: "pass",
        narrationFidelity: "pass",
      },
    };

    const originalGenerateStructured = llm.generateStructured.bind(llm);
    llm.generateStructured = async (request) => {
      if (request.schemaName === "chapter_qa") {
        qaCallCount++;
        if (qaCallCount === 1) {
          return { value: request.schema.parse(makeBadQa(5)), usage: { inputTokens: 10, outputTokens: 5 } };
        }
        return { value: request.schema.parse(persistentFailQa), usage: { inputTokens: 10, outputTokens: 5 } };
      }
      return originalGenerateStructured(request);
    };

    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", new MockTTS()]])));

    await expect(
      pipeline.run({
        root,
        story,
        chapter: 1,
        inputPath: paths.original,
        stopAfter: "qa",
      })
    ).rejects.toThrow(QualityGateError);

    // CRITICAL: Regeneration MUST be preserved, not rolled back to QA #1
    expect(await readFile(paths.english, "utf8")).toBe("Recovered translation 2");
    expect(await readFile(paths.narration, "utf8")).toBe("Recovered narration 2");
    const qaResult = JSON.parse(await readFile(paths.qa, "utf8"));
    expect(qaResult.status).toBe("fail");
  });

  it("E. Previously missing artifact: removes newly-created partial artifacts (like narrationTts) if they did not exist before recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-recovery-test-e-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "QA Story", slug: "qa-story" });
    const paths = storyPaths(root, story.slug, 1);

    await atomicWrite(paths.original, "第一章 初始内容");

    let qaCallCount = 0;
    const llm = new MockLLM("gemini", [
      "Initial translation 1",
      "Initial narration 1",
      "Recovered translation 2",
      "Recovered narration 2",
    ]);

    const originalGenerateStructured = llm.generateStructured.bind(llm);
    llm.generateStructured = async (request) => {
      if (request.schemaName === "chapter_qa") {
        qaCallCount++;
        if (qaCallCount === 1) {
          // Right before recovery snapshot is taken, delete narrationTts to simulate it not existing
          await rm(paths.narrationTts, { force: true });
          return { value: request.schema.parse(makeBadQa(5)), usage: { inputTokens: 10, outputTokens: 5 } };
        }
        throw new Error("QA validation crashed on attempt 2");
      }
      return originalGenerateStructured(request);
    };

    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", new MockTTS()]])));

    await expect(
      pipeline.run({
        root,
        story,
        chapter: 1,
        inputPath: paths.original,
        stopAfter: "qa",
      })
    ).rejects.toThrow("QA validation crashed on attempt 2");

    // The newly created narrationTts file must be deleted because it was absent before recovery
    expect(await readTextIfExists(paths.narrationTts)).toBeUndefined();
    // Prior files are restored
    expect(await readFile(paths.english, "utf8")).toBe("Initial translation 1");
    expect(await readFile(paths.narration, "utf8")).toBe("Initial narration 1");
  });

  it("F. Rollback failure handling: aggregates rollback failure and surfaces AggregateError while still restoring remaining files", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-recovery-test-f-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "QA Story", slug: "qa-story" });
    const paths = storyPaths(root, story.slug, 1);

    await atomicWrite(paths.original, "第一章 初始内容");

    let textCallCount = 0;
    const llm = new MockLLM("gemini", [
      "Initial translation 1",
      "Initial narration 1",
    ], makeBadQa(5));

    const originalGenerateText = llm.generateText.bind(llm);
    llm.generateText = async (request) => {
      textCallCount++;
      if (textCallCount === 3) {
        // Before recovery translation throws, make paths.english a directory to make atomicWrite fail during rollback
        await rm(paths.english, { force: true });
        await mkdir(paths.english);
        throw new Error("Translation failed in recovery");
      }
      return originalGenerateText(request);
    };

    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", new MockTTS()]])));

    let thrownError: unknown;
    try {
      await pipeline.run({
        root,
        story,
        chapter: 1,
        inputPath: paths.original,
        stopAfter: "qa",
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(AggregateError);
    const agg = thrownError as AggregateError;
    expect(agg.message).toContain("QA auto-recovery failed and artifact/metadata rollback encountered");
    expect(agg.errors[0]?.message).toContain("Translation failed in recovery");

    // The other files (narration, narrationTts, qa) should still have been restored despite english failing!
    expect(await readFile(paths.narration, "utf8")).toBe("Initial narration 1");
    expect(await readFile(paths.narrationTts, "utf8")).toBe("Initial narration 1");
    expect(JSON.parse(await readFile(paths.qa, "utf8")).status).toBe("warn");
  });
});

describe("QA recovery stage scope", () => {
  const makeMockAudio = () => ({
    master: vi.fn(async (_inputs: string[], output: string) => {
      await atomicWrite(output, "mastered-mp3");
      return { durationSeconds: 10, codec: "mp3", container: "mp3" };
    }),
  });

  const makeMockCensor = () => ({
    version: "test-censor",
    synthesize: vi.fn(async (provider: MockTTS, request: Parameters<MockTTS["synthesize"]>[0]) => provider.synthesize(request)),
  });

  it("A & B. Full pipeline recovery does not synthesize TTS during recursive recovery, then outer full pipeline continues once", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-scope-a-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "QA Story", slug: "qa-story" });
    const paths = storyPaths(root, story.slug, 1);

    await atomicWrite(paths.original, "第一章 初始内容");

    let qaCallCount = 0;
    let qa2Completed = false;

    const llm = new MockLLM("gemini", [
      "Initial translation 1",
      "Initial narration 1",
      "Recovered translation 2",
      "Recovered narration 2",
    ]);

    const originalGenerateStructured = llm.generateStructured.bind(llm);
    llm.generateStructured = async (request) => {
      if (request.schemaName === "chapter_qa") {
        qaCallCount++;
        if (qaCallCount === 1) {
          return { value: request.schema.parse(makeBadQa(5)), usage: { inputTokens: 10, outputTokens: 5 } };
        }
        qa2Completed = true;
        return { value: request.schema.parse(makeGoodQa()), usage: { inputTokens: 10, outputTokens: 5 } };
      }
      return originalGenerateStructured(request);
    };

    const mockTts = new MockTTS();
    const mockAudio = makeMockAudio();
    const mockCensor = makeMockCensor();

    // Track when TTS and Audio are called relative to QA #2
    let ttsCalledBeforeQa2 = false;
    let audioCalledBeforeQa2 = false;
    const originalSynthesize = mockTts.synthesize.bind(mockTts);
    mockTts.synthesize = async (req) => {
      if (!qa2Completed) ttsCalledBeforeQa2 = true;
      return originalSynthesize(req);
    };

    const originalMaster = mockAudio.master.bind(mockAudio);
    mockAudio.master = vi.fn(async (inputs, output) => {
      if (!qa2Completed) audioCalledBeforeQa2 = true;
      return originalMaster(inputs, output);
    });

    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", mockTts]])), mockAudio as any, mockCensor as any);

    const onStageEvent = vi.fn();

    // Run full pipeline (no executionStages, no stopAfter)
    const result = await pipeline.run({
      root,
      story,
      chapter: 1,
      inputPath: paths.original,
      onStageEvent,
    });

    // Requirement 12-A: TTS and Mastering were NOT called during recursive recovery before QA #2
    expect(ttsCalledBeforeQa2).toBe(false);
    expect(audioCalledBeforeQa2).toBe(false);

    // Requirement 12-B: QA #2 passed, outer full pipeline continued
    expect(qaCallCount).toBe(2);
    expect(mockTts.calls).toBe(1);
    expect(mockAudio.master).toHaveBeenCalledTimes(1);
    expect(result.stages.storyBible.status).toBe("complete");
    expect(result.stages.tts.status).toBe("complete");
    expect(result.stages.audioMastering.status).toBe("complete");

    // Output reflects the recovered narration
    expect(await readFile(paths.english, "utf8")).toBe("Recovered translation 2");
    expect(await readFile(paths.narration, "utf8")).toBe("Recovered narration 2");
  });

  it("C. QA #2 fails: no Story Bible, TTS, or audio runs, and QualityGateError remains authoritative", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-scope-c-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "QA Story", slug: "qa-story" });
    const paths = storyPaths(root, story.slug, 1);

    await atomicWrite(paths.original, "第一章 初始内容");

    let qaCallCount = 0;
    const llm = new MockLLM("gemini", [
      "Initial translation 1",
      "Initial narration 1",
      "Recovered translation 2",
      "Recovered narration 2",
    ]);

    const persistentFailQa: QaResult = {
      status: "fail",
      score: 0.2,
      issues: makeIssues(6, "fail"),
      checks: {
        completeness: "fail",
        names: "pass",
        numbers: "pass",
        terminology: "fail",
        dialogue: "pass",
        storyConsistency: "pass",
        narrationFidelity: "pass",
      },
    };

    const originalGenerateStructured = llm.generateStructured.bind(llm);
    llm.generateStructured = async (request) => {
      if (request.schemaName === "chapter_qa") {
        qaCallCount++;
        if (qaCallCount === 1) {
          return { value: request.schema.parse(makeBadQa(5)), usage: { inputTokens: 10, outputTokens: 5 } };
        }
        return { value: request.schema.parse(persistentFailQa), usage: { inputTokens: 10, outputTokens: 5 } };
      }
      return originalGenerateStructured(request);
    };

    const mockTts = new MockTTS();
    const mockAudio = makeMockAudio();
    const mockCensor = makeMockCensor();
    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", mockTts]])), mockAudio as any, mockCensor as any);

    // Run full pipeline
    await expect(
      pipeline.run({
        root,
        story,
        chapter: 1,
        inputPath: paths.original,
      })
    ).rejects.toThrow(QualityGateError);

    expect(qaCallCount).toBe(2);
    expect(mockTts.calls).toBe(0);
    expect(mockAudio.master).not.toHaveBeenCalled();

    const chapterMeta: Chapter = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    expect(chapterMeta.stages.storyBible.status).toBe("pending");
    expect(chapterMeta.stages.tts.status).toBe("pending");
    expect(chapterMeta.stages.audioMastering.status).toBe("pending");
  });

  it("D. Selected-stage QA run: executes only translation, narration, and QA, without downstream execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-scope-d-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "QA Story", slug: "qa-story" });
    const paths = storyPaths(root, story.slug, 1);

    await atomicWrite(paths.original, "第一章 初始内容");

    let qaCallCount = 0;
    const llm = new MockLLM("gemini", [
      "Initial translation 1",
      "Initial narration 1",
      "Recovered translation 2",
      "Recovered narration 2",
    ]);

    const originalGenerateStructured = llm.generateStructured.bind(llm);
    llm.generateStructured = async (request) => {
      if (request.schemaName === "chapter_qa") {
        qaCallCount++;
        if (qaCallCount === 1) {
          return { value: request.schema.parse(makeBadQa(5)), usage: { inputTokens: 10, outputTokens: 5 } };
        }
        return { value: request.schema.parse(makeGoodQa()), usage: { inputTokens: 10, outputTokens: 5 } };
      }
      return originalGenerateStructured(request);
    };

    const mockTts = new MockTTS();
    const mockAudio = makeMockAudio();
    const mockCensor = makeMockCensor();
    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", mockTts]])), mockAudio as any, mockCensor as any);

    // Seed initial chapter through narration so QA has prerequisites
    await pipeline.run({
      root,
      story,
      chapter: 1,
      inputPath: paths.original,
      stopAfter: "narration",
    });

    const result = await pipeline.run({
      root,
      story,
      chapter: 1,
      inputPath: paths.original,
      executionStages: ["qa"],
    });

    expect(qaCallCount).toBe(2);
    expect(result.stages.qa.status).toBe("complete");
    expect(result.quality?.status).toBe("pass");
    expect(mockTts.calls).toBe(0);
    expect(mockAudio.master).not.toHaveBeenCalled();
    expect(result.stages.storyBible.status).toBe("pending");
    expect(result.stages.tts.status).toBe("pending");
    expect(result.stages.audioMastering.status).toBe("pending");
  });

  it("E. One recovery only: does not trigger a second recovery attempt if QA #2 still has >4 issues", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-scope-e-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "QA Story", slug: "qa-story" });
    const paths = storyPaths(root, story.slug, 1);

    await atomicWrite(paths.original, "第一章 初始内容");

    let qaCallCount = 0;
    const llm = new MockLLM("gemini", [
      "Initial translation 1",
      "Initial narration 1",
      "Recovered translation 2",
      "Recovered narration 2",
    ]);

    const originalGenerateStructured = llm.generateStructured.bind(llm);
    llm.generateStructured = async (request) => {
      if (request.schemaName === "chapter_qa") {
        qaCallCount++;
        // Both QA 1 and QA 2 return 5 warn issues
        return { value: request.schema.parse(makeBadQa(5)), usage: { inputTokens: 10, outputTokens: 5 } };
      }
      return originalGenerateStructured(request);
    };

    const mockTts = new MockTTS();
    const mockAudio = makeMockAudio();
    const mockCensor = makeMockCensor();
    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", mockTts]])), mockAudio as any, mockCensor as any);

    const result = await pipeline.run({
      root,
      story,
      chapter: 1,
      inputPath: paths.original,
      stopAfter: "qa",
    });

    // Exactly 2 QA calls: initial run + one recovery attempt
    expect(qaCallCount).toBe(2);
    expect(result.stages.qa.status).toBe("complete");
    expect(result.quality?.status).toBe("warn");
  });
});
