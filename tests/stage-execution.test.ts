import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChapterPipeline } from "../src/pipeline/chapter-pipeline.js";
import { CopyingAudioProcessor } from "../src/audio/chapter-audio.js";
import { LLMRouter } from "../src/llm/router.js";
import { storyPaths } from "../src/storage/paths.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { pipelineStopAfterForStages, planStageExecution, planStageExecutionBatch, requiredStageNodes, stageExecutionInputSchema } from "../src/studio/stage-execution.js";
import { MockLLM, MockTTS, testStory } from "./helpers.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "stage-plan-")); const input = join(root, "chapter.txt"); const story = testStory();
  await writeFile(input, "第一章\n\n测试正文", "utf8"); await mkdir(join(root, "stories", story.slug), { recursive: true }); await atomicWriteJson(join(root, "stories", story.slug, "story.json"), story);
  const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", new MockLLM("gemini", ["Translation"])], ["openai", new MockLLM("openai", ["Narration"])]])), new MockTTS(), new CopyingAudioProcessor());
  await pipeline.run({ root, story, chapter: 1, inputPath: input });
  return { root, story, paths: storyPaths(root, story.slug, 1) };
}

describe("manual stage execution planner", () => {
  it("runs exactly selected stages and reuses stale prerequisites", async () => {
    const ctx = await setup(); const metadata = JSON.parse(await readFile(ctx.paths.chapterMeta, "utf8")); metadata.stages.storyBible.staleReason = "Changed settings"; await atomicWriteJson(ctx.paths.chapterMeta, metadata);
    const plan = await planStageExecution({ root: ctx.root, story: ctx.story.slug, chapter: 1, selectedStages: ["continuity"], force: true });
    expect(plan.runStages).toEqual(["continuity"]); expect(plan.reusedStages).toContainEqual({ stage: "context", state: "stale" });
    await rm(ctx.root, { recursive: true, force: true });
  });
  it("blocks selected-only work instead of silently generating prerequisites", async () => {
    const ctx = await setup(); await rm(ctx.paths.storyContext);
    const plan = await planStageExecution({ root: ctx.root, story: ctx.story.slug, chapter: 1, selectedStages: ["continuity"], mode: "selected", force: true });
    expect(plan.runStages).toEqual([]); expect(plan.blockedStages).toContain("continuity"); expect(plan.entries.find((item) => item.stage === "context")?.action).toBe("blocked");
    await rm(ctx.root, { recursive: true, force: true });
  });
  it("never adds Translation for selected-only Narration + QA when Translation is missing", async () => {
    const ctx = await setup(); await rm(ctx.paths.english);
    const plan = await planStageExecutionBatch({ root: ctx.root, story: ctx.story.slug, chapters: [1], selectedStages: ["narration", "qa"], mode: "selected", force: true });
    expect(plan.chapters[0]!.runStages).toEqual([]); expect(plan.chapters[0]!.blockedStages).toEqual(expect.arrayContaining(["narration", "qa"])); expect(plan.summary.providerOperations).toEqual({ llm: 0, tts: 0, images: 0 });
    await rm(ctx.root, { recursive: true, force: true });
  });
  it("adds missing Translation once for prerequisite-mode Narration + QA", async () => {
    const ctx = await setup(); await rm(ctx.paths.english);
    const plan = await planStageExecution({ root: ctx.root, story: ctx.story.slug, chapter: 1, selectedStages: ["narration", "qa"], mode: "prerequisites", force: true });
    expect(plan.runStages).toEqual(["translation", "narration", "qa"]); expect(plan.runStages.filter((stage) => stage === "translation")).toHaveLength(1);
    await rm(ctx.root, { recursive: true, force: true });
  });
  it("reuses a valid stale Translation prerequisite in selected-only mode", async () => {
    const ctx = await setup(); const metadata = JSON.parse(await readFile(ctx.paths.chapterMeta, "utf8")); metadata.stages.translation.staleReason = "Source settings changed"; await atomicWriteJson(ctx.paths.chapterMeta, metadata);
    const plan = await planStageExecution({ root: ctx.root, story: ctx.story.slug, chapter: 1, selectedStages: ["narration"], mode: "selected", force: true });
    expect(plan.runStages).toEqual(["narration"]); expect(plan.reusedStages).toContainEqual({ stage: "translation", state: "stale" });
    await rm(ctx.root, { recursive: true, force: true });
  });
  it("adds only missing prerequisites in prerequisite mode", async () => {
    const ctx = await setup(); await rm(ctx.paths.qa); await rm(ctx.paths.bibleUpdate); await writeFile(ctx.paths.storyContext, "not json", "utf8");
    const plan = await planStageExecution({ root: ctx.root, story: ctx.story.slug, chapter: 1, selectedStages: ["continuity"], mode: "prerequisites", force: true });
    expect(plan.runStages).toEqual(["qa", "storyBible", "context", "continuity"]); expect(plan.runStages).not.toContain("translation"); expect(plan.runStages).not.toContain("narration");
    expect(plan.entries.find((item) => item.stage === "qa")?.action).toBe("prerequisite-run");
    await rm(ctx.root, { recursive: true, force: true });
  });
  it("deduplicates a multi-stage graph and reports exact provider operations", async () => {
    const ctx = await setup();
    const plan = await planStageExecutionBatch({ root: ctx.root, story: ctx.story.slug, chapters: [1], selectedStages: ["artwork", "video"], mode: "prerequisites", force: true });
    expect(plan.chapters[0]!.runStages).toEqual(["alignment", "subtitles", "scenePlanning", "artwork", "video"]);
    expect(plan.summary.plannedByStage).toMatchObject({ alignment: 1, subtitles: 1, scenePlanning: 1, artwork: 1, video: 1 }); expect(plan.summary.providerOperations).toEqual({ llm: 1, tts: 0, images: 1 });
    expect(requiredStageNodes("video")).toEqual(expect.arrayContaining(["audioMastering", "subtitles", "scenePlanning", "artwork", "video"]));
    await rm(ctx.root, { recursive: true, force: true });
  });
  it("unions independent TTS and Artwork dependencies in topological order", async () => {
    const ctx = await setup();
    const plan = await planStageExecution({ root: ctx.root, story: ctx.story.slug, chapter: 1, selectedStages: ["artwork", "tts"], mode: "prerequisites", force: true });
    expect(plan.runStages).toEqual(["tts", "scenePlanning", "artwork"]); expect(new Set(plan.runStages).size).toBe(plan.runStages.length);
    await rm(ctx.root, { recursive: true, force: true });
  });
  it("produces a deterministic preview fingerprint", async () => {
    const ctx = await setup(); const options = { root: ctx.root, story: ctx.story.slug, chapters: [1], selectedStages: ["narration", "qa"] as const, mode: "selected" as const, force: true };
    expect((await planStageExecutionBatch(options)).fingerprint).toBe((await planStageExecutionBatch(options)).fingerprint); await rm(ctx.root, { recursive: true, force: true });
  });
  it("runs the core pipeline far enough to materialize a derived context prerequisite", () => {
    expect(pipelineStopAfterForStages(["context", "scenePlanning"])).toBe("storyBible"); expect(pipelineStopAfterForStages(["alignment"])).toBeUndefined();
  });
  it("normalizes legacy single-stage requests without weakening strict input validation", () => {
    expect(stageExecutionInputSchema.parse({ chapters: [3, 1, 3], stage: "qa", mode: "through" })).toMatchObject({ chapters: [1, 3], stages: ["qa"], mode: "prerequisites" }); expect(stageExecutionInputSchema.parse({ chapters: [1], selectedStage: "qa" })).toMatchObject({ stages: ["qa"] });
    expect(stageExecutionInputSchema.parse({ chapters: [1], stages: ["qa"] }).force).toBe(false);
    expect(() => stageExecutionInputSchema.parse({ chapters: [1], stages: ["qa"], surprise: true })).toThrow();
  });
});
