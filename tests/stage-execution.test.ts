import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChapterPipeline } from "../src/pipeline/chapter-pipeline.js";
import { CopyingAudioProcessor } from "../src/audio/chapter-audio.js";
import { LLMRouter } from "../src/llm/router.js";
import { sceneImagePath, storyPaths } from "../src/storage/paths.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { executeStagePlan, pipelineStopAfterForStages, planStageExecution, planStageExecutionBatch, requiredStageNodes, stageExecutionInputSchema } from "../src/studio/stage-execution.js";
import { inspectStageArtifact } from "../src/studio/artifact-state.js";
import { fileFingerprint } from "../src/utils/file-fingerprint.js";
import { MockLLM, MockTTS, testStory } from "./helpers.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "stage-plan-")); const input = join(root, "chapter.txt"); const story = testStory();
  await writeFile(input, "第一章\n\n测试正文", "utf8"); await mkdir(join(root, "stories", story.slug), { recursive: true }); await atomicWriteJson(join(root, "stories", story.slug, "story.json"), story);
  const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", new MockLLM("gemini", ["Translation"])], ["openai", new MockLLM("openai", ["Narration"])]])), new MockTTS(), new CopyingAudioProcessor());
  await pipeline.run({ root, story, chapter: 1, inputPath: input });
  return { root, story, paths: storyPaths(root, story.slug, 1) };
}

async function addSceneArtwork(ctx: Awaited<ReturnType<typeof setup>>) {
  const image = sceneImagePath(ctx.root, ctx.story.slug, 1, "scene-001");
  await mkdir(ctx.paths.scenesDirectory, { recursive: true }); await writeFile(image, "image test artwork");
  const imageFingerprint = await fileFingerprint(image);
  const chapter = JSON.parse(await readFile(ctx.paths.chapterMeta, "utf8"));
  const now = new Date().toISOString();
  await atomicWriteJson(ctx.paths.scenesManifest, { version: 1, chapter: 1, durationSeconds: chapter.audio.durationSeconds, planningFingerprint: "test", planner: { provider: "mock", model: "mock", promptVersion: "test" }, createdAt: now, updatedAt: now, scenes: [{ id: "scene-001", summary: "A lantern lights up", startSeconds: 0, endSeconds: chapter.audio.durationSeconds, visualPrompt: "A lantern", artwork: { status: "complete", review: "approved", imageFingerprint } }] });
}

