import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChapterPipeline } from "../src/pipeline/chapter-pipeline.js";
import { CopyingAudioProcessor } from "../src/audio/chapter-audio.js";
import { LLMRouter } from "../src/llm/router.js";
import { storyPaths } from "../src/storage/paths.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { planStageExecution, requiredStageNodes } from "../src/studio/stage-execution.js";
import { MockLLM, MockTTS, testStory } from "./helpers.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "stage-plan-")); const input = join(root, "chapter.txt"); const story = testStory();
  await writeFile(input, "第一章\n\n测试正文", "utf8"); await mkdir(join(root, "stories", story.slug), { recursive: true }); await atomicWriteJson(join(root, "stories", story.slug, "story.json"), story);
  const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", new MockLLM("gemini", ["Translation"])], ["openai", new MockLLM("openai", ["Narration"])]])), new MockTTS(), new CopyingAudioProcessor());
  await pipeline.run({ root, story, chapter: 1, inputPath: input });
  return { root, story, paths: storyPaths(root, story.slug, 1) };
}

describe("manual stage execution planner", () => {
  it("runs only selected continuity when all prerequisites exist, including stale artifacts", async () => {
    const ctx = await setup(); const metadata = JSON.parse(await readFile(ctx.paths.chapterMeta, "utf8")); metadata.stages.narration.staleReason = "Changed settings"; await atomicWriteJson(ctx.paths.chapterMeta, metadata);
    const plan = await planStageExecution({ root: ctx.root, story: ctx.story.slug, chapter: 1, selectedStage: "continuity" });
    expect(plan.runStages).toEqual(["continuity"]); expect(plan.reusedStages).toContainEqual({ stage: "narration", state: "stale" });
    await rm(ctx.root, { recursive: true, force: true });
  });
  it("rebuilds the coherent chain when a required artifact is missing or invalid", async () => {
    const ctx = await setup(); await rm(ctx.paths.qa); await writeFile(ctx.paths.storyContext, "not json", "utf8");
    const plan = await planStageExecution({ root: ctx.root, story: ctx.story.slug, chapter: 1, selectedStage: "continuity" });
    expect(plan.prerequisitesComplete).toBe(false); expect(plan.missingStages).toEqual(expect.arrayContaining(["qa", "context"])); expect(plan.runStages).toEqual(requiredStageNodes("continuity"));
    await rm(ctx.root, { recursive: true, force: true });
  });
  it("through follows graph dependencies and excludes downstream branches", async () => {
    const ctx = await setup(); const plan = await planStageExecution({ root: ctx.root, story: ctx.story.slug, chapter: 1, selectedStage: "continuity", mode: "through" });
    expect(plan.runStages).toEqual(requiredStageNodes("continuity")); expect(plan.runStages).not.toContain("tts"); expect(plan.runStages).not.toContain("video");
    expect(requiredStageNodes("subtitles")).toEqual(expect.arrayContaining(["tts", "audioMastering", "alignment", "subtitles"])); expect(requiredStageNodes("video")).toEqual(expect.arrayContaining(["scenePlanning", "artwork", "video"]));
    await rm(ctx.root, { recursive: true, force: true });
  });
});
