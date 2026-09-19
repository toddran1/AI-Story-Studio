import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alignStoredChapter } from "../src/alignment/chapter-alignment.js";
import { tokenizeNarration } from "../src/alignment/quality.js";
import { AlignmentConfig, AlignmentEngine } from "../src/alignment/types.js";
import { generateStoredArtwork } from "../src/artwork/generator.js";
import { ImageProvider } from "../src/artwork/provider.js";
import { CopyingAudioProcessor, masterStoredChapter } from "../src/audio/chapter-audio.js";
import { Chapter, StageName, chapterSchema } from "../src/domain/chapter.js";
import { LLMRouter } from "../src/llm/router.js";
import { LLMProvider } from "../src/llm/provider.js";
import { ChapterPipeline } from "../src/pipeline/chapter-pipeline.js";
import { buildProductionPlan } from "../src/production/planner.js";
import { planStoredScenes } from "../src/scenes/manifest.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { generateStoredSubtitles } from "../src/subtitles/chapter-subtitles.js";
import { renderStoredChapterVideo } from "../src/video/chapter-video.js";
import { VideoProcessor } from "../src/video/renderer.js";
import { MockLLM, MockTTS, testStory } from "./helpers.js";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const complete = { status: "complete" as const, fingerprint: "input", outputFingerprint: "output" };
const alignConfig: AlignmentConfig = { engine: "whisper-cpp", executable: "whisper-cli", model: "/model.bin", device: "cpu", minimumMatchPercentage: 80, minimumConfidence: .4, maximumGapSeconds: 5, timeoutMs: 10_000 };

class SceneLLM implements LLMProvider { readonly name = "openai" as const; calls: any[] = []; async validateConfiguration() {} async generateText() { return { text: "" }; } async generateStructured<T>(request: any): Promise<any> { this.calls.push(request); return { value: request.schema.parse({ scenes: [{ summary: "Mara enters the observatory.", startSeconds: 0, endSeconds: 12, characters: ["Mara"], location: "Old Observatory", visualPrompt: "Mara beneath the brass telescope", importance: "major" }, { summary: "The star map ignites.", startSeconds: 12, endSeconds: 30, characters: ["Mara"], location: "Old Observatory", visualPrompt: "Blue constellations flare", importance: "standard" }] }) as T }; } }
class FakeImages implements ImageProvider { readonly name = "openai"; readonly version = "fake-images-v1"; calls: any[] = []; async validateConfiguration() {} async generate(request: any) { this.calls.push(request); return { data: PNG_1X1, mimeType: "image/png" as const }; } }
class FakeVideo implements VideoProcessor { readonly version = "fake-video"; async render(_input: any, output: string) { await atomicWrite(output, Buffer.from("video")); return { durationSeconds: 30, videoCodec: "h264", audioCodec: "aac", width: 1920, height: 1080, container: "mp4" }; } }
class FakeAlignment implements AlignmentEngine { readonly name = "fake-align"; readonly version = "fake-v1"; async validateConfiguration() {} async align(request: { narration: string }) { const tokens = tokenizeNarration(request.narration); const step = 28 / Math.max(1, tokens.length); return tokens.map((text, index) => ({ text, start: .1 + index * step, end: .1 + index * step + step * .9, confidence: .95 })); } }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stale-artifacts-")); const story = testStory(); const paths = storyPaths(root, story.slug, 1); const now = new Date().toISOString();
  await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({
    chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, counts: { originalCharacters: 50, englishWords: 20, narrationWords: 14 }, createdAt: now, updatedAt: now,
    stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, continuity: complete, tts: complete, audioMastering: complete, alignment: complete, subtitles: complete, scenePlanning: { status: "pending" }, artwork: { status: "pending" }, video: { status: "pending" } },
    audio: { durationSeconds: 30, codec: "mp3", container: "mp3" },
  }));
  await atomicWrite(paths.narration, "Mara entered the old observatory. Above her, a map of blue stars awakened.");
  await atomicWrite(paths.audioRaw, Buffer.from("raw tts audio"));
  await atomicWrite(paths.audio, Buffer.from("mastered chapter audio"));
  return { root, story, paths };
}

async function markStale(paths: ReturnType<typeof storyPaths>, ...stages: StageName[]) {
  const meta = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
  for (const stage of stages) meta.stages[stage] = { ...meta.stages[stage], status: "pending", staleReason: "upstream changed" };
  await atomicWriteJson(paths.chapterMeta, meta);
}
async function metadata(paths: ReturnType<typeof storyPaths>): Promise<Chapter> {
  return chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8")));
}

async function pipelineSetup() {
  const root = await mkdtemp(join(tmpdir(), "stale-pipeline-")); const input = join(root, "chapter.txt"); const story = testStory();
  await writeFile(input, "第一章\n\n测试正文", "utf8"); await mkdir(join(root, "stories", story.slug), { recursive: true }); await atomicWriteJson(join(root, "stories", story.slug, "story.json"), story);
  const make = (narration = "Narration") => new ChapterPipeline(new LLMRouter(new Map([["gemini", new MockLLM("gemini", ["Translation"])], ["openai", new MockLLM("openai", [narration])]])), new MockTTS(), new CopyingAudioProcessor());
  await make().run({ root, story, chapter: 1, inputPath: input });
  return { root, story, input, paths: storyPaths(root, story.slug, 1), make };
}

