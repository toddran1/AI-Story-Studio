import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SummaryVisualService } from "../src/summaries/visuals.js";
import { SummaryMediaService } from "../src/summaries/media.js";
import { SummaryService, summaryPath } from "../src/summaries/service.js";
import { LLMRouter } from "../src/llm/router.js";
import { TTSProviderRouter } from "../src/tts/router.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { emptyStoryBible, storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { mergeStoryBible } from "../src/story-bible/updater.js";
import { tokenizeNarration } from "../src/alignment/quality.js";
import { FakeUpscaler, MockLLM, MockTTS, pngWithDims, testStory } from "./helpers.js";
import { parseSummaryArgs, runSummaryCommand } from "../apps/cli/summary.js";
import { imageDimensions } from "../src/artwork/resolution.js";
import { Story } from "../src/domain/story.js";

const NATIVE_1536x1024 = pngWithDims(1536, 1024);
const NATIVE_2752x1536 = pngWithDims(2752, 1536);
const NATIVE_2560x1440 = pngWithDims(2560, 1440);
const narration = "Malakai enters the dungeon. Malakai faces the monsters.";

describe("summary visual production M23 parity", () => {
  let root: string;
  let media: SummaryMediaService;
  let visuals: SummaryVisualService;
  let summaries: SummaryService;
  let id: string;
  let llm: MockLLM;
  let tts: MockTTS;
  let upscaler: FakeUpscaler;
  let generatedBuffer: Buffer;
  let imageCalls: any[];

  const images = {
    name: "openai",
    version: "fake-image",
    validateConfiguration: vi.fn(async () => {}),
    generate: vi.fn(async (req: any) => {
      imageCalls.push(req);
      return { data: generatedBuffer, mimeType: "image/png" as const };
    }),
  };

  let renderCalls: any[];
  const render = vi.fn(async (input: any, output: string, settings: any) => {
    renderCalls.push({ input, output, settings });
    await atomicWrite(output, "fake-mp4");
    return {
      durationSeconds: input.audioDurationSeconds,
      width: settings.width,
      height: settings.height,
      videoCodec: "h264",
      audioCodec: "aac",
      container: "mp4",
    };
  });

  const engine = {
    name: "fake-local-aligner",
    version: "v1",
    validateConfiguration: async () => {},
    align: vi.fn(async () =>
      tokenizeNarration(narration).map((text, index) => ({
        text,
        start: index < 4 ? index : index + 4,
        end: (index < 4 ? index : index + 4) + 0.8,
        confidence: 1,
      }))
    ),
  };

  const config = {
    engine: "disabled" as const,
    executable: "unused",
    device: "cpu" as const,
    minimumMatchPercentage: 90,
    minimumConfidence: 0.5,
    maximumGapSeconds: 5,
    timeoutMs: 1000,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    imageCalls = [];
    renderCalls = [];
    generatedBuffer = NATIVE_1536x1024;
    upscaler = new FakeUpscaler();

    root = await mkdtemp(join(tmpdir(), "summary-m23-parity-"));
    llm = new MockLLM("openai", ["Su Ming enters the dungeon. Su Ming faces the monsters.", narration]);
    tts = new MockTTS();

    const router = new LLMRouter(new Map([["openai", llm]]));
    summaries = new SummaryService(root, router);
    media = new SummaryMediaService(
      root,
      router,
      new TTSProviderRouter(tts),
      { version: "fake-censor", synthesize: async (provider, request) => provider.synthesize(request) },
      {
        version: "fake-master",
        master: async (_inputs, path) => {
          await atomicWrite(path, "fake-mastered-audio");
          return { durationSeconds: 12, codec: "mp3", container: "mp3" };
        },
      }
    );

    visuals = new SummaryVisualService(
      root,
      media,
      images,
      { version: "fake-video", render },
      config,
      engine,
      upscaler
    );

    const story = testStory();
    story.artwork = {
      ...story.artwork,
      outputResolution: "1440p",
      upscaling: "automatic",
      upscaler: "local-realesrgan",
      aspectRatio: "16:9",
    };
    story.video = {
      ...story.video,
      width: 2560,
      height: 1440,
    };
    await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, story);
    await atomicWrite(storyPaths(root, "demo-story", 1).english, "Su Ming enters a dungeon.");

    const bible = mergeStoryBible(
      emptyStoryBible(),
      storyBibleUpdateSchema.parse({
        chapterSummary: "Dungeon",
        characters: [
          {
            canonicalEnglishName: "Su Ming",
            originalName: "苏铭",
            firstSeenChapter: 1,
            lastSeenChapter: 1,
            description: "A young necromancer in black robes",
          },
        ],
      }),
      1
    );
    bible.canonicalEntities[0]!.localizedNaming = {
      locale: "en-US",
      fullName: "Malakai Sterling",
      shortName: "Malakai",
      usageMode: "ai_contextual",
    };
    await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, bible);

    id = (await summaries.generate("demo-story", { chapters: [1], title: "Dungeon recap" })).id;
    vi.spyOn(llm, "generateStructured").mockImplementation(async (request) => ({
      value: request.schema.parse({
        scenes: [
          {
            summary: "Su Ming arrives",
            startSeconds: 0,
            endSeconds: 5,
            characters: ["Malakai"],
            visualPrompt: "Su Ming in black robes at dungeon gate",
            importance: "standard",
            narrationStartWord: 0,
            narrationEndWord: 4,
          },
          {
            summary: "Su Ming confronts monsters",
            startSeconds: 5,
            endSeconds: 12,
            characters: ["Malakai"],
            visualPrompt: "Su Ming confronts dungeon monsters",
            importance: "major",
            narrationStartWord: 4,
            narrationEndWord: 8,
          },
        ],
      }),
    }));

    await media.audio("demo-story", id);
    await visuals.scenes("demo-story", id, { sceneCount: 2 });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("sources below target: preserves original, invokes AI upscaler, creates derivative and syncs canonical", async () => {
    generatedBuffer = NATIVE_1536x1024;
    const result = await visuals.artwork("demo-story", id);
    if ("dryRun" in result) throw new Error("Expected standard summary result");

    expect(images.generate).toHaveBeenCalledTimes(2);
    expect(upscaler.upscaleCalls).toHaveLength(2);

    const scene = result.scenePlan!.scenes[0]!;
    expect(scene.artwork.versions).toHaveLength(1);
    const version = scene.artwork.versions[0]!;

    expect(version.original).toMatchObject({
      width: 1536,
      height: 1024,
      provider: "openai",
    });
    expect(version.upscale?.status).toBe("applied");
    expect(version.upscale?.finalDimensions).toEqual({ width: 2560, height: 1440 });
    expect(version.upscale?.targetDimensions).toEqual({ width: 2560, height: 1440 });
    expect(version.upscale?.engine).toBe("local-realesrgan");
    expect(version.upscale?.scaleFactor).toBe(4);

    const paths = visuals.paths("demo-story", id);
    const originalBuf = await readFile(paths.sceneVersionImage(scene.id, 1));
    const derivativeBuf = await readFile(paths.sceneVersionProductionImage(scene.id, 1));
    const canonicalBuf = await readFile(paths.image(scene.id));

    expect(imageDimensions(originalBuf)).toEqual({ width: 1536, height: 1024 });
    expect(imageDimensions(derivativeBuf)).toEqual({ width: 2560, height: 1440 });
    expect(imageDimensions(canonicalBuf)).toEqual({ width: 2560, height: 1440 });
    expect(canonicalBuf.equals(derivativeBuf)).toBe(true);
  });

  it("sources above target: preserves original, normalizes without AI upscaler, creates derivative", async () => {
    generatedBuffer = NATIVE_2752x1536;
    const result = await visuals.artwork("demo-story", id);
    if ("dryRun" in result) throw new Error("Expected standard summary result");

    expect(images.generate).toHaveBeenCalledTimes(2);
    // Source (2752x1536) is larger than target (2560x1440) -> AI upscale not needed
    expect(upscaler.upscaleCalls).toHaveLength(0);
    expect(upscaler.normalizeCalls).toHaveLength(2);

    const scene = result.scenePlan!.scenes[0]!;
    const version = scene.artwork.versions[0]!;
    expect(version.original?.width).toBe(2752);
    expect(version.original?.height).toBe(1536);
    expect(version.upscale?.status).toBe("applied");
    expect(version.upscale?.finalDimensions).toEqual({ width: 2560, height: 1440 });
    expect(version.upscale?.scaleFactor).toBeUndefined();

    const paths = visuals.paths("demo-story", id);
    const derivativeBuf = await readFile(paths.sceneVersionProductionImage(scene.id, 1));
    expect(imageDimensions(derivativeBuf)).toEqual({ width: 2560, height: 1440 });
  });

  it("exact target: skips derivative creation and reuses original directly", async () => {
    generatedBuffer = NATIVE_2560x1440;
    const result = await visuals.artwork("demo-story", id);
    if ("dryRun" in result) throw new Error("Expected standard summary result");

    expect(images.generate).toHaveBeenCalledTimes(2);
    expect(upscaler.upscaleCalls).toHaveLength(0);
    expect(upscaler.normalizeCalls).toHaveLength(0);

    const scene = result.scenePlan!.scenes[0]!;
    const version = scene.artwork.versions[0]!;
    expect(version.upscale?.status).toBe("skipped-not-required");
    expect(version.upscale?.targetDimensions).toEqual({ width: 2560, height: 1440 });

    const paths = visuals.paths("demo-story", id);
    const canonicalBuf = await readFile(paths.image(scene.id));
    const originalBuf = await readFile(paths.sceneVersionImage(scene.id, 1));
    expect(canonicalBuf.equals(originalBuf)).toBe(true);
  });

  it("reupscales from preserved originals with zero provider calls when resolution changes", async () => {
    // Generate initial at 1080p
    const storyFile = storyPaths(root, "demo-story", 1).storyConfig;
    const story: Story = JSON.parse(await readFile(storyFile, "utf8"));
    story.artwork.outputResolution = "1080p";
    await atomicWriteJson(storyFile, story);

    generatedBuffer = NATIVE_1536x1024;
    await visuals.artwork("demo-story", id);
    expect(images.generate).toHaveBeenCalledTimes(2);
    const initialUpscaleCalls = upscaler.upscaleCalls.length;
    expect(initialUpscaleCalls).toBe(2);

    // Render video to current status
    await visuals.video("demo-story", id);
    expect((await visuals.get("demo-story", id)).video?.status).toBe("current");

    // Upgrade resolution to 1440p
    story.artwork.outputResolution = "1440p";
    await atomicWriteJson(storyFile, story);

    // Call reupscale
    const reupscaleResult = await visuals.reupscale("demo-story", id);
    expect(reupscaleResult.rederived).toHaveLength(2);
    expect(reupscaleResult.rederived[0]).toMatchObject({ sceneId: "scene-001", versionId: "v1", status: "applied" });

    // Zero additional provider calls!
    expect(images.generate).toHaveBeenCalledTimes(2);
    // Upscaler called again for new resolution
    expect(upscaler.upscaleCalls.length).toBe(4);

    // Video should be marked stale
    const updated = await visuals.get("demo-story", id);
    expect(updated.video?.status).toBe("stale");

    // Canonical image updated to 1440p
    const paths = visuals.paths("demo-story", id);
    const canonical = await readFile(paths.image("scene-001"));
    expect(imageDimensions(canonical)).toEqual({ width: 2560, height: 1440 });

    // Second reupscale call is idempotent (no-op)
    const secondReupscale = await visuals.reupscale("demo-story", id);
    expect(secondReupscale.rederived).toHaveLength(0);
  });

  it("injects aspect-ratio composition guidance into prompts with modern aspect ratio override", async () => {
    const storyFile = storyPaths(root, "demo-story", 1).storyConfig;
    const story: Story = JSON.parse(await readFile(storyFile, "utf8"));
    story.artwork.aspectRatio = "16:9";
    // Legacy size conflicting with modern aspectRatio
    story.artwork.size = "1024x1536";
    await atomicWriteJson(storyFile, story);

    await visuals.artwork("demo-story", id);

    expect(imageCalls.length).toBeGreaterThan(0);
    const prompt = imageCalls[0].prompt;
    expect(prompt).toContain("COMPOSITION: 16:9 landscape cinematic frame.");
    expect(prompt).not.toContain("vertical");
  });

  it("selects best production derivative for video rendering and falls back to original if missing", async () => {
    await visuals.artwork("demo-story", id);
    await visuals.video("demo-story", id);

    expect(renderCalls).toHaveLength(1);
    const videoCall = renderCalls[0];
    expect(videoCall.settings.width).toBe(2560);
    expect(videoCall.settings.height).toBe(1440);

    const sceneArtwork = videoCall.input.sceneArtwork;
    expect(sceneArtwork).toHaveLength(2);
    expect(sceneArtwork[0].path).toContain("scene-001-v1-production.png");

    // Delete derivative of scene-001
    const paths = visuals.paths("demo-story", id);
    await rm(paths.sceneVersionProductionImage("scene-001", 1));

    // Re-render video
    await visuals.video("demo-story", id, { force: true });
    expect(renderCalls).toHaveLength(2);
    const fallbackCall = renderCalls[1];
    expect(fallbackCall.input.sceneArtwork[0].path).toContain("scene-001-v1.png");
  });

  it("dry-run reports generation requirements without making provider calls or writing files", async () => {
    const result = await visuals.artwork("demo-story", id, { dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      imagesToGenerate: 2,
      reusable: 0,
      derivativesToBuild: 2,
    });
    expect(images.generate).not.toHaveBeenCalled();

    // Verify files were not created
    const paths = visuals.paths("demo-story", id);
    await expect(readFile(paths.sceneVersionImage("scene-001", 1))).rejects.toThrow();
  });

  it("supports CLI reupscale and dry-run commands", async () => {
    // Test CLI argument parsing
    const parsedReupscale = parseSummaryArgs(["reupscale", "demo-story", id, "--scene", "scene-001", "--version", "1"]);
    expect(parsedReupscale).toMatchObject({
      action: "reupscale",
      story: "demo-story",
      id,
      input: { sceneId: "scene-001", versionNumber: 1 },
    });

    const parsedDryRun = parseSummaryArgs(["artwork", "demo-story", id, "--dry-run"]);
    expect(parsedDryRun).toMatchObject({
      action: "artwork",
      story: "demo-story",
      id,
      input: { dryRun: true },
    });

    // Test CLI dry-run execution
    let output = "";
    await runSummaryCommand(parsedDryRun, {
      root,
      service: summaries,
      media,
      visuals,
      stdout: (text) => { output += text; },
      stderr: () => {},
    });
    expect(JSON.parse(output)).toMatchObject({
      dryRun: true,
      imagesToGenerate: 2,
      reusable: 0,
    });
    expect(images.generate).not.toHaveBeenCalled();

    // Now generate artwork for real
    await visuals.artwork("demo-story", id);
    expect(images.generate).toHaveBeenCalledTimes(2);

    // Test CLI reupscale execution
    output = "";
    await runSummaryCommand(parseSummaryArgs(["reupscale", "demo-story", id]), {
      root,
      service: summaries,
      media,
      visuals,
      stdout: (text) => { output += text; },
      stderr: () => {},
    });
    const cliReupscaleResult = JSON.parse(output);
    expect(cliReupscaleResult).toHaveProperty("rederived");
  });
});
