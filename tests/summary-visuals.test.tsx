import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SummaryVisualService } from "../src/summaries/visuals.js";
import { SummaryMediaService, summaryMediaPaths } from "../src/summaries/media.js";
import { SummaryService } from "../src/summaries/service.js";
import { LLMRouter } from "../src/llm/router.js";
import { TTSProviderRouter } from "../src/tts/router.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { fileFingerprint } from "../src/utils/file-fingerprint.js";
import { summaryPath } from "../src/summaries/service.js";
import { emptyStoryBible, storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { mergeStoryBible } from "../src/story-bible/updater.js";
import { tokenizeNarration } from "../src/alignment/quality.js";
import { MockLLM, MockTTS, testStory } from "./helpers.js";
import { parseSummaryArgs, runSummaryCommand } from "../apps/cli/summary.js";
import { SummaryArtworkPanel, SummaryScenePanel, SummaryVideoPanel } from "../apps/web/src/SummaryVisualPanels.js";
import { SummaryLayers } from "../apps/web/src/SummaryLayers.js";
import { FfmpegVideoProcessor } from "../src/video/renderer.js";
import { runCommand } from "../src/audio/ffmpeg.js";
import { JobManager } from "../apps/server/job-manager.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const narration = "Malakai enters the dungeon. Malakai faces the monsters.";
describe("summary visual production", () => {
  let root: string, media: SummaryMediaService, visuals: SummaryVisualService, summaries: SummaryService, id: string;
  let llm: MockLLM, tts: MockTTS;
  const images = { name: "openai", version: "fake-image", validateConfiguration: vi.fn(async () => {}), generate: vi.fn(async () => ({ data: PNG, mimeType: "image/png" as const })) };
  const render = vi.fn(async (input: any, output: string, settings: any) => { await atomicWrite(output, "fake-mp4"); return { durationSeconds: input.audioDurationSeconds, width: settings.width, height: settings.height, videoCodec: "h264", audioCodec: "aac", container: "mp4" }; });
  const engine = { name: "fake-local-aligner", version: "v1", validateConfiguration: async () => {}, align: vi.fn(async () => tokenizeNarration(narration).map((text, index) => ({ text, start: index < 4 ? index : index + 4, end: (index < 4 ? index : index + 4) + .8, confidence: 1 }))) };
  const config = { engine: "disabled" as const, executable: "unused", device: "cpu" as const, minimumMatchPercentage: 90, minimumConfidence: .5, maximumGapSeconds: 5, timeoutMs: 1000 };
  beforeEach(async () => {
    vi.clearAllMocks(); root = await mkdtemp(join(tmpdir(), "summary-visuals-")); llm = new MockLLM("openai", ["Su Ming enters the dungeon. Su Ming faces the monsters.", narration]); tts = new MockTTS();
    const router = new LLMRouter(new Map([["openai", llm]])); summaries = new SummaryService(root, router);
    media = new SummaryMediaService(root, router, new TTSProviderRouter(tts), { version: "fake-censor", synthesize: async (provider, request) => provider.synthesize(request) }, { version: "fake-master", master: async (_inputs, path) => { await atomicWrite(path, "fake-mastered-audio"); return { durationSeconds: 12, codec: "mp3", container: "mp3" }; } });
    visuals = new SummaryVisualService(root, media, images, { version: "fake-video", render }, config, engine);
    await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, testStory()); await atomicWrite(storyPaths(root, "demo-story", 1).english, "Su Ming enters a dungeon.");
    const bible = mergeStoryBible(emptyStoryBible(), storyBibleUpdateSchema.parse({ chapterSummary: "Dungeon", characters: [{ canonicalEnglishName: "Su Ming", originalName: "苏铭", firstSeenChapter: 1, lastSeenChapter: 1, description: "A young necromancer in black robes" }] }), 1);
    bible.canonicalEntities[0]!.localizedNaming = { locale: "en-US", fullName: "Malakai Sterling", shortName: "Malakai", usageMode: "ai_contextual" }; await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, bible);
    id = (await summaries.generate("demo-story", { chapters: [1], title: "Dungeon recap" })).id;
    vi.spyOn(llm, "generateStructured").mockImplementation(async (request) => ({ value: request.schema.parse({ scenes: [
      { summary: "Su Ming arrives", startSeconds: 0, endSeconds: 5, characters: ["Malakai"], visualPrompt: "Su Ming in black robes at the dungeon entrance", importance: "standard", narrationStartWord: 0, narrationEndWord: 4 },
      { summary: "Su Ming confronts monsters", startSeconds: 5, endSeconds: 12, characters: ["Malakai"], visualPrompt: "Su Ming confronts monsters inside the dungeon", importance: "major", narrationStartWord: 4, narrationEndWord: 8 },
    ] }) }));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const produce = () => visuals.produce("demo-story", id, { pacing: "custom", sceneCount: 2 });
  it("renders a real MP4 through the shared FFmpeg renderer without paid providers", async (context) => {
    try { await runCommand(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]); } catch { context.skip(); return; }
    const story = testStory(); story.video = { ...story.video, width: 640, height: 360, fps: 24, subtitleMode: "none" }; await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, story);
    const realMedia = new SummaryMediaService(root, new LLMRouter(new Map([["openai", llm]])), new TTSProviderRouter(tts), { version: "fake-censor", synthesize: async (provider, request) => provider.synthesize(request) }, { version: "test-tone-master", master: async (_inputs, output) => {
      await runCommand(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=200:duration=12", "-c:a", "libmp3lame", output]); return { durationSeconds: 12, codec: "mp3", container: "mp3" };
    } });
    const real = new SummaryVisualService(root, realMedia, images, new FfmpegVideoProcessor(), config, engine);
    const result = await real.produce("demo-story", id, { sceneCount: 2 }); expect(result.video).toMatchObject({ status: "current", durationSeconds: 12, width: 640, height: 360 });
  }, 30000);
  it("produces aligned scenes, canonical continuity artwork and synchronized video, then reuses all stages", async () => {
    const result = await produce(); expect(result.video).toMatchObject({ status: "current", durationSeconds: 12, sceneCount: 2 });
    expect(result.scenePlan?.timingMethod).toBe("aligned"); expect(result.scenePlan?.scenes[1]?.startSeconds).toBe(8);
    expect(images.generate.mock.calls[0]![0]).toMatchObject({ model: testStory().artwork.model });
    expect(JSON.stringify(images.generate.mock.calls)).toContain("Su Ming"); expect(JSON.stringify(images.generate.mock.calls)).toContain("CANONICAL VISUAL REFERENCE");
    expect(result.scenePlan?.scenes[0]?.artwork.entityIds).toHaveLength(1);
    expect(render.mock.calls[0]![0].sceneArtwork.map((scene: any) => scene.durationSeconds)).toEqual([8, 4]); expect(render.mock.calls[0]![2].introDurationSeconds).toBe(0);
    await produce(); expect(images.generate).toHaveBeenCalledTimes(2); expect(render).toHaveBeenCalledTimes(1); expect(engine.align).toHaveBeenCalledTimes(1); expect(tts.calls).toBe(1);
    expect(await visuals.export("demo-story", id, "video")).toMatchObject({ contentType: "video/mp4" });
  });
  it("falls back to deterministic timing when local alignment is unavailable", async () => {
    const fallback = new SummaryVisualService(root, media, images, { version: "fake-video", render }, config);
    const result = await fallback.produce("demo-story", id, { sceneCount: 2 }); expect(result.alignment?.mode).toBe("estimated"); expect(result.scenePlan?.timingMethod).toBe("estimated"); expect(result.scenePlan?.scenes[1]?.startSeconds).toBe(6); expect(result.video?.durationSeconds).toBe(12);
  });
  it("keeps artwork current for timing-only and voice changes and invalidates only video after an image change", async () => {
    const result = await produce(); const scenes = structuredClone(result.scenePlan!.scenes); scenes[0]!.endSeconds = 7; scenes[1]!.startSeconds = 7;
    await visuals.editScenes("demo-story", id, { scenes }); expect((await visuals.get("demo-story", id)).artwork?.status).toBe("current"); expect((await visuals.get("demo-story", id)).video?.status).toBe("stale");
    const reused = await produce(); expect(reused.scenePlan?.scenes[1]?.startSeconds).toBe(7); expect(images.generate).toHaveBeenCalledTimes(2);
    await visuals.video("demo-story", id); await visuals.artwork("demo-story", id, { force: true, scenes: ["scene-001"] });
    expect(images.generate).toHaveBeenCalledTimes(3); expect(await visuals.get("demo-story", id)).toMatchObject({ narration: { status: "current" }, audio: { status: "current" }, scenes: { status: "current" }, video: { status: "stale" } });
    const story = testStory(); story.pipeline.tts.referenceId = "other-voice"; await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, story);
    expect(await visuals.get("demo-story", id)).toMatchObject({ audio: { status: "stale" }, artwork: { status: "current" }, video: { status: "stale" } });
  });
  it("invalidates alignment and video when a replacement recording keeps the same duration", async () => {
    const produced = await produce(); expect(produced.alignment?.mode).toBe("aligned"); expect(produced.video?.status).toBe("current");
    const paths = summaryMediaPaths(root, "demo-story", id); const stored = await summaries.get("demo-story", id);
    await atomicWrite(paths.audio, "different-recording-with-the-same-duration");
    stored.audio!.outputFingerprint = (await fileFingerprint(paths.audio))!;
    await atomicWriteJson(summaryPath(root, "demo-story", id), stored);
    const refreshed = await media.get("demo-story", id);
    expect(refreshed.audio?.status).toBe("current"); expect(refreshed.alignment).toBeUndefined();
    expect((await visuals.get("demo-story", id)).video?.status).toBe("stale");
  });
  it("protects approved artwork and supports explicit regeneration and damaged cache detection", async () => {
    const result = await produce(); await visuals.reviewArtwork("demo-story", id, "scene-001", "approved"); const scenes = structuredClone(result.scenePlan!.scenes); scenes[0]!.visualPrompt = "A new visual direction";
    await visuals.editScenes("demo-story", id, { scenes }); await visuals.artwork("demo-story", id); expect(images.generate).toHaveBeenCalledTimes(2); expect((await visuals.get("demo-story", id)).artwork?.status).toBe("stale");
    await expect(visuals.video("demo-story", id)).rejects.toThrow("review protected artwork");
    await visuals.artwork("demo-story", id, { force: true, scenes: ["scene-001"] }); expect(images.generate).toHaveBeenCalledTimes(3);
    await atomicWrite(visuals.paths("demo-story", id).image("scene-001"), "damaged"); expect((await visuals.get("demo-story", id)).artwork?.status).toBe("stale"); await expect(visuals.reviewArtwork("demo-story", id, "scene-001", "approved")).rejects.toThrow("intact");
  });
  it("recovers from an interrupted image operation without repeating completed provider calls", async () => {
    await media.audio("demo-story", id); await visuals.scenes("demo-story", id, { sceneCount: 2 }); let pause = false;
    await visuals.artwork("demo-story", id, {}, (event) => { if (event.type.endsWith("completed")) pause = true; }, () => pause);
    expect(images.generate).toHaveBeenCalledTimes(1); await produce(); expect(images.generate).toHaveBeenCalledTimes(2); expect(render).toHaveBeenCalledTimes(1);
  });
  it("persists durable production progress, pauses safely and resumes through the same operation", async () => {
    const operations = new StudioOperations(root, loadEnvironment({}), undefined, { llm: new LLMRouter(new Map([["openai", llm]])), tts, image: images, video: { version: "fake-video", render },
      censor: { version: "fake-censor", synthesize: async (provider, request) => provider.synthesize(request) }, audio: { version: "fake-master", master: async (_inputs, path) => { await atomicWrite(path, "fake-mastered-audio"); return { durationSeconds: 12, codec: "mp3", container: "mp3" }; } } });
    try {
      const job = await operations.startSummaryMedia("demo-story", id, "produce", { sceneCount: 2 });
      const unsubscribe = operations.jobs.subscribe(job.id, (next) => { if ((next.progress as { type?: string })?.type === "summary.artwork.completed") operations.jobs.pause(job.id); });
      await vi.waitFor(() => expect(operations.jobs.get(job.id)?.status).toBe("paused")); unsubscribe?.(); expect(images.generate).toHaveBeenCalledTimes(1);
      await operations.jobs.flushDurable(); const restored = new JobManager(); await restored.restoreDurable(operations.summaryJobsDirectory()); expect(restored.get(job.id)?.status).toBe("paused");
      const resumed = await operations.startSummaryMedia("demo-story", id, "produce", { sceneCount: 2 }); await vi.waitFor(() => expect(operations.jobs.get(resumed.id)?.status).toBe("completed")); expect(images.generate).toHaveBeenCalledTimes(2); expect(render).toHaveBeenCalledTimes(1);
    } finally { await operations.close(); }
  });
  it("supports individual scene regeneration, reordering, disabling and deleting without losing narration coverage", async () => {
    const result = await produce(); const protectedScene = structuredClone(result.scenePlan!.scenes[1]!);
    vi.spyOn(llm, "generateStructured").mockImplementation(async (request) => ({ value: request.schema.parse({ scenes: [{ summary: "New arrival", startSeconds: 0, endSeconds: 8, characters: ["Malakai"], visualPrompt: "A new arrival at the dungeon", importance: "major" }] }) }));
    const regenerated = await media.regenerateScene("demo-story", id, "scene-001"); expect(regenerated.scenePlan?.scenes[1]).toEqual(protectedScene); expect(regenerated.scenePlan?.scenes[0]?.narrationText).toBe(result.scenePlan?.scenes[0]?.narrationText);
    const reordered = await visuals.editScenes("demo-story", id, { scenes: [...regenerated.scenePlan!.scenes].reverse() }); expect(reordered.scenePlan?.scenes[0]?.id).toBe("scene-002"); expect(reordered.scenePlan?.scenes[0]?.startSeconds).toBe(0);
    const scenes = structuredClone(reordered.scenePlan!.scenes); scenes[0]!.disabled = true; const disabled = await visuals.editScenes("demo-story", id, { scenes }); expect(disabled.scenePlan?.scenes[1]?.startSeconds).toBe(0); expect(disabled.scenePlan?.scenes[1]?.endSeconds).toBe(12);
    const kept = [{ ...disabled.scenePlan!.scenes[1]!, disabled: false }]; const deleted = await visuals.editScenes("demo-story", id, { scenes: kept }); expect(deleted.scenePlan?.scenes).toHaveLength(1); expect(deleted.scenePlan?.scenes[0]?.narrationEndWord).toBe(8);
    await expect(visuals.editScenes("demo-story", id, { scenes: [{ ...kept[0]!, disabled: true }] })).rejects.toThrow("at least one");
  });
  it("surfaces image/video failures, preserves successful work and rejects mismatched video duration", async () => {
    await media.audio("demo-story", id); await visuals.scenes("demo-story", id, { sceneCount: 2 }); images.generate.mockRejectedValueOnce(new Error("invalid image response"));
    await expect(visuals.artwork("demo-story", id)).rejects.toThrow("invalid image response"); expect((await visuals.get("demo-story", id)).artwork?.status).toBe("failed");
    await visuals.artwork("demo-story", id); render.mockRejectedValueOnce(new Error("FFmpeg failed")); await expect(visuals.video("demo-story", id)).rejects.toThrow("FFmpeg failed"); expect((await visuals.get("demo-story", id)).video?.status).toBe("failed");
    await visuals.video("demo-story", id); render.mockImplementationOnce(async (input: any, output: string, settings: any) => { await atomicWrite(output, "bad-duration"); return { durationSeconds: input.audioDurationSeconds + 2, width: settings.width, height: settings.height, videoCodec: "h264", audioCodec: "aac", container: "mp4" }; });
    await expect(visuals.video("demo-story", id, { force: true })).rejects.toThrow("duration does not match"); expect(await visuals.export("demo-story", id, "video")).toMatchObject({ contentType: "video/mp4" });
  });
  it("supports CLI production/export and all six UI layers with actionable controls", async () => {
    expect(parseSummaryArgs(["artwork", "demo-story", id, "--scene", "scene-001", "--force"])).toMatchObject({ action: "artwork", input: { scenes: ["scene-001"], force: true } });
    const command = parseSummaryArgs(["produce", "demo-story", id, "--scene-count", "2"]); let output = "";
    await runSummaryCommand(command, { root, service: summaries, media, visuals, stdout: (text) => { output += text; }, stderr: () => {} }); const summary = JSON.parse(output);
    expect(summary.video.status).toBe("current"); output = "";
    await runSummaryCommand(parseSummaryArgs(["export", "demo-story", id, "--type", "video"]), { root, service: summaries, media, visuals, stdout: (text) => { output += text; }, stderr: () => {} }); expect(JSON.parse(output).contentType).toBe("video/mp4");
    const props = { summary, base: `/stories/demo-story/summaries/${id}`, disabled: false, onChange: () => {}, onGenerate: () => {}, onError: () => {} };
    expect(renderToStaticMarkup(<SummaryScenePanel {...props} />)).toContain("Regenerate scene"); expect(renderToStaticMarkup(<SummaryArtworkPanel {...props} />)).toContain("Approve / retain"); expect(renderToStaticMarkup(<SummaryVideoPanel {...props} />)).toContain("Download MP4");
    expect(renderToStaticMarkup(<SummaryLayers {...props} slug="demo-story" busy={false}>Canonical</SummaryLayers>)).toContain("Artwork");
  });
});