describe("stale prerequisite consumption", () => {
  it("plans scenes from stale-but-valid narration and mastered audio, warning without mutating upstream", async () => {
    const { root, story, paths } = await fixture(); await markStale(paths, "narration", "audioMastering");
    const result = await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });
    expect(result.reused).toBe(false);
    expect(result.warnings).toContain("Using stale narration — it may not reflect the latest Translation changes.");
    expect(result.warnings).toContain("Using stale mastered audio.");
    const after = await metadata(paths);
    expect(after.stages.narration).toMatchObject({ status: "pending", staleReason: "upstream changed" });
    expect(after.stages.audioMastering).toMatchObject({ status: "pending", staleReason: "upstream changed" });
    expect(after.stages.scenePlanning.status).toBe("complete");
  });
  it("still blocks scene planning when narration or mastered audio is missing", async () => {
    const missingNarration = await fixture(); await rm(missingNarration.paths.narration);
    await expect(planStoredScenes({ root: missingNarration.root, story: missingNarration.story, chapter: 1, provider: new SceneLLM() })).rejects.toThrow("narration is missing");
    const missingAudio = await fixture(); await rm(missingAudio.paths.audio);
    await expect(planStoredScenes({ root: missingAudio.root, story: missingAudio.story, chapter: 1, provider: new SceneLLM() })).rejects.toThrow("audio is not mastered");
  });
  it("blocks scene planning when mastered audio exists but its metadata is gone", async () => {
    const { root, story, paths } = await fixture(); const meta = JSON.parse(await readFile(paths.chapterMeta, "utf8")); delete meta.audio; await atomicWriteJson(paths.chapterMeta, meta);
    await expect(planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() })).rejects.toThrow("audio is not mastered");
  });
  it("regenerates scenes when the consumed mastered audio actually changes", async () => {
    const { root, story, paths } = await fixture(); const provider = new SceneLLM();
    await planStoredScenes({ root, story, chapter: 1, provider });
    expect((await planStoredScenes({ root, story, chapter: 1, provider })).reused).toBe(true);
    await atomicWrite(paths.audio, Buffer.from("remastered chapter audio"));
    expect((await planStoredScenes({ root, story, chapter: 1, provider })).reused).toBe(false);
    expect(provider.calls).toHaveLength(2);
  });
  it("aligns from stale mastered audio with a warning, and blocks zero-byte audio", async () => {
    const { root, story, paths } = await fixture(); await markStale(paths, "audioMastering");
    const result = await alignStoredChapter({ root, storySlug: story.slug, chapter: 1, language: "en", config: alignConfig, engine: new FakeAlignment(), force: true });
    expect(result.artifact.mode).toBe("aligned");
    expect(result.warnings).toContain("Using stale mastered audio.");
    expect((await metadata(paths)).stages.audioMastering).toMatchObject({ status: "pending", staleReason: "upstream changed" });
    await atomicWrite(paths.audio, Buffer.alloc(0));
    await expect(alignStoredChapter({ root, storySlug: story.slug, chapter: 1, language: "en", config: alignConfig, engine: new FakeAlignment(), force: true })).rejects.toThrow("audio is not mastered");
  });
  it("generates subtitles from stale mastered audio and stale alignment, warning for each", async () => {
    const { root, story, paths } = await fixture();
    await alignStoredChapter({ root, storySlug: story.slug, chapter: 1, language: "en", config: alignConfig, engine: new FakeAlignment() });
    await markStale(paths, "audioMastering", "alignment");
    const result = await generateStoredSubtitles({ root, story, chapter: 1, force: true });
    expect(result.document.timingMode).toBe("aligned");
    expect(result.warnings).toContain("Using stale mastered audio.");
    expect(result.warnings).toContain("Using stale alignment.");
    const after = await metadata(paths);
    expect(after.stages.alignment).toMatchObject({ status: "pending", staleReason: "upstream changed" });
    expect(after.stages.subtitles.status).toBe("complete");
  });
  it("renders video from stale mastered audio and stale subtitles, warning for each", async () => {
    const { root, story, paths } = await fixture();
    await generateStoredSubtitles({ root, story, chapter: 1 });
    await markStale(paths, "audioMastering", "subtitles");
    const result = await renderStoredChapterVideo({ root, story, chapter: 1, processor: new FakeVideo(), force: true });
    expect(result.reused).toBe(false);
    expect(result.warnings).toContain("Using stale mastered audio.");
    expect(result.warnings).toContain("Using stale subtitles.");
    expect((await metadata(paths)).stages.subtitles).toMatchObject({ status: "pending", staleReason: "upstream changed" });
  });
  it("blocks video on corrupt subtitles or zero-byte audio", async () => {
    const corrupt = await fixture(); await generateStoredSubtitles({ root: corrupt.root, story: corrupt.story, chapter: 1 });
    await atomicWrite(corrupt.paths.subtitlesDocument, "not json");
    await expect(renderStoredChapterVideo({ root: corrupt.root, story: corrupt.story, chapter: 1, processor: new FakeVideo(), force: true })).rejects.toThrow("subtitles are not ready");
    const emptyAudio = await fixture(); await generateStoredSubtitles({ root: emptyAudio.root, story: emptyAudio.story, chapter: 1 });
    await atomicWrite(emptyAudio.paths.audio, Buffer.alloc(0));
    await expect(renderStoredChapterVideo({ root: emptyAudio.root, story: emptyAudio.story, chapter: 1, processor: new FakeVideo(), force: true })).rejects.toThrow("audio is not mastered");
  });
  it("masters from stale raw TTS audio with a warning, and blocks empty inputs", async () => {
    const { root, story, paths } = await fixture(); await markStale(paths, "tts");
    const result = await masterStoredChapter({ root, story, chapter: 1, processor: new CopyingAudioProcessor() });
    expect(result.reused).toBe(false);
    expect(result.warnings).toContain("Using stale raw TTS audio — it may not reflect the latest Narration changes.");
    expect((await metadata(paths)).stages.tts).toMatchObject({ status: "pending", staleReason: "upstream changed" });
    const empty = await fixture(); await atomicWrite(empty.paths.audioRaw, Buffer.alloc(0));
    await expect(masterStoredChapter({ root: empty.root, story: empty.story, chapter: 1, processor: new CopyingAudioProcessor(), force: true })).rejects.toThrow("missing or empty");
  });
  it("generates artwork from a stale scene plan with a warning, and blocks a corrupt plan", async () => {
    const { root, story, paths } = await fixture();
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });
    await markStale(paths, "scenePlanning");
    const events: Array<{ type: string; warnings?: string[] }> = [];
    const result = await generateStoredArtwork({ root, story, chapter: 1, provider: new FakeImages(), sceneId: "scene-001", onProgress: (event) => events.push(event) });
    expect(result.generated).toBe(1);
    expect(result.warnings).toContain("Using stale scene plan — it may not reflect the latest Narration changes.");
    expect(events).toContainEqual(expect.objectContaining({ type: "artwork.prerequisites", warnings: result.warnings }));
    expect((await metadata(paths)).stages.scenePlanning).toMatchObject({ status: "pending", staleReason: "upstream changed" });
    const corrupt = await fixture(); await atomicWrite(corrupt.paths.scenesManifest, "not json");
    await expect(generateStoredArtwork({ root: corrupt.root, story: corrupt.story, chapter: 1, provider: new FakeImages() })).rejects.toThrow();
  });
});