describe("manual stage execution planner", () => {
  const chapterPlan = (ctx: Awaited<ReturnType<typeof setup>>, stage: Parameters<typeof planStageExecution>[0]["selectedStages"][number]) =>
    planStageExecution({ root: ctx.root, story: ctx.story.slug, chapter: 1, selectedStages: [stage], executionPolicy: "chapter-stage", storyConfig: ctx.story });

  it("forces translation alone, retains stale downstream files, and regenerates narration without translation", async () => {
    const ctx = await setup(); const input = join(ctx.root, "chapter.txt");
    const translation = await chapterPlan(ctx, "translation");
    expect(translation.runStages).toEqual(["translation"]);
    const translationProvider = new MockLLM("gemini", ["New translation"]);
    const narrationProvider = new MockLLM("openai", ["New reader narration"]);
    const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", translationProvider], ["openai", narrationProvider]])), new MockTTS(), new CopyingAudioProcessor());
    const runtime = { pipeline, alignment: { config: {} as any }, video: {} as any };
    await executeStagePlan({ root: ctx.root, story: ctx.story, chapter: 1, inputPath: input, plan: translation, runtime });
    expect(await readFile(ctx.paths.english, "utf8")).toContain("New translation");
    expect(await inspectStageArtifact(ctx.root, ctx.story.slug, 1, "narration")).toMatchObject({ availability: "available", freshness: "stale" });
    expect(await readFile(ctx.paths.narration, "utf8")).toBeTruthy();
    const narration = await chapterPlan(ctx, "narration");
    expect(narration.runStages).toEqual(["narration"]);
    await executeStagePlan({ root: ctx.root, story: ctx.story, chapter: 1, inputPath: input, plan: narration, runtime });
    expect(await readFile(ctx.paths.narration, "utf8")).toContain("New reader narration");
    expect(await readFile(ctx.paths.narrationTts, "utf8")).toContain("New reader narration");
    expect(translationProvider.calls).toHaveLength(1);
    await rm(ctx.root, { recursive: true, force: true });
  });
  it("keeps both narration artifacts when regeneration fails before replacement", async () => {
    const ctx = await setup(); const previous = await Promise.all([readFile(ctx.paths.narration, "utf8"), readFile(ctx.paths.narrationTts, "utf8")]);
    const failingNarrator = new MockLLM("openai");
    failingNarrator.generateText = async () => { throw new Error("Provider unavailable"); };
    const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", new MockLLM("gemini")], ["openai", failingNarrator]])), new MockTTS(), new CopyingAudioProcessor());
    await expect(executeStagePlan({ root: ctx.root, story: ctx.story, chapter: 1, inputPath: join(ctx.root, "chapter.txt"), plan: await chapterPlan(ctx, "narration"), runtime: { pipeline, alignment: { config: {} as any }, video: {} as any } })).rejects.toThrow("Provider unavailable");
    expect(await Promise.all([readFile(ctx.paths.narration, "utf8"), readFile(ctx.paths.narrationTts, "utf8")])).toEqual(previous);
    await rm(ctx.root, { recursive: true, force: true });
  });
  it("preserves the previous translation when the provider returns empty output", async () => {
    const ctx = await setup(); const previous = await readFile(ctx.paths.english, "utf8");
    const pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", new MockLLM("gemini", [""])], ["openai", new MockLLM("openai")]])), new MockTTS(), new CopyingAudioProcessor());
    await expect(executeStagePlan({ root: ctx.root, story: ctx.story, chapter: 1, inputPath: join(ctx.root, "chapter.txt"), plan: await chapterPlan(ctx, "translation"), runtime: { pipeline, alignment: { config: {} as any }, video: {} as any } })).rejects.toThrow("empty chapter");
    expect(await readFile(ctx.paths.english, "utf8")).toBe(previous);
    await rm(ctx.root, { recursive: true, force: true });
  });

  it("uses stale upstream artifacts and expands only the target's internal operations", async () => {
    const ctx = await setup(); const metadata = JSON.parse(await readFile(ctx.paths.chapterMeta, "utf8"));
    for (const stage of ["translation", "narration", "qa", "storyBible", "audioMastering"]) metadata.stages[stage].staleReason = "Earlier settings changed";
    await atomicWriteJson(ctx.paths.chapterMeta, metadata);
    expect((await chapterPlan(ctx, "storyBible")).runStages).toEqual(["storyBible", "context"]);
    expect((await chapterPlan(ctx, "audioMastering")).runStages).toEqual(["tts", "audioMastering"]);
    expect((await chapterPlan(ctx, "subtitles")).runStages).toEqual(["alignment", "subtitles"]);
    expect((await chapterPlan(ctx, "scenePlanning")).runStages).toEqual(["scenePlanning"]);
    expect((await inspectStageArtifact(ctx.root, ctx.story.slug, 1, "translation")).availability).toBe("available");
    await rm(ctx.root, { recursive: true, force: true });
  });

  it.each([["warn", false], ["warn", true], ["fail", false], ["fail", true]] as const)("blocks downstream stages when QA is %s (stale: %s)", async (status, stale) => {
    const ctx = await setup(); const qa = JSON.parse(await readFile(ctx.paths.qa, "utf8")); qa.status = status; await atomicWriteJson(ctx.paths.qa, qa);
    if (stale) { const metadata = JSON.parse(await readFile(ctx.paths.chapterMeta, "utf8")); metadata.stages.qa.staleReason = "Old QA"; await atomicWriteJson(ctx.paths.chapterMeta, metadata); }
    for (const stage of ["storyBible", "audioMastering", "subtitles", "scenePlanning", "artwork", "video"] as const) {
      const plan = await chapterPlan(ctx, stage);
      expect(plan.blockedStages).toContain(stage);
      expect(plan.entries.find((entry) => entry.stage === "qa")?.reason).toContain(`QA status is ${status}`);
    }
    await rm(ctx.root, { recursive: true, force: true });
  });

  it("blocks missing or invalid prerequisites without scheduling them", async () => {
    const ctx = await setup(); await rm(ctx.paths.english);
    const narration = await chapterPlan(ctx, "narration");
    expect(narration.runStages).toEqual([]); expect(narration.entries.find((entry) => entry.stage === "translation")?.availability).toBe("missing");
    const audioWithoutTranslation = await chapterPlan(ctx, "audioMastering");
    expect(audioWithoutTranslation.runStages).toEqual([]); expect(audioWithoutTranslation.entries.find((entry) => entry.stage === "translation")?.availability).toBe("missing");
    await writeFile(ctx.paths.english, "corrupt", "utf8"); await writeFile(ctx.paths.qa, "{bad", "utf8");
    const audio = await chapterPlan(ctx, "audioMastering");
    expect(audio.runStages).toEqual([]); expect(audio.entries.find((entry) => entry.stage === "qa")?.availability).toBe("invalid");
    await rm(ctx.paths.qa);
    expect((await chapterPlan(ctx, "audioMastering")).entries.find((entry) => entry.stage === "qa")?.availability).toBe("missing");
    await rm(ctx.root, { recursive: true, force: true });
  });

  it("keeps subtitles optional for Chapter Video in burn and none modes", async () => {
    const ctx = await setup();
    const withSubtitles = await chapterPlan(ctx, "video");
    expect(withSubtitles.artifacts.map((item) => item.stage)).not.toContain("subtitles");
    const withoutSubtitles = await planStageExecution({ root: ctx.root, story: ctx.story.slug, chapter: 1, selectedStages: ["video"], executionPolicy: "chapter-stage", storyConfig: { ...ctx.story, video: { ...ctx.story.video, subtitleMode: "none" } } });
    expect(withoutSubtitles.artifacts.map((item) => item.stage)).not.toContain("subtitles");
    await rm(ctx.root, { recursive: true, force: true });
  });
  it("requires mastered Audio for Scenes and downstream Artwork before execution", async () => {
    const ctx = await setup(); await addSceneArtwork(ctx); await rm(ctx.paths.audio);
    for (const stage of ["scenePlanning", "artwork", "video"] as const) {
      const plan = await chapterPlan(ctx, stage);
      expect(plan.runStages).toEqual([]);
      expect(plan.entries.find((entry) => entry.stage === "audioMastering")?.action).toBe("blocked");
    }
    expect(requiredStageNodes("scenePlanning")).toContain("audioMastering");
    await rm(ctx.root, { recursive: true, force: true });
  });
  it.each(["missing", "invalid"] as const)("blocks Subtitles and Scenes when Audio is %s", async (availability) => {
    const ctx = await setup();
    if (availability === "missing") await rm(ctx.paths.audio);
    else await writeFile(ctx.paths.audio, "corrupt audio");
    for (const stage of ["subtitles", "scenePlanning"] as const) {
      const plan = await chapterPlan(ctx, stage);
      expect(plan.runStages).toEqual([]);
      expect(plan.entries.find((entry) => entry.stage === "audioMastering")).toMatchObject({ action: "blocked", availability });
    }
    await rm(ctx.root, { recursive: true, force: true });
  });
  it("runs Scenes, Artwork, and Video with stale Audio and no Subtitles", async () => {
    const ctx = await setup(); await addSceneArtwork(ctx); await rm(ctx.paths.subtitlesDocument, { force: true }); await rm(ctx.paths.subtitlesSrt, { force: true });
    const metadata = JSON.parse(await readFile(ctx.paths.chapterMeta, "utf8"));
    for (const stage of ["audioMastering", "narration", "storyBible", "scenePlanning", "artwork", "qa"]) metadata.stages[stage].staleReason = "Older input";
    await atomicWriteJson(ctx.paths.chapterMeta, metadata);
    for (const [stage, expected] of [["scenePlanning", ["scenePlanning"]], ["artwork", ["artwork"]], ["video", ["video"]]] as const) {
      const plan = await chapterPlan(ctx, stage);
      expect(plan.runStages).toEqual(expected);
      expect(plan.artifacts.map((item) => item.stage)).not.toContain("subtitles");
      expect(plan.reusedStages).toContainEqual({ stage: "audioMastering", state: "stale" });
    }
    const video = await chapterPlan(ctx, "video");
    let renderedSubtitles: string | undefined; let renderedMode: string | undefined;
    await executeStagePlan({ root: ctx.root, story: ctx.story, chapter: 1, inputPath: join(ctx.root, "chapter.txt"), plan: video, runtime: { pipeline: { run: async () => undefined }, alignment: { config: {} as any }, video: { version: "test", render: async (input, output, settings) => { renderedSubtitles = input.subtitles; renderedMode = settings.subtitleMode; await writeFile(output, "video test"); return { durationSeconds: 1, videoCodec: "h264", audioCodec: "aac", width: settings.width, height: settings.height, container: "mp4" }; } } } });
    expect(renderedSubtitles).toBeUndefined(); expect(renderedMode).toBe("none");
    await rm(ctx.root, { recursive: true, force: true });
  });
  it("blocks missing scenes for Artwork and Video without adding scene generation", async () => {
    const ctx = await setup();
    for (const stage of ["artwork", "video"] as const) {
      const plan = await chapterPlan(ctx, stage);
      expect(plan.runStages).toEqual([]);
      expect(plan.entries.find((entry) => entry.stage === "scenePlanning")?.action).toBe("blocked");
    }
    await rm(ctx.root, { recursive: true, force: true });
  });
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
