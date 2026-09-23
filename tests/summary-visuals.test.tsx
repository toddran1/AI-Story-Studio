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
import { MockLLM, MockTTS, pngWithDims, testStory } from "./helpers.js";
import { parseSummaryArgs, runSummaryCommand } from "../apps/cli/summary.js";
import { SummaryArtworkPanel, SummaryScenePanel, SummaryVideoPanel, summaryArtDirectionChoiceOptions } from "../apps/web/src/SummaryVisualPanels.js";
import { SummaryLayers } from "../apps/web/src/SummaryLayers.js";
import { FfmpegVideoProcessor } from "../src/video/renderer.js";
import { runCommand } from "../src/audio/ffmpeg.js";
import { JobManager } from "../apps/server/job-manager.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { saveVisualProfiles } from "../src/visual-canon/profiles.js";
import { loadStoryBibleWithCanonicalOverlay } from "../src/story-bible/canonical.js";
import { createDefaultArtDirection } from "../src/domain/art-direction.js";
import { saveStoryArtDirection } from "../src/visual-canon/art-direction.js";
import { resolveSummarySceneArtDirection } from "../src/summaries/art-direction.js";
import { normalizeSceneDirectionForFingerprint, normalizeSceneOverridesForFingerprint } from "../src/visual-canon/resolver.js";

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
  const prepareContinuityArtwork = async (model = "gpt-image-2.5-flare", references: number | Buffer[] = 0) => {
    const planned = await produce(); const entityId = planned.scenePlan!.scenes[1]!.entityIds![0]!;
    const story = testStory(); story.artwork.model = model; await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, story);
    if (references) {
      const now = new Date().toISOString(); const ids = Array.isArray(references) ? references.map((_, index) => `budget-ref-${index}`) : Array.from({ length: references }, (_, index) => `budget-ref-${index}`);
      await saveVisualProfiles(root, "demo-story", { [entityId]: { id: `vp-${entityId}`, entityId, visualType: "character", status: "approved", revision: 2, createdAt: now, updatedAt: now, appearance: "A person", visualPrompt: "person", notes: "", character: {}, variants: [], references: ids.map((refId, index) => ({ id: refId, entityId, imagePath: `${refId}.png`, role: index === 0 ? "primary_reference" as const : "face_portrait" as const, source: "uploaded" as const, approved: true, createdAt: now })) } });
      for (const [index, refId] of ids.entries()) await atomicWrite(visualProfileRefPath(root, "demo-story", entityId, refId, "png"), Array.isArray(references) ? references[index]! : PNG);
    }
    await visuals.reviewArtwork("demo-story", id, "scene-001", "approved");
    images.generate.mockClear(); await visuals.artwork("demo-story", id, { force: true, scenes: ["scene-002"] });
    return planned;
  };
  const changeApprovedPreviousImage = async (changeVersionIdentity = false) => {
    const stored = await summaries.get("demo-story", id); const first = stored.scenePlan!.scenes[0]!;
    const version = first.artwork.versions!.find((item) => item.id === first.artwork.approvedVersionId)!;
    const replacement = pngWithDims(2, 1); const paths = visuals.paths("demo-story", id);
    await atomicWrite(paths.sceneVersionImage(first.id, version.versionNumber), replacement); await atomicWrite(paths.image(first.id), replacement);
    const changedFingerprint = (await fileFingerprint(paths.sceneVersionImage(first.id, version.versionNumber)))!;
    version.imageFingerprint = changedFingerprint; first.artwork.imageFingerprint = changedFingerprint;
    if (changeVersionIdentity) { version.id = "approved-version-revised"; first.artwork.approvedVersionId = version.id; }
    await atomicWriteJson(summaryPath(root, "demo-story", id), stored);
  };
  const sceneEdit = (scene: NonNullable<Awaited<ReturnType<typeof produce>>["scenePlan"]>["scenes"][number], patch: Record<string, unknown> = {}) => ({ scene: {
    summary: scene.summary, visualPrompt: scene.visualPrompt, characters: scene.characters, entityIds: scene.entityIds ?? [],
    location: scene.location, startSeconds: scene.startSeconds, endSeconds: scene.endSeconds,
    disabled: scene.disabled, importance: scene.importance, direction: scene.direction, overrides: scene.overrides,
    ...patch,
  } });
  it("resolves story, summary and scene art direction with safe fallback for deleted presets", async () => {
    const direction = createDefaultArtDirection();
    direction.presets.push({ ...direction.presets[0]!, id: "preset-flashback", name: "Flashback", isDefault: false, customStylePrompt: "soft sepia memory" });
    const plan = await produce(); const scene = plan.scenePlan!.scenes[0]!;
    expect(resolveSummarySceneArtDirection(direction, undefined, scene)).toMatchObject({ source: "story-default", preset: { id: "preset_main_style" } });
    expect(resolveSummarySceneArtDirection(direction, { mode: "preset", presetId: "preset-flashback" }, scene)).toMatchObject({ source: "summary-override", preset: { id: "preset-flashback" } });
    expect(resolveSummarySceneArtDirection(direction, { mode: "disabled" }, scene).source).toBe("disabled");
    const storyDefaultScene = { ...scene, overrides: { ...scene.overrides, artDirectionMode: "story-default" as const } };
    expect(resolveSummarySceneArtDirection(direction, { mode: "preset", presetId: "preset-flashback" }, storyDefaultScene)).toMatchObject({ source: "story-default", preset: { id: "preset_main_style" } });
    const ownPreset = { ...scene, overrides: { ...scene.overrides, artDirectionPresetId: "preset-main" } };
    expect(resolveSummarySceneArtDirection(direction, { mode: "preset", presetId: "preset-flashback" }, ownPreset)).toMatchObject({ source: "story-default", preset: { id: "preset_main_style" }, missingPresetId: "preset-main" });
    const own = { ...scene, overrides: { ...scene.overrides, artDirectionPresetId: "preset-flashback" } };
    expect(resolveSummarySceneArtDirection(direction, { mode: "disabled" }, own)).toMatchObject({ source: "scene-override", preset: { id: "preset-flashback" } });
    const pinned = { mode: "preset" as const, presetId: "preset_main_style" };
    direction.presets[0]!.isDefault = false; direction.presets.push({ ...direction.presets[0]!, id: "preset-battle", name: "Battle Cinematic", isDefault: true, customStylePrompt: "battle style" });
    direction.activePresetId = "preset-battle";
    expect(resolveSummarySceneArtDirection(direction, { mode: "story-default" }, scene).preset.id).toBe("preset-battle");
    expect(resolveSummarySceneArtDirection(direction, pinned, scene).preset.id).toBe("preset_main_style");
  });
  it("normalizes equivalent direction and override storage shapes for shared Visual Canon fingerprints", () => {
    expect(normalizeSceneDirectionForFingerprint(undefined)).toEqual(normalizeSceneDirectionForFingerprint({ characterExpressions: {}, useCharacterReferences: true, useCreatureReferences: true, useLocationReferences: true, preserveWardrobeEquipment: true, useStoryArtDirection: true }));
    expect(normalizeSceneDirectionForFingerprint({ characterExpressions: { "ent_empty": "  " } })).toEqual(normalizeSceneDirectionForFingerprint(undefined));
    expect(normalizeSceneOverridesForFingerprint(undefined)).toEqual(normalizeSceneOverridesForFingerprint({ wardrobeOverrides: {}, artDirectionMode: "inherit-summary", customVisualPrompt: " ", customNegativePrompt: "" }));
    expect(normalizeSceneOverridesForFingerprint({ artDirectionMode: "story-default" })).not.toEqual(normalizeSceneOverridesForFingerprint(undefined));
    expect(normalizeSceneDirectionForFingerprint({ useStoryArtDirection: false })).not.toEqual(normalizeSceneDirectionForFingerprint(undefined));
    expect(normalizeSceneDirectionForFingerprint({ cameraAngle: "low_angle" })).not.toEqual(normalizeSceneDirectionForFingerprint(undefined));
  });
  it("returns artwork to current when edited direction is restored to the generated effective defaults", async () => {
    const planned = await produce(); const scene = planned.scenePlan!.scenes[0]!;
    const originalFingerprint = scene.artwork.fingerprint;
    const low = await visuals.updateScene("demo-story", id, scene.id, sceneEdit(scene, { direction: { ...(scene.direction ?? {}), cameraAngle: "low_angle" } }));
    expect(await visuals.artwork("demo-story", id, { dryRun: true })).toMatchObject({ sceneIds: [scene.id], imagesToGenerate: 1 });
    const changed = low.scenePlan!.scenes[0]!;
    await visuals.updateScene("demo-story", id, scene.id, sceneEdit(changed, { direction: { ...(changed.direction ?? {}), cameraAngle: undefined } }));
    expect(await visuals.artwork("demo-story", id, { dryRun: true })).toMatchObject({ sceneIds: [], imagesToGenerate: 0 });
    expect((await visuals.get("demo-story", id)).artwork?.status).toBe("current");
    expect((await summaries.get("demo-story", id)).scenePlan!.scenes[0]!.artwork.fingerprint).toBe(originalFingerprint);
  });
  it("immediately reconciles per-scene and aggregate freshness on semantic art-direction updates", async () => {
    const planned = await produce();
    const direction = createDefaultArtDirection();
    direction.presets.push({ ...direction.presets[0]!, id: "preset-flashback", name: "Flashback", isDefault: false, customStylePrompt: "soft sepia memory" });
    await saveStoryArtDirection(root, "demo-story", direction);
    const second = planned.scenePlan!.scenes[1]!;
    await visuals.updateScene("demo-story", id, second.id, sceneEdit(second, { overrides: { ...(second.overrides ?? {}), artDirectionMode: "story-default" } }));
    await visuals.artwork("demo-story", id, { force: true, scenes: [second.id] });
    await visuals.video("demo-story", id);

    const operations = new StudioOperations(root, loadEnvironment({}), undefined, { llm: new LLMRouter(new Map([["openai", llm]])), tts, image: images, video: { version: "fake-video", render },
      censor: { version: "fake-censor", synthesize: async (provider, request) => provider.synthesize(request) }, audio: { version: "fake-master", master: async (_inputs, path) => { await atomicWrite(path, "fake-mastered-audio"); return { durationSeconds: 12, codec: "mp3", container: "mp3" }; } } });
    try {
      const providerCalls = { images: images.generate.mock.calls.length, renders: render.mock.calls.length, llm: llm.calls.length, tts: tts.calls };
      const changed = await operations.updateSummary("demo-story", id, { artDirectionOverride: { mode: "preset", presetId: "preset-flashback" } });
      expect(changed).toMatchObject({ artwork: { status: "stale" }, video: { status: "stale" } });
      expect(await visuals.artwork("demo-story", id, { dryRun: true })).toMatchObject({ sceneIds: ["scene-001"], imagesToGenerate: 1 });
      expect(images.generate).toHaveBeenCalledTimes(providerCalls.images); expect(render).toHaveBeenCalledTimes(providerCalls.renders); expect(llm.calls).toHaveLength(providerCalls.llm); expect(tts.calls).toBe(providerCalls.tts);

      const same = await operations.updateSummary("demo-story", id, { artDirectionOverride: { mode: "preset", presetId: "preset-flashback" } });
      expect(same).toMatchObject({ artwork: { status: "stale" }, video: { status: "stale" } });
      expect(images.generate).toHaveBeenCalledTimes(providerCalls.images);
      const restored = await operations.updateSummary("demo-story", id, { artDirectionOverride: { mode: "story-default" } });
      expect(restored).toMatchObject({ artwork: { status: "current" }, video: { status: "current" } });
      expect(images.generate).toHaveBeenCalledTimes(providerCalls.images);

      // Both remaining scenes now opt out of Summary direction (one directly,
      // one through Story Default); changing the Summary selection affects neither.
      const first = changed.scenePlan!.scenes[0]!;
      await operations.updateSummary("demo-story", id, { artDirectionOverride: { mode: "disabled" } });
      await visuals.updateScene("demo-story", id, first.id, sceneEdit(restored.scenePlan!.scenes[0]!, { direction: { ...(restored.scenePlan!.scenes[0]!.direction ?? {}), useStoryArtDirection: false } }));
      await visuals.artwork("demo-story", id, { force: true, scenes: [first.id] });
      await visuals.video("demo-story", id);
      const noEffectiveChange = await operations.updateSummary("demo-story", id, { artDirectionOverride: { mode: "preset", presetId: "preset-flashback" } });
      expect(noEffectiveChange).toMatchObject({ artwork: { status: "current" }, video: { status: "current" } });
      expect(images.generate).toHaveBeenCalledTimes(providerCalls.images + 1);
    } finally { await operations.close(); }
  });
  it("omits all Story Art Direction text while retaining scene canon and custom instructions", async () => {
    const planned = await produce();
    const direction = createDefaultArtDirection("UNIQUE STORY DIRECTION SHOULD NOT APPEAR");
    direction.presets[0]!.globalNegativePrompt = "UNIQUE GLOBAL NEGATIVE SHOULD NOT APPEAR";
    await saveStoryArtDirection(root, "demo-story", direction);
    const story = testStory(); story.artwork.stylePrompt = "UNIQUE BOOK STYLE SHOULD NOT APPEAR"; await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, story);
    const scene = planned.scenePlan!.scenes[0]!;
    await visuals.updateScene("demo-story", id, scene.id, sceneEdit(scene, {
      direction: { ...(scene.direction ?? {}), useStoryArtDirection: false, cameraAngle: "low_angle" },
      overrides: { ...(scene.overrides ?? {}), customVisualPrompt: "UNIQUE SCENE PROMPT MUST APPEAR", customNegativePrompt: "UNIQUE SCENE NEGATIVE MUST APPEAR" },
    }));
    images.generate.mockClear();
    await visuals.artwork("demo-story", id, { force: true, scenes: [scene.id] });
    const request = images.generate.mock.calls[0]![0];
    expect(request.prompt).not.toContain("UNIQUE STORY DIRECTION SHOULD NOT APPEAR");
    expect(request.prompt).not.toContain("UNIQUE BOOK STYLE SHOULD NOT APPEAR");
    expect(request.prompt).toContain("UNIQUE SCENE PROMPT MUST APPEAR");
    expect(request.prompt).toContain("ENTITY VISUAL CANON");
    expect(request.prompt).toContain("SCENE-STATE PRIORITY");
    expect(request.negativePrompt).not.toContain("UNIQUE GLOBAL NEGATIVE SHOULD NOT APPEAR");
    expect(request.negativePrompt).toContain("UNIQUE SCENE NEGATIVE MUST APPEAR");
  });
  it("saves summary art direction without provider calls and only invalidates scenes that inherit it", async () => {
    const planned = await produce();
    const direction = createDefaultArtDirection();
    direction.presets.push({ ...direction.presets[0]!, id: "preset-flashback", name: "Flashback", isDefault: false, customStylePrompt: "soft sepia memory" });
    await saveStoryArtDirection(root, "demo-story", direction);
    const second = planned.scenePlan!.scenes[1]!;
    await visuals.updateScene("demo-story", id, second.id, sceneEdit(second, { overrides: { ...second.overrides, artDirectionPresetId: "preset_main_style" } }));
    await visuals.artwork("demo-story", id, { scenes: [second.id] });
    const imageCalls = images.generate.mock.calls.length, llmCalls = llm.calls.length, ttsCalls = tts.calls;
    const updated = await summaries.update("demo-story", id, { artDirectionOverride: { mode: "preset", presetId: "preset-flashback" } });
    expect(updated.artDirectionOverride).toEqual({ mode: "preset", presetId: "preset-flashback" });
    expect(images.generate).toHaveBeenCalledTimes(imageCalls); expect(llm.calls).toHaveLength(llmCalls); expect(tts.calls).toBe(ttsCalls);
    const planAfterChange = await visuals.artwork("demo-story", id, { dryRun: true });
    expect(planAfterChange).toMatchObject({ sceneIds: ["scene-001"], imagesToGenerate: 1 });
    const stored = await summaries.get("demo-story", id);
    expect(stored.narration?.status).toBe("current"); expect(stored.scenePlan!.scenes[1]!.artwork.versions!.at(-1)?.provenance?.artDirection).toMatchObject({ source: "scene-override", presetId: "preset_main_style", presetName: "Main Style" });
  });
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
  it("blocks Produce before upstream provider stages when a reusable scene plan has unresolved profiles", async () => {
    await media.narration("demo-story", id); await media.audio("demo-story", id); await visuals.scenes("demo-story", id, { sceneCount: 2 });
    await saveVisualProfiles(root, "demo-story", {});
    const llmCalls = llm.calls.length, ttsCalls = tts.calls;
    const result = await visuals.produce("demo-story", id, { sceneCount: 2 });
    expect(result).toMatchObject({ status: "blocked", reason: "visual-profile-decisions-required", beforeUpstream: true, preflight: { ready: false, requiresDecision: [{ name: "Su Ming" }] } });
    expect(llm.calls.length).toBe(llmCalls); expect(tts.calls).toBe(ttsCalls); expect(images.generate).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
  });
  it("preflights an authoritative manually edited scene plan before upstream work when it is still reusable", async () => {
    const planned = await produce(); const first = planned.scenePlan!.scenes[0]!;
    await visuals.updateScene("demo-story", id, first.id, sceneEdit(first, { visualPrompt: "Manually approved framing" }));
    await saveVisualProfiles(root, "demo-story", {}); const llmCalls = llm.calls.length, ttsCalls = tts.calls;
    const result = await visuals.produce("demo-story", id, { pacing: "custom", sceneCount: 2 });
    expect(result).toMatchObject({ status: "blocked", beforeUpstream: true, preflight: { requiresDecision: [{ name: "Su Ming" }] } });
    expect(llm.calls.length).toBe(llmCalls); expect(tts.calls).toBe(ttsCalls);
  });
  it("does not early-preflight a manually edited plan whose narration source fingerprint is stale", async () => {
    const planned = await produce(); await visuals.updateScene("demo-story", id, planned.scenePlan!.scenes[0]!.id, sceneEdit(planned.scenePlan!.scenes[0]!, { visualPrompt: "Reviewed manual framing" }));
    await saveVisualProfiles(root, "demo-story", {}); images.generate.mockClear(); render.mockClear();
    const stored = await summaries.get("demo-story", id); stored.scenes!.sourceFingerprint = "outdated-source";
    await atomicWriteJson(summaryPath(root, "demo-story", id), stored);
    const result = visuals.produce("demo-story", id, { pacing: "custom", sceneCount: 2 });
    await expect(result).rejects.toThrow("Manual scenes require explicit regeneration");
    // If Produce had incorrectly trusted the old scene entities, it would have
    // returned a blocked Visual Profile preflight instead of honoring the scene
    // service's manual-plan guard.
    expect(images.generate).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
  });
  it("does not early-preflight old entities when the scene planner configuration changed", async () => {
    await produce(); await saveVisualProfiles(root, "demo-story", {}); images.generate.mockClear(); render.mockClear();
    const story = testStory(); story.pipeline.scenePlanner.model = "gpt-6-sol"; await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, story);
    const result = await visuals.produce("demo-story", id, { pacing: "custom", sceneCount: 2 });
    expect(result).toMatchObject({ status: "blocked", beforeUpstream: false, preflight: { requiresDecision: [{ name: "Su Ming" }] } });
    expect(llm.calls.length).toBeGreaterThan(1); expect(images.generate).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
  });
  it("plans first when requested pacing differs instead of prompting for the old plan", async () => {
    await produce(); await saveVisualProfiles(root, "demo-story", {}); images.generate.mockClear(); render.mockClear();
    const result = await visuals.produce("demo-story", id, { pacing: "custom", sceneCount: 1 });
    expect(result).toMatchObject({ status: "blocked", beforeUpstream: false, preflight: { requiresDecision: [{ name: "Su Ming" }] } });
    expect(llm.calls.length).toBeGreaterThan(1); expect(images.generate).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
  });
  it("does not preflight old scene entities when force requests a replacement plan", async () => {
    await produce(); await saveVisualProfiles(root, "demo-story", {}); images.generate.mockClear(); render.mockClear();
    const replacement = (request: any) => request.schema.parse({ scenes: [
      { summary: "Other arrives", startSeconds: 0, endSeconds: 6, characters: ["Other"], visualPrompt: "A companion arrives", importance: "standard", narrationStartWord: 0, narrationEndWord: 4 },
      { summary: "Other advances", startSeconds: 6, endSeconds: 12, characters: ["Other"], visualPrompt: "The companion advances", importance: "major", narrationStartWord: 4, narrationEndWord: 8 },
    ] });
    const bible = await loadStoryBibleWithCanonicalOverlay(root, "demo-story");
    const updated = mergeStoryBible(bible, storyBibleUpdateSchema.parse({ chapterSummary: "Dungeon", characters: [{ canonicalEnglishName: "Other", originalName: "其他", firstSeenChapter: 1, lastSeenChapter: 1, description: "A companion" }] }), 1);
    await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, updated);
    vi.spyOn(llm, "generateStructured").mockImplementation(async (request) => ({ value: replacement(request) }));
    const result = await visuals.produce("demo-story", id, { force: true, pacing: "custom", sceneCount: 2 });
    expect(result).toMatchObject({ status: "blocked", beforeUpstream: false, preflight: { requiresDecision: [{ name: "Other" }] } });
    expect(result.preflight.requiresDecision).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "Su Ming" })]));
    expect(images.generate).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
    const plan = await media.get("demo-story", id); expect(plan.scenePlan!.scenes.every((scene) => scene.characters.includes("Other"))).toBe(true);
    const entityId = updated.canonicalEntities.find((entity) => entity.canonicalName === "Other")!.id; const now = new Date().toISOString();
    await saveVisualProfiles(root, "demo-story", { [entityId]: { id: "vp-other", entityId, visualType: "character", status: "approved", revision: 1, createdAt: now, updatedAt: now, appearance: "A companion", visualPrompt: "companion", notes: "", character: {}, variants: [], references: [] } });
    const modelCalls = llm.calls.length, ttsCalls = tts.calls;
    const resumed = await visuals.produce("demo-story", id, { pacing: "custom", sceneCount: 2 });
    expect(resumed.video?.status).toBe("current"); expect(llm.calls.length).toBe(modelCalls); expect(tts.calls).toBe(ttsCalls);
  });
  it("does not prompt for an old unresolved entity removed by the newly generated plan", async () => {
    await produce(); await saveVisualProfiles(root, "demo-story", {});
    vi.spyOn(llm, "generateStructured").mockImplementation(async (request) => ({ value: request.schema.parse({ scenes: [
      { summary: "A quiet threshold", startSeconds: 0, endSeconds: 6, characters: [], visualPrompt: "A quiet empty dungeon threshold", importance: "standard", narrationStartWord: 0, narrationEndWord: 4 },
      { summary: "A dark corridor", startSeconds: 6, endSeconds: 12, characters: [], visualPrompt: "An empty corridor", importance: "major", narrationStartWord: 4, narrationEndWord: 8 },
    ] }) }));
    const result = await visuals.produce("demo-story", id, { force: true, pacing: "custom", sceneCount: 2 });
    expect(result.status).not.toBe("blocked"); expect(result.video?.status).toBe("current");
    expect(images.generate).toHaveBeenCalled(); expect(render).toHaveBeenCalled();
  });
  it("preserves newly generated narration, audio and scenes when post-planning preflight blocks Produce", async () => {
    await saveVisualProfiles(root, "demo-story", {});
    const result = await visuals.produce("demo-story", id, { pacing: "custom", sceneCount: 2 });
    expect(result).toMatchObject({ status: "blocked", reason: "visual-profile-decisions-required", beforeUpstream: false });
    const saved = await media.get("demo-story", id);
    expect(saved.narration?.text).toBeTruthy(); expect(saved.audio?.outputFingerprint).toBeTruthy(); expect(saved.scenePlan?.scenes).toHaveLength(2);
    expect(images.generate).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
  });
  it("does not invent historical grounding for legacy summary artwork", async () => {
    const produced = await produce();
    const stored = await media.get("demo-story", id) as any;
    delete stored.scenePlan.scenes[0].artwork.versions[0].provenance;
    await atomicWriteJson(summaryPath(root, "demo-story", id), stored);
    const grounding = await visuals.sceneArtworkGrounding("demo-story", id);
    expect(grounding[0]).toMatchObject({ legacyGroundingUnknown: true, groundingRecorded: false, grounding: [] });
    expect(produced.scenePlan?.scenes[0]?.artwork.imageFingerprint).toBeTruthy();
  });
  it("uses an intact approved previous summary-scene image as a bounded continuity reference", async () => {
    await produce();
    const story = testStory(); story.artwork.model = "gpt-image-2.5-flare"; await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, story);
    await visuals.reviewArtwork("demo-story", id, "scene-001", "approved");
    images.generate.mockClear();
    const result = await visuals.artwork("demo-story", id, { force: true, scenes: ["scene-002"] });
    expect(images.generate.mock.calls[0]![0].referenceImages).toHaveLength(1);
    expect(images.generate.mock.calls[0]![0].referenceImages[0]).toMatchObject({ role: "previous-scene" });
    expect(result.scenePlan?.scenes[1]?.artwork.versions?.at(-1)?.provenance).toMatchObject({
      continuityReference: { kind: "previous-scene", used: true, sourceSceneId: "scene-001", versionNumber: 1 },
    });
  });
  it("invalidates downstream artwork when an actually-used previous-scene image changes", async () => {
    await prepareContinuityArtwork();
    expect((await visuals.sceneArtworkGrounding("demo-story", id))[1]).toMatchObject({ status: "current" });
    await changeApprovedPreviousImage();
    expect((await visuals.sceneArtworkGrounding("demo-story", id))[1]).toMatchObject({ status: "stale" });
  });
  it("does not fingerprint the unused previous image when reference count is full, preserving provenance", async () => {
    await prepareContinuityArtwork("gpt-image-2.5-flare", 4);
    const before = await summaries.get("demo-story", id);
    expect(before.scenePlan!.scenes[1]!.artwork.versions!.at(-1)!.provenance).toMatchObject({
      continuityReference: { kind: "previous-scene", used: false, sourceSceneId: "scene-001", reason: expect.stringContaining("count budget") },
    });
    expect((await visuals.sceneArtworkGrounding("demo-story", id))[1]).toMatchObject({ status: "current" });
    await changeApprovedPreviousImage(true);
    expect((await visuals.sceneArtworkGrounding("demo-story", id))[1]).toMatchObject({ status: "current" });
  });
  it("does not fingerprint the unused previous image when the reference byte budget is full", async () => {
    const fullBudgetReferences = Array.from({ length: 3 }, () => Buffer.alloc(8 * 1024 * 1024, 7));
    await prepareContinuityArtwork("gpt-image-2.5-flare", fullBudgetReferences);
    const before = await summaries.get("demo-story", id);
    expect(before.scenePlan!.scenes[1]!.artwork.versions!.at(-1)!.provenance).toMatchObject({
      continuityReference: { kind: "previous-scene", used: false, reason: expect.stringContaining("budget") },
    });
    await changeApprovedPreviousImage(true);
    expect((await visuals.sceneArtworkGrounding("demo-story", id))[1]).toMatchObject({ status: "current" });
  });
  it("keeps text-only continuity stable when the configured image provider cannot accept references", async () => {
    await prepareContinuityArtwork("gpt-image-1");
    const before = await summaries.get("demo-story", id);
    expect(before.scenePlan!.scenes[1]!.artwork.versions!.at(-1)!.provenance).toMatchObject({
      continuityReference: { kind: "previous-scene", used: false, sourceSceneId: "scene-001", reason: expect.stringContaining("cannot consume") },
    });
    await changeApprovedPreviousImage(true);
    expect((await visuals.sceneArtworkGrounding("demo-story", id))[1]).toMatchObject({ status: "current" });
  });
  it("uses text-only fallback for a corrupt previous image without retaining stale image identity", async () => {
    const planned = await produce(); const story = testStory(); story.artwork.model = "gpt-image-2.5-flare"; await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, story);
    await visuals.reviewArtwork("demo-story", id, "scene-001", "approved");
    await atomicWrite(visuals.paths("demo-story", id).sceneVersionImage("scene-001", 1), "corrupt image");
    const generated = await visuals.artwork("demo-story", id, { force: true, scenes: ["scene-002"] });
    const provenance = generated.scenePlan!.scenes[1]!.artwork.versions!.at(-1)!.provenance;
    expect(provenance).toMatchObject({ continuityReference: { kind: "previous-scene", used: false, sourceSceneId: "scene-001", versionNumber: 1, reason: expect.stringContaining("unavailable") } });
    expect((await visuals.sceneArtworkGrounding("demo-story", id))[1]).toMatchObject({ status: "current" });
    expect(planned.scenePlan!.scenes[1]!.artwork.imageFingerprint).toBeTruthy();
  });
  it("still invalidates artwork when the textual continuity state changes", async () => {
    const planned = await produce(); const scenes = structuredClone(planned.scenePlan!.scenes);
    scenes[0]!.visualChanges = { environment: { set: { description: "A ruined dungeon" } } };
    await visuals.editScenes("demo-story", id, { scenes });
    expect((await visuals.sceneArtworkGrounding("demo-story", id))[1]).toMatchObject({ status: "stale" });
  });
  it("allocates the shared reference budget primary-first across visible entities", async () => {
    await media.narration("demo-story", id); await media.audio("demo-story", id); let planned = await visuals.scenes("demo-story", id, { sceneCount: 2 });
    const story = testStory(); story.artwork.model = "gpt-image-2.5-flare"; await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, story);
    const bible = await loadStoryBibleWithCanonicalOverlay(root, "demo-story");
    const updated = mergeStoryBible(bible, storyBibleUpdateSchema.parse({ chapterSummary: "Dungeon", characters: [{ canonicalEnglishName: "Other", originalName: "其他", firstSeenChapter: 1, lastSeenChapter: 1, description: "A companion" }] }), 1);
    const secondId = updated.canonicalEntities.find((entity) => entity.canonicalName === "Other")!.id;
    await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, updated);
    await media.narration("demo-story", id, { force: true }); await media.audio("demo-story", id, { force: true }); planned = await visuals.scenes("demo-story", id, { sceneCount: 2, force: true });
    const now = new Date().toISOString(); const firstId = planned.scenePlan!.scenes[0]!.entityIds![0]!;
    const profile = (entityId: string, referenceIds: string[]) => ({ id: `vp-${entityId}`, entityId, visualType: "character" as const, status: "approved" as const, revision: 1, createdAt: now, updatedAt: now, appearance: "A person", visualPrompt: "person", notes: "", character: {}, variants: [], references: referenceIds.map((refId, index) => ({ id: refId, entityId, imagePath: `${refId}.png`, role: index === 0 ? "primary_reference" as const : "face_portrait" as const, source: "uploaded" as const, approved: true, createdAt: now })) });
    await saveVisualProfiles(root, "demo-story", { [firstId]: profile(firstId, ["first-primary", "first-extra"]), [secondId]: profile(secondId, ["second-primary", "second-extra"]) });
    for (const refId of ["first-primary", "first-extra", "second-primary", "second-extra"]) await atomicWrite(visualProfileRefPath(root, "demo-story", refId.startsWith("first") ? firstId : secondId, refId, "png"), PNG);
    const scenes = structuredClone(planned.scenePlan!.scenes); scenes[0]!.characters = ["Su Ming", "Other"]; scenes[0]!.entityIds = [firstId, secondId];
    await visuals.editScenes("demo-story", id, { scenes }); images.generate.mockClear();
    await visuals.artwork("demo-story", id, { force: true, scenes: ["scene-001"] });
    const refs = images.generate.mock.calls[0]![0].referenceImages;
    expect(refs).toHaveLength(4);
    expect(refs.map((reference: { role: string }) => reference.role)).toEqual(["primary_reference", "primary_reference", "face_portrait", "face_portrait"]);
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
  it("keeps artwork current for timing-only and voice changes and reconciles video against actual image fingerprints", async () => {
    const result = await produce(); const scenes = structuredClone(result.scenePlan!.scenes); scenes[0]!.endSeconds = 7; scenes[1]!.startSeconds = 7;
    await visuals.editScenes("demo-story", id, { scenes }); expect((await visuals.get("demo-story", id)).artwork?.status).toBe("current"); expect((await visuals.get("demo-story", id)).video?.status).toBe("stale");
    const reused = await produce(); expect(reused.scenePlan?.scenes[1]?.startSeconds).toBe(7); expect(images.generate).toHaveBeenCalledTimes(2);
    await visuals.video("demo-story", id); await visuals.artwork("demo-story", id, { force: true, scenes: ["scene-001"] });
    expect(images.generate).toHaveBeenCalledTimes(3); expect(await visuals.get("demo-story", id)).toMatchObject({ narration: { status: "current" }, audio: { status: "current" }, scenes: { status: "current" }, video: { status: "current" } });
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
    const result = await produce(); const initial = result.scenePlan!.scenes[0]!;
    const direction = { ...initial.direction!, cameraAngle: "low_angle" as const, useCharacterReferences: false };
    const overrides = { ...initial.overrides!, customVisualPrompt: "Keep a silver crescent on the gauntlet", customNegativePrompt: "no modern clothing" };
    const edited = await visuals.updateScene("demo-story", id, initial.id, sceneEdit(initial, { direction, overrides }));
    const protectedScene = structuredClone(result.scenePlan!.scenes[1]!);
    let regenerationInput = "";
    vi.spyOn(llm, "generateStructured").mockImplementation(async (request) => { regenerationInput = request.input; return { value: request.schema.parse({ scenes: [{ summary: "New arrival", startSeconds: 0, endSeconds: 8, characters: ["Malakai"], visualPrompt: "A new arrival at the dungeon", importance: "major" }] }) }; });
    const proposal = await media.previewSceneRegeneration("demo-story", id, "scene-001", { mode: "full_visual_direction" });
    expect(regenerationInput).toContain("Keep a silver crescent on the gauntlet"); expect(regenerationInput).toContain("low_angle");
    expect((await visuals.get("demo-story", id)).scenePlan?.scenes[0]?.summary).toBe(result.scenePlan?.scenes[0]?.summary);
    const regenerated = await visuals.applySceneRegeneration("demo-story", id, "scene-001", proposal); expect(regenerated.scenePlan?.scenes[1]).toEqual(protectedScene); expect(regenerated.scenePlan?.scenes[0]?.narrationText).toBe(result.scenePlan?.scenes[0]?.narrationText); expect(regenerated.scenePlan?.scenes[0]?.direction).toMatchObject(direction); expect(regenerated.scenePlan?.scenes[0]?.overrides).toMatchObject(overrides);
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
  it("approves a preserved historical summary image without generating a new one", async () => {
    const first = await produce();
    const sceneId = first.scenePlan!.scenes[0]!.id;
    const initialVersion = first.scenePlan!.scenes[0]!.artwork.versions![0]!;
    const imageCalls = images.generate.mock.calls.length;
    await visuals.artwork("demo-story", id, { force: true, scenes: [sceneId] });
    const afterGeneration = await visuals.get("demo-story", id);
    expect(afterGeneration.scenePlan!.scenes[0]!.artwork.versions).toHaveLength(2);
    const approved = await visuals.reviewArtworkVersion("demo-story", id, sceneId, initialVersion.id);
    expect(approved.scenePlan!.scenes[0]!.artwork.approvedVersionId).toBe(initialVersion.id);
    expect(approved.scenePlan!.scenes[0]!.artwork.versions![0]!.review).toBe("approved");
    expect(await fileFingerprint(visuals.paths("demo-story", id).image(sceneId))).toBe(approved.scenePlan!.scenes[0]!.artwork.imageFingerprint);
    expect(images.generate.mock.calls.length).toBe(imageCalls + 1);
    expect((await visuals.exportArtworkVersion("demo-story", id, sceneId, initialVersion.id)).path).toContain("scene-001-v1.png");
    await expect(visuals.reviewArtworkVersion("demo-story", id, sceneId, "v999")).rejects.toThrow("not found");
  });
  it("uses shared continuity overrides for summary reference policy and prompt staleness", async () => {
    const produced = await produce();
    const secondId = produced.scenePlan!.scenes[1]!.id;
    await visuals.reviewArtwork("demo-story", id, "scene-001", "approved");
    const before = (await visuals.sceneContinuityDetail("demo-story", id)).find((item) => item.sceneId === secondId)!.continuity!;
    expect(before.referenceDecision?.kind).toBe("previous-scene");
    const changed = await visuals.updateSceneContinuity("demo-story", id, secondId, { note: "The silver staff remains in Malakai's left hand", usePreviousReference: "avoid" });
    const state = changed.find((item) => item.sceneId === secondId)!.continuity!;
    expect(state.manualOverride?.note).toContain("silver staff");
    expect(state.referenceDecision?.used).toBe(false);
    expect((await visuals.sceneArtworkGrounding("demo-story", id)).find((item) => item.sceneId === secondId)?.status).toBe("stale");
    images.generate.mockClear();
    await visuals.artwork("demo-story", id, { force: true, scenes: [secondId] });
    expect(images.generate.mock.calls[0]?.[0]?.prompt).toContain("silver staff remains");
    const restored = await visuals.resetSceneContinuity("demo-story", id, secondId);
    expect(restored.find((item) => item.sceneId === secondId)!.continuity!.manualOverride).toBeUndefined();
  });
  it("previews image-prompt regeneration without writes and rejects a proposal after a newer scene edit", async () => {
    const before = await produce(); const original = structuredClone(before.scenePlan!.scenes[0]!);
    const direction = { ...original.direction!, composition: "symmetrical" as const, useLocationReferences: false };
    const overrides = { ...original.overrides!, customVisualPrompt: "Keep the cracked red lantern", wardrobeOverrides: { "Malakai": "black travel cloak" } };
    await visuals.updateScene("demo-story", id, original.id, sceneEdit(original, { direction, overrides }));
    const configured = (await summaries.get("demo-story", id)).scenePlan!.scenes[0]!;
    const storedBefore = await readFile(summaryPath(root, "demo-story", id), "utf8");
    let regenerationInput = "";
    vi.spyOn(llm, "generateStructured").mockImplementation(async (request) => { regenerationInput = request.input; return { value: request.schema.parse({ visualPrompt: "A tighter cinematic angle at the entrance" }) }; });
    const proposal = await media.previewSceneRegeneration("demo-story", id, original.id, { mode: "image_prompt" });
    expect(regenerationInput).toContain("Keep the cracked red lantern"); expect(regenerationInput).toContain("black travel cloak");
    expect(proposal.proposed).toMatchObject({ summary: original.summary, characters: original.characters, location: original.location, importance: original.importance, visualPrompt: "A tighter cinematic angle at the entrance" });
    expect(await readFile(summaryPath(root, "demo-story", id), "utf8")).toBe(storedBefore);
    const newer = await visuals.updateScene("demo-story", id, original.id, sceneEdit(configured, { summary: "A manual visual beat" }));
    await expect(visuals.applySceneRegeneration("demo-story", id, original.id, proposal)).rejects.toThrow("changed since the proposal");
    expect((await visuals.get("demo-story", id)).scenePlan!.scenes[0]!.summary).toBe("A manual visual beat");
    const fresh = await media.previewSceneRegeneration("demo-story", id, original.id, { mode: "image_prompt" });
    const applied = await visuals.applySceneRegeneration("demo-story", id, original.id, fresh);
    expect(applied.scenePlan!.scenes[0]).toMatchObject({ summary: newer.scenePlan!.scenes[0]!.summary, startSeconds: original.startSeconds, endSeconds: original.endSeconds, narrationText: original.narrationText, visualPrompt: "A tighter cinematic angle at the entrance" });
    expect(applied.scenePlan!.scenes[0]!.artwork.versions).toEqual(original.artwork.versions); expect(applied.scenePlan!.scenes[0]!.direction).toMatchObject(direction); expect(applied.scenePlan!.scenes[0]!.overrides).toMatchObject(overrides);
    expect((await visuals.sceneArtworkGrounding("demo-story", id))[0]!.status).toBe("stale");
  });
  it("surfaces image/video failures, preserves successful work and rejects mismatched video duration", async () => {
    await media.audio("demo-story", id); await visuals.scenes("demo-story", id, { sceneCount: 2 }); images.generate.mockRejectedValueOnce(new Error("invalid image response"));
    await expect(visuals.artwork("demo-story", id)).rejects.toThrow("invalid image response"); expect((await visuals.get("demo-story", id)).artwork?.status).toBe("failed");
    await visuals.artwork("demo-story", id); render.mockRejectedValueOnce(new Error("FFmpeg failed")); await expect(visuals.video("demo-story", id)).rejects.toThrow("FFmpeg failed"); expect((await visuals.get("demo-story", id)).video?.status).toBe("failed");
    await visuals.video("demo-story", id); render.mockImplementationOnce(async (input: any, output: string, settings: any) => { await atomicWrite(output, "bad-duration"); return { durationSeconds: input.audioDurationSeconds + 2, width: settings.width, height: settings.height, videoCodec: "h264", audioCodec: "aac", container: "mp4" }; });
    await expect(visuals.video("demo-story", id, { force: true })).rejects.toThrow("duration does not match"); expect(await visuals.export("demo-story", id, "video")).toMatchObject({ contentType: "video/mp4" });
  });
  it("returns actionable nonzero CLI failure for unresolved Produce profiles without image or video calls", async () => {
    const planned = await produce(); const entityId = planned.scenePlan!.scenes[0]!.entityIds![0]!;
    await saveVisualProfiles(root, "demo-story", {}); images.generate.mockClear(); render.mockClear();
    let output = "";
    await expect(runSummaryCommand(parseSummaryArgs(["produce", "demo-story", id]), { root, service: summaries, media, visuals,
      stdout: (text) => { output += text; }, stderr: () => {} })).rejects.toThrow(`Su Ming (${entityId})`);
    expect(JSON.parse(output)).toMatchObject({ status: "blocked", reason: "visual-profile-decisions-required" });
    expect(images.generate).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
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
    expect(summaryArtDirectionChoiceOptions(createDefaultArtDirection()).map((option) => option.label)).toEqual(["Story Default · Main Style", "Preset · Main Style", "No Story Art Direction"]);
    expect(scenePanel).toContain("Summary Art Direction"); expect(scenePanel).toContain("Story Default · Main Style"); expect(scenePanel).toContain("No Story Art Direction"); expect(scenePanel).toContain("Advanced visual direction"); expect(scenePanel).toContain("Custom negative prompt");
    expect(scenePanel).toContain("Image prompt only"); expect(scenePanel).toContain("Full visual direction");
    const artworkPanel = renderToStaticMarkup(<SummaryArtworkPanel {...props} />);
    expect(artworkPanel).toContain("Approve displayed image"); expect(artworkPanel).toContain("Regenerate artwork from current saved scene"); expect(artworkPanel).toContain("Edit scene");
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
