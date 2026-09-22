import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { storyPaths, visualProfileRefPath } from "../src/storage/paths.js";
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
import { saveVisualProfiles } from "../src/visual-canon/profiles.js";
import { loadStoryBibleWithCanonicalOverlay } from "../src/story-bible/canonical.js";

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
    const entityId = bible.canonicalEntities[0]!.id; const now = new Date().toISOString();
    await saveVisualProfiles(root, "demo-story", { [entityId]: { id: "vp-su-ming", entityId, visualType: "character", status: "approved", revision: 1, createdAt: now, updatedAt: now, appearance: "A young necromancer", visualPrompt: "young necromancer with dark hair", notes: "", character: {}, references: [], variants: [] } });
    id = (await summaries.generate("demo-story", { chapters: [1], title: "Dungeon recap" })).id;
    vi.spyOn(llm, "generateStructured").mockImplementation(async (request) => ({ value: request.schema.parse({ scenes: [
      { summary: "Su Ming arrives", startSeconds: 0, endSeconds: 5, characters: ["Malakai"], visualPrompt: "Su Ming in black robes at the dungeon entrance", importance: "standard", narrationStartWord: 0, narrationEndWord: 4 },
      { summary: "Su Ming confronts monsters", startSeconds: 5, endSeconds: 12, characters: ["Malakai"], visualPrompt: "Su Ming confronts monsters inside the dungeon", importance: "major", narrationStartWord: 4, narrationEndWord: 8 },
    ] }) }));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const produce = () => visuals.produce("demo-story", id, { pacing: "custom", sceneCount: 2 });
  const sceneEdit = (scene: NonNullable<Awaited<ReturnType<typeof produce>>["scenePlan"]>["scenes"][number], patch: Record<string, unknown> = {}) => ({ scene: {
    summary: scene.summary, visualPrompt: scene.visualPrompt, characters: scene.characters, entityIds: scene.entityIds ?? [],
    location: scene.location, startSeconds: scene.startSeconds, endSeconds: scene.endSeconds,
    disabled: scene.disabled, importance: scene.importance, direction: scene.direction, overrides: scene.overrides,
    ...patch,
  } });
  it("plans produce dry-runs without generating, rendering, or changing summary metadata", async () => {
    const before = await readFile(summaryPath(root, "demo-story", id), "utf8");
    const llmCalls = llm.calls.length, ttsCalls = tts.calls, imageCalls = images.generate.mock.calls.length, renderCalls = render.mock.calls.length;
    const result = await visuals.produce("demo-story", id, { dryRun: true, sceneCount: 2 });
    expect(result).toMatchObject({ dryRun: true, narration: { action: "generate" }, audio: { action: "generate" }, scenes: { action: "generate" }, artwork: { blocked: true }, video: { action: "blocked" } });
    expect(llm.calls.length).toBe(llmCalls); expect(tts.calls).toBe(ttsCalls); expect(images.generate.mock.calls.length).toBe(imageCalls); expect(render.mock.calls.length).toBe(renderCalls);
    expect(await readFile(summaryPath(root, "demo-story", id), "utf8")).toBe(before);
  });
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
    expect(JSON.stringify(images.generate.mock.calls)).toContain("Su Ming"); expect(JSON.stringify(images.generate.mock.calls)).toContain("ENTITY VISUAL CANON"); expect(JSON.stringify(images.generate.mock.calls)).toContain("SCENE-STATE PRIORITY");
    expect(JSON.stringify(images.generate.mock.calls)).toContain("young necromancer with dark hair");
    expect(result.scenePlan?.scenes[0]?.artwork.entityIds).toHaveLength(1);
    expect(render.mock.calls[0]![0].sceneArtwork.map((scene: any) => scene.durationSeconds)).toEqual([8, 4]); expect(render.mock.calls[0]![2].introDurationSeconds).toBe(0);
    await produce(); expect(images.generate).toHaveBeenCalledTimes(2); expect(render).toHaveBeenCalledTimes(1); expect(engine.align).toHaveBeenCalledTimes(1); expect(tts.calls).toBe(1);
    expect(await visuals.export("demo-story", id, "video")).toMatchObject({ contentType: "video/mp4" });
  });
  it("preflights missing and draft profiles against only scenes that need generation before calling the image provider", async () => {
    const planned = await produce(); const entityId = planned.scenePlan!.scenes[0]!.entityIds![0]!; images.generate.mockClear();
    await saveVisualProfiles(root, "demo-story", {});
    const reusableOnly = await visuals.artwork("demo-story", id, { missingOnly: true, dryRun: true });
    expect(reusableOnly).toMatchObject({ imagesToGenerate: 0, sceneIds: [], preflight: { ready: true, requiresDecision: [] } });
    const missing = await visuals.artwork("demo-story", id, { force: true, dryRun: true });
    expect(missing).toMatchObject({ dryRun: true, imagesToGenerate: 2, preflight: { ready: false, requiresDecision: [{ entityId, state: "missing_profile" }] } });
    await expect(visuals.artwork("demo-story", id, { force: true })).rejects.toThrow("Visual Profile Check required");
    expect(images.generate).not.toHaveBeenCalled();

    const now = new Date().toISOString();
    await saveVisualProfiles(root, "demo-story", { [entityId]: { id: "vp-draft", entityId, status: "draft", revision: 1, createdAt: now, updatedAt: now } });
    const draft = await visuals.artwork("demo-story", id, { force: true, dryRun: true, scenes: ["scene-001"] });
    expect(draft).toMatchObject({ imagesToGenerate: 1, sceneIds: ["scene-001"], preflight: { ready: false, requiresDecision: [{ entityId, state: "draft_profile" }] } });
    expect(images.generate).not.toHaveBeenCalled();
  });
  it("uses the shared Visual Canon preflight decision, persistent skip policy and one-time fallback for summary images", async () => {
    const planned = await produce(); const entityId = planned.scenePlan!.scenes[0]!.entityIds![0]!; images.generate.mockClear();
    await saveVisualProfiles(root, "demo-story", {});
    const bible = await loadStoryBibleWithCanonicalOverlay(root, "demo-story");
    const entity = bible.canonicalEntities.find((item) => item.id === entityId)!; entity.visualProfilePolicy = { mode: "skip" };
    await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, bible);
    const skipped = await visuals.artwork("demo-story", id, { force: true, dryRun: true });
    expect(skipped).toMatchObject({ preflight: { ready: true, entities: [{ entityId, state: "skip_profile", policy: "skip" }] } });
    const skippedGeneration = await visuals.artwork("demo-story", id, { force: true });
    expect(skippedGeneration.scenePlan?.scenes[0]?.artwork.versions?.at(-1)?.provenance?.visualCanon).toMatchObject([{ entityId, source: "Story Bible fallback (skip policy)" }]);
    entity.visualProfilePolicy = { mode: "prompt" }; await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, bible);
    const oneTime = await visuals.artwork("demo-story", id, { force: true, allowUnprofiledEntityIds: [entityId] });
    expect(oneTime.scenePlan?.scenes[0]?.artwork.versions?.at(-1)?.provenance?.visualCanon).toMatchObject([{ entityId, source: "Story Bible fallback (one-time)" }]);
    expect(images.generate).toHaveBeenCalledTimes(4);
  });
  it("sends approved Visual Profile references while excluding unapproved candidates and records grounding provenance", async () => {
    const planned = await produce(); const entityId = planned.scenePlan!.scenes[0]!.entityIds![0]!; images.generate.mockClear();
    const story = testStory(); story.artwork.model = "gpt-image-2.5-flare"; await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, story);
    const now = new Date().toISOString();
    await saveVisualProfiles(root, "demo-story", { [entityId]: { id: "vp-su-ming", entityId, visualType: "character", status: "approved", revision: 2, createdAt: now, updatedAt: now,
      appearance: "Same young necromancer", visualPrompt: "young necromancer with dark hair", notes: "", character: {}, variants: [], references: [
        { id: "approved-primary", entityId, imagePath: "approved-primary.png", role: "primary_reference", source: "uploaded", approved: true, createdAt: now },
        { id: "draft-face", entityId, imagePath: "draft-face.png", role: "face_portrait", source: "generated", approved: false, createdAt: now },
      ] } });
    await atomicWrite(visualProfileRefPath(root, "demo-story", entityId, "approved-primary", "png"), PNG);
    await atomicWrite(visualProfileRefPath(root, "demo-story", entityId, "draft-face", "png"), PNG);
    const result = await visuals.artwork("demo-story", id, { force: true, scenes: ["scene-001"] });
    const request = images.generate.mock.calls[0]![0];
    expect(request.referenceImages).toHaveLength(1); expect(request.referenceImages[0]).toMatchObject({ role: "primary_reference" });
    expect(result.scenePlan!.scenes[0]!.artwork.versions!.at(-1)!.provenance).toMatchObject({ referencesUsed: "images", referenceImageCount: 1, visualCanon: [{ entityId, source: "approved Visual Profile", reference: true, primaryReference: true, profileRevision: 2 }] });
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
    const proposal = await media.previewSceneRegeneration("demo-story", id, "scene-001", { mode: "full_visual_direction" });
    expect((await visuals.get("demo-story", id)).scenePlan?.scenes[0]?.summary).toBe(result.scenePlan?.scenes[0]?.summary);
    const regenerated = await visuals.applySceneRegeneration("demo-story", id, "scene-001", proposal); expect(regenerated.scenePlan?.scenes[1]).toEqual(protectedScene); expect(regenerated.scenePlan?.scenes[0]?.narrationText).toBe(result.scenePlan?.scenes[0]?.narrationText);
    const reordered = await visuals.editScenes("demo-story", id, { scenes: [...regenerated.scenePlan!.scenes].reverse() }); expect(reordered.scenePlan?.scenes[0]?.id).toBe("scene-002"); expect(reordered.scenePlan?.scenes[0]?.startSeconds).toBe(0);
    const scenes = structuredClone(reordered.scenePlan!.scenes); scenes[0]!.disabled = true; const disabled = await visuals.editScenes("demo-story", id, { scenes }); expect(disabled.scenePlan?.scenes[1]?.startSeconds).toBe(0); expect(disabled.scenePlan?.scenes[1]?.endSeconds).toBe(12);
    const kept = [{ ...disabled.scenePlan!.scenes[1]!, disabled: false }]; const deleted = await visuals.editScenes("demo-story", id, { scenes: kept }); expect(deleted.scenePlan?.scenes).toHaveLength(1); expect(deleted.scenePlan?.scenes[0]?.narrationEndWord).toBe(8);
    await expect(visuals.editScenes("demo-story", id, { scenes: [{ ...kept[0]!, disabled: true }] })).rejects.toThrow("at least one");
  });
  it("saves only the selected scene, validates full-plan timing and avoids provider calls", async () => {
    const before = await produce(); const first = before.scenePlan!.scenes[0]!, second = structuredClone(before.scenePlan!.scenes[1]!);
    const modelCalls = llm.calls.length, imageCalls = images.generate.mock.calls.length;
    const changed = await visuals.updateScene("demo-story", id, first.id, sceneEdit(first, { visualPrompt: "A revised image prompt" }));
    expect(changed.scenePlan!.scenes[0]!.visualPrompt).toBe("A revised image prompt");
    expect(changed.scenePlan!.scenes[1]).toEqual(second);
    expect(changed.scenePlan!.manualRevision).toBe(before.scenePlan!.manualRevision + 1);
    expect(changed.scenePlan!.manuallyEdited).toBe(true);
    expect((await visuals.sceneArtworkGrounding("demo-story", id))[0]).toMatchObject({ sceneId: first.id, status: "stale" });
    expect(changed.scenePlan!.scenes[0]!.artwork.versions).toEqual(first.artwork.versions);
    expect(changed.video?.status).toBe("stale");
    expect(llm.calls.length).toBe(modelCalls); expect(images.generate.mock.calls.length).toBe(imageCalls);
    await expect(visuals.updateScene("demo-story", id, first.id, sceneEdit(changed.scenePlan!.scenes[0]!, { endSeconds: first.endSeconds - 1 }))).rejects.toThrow();
    expect((await visuals.get("demo-story", id)).scenePlan!.scenes[0]!.endSeconds).toBe(first.endSeconds);
    await expect(visuals.updateScene("demo-story", id, "scene-999", sceneEdit(first))).rejects.toThrow("Scene was not found");
  });
  it("previews image-prompt regeneration without writes and rejects a proposal after a newer scene edit", async () => {
    const before = await produce(); const original = structuredClone(before.scenePlan!.scenes[0]!);
    const storedBefore = await readFile(summaryPath(root, "demo-story", id), "utf8");
    vi.spyOn(llm, "generateStructured").mockImplementation(async (request) => ({ value: request.schema.parse({ visualPrompt: "A tighter cinematic angle at the entrance" }) }));
    const proposal = await media.previewSceneRegeneration("demo-story", id, original.id, { mode: "image_prompt" });
    expect(proposal.proposed).toMatchObject({ summary: original.summary, characters: original.characters, location: original.location, importance: original.importance, visualPrompt: "A tighter cinematic angle at the entrance" });
    expect(await readFile(summaryPath(root, "demo-story", id), "utf8")).toBe(storedBefore);
    const newer = await visuals.updateScene("demo-story", id, original.id, sceneEdit(original, { summary: "A manual visual beat" }));
    await expect(visuals.applySceneRegeneration("demo-story", id, original.id, proposal)).rejects.toThrow("changed since the proposal");
    expect((await visuals.get("demo-story", id)).scenePlan!.scenes[0]!.summary).toBe("A manual visual beat");
    const fresh = await media.previewSceneRegeneration("demo-story", id, original.id, { mode: "image_prompt" });
    const applied = await visuals.applySceneRegeneration("demo-story", id, original.id, fresh);
    expect(applied.scenePlan!.scenes[0]).toMatchObject({ summary: newer.scenePlan!.scenes[0]!.summary, startSeconds: original.startSeconds, endSeconds: original.endSeconds, narrationText: original.narrationText, visualPrompt: "A tighter cinematic angle at the entrance" });
    expect(applied.scenePlan!.scenes[0]!.artwork.versions).toEqual(original.artwork.versions);
    expect((await visuals.sceneArtworkGrounding("demo-story", id))[0]!.status).toBe("stale");
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
    const entityId = (await produce()).scenePlan!.scenes[0]!.entityIds![0]!;
    expect(parseSummaryArgs(["artwork", "demo-story", id, "--dry-run", "--allow-unprofiled", entityId])).toMatchObject({ action: "artwork", input: { dryRun: true, allowUnprofiledEntityIds: [entityId] } });
    expect(parseSummaryArgs(["produce", "demo-story", id, "--dry-run", "--allow-unprofiled", entityId])).toMatchObject({ action: "produce", input: { dryRun: true, allowUnprofiledEntityIds: [entityId] } });
    const command = parseSummaryArgs(["produce", "demo-story", id, "--scene-count", "2"]); let output = "";
    await runSummaryCommand(command, { root, service: summaries, media, visuals, stdout: (text) => { output += text; }, stderr: () => {} }); const summary = JSON.parse(output);
    expect(summary.video.status).toBe("current"); output = "";
    await runSummaryCommand(parseSummaryArgs(["export", "demo-story", id, "--type", "video"]), { root, service: summaries, media, visuals, stdout: (text) => { output += text; }, stderr: () => {} }); expect(JSON.parse(output).contentType).toBe("video/mp4");
    const props = { summary, base: `/stories/demo-story/summaries/${id}`, disabled: false, onChange: () => {}, onGenerate: () => {}, onError: () => {} };
    const scenePanel = renderToStaticMarkup(<SummaryScenePanel {...props} />);
    expect(scenePanel).toContain("Regenerate scene"); expect(scenePanel).toContain("Save this scene"); expect(scenePanel).toContain("Save all scene edits"); expect(scenePanel).toContain("Revert changes");
    expect(scenePanel).toContain("Image prompt only"); expect(scenePanel).toContain("Full visual direction");
    const artworkPanel = renderToStaticMarkup(<SummaryArtworkPanel {...props} />);
    expect(artworkPanel).toContain("Approve / retain"); expect(artworkPanel).toContain("Regenerate artwork from current saved scene"); expect(artworkPanel).toContain("Edit scene");
    expect(renderToStaticMarkup(<SummaryVideoPanel {...props} />)).toContain("Download MP4");
    const layers = renderToStaticMarkup(<SummaryLayers {...props} slug="demo-story" busy={false}>Canonical</SummaryLayers>);
    expect(layers).toContain("Artwork"); expect(layers).toContain('hidden=""'); expect(layers).toContain("Save this scene");
  });
  it("rejects summary CLI flags that do not apply to their command", () => {
    expect(() => parseSummaryArgs(["scenes", "demo-story", id, "--dry-run"])).toThrow(/Unknown scenes option/);
    expect(() => parseSummaryArgs(["artwork", "demo-story", id, "--pacing", "fast"])).toThrow(/Unknown artwork option/);
    expect(() => parseSummaryArgs(["video", "demo-story", id, "--missing-only"])).toThrow(/Unknown video option/);
    expect(parseSummaryArgs(["produce", "demo-story", id, "--force", "--missing-only", "--dry-run", "--scene-count", "2"])).toMatchObject({ action: "produce", input: { force: true, missingOnly: true, dryRun: true, sceneCount: 2 } });
  });
  const markStale = async (...stages: Array<"narration" | "tts" | "audio" | "scenes">) => {
    const stored = await summaries.get("demo-story", id);
    for (const stage of stages) stored[stage]!.status = "stale";
    await atomicWriteJson(summaryPath(root, "demo-story", id), stored);
  };
  const button = (markup: string, label: string) => new RegExp(`<button[^>]*>${label}</button>`).exec(markup)?.[0] ?? "";
  it("generates scenes from stale-but-valid narration and audio without regenerating upstream stages", async () => {
    await media.audio("demo-story", id); await markStale("narration", "tts", "audio");
    const before = await media.get("demo-story", id);
    expect(before).toMatchObject({ narration: { status: "stale" }, audio: { status: "stale" } }); expect(before.scenePlan).toBeUndefined();
    const llmCalls = llm.calls.length; const ttsCalls = tts.calls; const structured = vi.mocked(llm.generateStructured).mock.calls.length;
    const result = await visuals.scenes("demo-story", id, { sceneCount: 2 });
    expect(result.scenes?.status).toBe("current"); expect(result.scenePlan?.scenes).toHaveLength(2);
    // Stale audio is not a scene-generation dependency: estimated timing fallback is used.
    expect(result.scenePlan?.timingMethod).toBe("estimated");
    // Only the scene planner ran: no narration regeneration, no TTS regeneration, upstream stays stale.
    expect(vi.mocked(llm.generateStructured).mock.calls.length).toBe(structured + 1); expect(llm.calls.length).toBe(llmCalls);
    expect(tts.calls).toBe(ttsCalls);
    const after = await media.get("demo-story", id); expect(after).toMatchObject({ narration: { status: "stale" }, audio: { status: "stale" } });
    // Regenerating narration later still correctly invalidates the scenes built from the stale text.
    await media.narration("demo-story", id, { force: true });
    expect((await media.get("demo-story", id)).scenes?.status).toBe("stale");
  });
  it("blocks scene generation only when narration text is genuinely missing", async () => {
    await expect(visuals.scenes("demo-story", id, { sceneCount: 2 })).rejects.toThrow("Generate or review summary narration");
  });
  it("produces artwork from a stale-but-valid scene plan and blocks a missing plan", async () => {
    await expect(visuals.artwork("demo-story", id)).rejects.toThrow("Generate scenes before artwork production");
    await produce(); await markStale("scenes");
    expect((await visuals.get("demo-story", id)).scenes?.status).toBe("stale");
    const llmCalls = llm.calls.length;
    await visuals.artwork("demo-story", id, { force: true, scenes: ["scene-001"] });
    expect(images.generate).toHaveBeenCalledTimes(3); expect(llm.calls.length).toBe(llmCalls);
    const after = await visuals.get("demo-story", id);
    expect(after.scenes?.status).toBe("stale"); expect(after.scenePlan?.scenes[0]?.artwork.status).toBe("complete");
  });
  it("renders video from stale-but-valid audio and scenes, and blocks corrupt audio", async () => {
    await produce(); await markStale("tts", "audio", "scenes");
    const stale = await visuals.get("demo-story", id);
    expect(stale).toMatchObject({ audio: { status: "stale" }, scenes: { status: "stale" } });
    const ttsCalls = tts.calls; const imageCalls = images.generate.mock.calls.length; const llmCalls = llm.calls.length; const renders = render.mock.calls.length;
    const rendered = await visuals.video("demo-story", id, { force: true });
    expect(rendered.video?.status).toBe("current"); expect(rendered.video?.sourceFingerprint).toBe(stale.audio?.outputFingerprint);
    expect(render.mock.calls.length).toBe(renders + 1); expect(tts.calls).toBe(ttsCalls);
    expect(images.generate.mock.calls.length).toBe(imageCalls); expect(llm.calls.length).toBe(llmCalls);
    await atomicWrite(summaryMediaPaths(root, "demo-story", id).audio, "corrupt-audio");
    await expect(visuals.video("demo-story", id, { force: true })).rejects.toThrow("Usable mastered audio");
  });
  it("keeps editorial scene editing gated on reviewed current narration", async () => {
    const result = await produce(); await markStale("narration");
    await expect(visuals.editScenes("demo-story", id, { scenes: structuredClone(result.scenePlan!.scenes) })).rejects.toThrow("Review narration");
    await expect(visuals.editScenes("demo-story", id, { acceptCurrent: true })).rejects.toThrow("Review narration");
  });
  it("enables manual generation from stale-but-valid inputs in the summary panels", async () => {
    await media.audio("demo-story", id); await markStale("narration", "tts", "audio");
    const staleInputs = await media.get("demo-story", id);
    const props = { summary: staleInputs, base: `/stories/demo-story/summaries/${id}`, disabled: false, onChange: () => {}, onGenerate: () => {}, onError: () => {} };
    const scenePanel = renderToStaticMarkup(<SummaryScenePanel {...props} />);
    expect(button(scenePanel, "Generate scenes")).not.toContain("disabled");
    expect(scenePanel).toContain("Using stale narration");
    const missingNarration = renderToStaticMarkup(<SummaryScenePanel {...props} summary={{ ...staleInputs, narration: undefined }} />);
    expect(button(missingNarration, "Generate scenes")).toContain("disabled");
    vi.spyOn(llm, "generateText").mockImplementationOnce(async () => ({ text: narration, usage: { inputTokens: 10, outputTokens: 5 } }));
    await produce(); await markStale("tts", "audio", "scenes");
    const staleMedia = await visuals.get("demo-story", id);
    const artworkPanel = renderToStaticMarkup(<SummaryArtworkPanel {...props} summary={staleMedia} />);
    expect(button(artworkPanel, "Generate missing artwork")).not.toContain("disabled");
    expect(artworkPanel).toContain("The scene plan is stale");
    const videoPanel = renderToStaticMarkup(<SummaryVideoPanel {...props} summary={staleMedia} />);
    expect(button(videoPanel, "Generate / update video")).not.toContain("disabled");
    expect(videoPanel).toContain("stale audio/scene inputs");
    const currentPanel = renderToStaticMarkup(<SummaryVideoPanel {...props} summary={await visuals.get("demo-story", id)} />);
    expect(button(currentPanel, "Generate / update video")).not.toContain("disabled");
  });
});
