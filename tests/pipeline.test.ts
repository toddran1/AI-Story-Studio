import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChapterPipeline } from "../src/pipeline/chapter-pipeline.js";
import { LLMRouter } from "../src/llm/router.js";
import { storyPaths } from "../src/storage/paths.js";
import { MockLLM, MockTTS, testStory } from "./helpers.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "story-studio-")); const input = join(root, "chapter.txt");
  await writeFile(input, "第一章\n\n林遥打开了门。", "utf8");
  const gemini = new MockLLM("gemini", ["English translation"]); const openai = new MockLLM("openai", ["Polished narration"]); const tts = new MockTTS();
  const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), tts);
  return { root, input, gemini, openai, tts, pipeline, paths: storyPaths(root, "demo-story", 1) };
}

describe("chapter pipeline", () => {
  it("persists each representation and reuses valid outputs", async () => {
    const ctx = await setup();
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    expect(await readFile(ctx.paths.original, "utf8")).toContain("林遥");
    expect(await readFile(ctx.paths.english, "utf8")).toBe("English translation");
    expect(await readFile(ctx.paths.narration, "utf8")).toBe("Polished narration");
    expect(ctx.gemini.calls[0]?.input).toContain("林遥");
    expect(ctx.gemini.calls[0]?.input).toContain("ESTABLISHED STORY CONTEXT");
    expect(ctx.openai.calls[0]?.input).toContain("English translation");
    expect(ctx.openai.calls[0]?.input).not.toContain("林遥");
    const callCount = ctx.gemini.calls.length + ctx.openai.calls.length;
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    expect(ctx.gemini.calls.length + ctx.openai.calls.length).toBe(callCount);
    expect(ctx.tts.calls).toBe(1);
  });

  it("resumes at TTS after earlier stages completed", async () => {
    const ctx = await setup();
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    const meta = JSON.parse(await readFile(ctx.paths.chapterMeta, "utf8")); meta.stages.tts.status = "failed";
    await writeFile(ctx.paths.chapterMeta, JSON.stringify(meta), "utf8");
    const previousLLMCalls = ctx.gemini.calls.length + ctx.openai.calls.length;
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    expect(ctx.gemini.calls.length + ctx.openai.calls.length).toBe(previousLLMCalls);
    expect(ctx.tts.calls).toBe(2);
  });

  it("forces one stage and its downstream dependents", async () => {
    const ctx = await setup();
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input, force: "narration" });
    expect(ctx.openai.calls.length).toBe(2);
    expect(ctx.tts.calls).toBe(2);
  });
});
