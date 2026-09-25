import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
import { TRANSLATION_FINGERPRINT_VERSION, TRANSLATION_PROMPT_VERSION } from "../src/translation/prompts.js";
import { CensorAudioService } from "../src/tts/censor-audio.js";
import { TTSRequest } from "../src/tts/types.js";
import { markStagesCurrent } from "../src/studio/stage-acceptance.js";
import { qaResultSchema, qaStateSchema } from "../src/domain/qa.js";
import { StructuredLLMRequest } from "../src/llm/types.js";

class CountingAudioProcessor extends CopyingAudioProcessor { calls = 0; override async master(inputs: string[], output: string) { this.calls++; return super.master(inputs, output); } }

const qaWithIssues = (count: number, fail = false, allFail = false) => ({
  status: fail ? "fail" : "warn", score: fail ? 0.2 : 0.7,
  issues: Array.from({ length: count }, (_, index) => ({ category: "numbers", severity: fail && (allFail || index >= 3) ? "fail" : "warn", message: `Fresh issue ${index}`, evidence: `Evidence ${index}` })),
  checks: { completeness: "pass", names: "pass", numbers: fail ? "fail" : "warn", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" },
});

describe("pipeline QA fresh execution and recovery", () => {
  async function fixture(results: ReturnType<typeof qaWithIssues>[]) {
    const root = await mkdtemp(join(tmpdir(), "story-studio-qa-recovery-"));
    const input = join(root, "chapter.txt");
    await writeFile(input, "第一章\n\n林遥打开了门。", "utf8");
    const gemini = new MockLLM("gemini", ["Translation one", "Translation two"]);
    const openai = new SequenceQaLLM(results);
    const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), new MockTTS(), new CopyingAudioProcessor());
    const story = testStory();
    const paths = storyPaths(root, story.slug, 1);
    await pipeline.run({ root, story, chapter: 1, inputPath: input, stopAfter: "narration" });
    return { root, input, gemini, openai, pipeline, story, paths };
  }

  it("runs QA once at four issues and replaces old chapter review state", async () => {
    const ctx = await fixture([qaWithIssues(4)]);
    const contextBefore = await readFile(ctx.paths.storyContext, "utf8");
    const preserved = [ctx.paths.audioRaw, ctx.paths.audio, ctx.paths.subtitlesSrt, ctx.paths.scenesManifest, ctx.paths.video];
    for (const path of preserved) await writeFile(path, "keep", "utf8");
    const oldQa = { ...qaWithIssues(1), findings: [{ id: "qaf_aaaaaaaaaaaaaaaaaaaaaaaa", category: "numbers", severity: "warn", message: "Old", evidence: "Old", status: "dismissed", fingerprint: "old" }] };
    await atomicWriteJson(ctx.paths.qa, oldQa);
    const beforeTranslation = await readFile(ctx.paths.english, "utf8");
    const beforeNarration = await readFile(ctx.paths.narration, "utf8");
    const result = await ctx.pipeline.run({ root: ctx.root, story: ctx.story, chapter: 1, inputPath: ctx.input, executionStages: ["qa"], stopAfter: "qa" });
    const qa = qaStateSchema.parse(JSON.parse(await readFile(ctx.paths.qa, "utf8")));
    expect(ctx.openai.qaCalls).toBe(1);
    expect(ctx.gemini.calls).toHaveLength(1);
    expect(await readFile(ctx.paths.english, "utf8")).toBe(beforeTranslation);
    expect(await readFile(ctx.paths.narration, "utf8")).toBe(beforeNarration);
    for (const path of preserved) expect(await readFile(path, "utf8")).toBe("keep");
    expect(await readFile(ctx.paths.storyContext, "utf8")).toBe(contextBefore);
    expect(qa.findings).toHaveLength(4);
    expect(qa.findings.some((finding) => finding.id === "qaf_aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(result.quality?.status).toBe("warn");
  });

  it("recovers once at five mixed issues and keeps the second QA result", async () => {
    const ctx = await fixture([qaWithIssues(5, true), qaWithIssues(2)]);
    await writeFile(ctx.paths.audioRaw, "keep", "utf8");
    const events: string[] = [];
    const result = await ctx.pipeline.run({ root: ctx.root, story: ctx.story, chapter: 1, inputPath: ctx.input, executionStages: ["qa"], stopAfter: "qa", onStageEvent: (event) => {
      if (event.status === "started" && !event.detail) events.push(event.stage);
    } });
    expect(events).toEqual(["qa", "translation", "narration", "qa"]);
    expect(ctx.gemini.calls).toHaveLength(2);
    expect(ctx.openai.calls.filter((call) => !call.structured)).toHaveLength(2);
    expect(ctx.openai.qaCalls).toBe(2);
    expect(await readFile(ctx.paths.english, "utf8")).toBe("Translation two");
    expect(await readFile(ctx.paths.narration, "utf8")).toBe("Narration two");
    expect((await readFile(ctx.paths.narrationTts, "utf8")).length).toBeGreaterThan(0);
    expect(await readFile(ctx.paths.audioRaw, "utf8")).toBe("keep");
    expect(qaStateSchema.parse(JSON.parse(await readFile(ctx.paths.qa, "utf8"))).findings).toHaveLength(2);
    expect(result.quality?.status).toBe("warn");
  });

  it("preserves the one-time recovery when five critical QA issues are reported", async () => {
    const ctx = await fixture([qaWithIssues(5, true, true), qaWithIssues(1)]);
    const events: string[] = [];
    await ctx.pipeline.run({ root: ctx.root, story: ctx.story, chapter: 1, inputPath: ctx.input, executionStages: ["qa"], stopAfter: "qa", onStageEvent: (event) => {
      if (event.status === "started" && !event.detail) events.push(event.stage);
    } });
    expect(events).toEqual(["qa", "translation", "narration", "qa"]);
    expect(ctx.gemini.calls).toHaveLength(2);
    expect(ctx.openai.qaCalls).toBe(2);
  });

  it("stops after the second QA and applies its failure gate", async () => {
    const ctx = await fixture([qaWithIssues(6, true), qaWithIssues(8, true)]);
    await expect(ctx.pipeline.run({ root: ctx.root, story: ctx.story, chapter: 1, inputPath: ctx.input, executionStages: ["qa"], stopAfter: "qa" })).rejects.toThrow("failed QA");
    expect(ctx.openai.qaCalls).toBe(2);
    expect(ctx.gemini.calls).toHaveLength(2);
    expect(qaStateSchema.parse(JSON.parse(await readFile(ctx.paths.qa, "utf8"))).findings).toHaveLength(8);
  });

  it("budgets recovery independently for each chapter", async () => {
    const ctx = await fixture([qaWithIssues(2), qaWithIssues(5), qaWithIssues(1)]);
    const secondInput = join(ctx.root, "chapter-two.txt");
    await writeFile(secondInput, "第二章\n\n林遥关上了门。", "utf8");
    await ctx.pipeline.run({ root: ctx.root, story: ctx.story, chapter: 2, inputPath: secondInput, stopAfter: "narration" });
    await ctx.pipeline.run({ root: ctx.root, story: ctx.story, chapter: 1, inputPath: ctx.input, executionStages: ["qa"], stopAfter: "qa" });
    await ctx.pipeline.run({ root: ctx.root, story: ctx.story, chapter: 2, inputPath: secondInput, executionStages: ["qa"], stopAfter: "qa" });
    expect(ctx.openai.qaCalls).toBe(3);
    expect(qaStateSchema.parse(JSON.parse(await readFile(ctx.paths.qa, "utf8"))).findings).toHaveLength(2);
    expect(qaStateSchema.parse(JSON.parse(await readFile(storyPaths(ctx.root, ctx.story.slug, 2).qa, "utf8"))).findings).toHaveLength(1);
  });
});

class SequenceQaLLM extends MockLLM {
  qaCalls = 0;
  constructor(private readonly results: ReturnType<typeof qaWithIssues>[]) { super("openai", ["Narration one", "Narration two", "Narration three", "Narration four"]); }
  override async generateStructured<T>(request: StructuredLLMRequest<T>) {
    if (request.schemaName !== "chapter_qa") return super.generateStructured(request);
    this.calls.push({ ...request, structured: true });
    const result = qaResultSchema.parse(this.results[Math.min(this.qaCalls++, this.results.length - 1)]);
    return { value: request.schema.parse(result), usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "story-studio-")); const input = join(root, "chapter.txt");
  await writeFile(input, "第一章\n\n林遥打开了门。", "utf8");
  const gemini = new MockLLM("gemini", ["English translation"]); const openai = new MockLLM("openai", ["Polished narration"]); const tts = new MockTTS();
  const audio = new CountingAudioProcessor(); const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), tts, audio);
  return { root, input, gemini, openai, tts, audio, pipeline, paths: storyPaths(root, "demo-story", 1) };
}

