import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BatchRunner, ChapterProcessor } from "../src/batch/batch-runner.js";
import { createBatchState } from "../src/batch/batch-state.js";
import { ShutdownController } from "../src/batch/shutdown.js";
import { batchPaths } from "../src/storage/paths.js";
import { testStory } from "./helpers.js";

const discovered = [1, 2, 3, 4].map((chapter) => ({ chapter, filename: `${chapter}.txt`, path: `/input/${chapter}.txt` }));
const retry = { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
async function setup(processor: ChapterProcessor, chapters = discovered) {
  const root = await mkdtemp(join(tmpdir(), "batch-runner-"));
  const state = createBatchState({ root, story: "demo-story", inputDirectory: "/input", chapters, allowGaps: false, continueOnError: false, delayMs: 0 });
  return { root, state, runner: new BatchRunner(processor), shutdown: new ShutdownController() };
}

describe("batch runner", () => {
  it("processes ascending chapters strictly sequentially", async () => {
    const order: string[] = []; let active = 0;
    const ctx = await setup({ run: async ({ chapter }) => { expect(active).toBe(0); active++; order.push(`start-${chapter}`); await Promise.resolve(); order.push(`end-${chapter}`); active--; } });
    const result = await ctx.runner.run({ ...ctx, story: testStory(), chapters: discovered, retry, sleep: async () => undefined });
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3", "start-4", "end-4"]);
    expect(result.status).toBe("completed");
  });
  it("stops on failure and persists completed/failed/pending state", async () => {
    const calls: number[] = [];
    const ctx = await setup({ run: async ({ chapter }) => { calls.push(chapter); if (chapter === 3) throw new Error("permanent failure"); } });
    const result = await ctx.runner.run({ ...ctx, story: testStory(), chapters: discovered, retry, sleep: async () => undefined });
    expect(calls).toEqual([1, 2, 3]); expect(result.chapters["4"]?.status).toBe("pending");
    const persisted = JSON.parse(await readFile(batchPaths(ctx.root, "demo-story", result.id).manifest!, "utf8"));
    expect(persisted.chapters["2"].status).toBe("complete"); expect(persisted.chapters["3"].status).toBe("failed");
  });
  it("resume selection begins at the failed chapter", async () => {
    const calls: number[] = []; const resume = discovered.slice(2);
    const ctx = await setup({ run: async ({ chapter }) => { calls.push(chapter); } }, resume);
    await ctx.runner.run({ ...ctx, story: testStory(), chapters: resume, retry, sleep: async () => undefined });
    expect(calls).toEqual([3, 4]);
  });
  it("finishes current work after shutdown but does not start the next chapter", async () => {
    const calls: number[] = []; const shutdown = new ShutdownController();
    const ctx = await setup({ run: async ({ chapter }) => { calls.push(chapter); shutdown.request(); } });
    const result = await ctx.runner.run({ ...ctx, shutdown, story: testStory(), chapters: discovered, retry, sleep: async () => undefined });
    expect(calls).toEqual([1]); expect(result.status).toBe("paused"); expect(result.chapters["1"]?.status).toBe("complete");
  });
  it("applies force only on the first retry attempt", async () => {
    const forces: Array<string | undefined> = []; let attempts = 0;
    const processor: ChapterProcessor = { run: async ({ force }) => { forces.push(force); attempts++; if (attempts === 1) throw Object.assign(new Error("temporary unavailable"), { status: 503 }); } };
    const ctx = await setup(processor, discovered.slice(0, 1)); ctx.state.options.force = "narration";
    await ctx.runner.run({ ...ctx, story: testStory(), chapters: discovered.slice(0, 1),
      retry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 }, sleep: async () => undefined });
    expect(forces).toEqual(["narration", undefined]);
  });
  it("does not start another retry after shutdown is requested", async () => {
    const shutdown = new ShutdownController(); let calls = 0;
    const ctx = await setup({ run: async () => { calls++; shutdown.request(); throw Object.assign(new Error("temporary unavailable"), { status: 503 }); } }, discovered.slice(0, 1));
    const result = await ctx.runner.run({ ...ctx, shutdown, story: testStory(), chapters: discovered.slice(0, 1),
      retry: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 100 }, sleep: async () => undefined });
    expect(calls).toBe(1); expect(result.status).toBe("paused");
  });
  it("aggregates only usage from stages executed in this batch", async () => {
    const ctx = await setup({ run: async ({ onStageEvent }) => {
      onStageEvent?.({ stage: "translation", status: "completed", state: { status: "complete", provider: "openai", usage: { inputTokens: 12, outputTokens: 4 } } });
      onStageEvent?.({ stage: "narration", status: "reused", state: { status: "complete", provider: "openai", usage: { inputTokens: 99 } } });
    } }, discovered.slice(0, 1));
    const result = await ctx.runner.run({ ...ctx, story: testStory(), chapters: discovered.slice(0, 1), retry, sleep: async () => undefined });
    expect(result.usage.openai).toEqual({ inputTokens: 12, outputTokens: 4 });
  });
});
