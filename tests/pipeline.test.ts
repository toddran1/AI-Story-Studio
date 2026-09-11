import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChapterPipeline } from "../src/pipeline/chapter-pipeline.js";
import { LLMRouter } from "../src/llm/router.js";
import { storyPaths } from "../src/storage/paths.js";
import { MockLLM, MockTTS, testStory } from "./helpers.js";
import { CopyingAudioProcessor } from "../src/audio/chapter-audio.js";
import { saveChapterTextEdit } from "../src/studio/workflow.js";
import { emptyStoryBible } from "../src/domain/story-bible.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";

class CountingAudioProcessor extends CopyingAudioProcessor { calls = 0; override async master(inputs: string[], output: string) { this.calls++; return super.master(inputs, output); } }

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "story-studio-")); const input = join(root, "chapter.txt");
  await writeFile(input, "第一章\n\n林遥打开了门。", "utf8");
  const gemini = new MockLLM("gemini", ["English translation"]); const openai = new MockLLM("openai", ["Polished narration"]); const tts = new MockTTS();
  const audio = new CountingAudioProcessor(); const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), tts, audio);
  return { root, input, gemini, openai, tts, audio, pipeline, paths: storyPaths(root, "demo-story", 1) };
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

  it("keeps S2 delivery cues in the TTS script but out of the reader-facing narration", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-studio-s2-cues-")); const input = join(root, "chapter.txt"); await writeFile(input, "正文", "utf8");
    const gemini = new MockLLM("gemini", ["Translation"]); const openai = new MockLLM("openai", ["[sad] The [System] spoke. [pause] Then she left."]); const tts = new MockTTS();
    const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), tts, new CopyingAudioProcessor()); const paths = storyPaths(root, "demo-story", 1);
    await pipeline.run({ root, story: testStory({ tts: { ...testStory().pipeline.tts, model: "s2.1-pro-free" } }), chapter: 1, inputPath: input });
    expect(await readFile(paths.narration, "utf8")).toBe("The [System] spoke. Then she left.");
    expect(await readFile(paths.narrationTts, "utf8")).toContain("[sad]");
    expect(tts.requests[0]?.text).toContain("[pause]");
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

  it("keeps a manual narration authoritative until that stage is explicitly forced", async () => {
    const ctx = await setup(); await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    await saveChapterTextEdit(ctx.root, "demo-story", 1, { field: "narration", text: "The producer's deliberate narration." });
    const narrationCalls = ctx.openai.calls.filter((call) => !call.structured).length;
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    expect(await readFile(ctx.paths.narration, "utf8")).toBe("The producer's deliberate narration."); expect(ctx.openai.calls.filter((call) => !call.structured)).toHaveLength(narrationCalls);
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input, force: "narration" });
    expect(ctx.openai.calls.filter((call) => !call.structured)).toHaveLength(narrationCalls + 1);
  });

  it("forces one stage and its downstream dependents", async () => {
    const ctx = await setup();
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input, force: "narration" });
    expect(ctx.openai.calls.length).toBe(4);
    expect(ctx.tts.calls).toBe(2);
  });

  it("marks downstream stages stale when an upstream regeneration fails", async () => {
    const ctx = await setup();
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    ctx.openai.generateText = async () => { throw new Error("narration unavailable"); };
    await expect(ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input, force: "narration" })).rejects.toThrow("narration unavailable");
    const metadata = JSON.parse(await readFile(ctx.paths.chapterMeta, "utf8"));
    expect(metadata.stages.narration.status).toBe("failed");
    expect(metadata.stages.qa.status).toBe("pending");
    expect(metadata.stages.storyBible.status).toBe("pending");
    expect(metadata.stages.tts.status).toBe("pending");
    expect(metadata.quality).toBeUndefined();
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

  it("remasters zero-byte final audio without rerunning TTS or language stages", async () => {
    const ctx = await setup();
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    const priorLLMCalls = ctx.gemini.calls.length + ctx.openai.calls.length;
    await writeFile(ctx.paths.audio, new Uint8Array());
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input });
    expect(ctx.gemini.calls.length + ctx.openai.calls.length).toBe(priorLLMCalls);
    expect(ctx.tts.calls).toBe(1);
  });

  it("remasters changed audio settings and --force audio without rerunning TTS", async () => {
    const ctx = await setup(); const story = testStory(); await ctx.pipeline.run({ root: ctx.root, story, chapter: 1, inputPath: ctx.input });
    const firstTtsCalls = ctx.tts.calls; const changed = { ...story, audio: { ...story.audio, loudnessTarget: -16 } };
    await ctx.pipeline.run({ root: ctx.root, story: changed, chapter: 1, inputPath: ctx.input });
    expect(ctx.audio.calls).toBe(2); expect(ctx.tts.calls).toBe(firstTtsCalls);
    await ctx.pipeline.run({ root: ctx.root, story: changed, chapter: 1, inputPath: ctx.input, force: "audio" });
    expect(ctx.audio.calls).toBe(3); expect(ctx.tts.calls).toBe(firstTtsCalls);
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
    const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), tts, new CopyingAudioProcessor());
    const paths = storyPaths(root, "demo-story", 1);
    const lastKnownGood = { ...emptyStoryBible(), version: 7 }; await atomicWriteJson(paths.bible, lastKnownGood);
    await expect(pipeline.run({ root, story: testStory(), chapter: 1, inputPath: input })).rejects.toThrow("Chapter 1 failed QA");
    expect(JSON.parse(await readFile(paths.qa, "utf8")).status).toBe("fail");
    expect(JSON.parse(await readFile(paths.bible, "utf8")).version).toBe(7);
    expect(gemini.calls.filter((call) => call.structured)).toHaveLength(0);
    expect(tts.calls).toBe(0);
  });

  it("records a QA warning and continues", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-studio-warn-")); const input = join(root, "chapter.txt"); await writeFile(input, "正文", "utf8");
    const qa = { status: "warn", score: 0.75, issues: [{ category: "terminology", severity: "warn", message: "Review this term.", evidence: "The canonical term differs." }], checks: {
      completeness: "pass", names: "pass", numbers: "pass", terminology: "warn", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass",
    } };
    const gemini = new MockLLM("gemini", ["Text"]); const openai = new MockLLM("openai", ["Narration"], qa); const tts = new MockTTS();
    const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), tts, new CopyingAudioProcessor());
    const result = await pipeline.run({ root, story: testStory(), chapter: 1, inputPath: input });
    expect(result.quality?.status).toBe("warn"); expect(tts.calls).toBe(1);
  });
});