describe("chapter pipeline", () => {
  it("reuses a manual acceptance only for the configuration it accepted", async () => {
    const ctx = await setup(); const story = testStory();
    await mkdir(join(ctx.root, "stories", story.slug), { recursive: true }); await atomicWriteJson(join(ctx.root, "stories", story.slug, "story.json"), story);
    const chapter = await ctx.pipeline.run({ root: ctx.root, story, chapter: 1, inputPath: ctx.input, stopAfter: "translation" });
    chapter.stages.translation.status = "pending"; await atomicWriteJson(ctx.paths.chapterMeta, chapter);
    await markStagesCurrent(ctx.root, story.slug, { chapters: [1], stages: ["translation"] });
    const before = ctx.gemini.calls.length;
    await ctx.pipeline.run({ root: ctx.root, story, chapter: 1, inputPath: ctx.input, stopAfter: "translation" });
    expect(ctx.gemini.calls).toHaveLength(before);
    const changed = { ...story, pipeline: { ...story.pipeline, translation: { ...story.pipeline.translation, model: "changed-model" } } };
    await ctx.pipeline.run({ root: ctx.root, story: changed, chapter: 1, inputPath: ctx.input, stopAfter: "translation" });
    expect(ctx.gemini.calls).toHaveLength(before + 1);
  });
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

  it("stops after the selected stage and reuses valid earlier work on later runs", async () => {
    const ctx = await setup();
    const chapter = await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input, stopAfter: "translation" });
    expect(await readFile(ctx.paths.original, "utf8")).toContain("林遥");
    expect(await readFile(ctx.paths.english, "utf8")).toBe("English translation");
    expect(chapter.stages.translation.status).toBe("complete");
    expect(chapter.stages.narration.status).toBe("pending");
    expect(ctx.openai.calls).toHaveLength(0); expect(ctx.tts.calls).toBe(0);
    const translationCalls = ctx.gemini.calls.length;
    const resumed = await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input, stopAfter: "narration" });
    expect(resumed.stages.narration.status).toBe("complete");
    expect(resumed.stages.qa.status).toBe("pending");
    expect(ctx.gemini.calls.length).toBe(translationCalls);
    expect(ctx.tts.calls).toBe(0);
  });

  it("reuses an existing v2 translation fingerprint after the output-neutral prompt clarification", async () => {
    const ctx = await setup();
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input, stopAfter: "translation" });
    const metadata = JSON.parse(await readFile(ctx.paths.chapterMeta, "utf8"));
    expect(TRANSLATION_PROMPT_VERSION).toBe("3");
    expect(TRANSLATION_FINGERPRINT_VERSION).toBe("2");
    expect(metadata.stages.translation.promptVersion).toBe("3");
    metadata.stages.translation.promptVersion = "2";
    await writeFile(ctx.paths.chapterMeta, JSON.stringify(metadata), "utf8");
    const calls = ctx.gemini.calls.length;
    await ctx.pipeline.run({ root: ctx.root, story: testStory(), chapter: 1, inputPath: ctx.input, stopAfter: "translation" });
    expect(ctx.gemini.calls).toHaveLength(calls);
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

  it("reassembles censored audio and records timing metadata without rerunning text stages", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-studio-censor-")); const input = join(root, "chapter.txt"); await writeFile(input, "正文", "utf8");
    const gemini = new MockLLM("gemini", ["Translation"]); const openai = new MockLLM("openai", ["This shit is crazy."]); const tts = new MockTTS();
    const censorCalls: TTSRequest[] = [];
    const censor: CensorAudioService = {
      version: "test-censor-v1",
      synthesize: async (provider, request) => {
        censorCalls.push(request);
        if (!request.bleepStrongProfanity) return provider.synthesize(request);
        const audio = new Uint8Array([7, 7, 7]);
        return { audio, segments: [audio, audio, audio], assembled: true, providerRequests: 2, censor: { segments: 1, durationSeconds: 0.35 } };
      },
    };
    const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), tts, new CopyingAudioProcessor(), censor);
    const story = testStory(); const paths = storyPaths(root, story.slug, 1);
    const first = await pipeline.run({ root, story, chapter: 1, inputPath: input });
    const translationCalls = gemini.calls.length; const narrationCalls = openai.calls.filter((call) => !call.structured).length;
    const censoredStory = { ...story, narrationSettings: { ...story.narrationSettings, bleepStrongProfanity: true } };
    const second = await pipeline.run({ root, story: censoredStory, chapter: 1, inputPath: input });
    expect(second.stages.tts.fingerprint).not.toBe(first.stages.tts.fingerprint);
    expect(gemini.calls).toHaveLength(translationCalls); expect(openai.calls.filter((call) => !call.structured)).toHaveLength(narrationCalls);
    expect(censorCalls.at(-1)).toMatchObject({ text: "This shit is crazy.", bleepStrongProfanity: true });
    expect(second.stages.tts.usage).toMatchObject({ censoredSegments: 1, censorDurationSeconds: 0.35 });
    expect(Array.from(await readFile(paths.audioRaw))).toEqual([7, 7, 7]);
    expect(await readdir(paths.segments)).toHaveLength(3);
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

  it("never copies mastered audio into raw tts when raw tts is missing", async () => {
    const ctx = await setup();
    const story = testStory();
    await ctx.pipeline.run({ root: ctx.root, story, chapter: 1, inputPath: ctx.input });
    const { rm } = await import("node:fs/promises");
    await rm(ctx.paths.audioRaw);

    const ttsBefore = ctx.tts.calls;
    await ctx.pipeline.run({ root: ctx.root, story, chapter: 1, inputPath: ctx.input });
    // Raw TTS must be synthesized anew by TTS provider, never copied from mastered audio
    expect(ctx.tts.calls).toBe(ttsBefore + 1);
  });
});
