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
    expect(ctx.openai.calls.length).toBe(4);
    expect(ctx.tts.calls).toBe(2);
  });

  it("uses translation passthrough when source and output languages match", async () => {
    const ctx = await setup(); const story = testStory({ translation: { provider: "openai", model: "translation-model" } });
    story.sourceLanguage = "en-US"; story.outputLanguage = "en-US";
    const result = await ctx.pipeline.run({ root: ctx.root, story, chapter: 1, inputPath: ctx.input });
    expect(await readFile(ctx.paths.english, "utf8")).toContain("林遥");
    expect(result.stages.translation.provider).toBe("passthrough");
    expect(ctx.openai.calls).toHaveLength(2);
  });

  it("reruns a stage and its dependents when a cached output is modified", async () => {
    const ctx = await setup();
    const first = await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    await writeFile(ctx.paths.english, "tampered translation", "utf8");
    const second = await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    expect(second.stages.qa.fingerprint).not.toBe(first.stages.qa.fingerprint);
    expect(ctx.gemini.calls.length).toBe(4);
    expect(ctx.openai.calls.length).toBe(4);
    expect(ctx.tts.calls).toBe(2);
  });

  it("invalidates QA when narration output changes", async () => {
    const ctx = await setup();
    const first = await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    const firstFingerprint = first.stages.qa.fingerprint;
    const previousQaCalls = ctx.openai.calls.filter((call) => call.structured).length;
    await writeFile(ctx.paths.narration, "manually changed narration", "utf8");
    const second = await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    expect(second.stages.qa.fingerprint).not.toBe(firstFingerprint);
    expect(ctx.openai.calls.filter((call) => call.structured)).toHaveLength(previousQaCalls + 1);
  });

  it("regenerates zero-byte cached audio without rerunning language stages", async () => {
    const ctx = await setup();
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    const priorLLMCalls = ctx.gemini.calls.length + ctx.openai.calls.length;
    await writeFile(ctx.paths.audio, new Uint8Array());
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    expect(ctx.gemini.calls.length + ctx.openai.calls.length).toBe(priorLLMCalls);
    expect(ctx.tts.calls).toBe(2);
  });

  it("rejects chapter metadata copied into the wrong chapter directory", async () => {
    const ctx = await setup();
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    const metadata = JSON.parse(await readFile(ctx.paths.chapterMeta, "utf8")); metadata.chapter = 2;
    await writeFile(ctx.paths.chapterMeta, JSON.stringify(metadata), "utf8");
    await expect(ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input })).rejects.toThrow(/metadata mismatch/);
  });

  it("forces QA without rerunning translation or narration", async () => {
    const ctx = await setup();
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    const translationCalls = ctx.gemini.calls.filter((call) => !call.structured).length;
    const narrationCalls = ctx.openai.calls.filter((call) => !call.structured).length;
    const qaCalls = ctx.openai.calls.filter((call) => call.structured).length;
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input, force: "qa" });
    expect(ctx.gemini.calls.filter((call) => !call.structured)).toHaveLength(translationCalls);
    expect(ctx.openai.calls.filter((call) => !call.structured)).toHaveLength(narrationCalls);
    expect(ctx.openai.calls.filter((call) => call.structured)).toHaveLength(qaCalls + 1);
    expect(ctx.tts.calls).toBe(2);
  });

  it("persists a failed QA result and stops before Story Bible and TTS", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-studio-fail-")); const input = join(root, "chapter.txt");
    await writeFile(input, "第一章\n\n数值是一百。", "utf8");
    const qa = { status: "fail", score: 0.3, issues: [{ category: "numbers", severity: "fail", message: "A value changed.", evidence: "Source says 100; output says 10." }], checks: {
      completeness: "pass", names: "pass", numbers: "fail", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass",
    } };
    const gemini = new MockLLM("gemini", ["The value is one hundred."]); const openai = new MockLLM("openai", ["The value was one hundred."], qa); const tts = new MockTTS();
    const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), tts);
    const paths = storyPaths(root, "demo-story", 1);
    await expect(pipeline.run({ root, story: testStory(), chapter: 1, inputPath: input })).rejects.toThrow("Chapter 1 failed QA");
    expect(JSON.parse(await readFile(paths.qa, "utf8")).status).toBe("fail");
    expect(gemini.calls.filter((call) => call.structured)).toHaveLength(0);
    expect(tts.calls).toBe(0);
  });

  it("records a QA warning and continues", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-studio-warn-")); const input = join(root, "chapter.txt"); await writeFile(input, "正文", "utf8");
    const qa = { status: "warn", score: 0.75, issues: [{ category: "terminology", severity: "warn", message: "Review this term.", evidence: "The canonical term differs." }], checks: {
      completeness: "pass", names: "pass", numbers: "pass", terminology: "warn", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass",
    } };
    const gemini = new MockLLM("gemini", ["Text"]); const openai = new MockLLM("openai", ["Narration"], qa); const tts = new MockTTS();
    const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), tts);
    const result = await pipeline.run({ root, story: testStory(), chapter: 1, inputPath: input });
    expect(result.quality?.status).toBe("warn"); expect(tts.calls).toBe(1);
  });
});