describe("stale prerequisites in the core pipeline", () => {
  it("runs narration-only against a stale translation without clearing the stale flag", async () => {
    const { root, story, input, paths, make } = await pipelineSetup(); await markStale(paths, "translation");
    await make("Narration v2").run({ root, story, chapter: 1, inputPath: input, executionStages: ["narration"], stopAfter: "narration" });
    const after = await metadata(paths);
    expect(after.stages.translation).toMatchObject({ status: "pending", staleReason: "upstream changed" });
    expect(after.stages.narration.status).toBe("complete");
    await rm(root, { recursive: true, force: true });
  });
  it("runs TTS-only against stale narration without clearing the stale flag", async () => {
    const { root, story, input, paths, make } = await pipelineSetup(); await markStale(paths, "narration");
    await make().run({ root, story, chapter: 1, inputPath: input, executionStages: ["tts"], stopAfter: "tts" });
    const after = await metadata(paths);
    expect(after.stages.narration).toMatchObject({ status: "pending", staleReason: "upstream changed" });
    expect(after.stages.tts.status).toBe("complete");
    await rm(root, { recursive: true, force: true });
  });
});

describe("production planner dry-run artifact states", () => {
  it("distinguishes reusable-current, available-stale, and missing per stage", async () => {
    const { root, story, paths } = await pipelineSetup();
    const fresh = await buildProductionPlan({ root, story, chapters: [1], outputs: ["audio"], artwork: false });
    expect(fresh.stageStates?.["1"]?.translation).toMatchObject({ availability: "available", freshness: "current", reusable: true });
    await markStale(paths, "narration");
    const stale = await buildProductionPlan({ root, story, chapters: [1], outputs: ["audio"], artwork: false });
    expect(stale.stageStates?.["1"]?.narration).toMatchObject({ availability: "available", freshness: "stale", reusable: false });
    expect(stale.stageStates?.["1"]?.translation).toMatchObject({ availability: "available", freshness: "current", reusable: true });
    expect(stale.chapterRequirements["1"]).toContain("narration");
    await rm(paths.english);
    const missing = await buildProductionPlan({ root, story, chapters: [1], outputs: ["audio"], artwork: false });
    expect(missing.stageStates?.["1"]?.translation?.availability).toBe("missing");
    await rm(root, { recursive: true, force: true });
  });
});
