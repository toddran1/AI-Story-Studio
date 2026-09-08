import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectChapterDirectory } from "../src/batch/chapter-discovery.js";
import { createBatchState } from "../src/batch/batch-state.js";
import { BatchRunner } from "../src/batch/batch-runner.js";
import { ShutdownController } from "../src/batch/shutdown.js";
import { ChapterPipeline } from "../src/pipeline/chapter-pipeline.js";
import { LLMRouter } from "../src/llm/router.js";
import { MockLLM, MockTTS, testStory } from "./helpers.js";

describe("no-cost multi-chapter integration", () => {
  it("uses ChapterPipeline sequentially and carries earlier summaries forward", async () => {
    const root = await mkdtemp(join(tmpdir(), "batch-integration-"));
    const directory = resolve("tests/fixtures/multi-chapter-story");
    const chapters = (await inspectChapterDirectory(directory)).chapters;
    const gemini = new MockLLM("gemini"); const openai = new MockLLM("openai");
    const processor = new ChapterPipeline(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), new MockTTS());
    const state = createBatchState({ root, story: "demo-story", inputDirectory: directory, chapters, allowGaps: false, continueOnError: false, delayMs: 0 });
    const result = await new BatchRunner(processor).run({ root, story: testStory(), chapters, state,
      retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 }, shutdown: new ShutdownController(), sleep: async () => undefined });
    const translations = gemini.calls.filter((call) => call.instructions.includes("literary translator"));
    expect(translations).toHaveLength(3);
    expect(translations[0]?.input).not.toContain("A star lamp awakens.");
    expect(translations[1]?.input).toContain("A star lamp awakens.");
    expect(result.status).toBe("completed");

    const paidCallCount = gemini.calls.length + openai.calls.length;
    const rerunState = createBatchState({ root, story: "demo-story", inputDirectory: directory, chapters, allowGaps: false, continueOnError: false, delayMs: 0 });
    await new BatchRunner(processor).run({ root, story: testStory(), chapters, state: rerunState,
      retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 }, shutdown: new ShutdownController(), sleep: async () => undefined });
    expect(gemini.calls.length + openai.calls.length).toBe(paidCallCount);
  });
});
