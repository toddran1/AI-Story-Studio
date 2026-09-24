import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateStoredArtwork, bestProductionAsset, reviewStoredArtwork, reupscaleStoredArtwork, artworkFingerprint } from "../src/artwork/generator.js";
import { ImageGenerationRequest, ImageProvider } from "../src/artwork/provider.js";
import { imageDimensions, planResolution, resolveTargetDimensions } from "../src/artwork/resolution.js";
import { ffmpegResizer, LocalRealEsrganUpscaler } from "../src/artwork/local-realesrgan.upscaler.js";
import { ImageUpscaler, ImageUpscaleRequest } from "../src/artwork/upscaler.js";
import { ConfigurationError } from "../src/pipeline/errors.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { Story } from "../src/domain/story.js";
import { LLMProvider } from "../src/llm/provider.js";
import { planStoredScenes } from "../src/scenes/manifest.js";
import { artworkSettingsSchema, sceneManifestSchema } from "../src/scenes/types.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { sceneVersionProductionImagePath, storyPaths } from "../src/storage/paths.js";
import { exists } from "../src/storage/story-files.js";
import { generateStoredSubtitles } from "../src/subtitles/chapter-subtitles.js";
import { renderStoredChapterVideo } from "../src/video/chapter-video.js";
import { VideoProcessor } from "../src/video/renderer.js";
import { CommandResult } from "../src/audio/ffmpeg.js";
import { getScenesDashboard } from "../apps/server/catalog.js";
import { testStory } from "./helpers.js";

/** Builds a minimal PNG buffer with the given IHDR dimensions (valid per the
 * generator's structural PNG validation; CRCs are not checked). */
export function pngWithDims(width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  const iend = Buffer.alloc(12);
  iend.write("IEND", 4, "ascii");
  return Buffer.concat([signature, ihdr, iend]);
}

const NATIVE = pngWithDims(1536, 1024);
const NATIVE_4K = pngWithDims(5504, 3072);

class SceneLLM implements LLMProvider {
  readonly name = "openai" as const;
  constructor(private plan?: unknown) {}
  async validateConfiguration() {}
  async generateText() { return { text: "" }; }
  async generateStructured<T>(request: any): Promise<any> {
    return {
      value: request.schema.parse(this.plan ?? {
        scenes: [
          { summary: "Li Chen enters the observatory.", startSeconds: 0, endSeconds: 15, characters: ["Li Chen"], location: "Old Observatory", visualPrompt: "Li Chen beneath the brass telescope", importance: "major" },
          { summary: "The star map ignites.", startSeconds: 15, endSeconds: 30, characters: ["Li Chen"], location: "Old Observatory", visualPrompt: "Blue constellations flare across the chamber", importance: "standard" },
        ],
      }) as T,
    };
  }
}

function fakeImages(data: Buffer = NATIVE, name = "openai") {
  const calls: ImageGenerationRequest[] = [];
  const provider: ImageProvider & { calls: ImageGenerationRequest[] } = {
    name,
    version: `fake-${name}-v1`,
    calls,
    validateConfiguration: async () => {},
    generate: async (request) => { calls.push(request); return { data, mimeType: "image/png" as const }; },
  };
  return provider;
}

class FakeUpscaler implements ImageUpscaler {
  readonly name = "local-realesrgan";
  readonly version = "fake-upscaler-v1";
  upscaleCalls: ImageUpscaleRequest[] = [];
  normalizeCalls: ImageUpscaleRequest[] = [];
  constructor(readonly model = "realesrgan-x4plus", private behavior: "ok" | "unavailable" | "fail" = "ok") {}
  async validateConfiguration() {
    if (this.behavior === "unavailable") throw new ConfigurationError("Upscaler executable 'realesrgan-ncnn-vulkan' is unavailable. Install Real-ESRGAN or set UPSCALER_EXECUTABLE.");
  }
  private async derive(request: ImageUpscaleRequest, scaleFactor?: number) {
    await this.validateConfiguration();
    if (this.behavior === "fail") throw new Error("upscaler engine exploded");
    await atomicWrite(request.outputPath, pngWithDims(request.targetWidth, request.targetHeight));
    return {
      outputPath: request.outputPath,
      sourceDimensions: { width: request.sourceWidth, height: request.sourceHeight },
      finalDimensions: { width: request.targetWidth, height: request.targetHeight },
      engine: this.name,
      model: this.model,
      scaleFactor,
      fit: "exact" as const,
    };
  }
  async upscale(request: ImageUpscaleRequest) { this.upscaleCalls.push(request); return this.derive(request, 4); }
  async normalize(request: ImageUpscaleRequest) { this.normalizeCalls.push(request); return this.derive(request); }
}

class FakeVideo implements VideoProcessor {
  readonly version = "fake-video-v1";
  calls: Array<{ settings: { width: number; height: number } }> = [];
  async render(_input: any, output: string, settings: any) {
    this.calls.push({ settings });
    await atomicWrite(output, Buffer.from(`video-${this.calls.length}`));
    return { durationSeconds: 33, videoCodec: "h264", audioCodec: "aac", width: settings.width, height: settings.height, container: "mp4" };
  }
}

async function fixture(artwork?: Partial<Story["artwork"]>, options?: { plan?: unknown }) {
  const root = await mkdtemp(join(tmpdir(), "artwork-resolution-"));
  const story: Story = { ...testStory(), artwork: { ...testStory().artwork, ...artwork } };
  const paths = storyPaths(root, story.slug, 1);
  await atomicWriteJson(paths.storyConfig, story);
  const now = new Date().toISOString();
  const complete = { status: "complete" as const, fingerprint: "input", outputFingerprint: "output" };
  const chapter = chapterSchema.parse({
    chapter: 1, originalTitle: "The Observatory", sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
    counts: { originalCharacters: 50, englishWords: 20, narrationWords: 18 }, createdAt: now, updatedAt: now,
    stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, tts: complete, audioMastering: complete, subtitles: { status: "pending" }, scenePlanning: { status: "pending" }, artwork: { status: "pending" }, video: { status: "pending" } },
    audio: { durationSeconds: 30, codec: "mp3", container: "mp3" },
  });
  await atomicWriteJson(paths.chapterMeta, chapter);
  await atomicWrite(paths.narration, "Li Chen entered the old observatory. Above him, a map of blue stars awakened.");
  await atomicWrite(paths.audio, Buffer.from("mastered"));
  await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM(options?.plan) });
  return { root, story, paths };
}

async function readManifest(paths: ReturnType<typeof storyPaths>) {
  return sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
}

describe("artwork resolution model", () => {
  it("maps every output resolution and aspect ratio to exactly one dimension set", () => {
    expect(resolveTargetDimensions("native", "16:9")).toBeUndefined();
    expect(resolveTargetDimensions("720p", "16:9")).toEqual({ width: 1280, height: 720 });
    expect(resolveTargetDimensions("1080p", "16:9")).toEqual({ width: 1920, height: 1080 });
    expect(resolveTargetDimensions("1440p", "16:9")).toEqual({ width: 2560, height: 1440 });
    expect(resolveTargetDimensions("2160p", "16:9")).toEqual({ width: 3840, height: 2160 });
    expect(resolveTargetDimensions("720p", "9:16")).toEqual({ width: 720, height: 1280 });
    expect(resolveTargetDimensions("1080p", "9:16")).toEqual({ width: 1080, height: 1920 });
    expect(resolveTargetDimensions("1440p", "9:16")).toEqual({ width: 1440, height: 2560 });
    expect(resolveTargetDimensions("2160p", "9:16")).toEqual({ width: 2160, height: 3840 });
    expect(resolveTargetDimensions("720p", "1:1")).toEqual({ width: 720, height: 720 });
    expect(resolveTargetDimensions("1080p", "1:1")).toEqual({ width: 1080, height: 1080 });
    expect(resolveTargetDimensions("1440p", "1:1")).toEqual({ width: 1440, height: 1440 });
    expect(resolveTargetDimensions("2160p", "1:1")).toEqual({ width: 2160, height: 2160 });
  });

  it("plans upscaling decisions from requested resolution, mode, and native dimensions", () => {
    expect(planResolution({ requested: "native", aspectRatio: "16:9", upscaling: "automatic" })).toMatchObject({ action: "none", upscaleRequired: false, target: undefined });
    expect(planResolution({ requested: "2160p", aspectRatio: "16:9", upscaling: "off" })).toMatchObject({ action: "none", upscaleRequired: false });
    expect(planResolution({ requested: "2160p", aspectRatio: "16:9", upscaling: "automatic" })).toMatchObject({ action: "none", upscaleRequired: false, reason: "native dimensions unknown" });
    expect(planResolution({ requested: "1080p", aspectRatio: "16:9", upscaling: "automatic", nativeWidth: 1920, nativeHeight: 1080 })).toMatchObject({ action: "none", upscaleRequired: false });
    expect(planResolution({ requested: "2160p", aspectRatio: "16:9", upscaling: "automatic", nativeWidth: 1536, nativeHeight: 1024 })).toMatchObject({ action: "upscale", upscaleRequired: true });
    expect(planResolution({ requested: "1080p", aspectRatio: "16:9", upscaling: "automatic", nativeWidth: 2752, nativeHeight: 1536 })).toMatchObject({ action: "normalize", upscaleRequired: false });
    expect(planResolution({ requested: "2160p", aspectRatio: "16:9", upscaling: "always", nativeWidth: 5504, nativeHeight: 3072 })).toMatchObject({ action: "normalize", upscaleRequired: false });
    expect(planResolution({ requested: "2160p", aspectRatio: "16:9", upscaling: "always", nativeWidth: 3840, nativeHeight: 2160 })).toMatchObject({ action: "none", upscaleRequired: false });
    expect(planResolution({ requested: "2160p", aspectRatio: "16:9", upscaling: "automatic", nativeEstimate: { width: 1536, height: 1024 } })).toMatchObject({ action: "upscale", upscaleRequired: true });
  });

  it("parses PNG and JPEG dimensions without dependencies", () => {
    expect(imageDimensions(pngWithDims(2752, 1536))).toEqual({ width: 2752, height: 1536 });
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]),
      Buffer.from([0x06, 0x00, 0x0a, 0x80]), // height 1536, width 2688
      Buffer.alloc(12),
    ]);
    expect(imageDimensions(jpeg)).toEqual({ width: 2688, height: 1536 });
    expect(imageDimensions(Buffer.from("not an image"))).toBeUndefined();
  });

  it("keeps legacy artwork settings parsing with new fields defaulted", () => {
    const legacy = artworkSettingsSchema.parse({ provider: "openai", model: "gpt-image-1", quality: "low", size: "1024x1024" });
    expect(legacy).toMatchObject({ quality: "low", size: "1024x1024", outputResolution: "native", upscaling: "automatic", upscaler: "local-realesrgan" });
  });
});

describe("local Real-ESRGAN upscaler adapter", () => {
  const request = { sourcePath: "in.png", sourceWidth: 2752, sourceHeight: 1536, targetWidth: 3840, targetHeight: 2160, outputPath: "out.png" };
  function runner(captured: { calls?: Array<{ command: string; args: string[] }>, failHelp?: boolean }) {
    return async (command: string, args: string[]): Promise<CommandResult> => {
      (captured.calls ??= []).push({ command, args });
      if (args[0] === "-h" && captured.failHelp) throw new Error("spawn ENOENT");
      if (args.includes("-o")) await atomicWrite(args[args.indexOf("-o") + 1]!, pngWithDims(5504, 3072));
      return { stdout: "", stderr: "" };
    };
  }
  it("probes -h and reports an actionable error when the binary is missing", async () => {
    const captured: any = { failHelp: true };
    const upscaler = new LocalRealEsrganUpscaler("realesrgan-ncnn-vulkan", "realesrgan-x4plus", 1000, runner(captured));
    await expect(upscaler.validateConfiguration()).rejects.toBeInstanceOf(ConfigurationError);
    await expect(upscaler.validateConfiguration()).rejects.toThrow(/Install Real-ESRGAN/);
  });
  it("treats a usage banner with a non-zero exit as an available binary", async () => {
    const bannerRunner = async (): Promise<CommandResult> => { throw new Error("realesrgan-ncnn-vulkan exited with 255: Usage: realesrgan-ncnn-vulkan -i infile -o outfile [options]..."); };
    const upscaler = new LocalRealEsrganUpscaler("realesrgan-ncnn-vulkan", "realesrgan-x4plus", 1000, bannerRunner);
    await expect(upscaler.validateConfiguration()).resolves.toBeUndefined();
  });
  it("fails when the upscaler produces no output", async () => {
    const silentRunner = async (_command: string, args: string[]): Promise<CommandResult> => {
      if (args[0] === "-h") return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" }; // exit 0 but never writes the -o file
    };
    const upscaler = new LocalRealEsrganUpscaler("realesrgan-ncnn-vulkan", "realesrgan-x4plus", 1000, silentRunner);
    await expect(upscaler.upscale({ ...request, outputPath: join(await mkdtemp(join(tmpdir(), "upscale-")), "out.png") })).rejects.toThrow(/produced no output/);
  });
  it("picks the smallest factor reaching the target and normalizes to exact dimensions", async () => {
    const captured: any = {};
    const resizes: Array<{ source: { width: number; height: number } }> = [];
    const resizer = async (_i: string, o: string, source: any, target: any) => { resizes.push({ source }); await atomicWrite(o, pngWithDims(target.width, target.height)); return { fit: "crop" as const }; };
    const upscaler = new LocalRealEsrganUpscaler("realesrgan-ncnn-vulkan", "realesrgan-x4plus", 1000, runner(captured), resizer);
    const result = await upscaler.upscale({ ...request, outputPath: join(await mkdtemp(join(tmpdir(), "upscale-")), "out.png") });
    const run = captured.calls.find((call: any) => call.args.includes("-s"));
    expect(run.args).toContain("2"); // 2x of 2752x1536 already covers 3840x2160
    expect(resizes[0]!.source).toEqual({ width: 5504, height: 3072 });
    expect(result).toMatchObject({ scaleFactor: 2, fit: "crop", finalDimensions: { width: 3840, height: 2160 } });
  });
  it("uses 4x when 2x cannot reach the target", async () => {
    const captured: any = {};
    const resizer = async (_i: string, o: string) => { await atomicWrite(o, pngWithDims(3840, 2160)); return { fit: "exact" as const }; };
    const upscaler = new LocalRealEsrganUpscaler("realesrgan-ncnn-vulkan", "realesrgan-x4plus", 1000, runner(captured), resizer);
    await upscaler.upscale({ ...request, sourceWidth: 1376, sourceHeight: 768, outputPath: join(await mkdtemp(join(tmpdir(), "upscale-")), "out.png") });
    const run = captured.calls.find((call: any) => call.args.includes("-s"));
    expect(run.args[run.args.indexOf("-s") + 1]).toBe("4");
  });
  it("ffmpeg resizer never stretches: lanczos on matching aspect, cover-crop otherwise", async () => {
    const calls: Array<{ args: string[] }> = [];
    const run = async (_command: string, args: string[]) => { calls.push({ args }); return { stdout: "", stderr: "" }; };
    const resize = ffmpegResizer("ffmpeg", run);
    // Exact aspect ratio match: lanczos scaling
    expect(await resize("in.png", "out.png", { width: 3840, height: 2160 }, { width: 1920, height: 1080 })).toEqual({ fit: "exact" });
    expect(calls[0]!.args.join(" ")).toContain("scale=1920:1080:flags=lanczos");
    // Aspect ratio mismatch (1:1 -> 16:9): cover-crop
    expect(await resize("in.png", "out.png", { width: 1024, height: 1024 }, { width: 3840, height: 2160 })).toEqual({ fit: "crop" });
    expect(calls[1]!.args.join(" ")).toContain("force_original_aspect_ratio=increase,crop=3840:2160");
    // Minor aspect ratio difference (Gemini 2752x1536 [1.7917] vs 1920x1080 [1.7778]): cover-crop prevents stretching
    expect(await resize("in.png", "out.png", { width: 2752, height: 1536 }, { width: 1920, height: 1080 })).toEqual({ fit: "crop" });
    expect(calls[2]!.args.join(" ")).toContain("force_original_aspect_ratio=increase,crop=1920:1080");
    // Gemini 4K (5504x3072 [1.7917] vs 3840x2160 [1.7778]): cover-crop prevents stretching
    expect(await resize("in.png", "out.png", { width: 5504, height: 3072 }, { width: 3840, height: 2160 })).toEqual({ fit: "crop" });
    expect(calls[3]!.args.join(" ")).toContain("force_original_aspect_ratio=increase,crop=3840:2160");
  });
  it("fails explicitly when 4x cannot reach the target on either axis", async () => {
    const captured: any = {};
    const upscaler = new LocalRealEsrganUpscaler("realesrgan-ncnn-vulkan", "realesrgan-x4plus", 1000, runner(captured));
    await expect(
      upscaler.upscale({ ...request, sourceWidth: 640, sourceHeight: 360, targetWidth: 3840, targetHeight: 2160, outputPath: "out.png" })
    ).rejects.toThrow(/Unsupported upscaling scale/);
  });
  it("discovers fallback executable path when bare command name fails in PATH", async () => {
    const captured: any = {};
    const fallbackRunner = async (command: string, args: string[]): Promise<CommandResult> => {
      (captured.calls ??= []).push({ command, args });
      if (command === "realesrgan-ncnn-vulkan") throw new Error("spawn ENOENT");
      if (command.includes("/usr/local/bin/realesrgan-ncnn-vulkan")) {
        if (args[0] === "-h") return { stdout: "Usage: realesrgan-ncnn-vulkan ...", stderr: "" };
        if (args.includes("-o")) await atomicWrite(args[args.indexOf("-o") + 1]!, pngWithDims(5504, 3072));
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    };
    const resizer = async (_i: string, o: string, source: any, target: any) => { await atomicWrite(o, pngWithDims(target.width, target.height)); return { fit: "exact" as const }; };
    const upscaler = new LocalRealEsrganUpscaler("realesrgan-ncnn-vulkan", "realesrgan-x4plus", 1000, fallbackRunner, resizer);
    await upscaler.validateConfiguration();
    const result = await upscaler.upscale({ ...request, outputPath: join(await mkdtemp(join(tmpdir(), "upscale-")), "out.png") });
    expect(result.finalDimensions).toEqual({ width: 3840, height: 2160 });
    expect(captured.calls.some((c: any) => c.command === "/usr/local/bin/realesrgan-ncnn-vulkan")).toBe(true);
  });
  it("allows retrying validateConfiguration after an initial failure", async () => {
    let fail = true;
    const retryRunner = async (command: string, args: string[]): Promise<CommandResult> => {
      if (fail) throw new Error("transient error");
      return { stdout: "Usage: realesrgan-ncnn-vulkan ...", stderr: "" };
    };
    const upscaler = new LocalRealEsrganUpscaler("realesrgan-ncnn-vulkan", "realesrgan-x4plus", 1000, retryRunner);
    await expect(upscaler.validateConfiguration()).rejects.toBeInstanceOf(ConfigurationError);
    fail = false;
    await expect(upscaler.validateConfiguration()).resolves.toBeUndefined();
  });
});

describe("artwork generation with production derivatives", () => {
  it("records original dimensions, upscales to the target, and makes the derivative the canonical asset", async () => {
    const { root, story, paths } = await fixture({ outputResolution: "2160p" });
    const images = fakeImages();
    const upscaler = new FakeUpscaler();
    const result = await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001", upscaler });
    expect(result.generated).toBe(1);
    expect(upscaler.upscaleCalls).toHaveLength(1);
    expect(upscaler.upscaleCalls[0]).toMatchObject({ sourceWidth: 1536, sourceHeight: 1024, targetWidth: 3840, targetHeight: 2160 });
    // Never AI-upscales a derivative: the source is the ORIGINAL version path
    expect(upscaler.upscaleCalls[0]!.sourcePath).toBe(join(paths.scenesDirectory, "scene-001-v1.png"));
    const manifest = await readManifest(paths);
    const version = manifest.scenes[0]!.artwork.versions[0]!;
    expect(version.original).toMatchObject({ width: 1536, height: 1024, provider: "openai" });
    expect(version.upscale).toMatchObject({ status: "applied", engine: "local-realesrgan", finalDimensions: { width: 3840, height: 2160 }, scaleFactor: 4, fit: "exact" });
    const derivative = await readFile(sceneVersionProductionImagePath(root, story.slug, 1, "scene-001", 1));
    expect(imageDimensions(derivative)).toEqual({ width: 3840, height: 2160 });
    // The canonical scene image is the production derivative
    expect((await readFile(join(paths.scenesDirectory, "scene-001.png"))).equals(derivative)).toBe(true);
    const asset = await bestProductionAsset(root, story, 1, "scene-001", version);
    expect(asset).toMatchObject({ upscaled: true, engine: "local-realesrgan", width: 3840, height: 2160 });
    expect(asset.path).toBe(sceneVersionProductionImagePath(root, story.slug, 1, "scene-001", 1));
  });

  it("normalizes without an AI pass in automatic mode when native generation exceeds the target", async () => {
    const { root, story, paths } = await fixture({ outputResolution: "720p" });
    const upscaler = new FakeUpscaler();
    await generateStoredArtwork({ root, story, chapter: 1, provider: fakeImages(), sceneId: "scene-001", upscaler });
    expect(upscaler.upscaleCalls).toHaveLength(0);
    expect(upscaler.normalizeCalls).toHaveLength(1);
    expect(upscaler.normalizeCalls[0]).toMatchObject({ sourceWidth: 1536, sourceHeight: 1024, targetWidth: 1280, targetHeight: 720 });
    const version = (await readManifest(paths)).scenes[0]!.artwork.versions[0]!;
    expect(version.upscale).toMatchObject({ status: "applied", finalDimensions: { width: 1280, height: 720 } });
    expect(version.upscale?.scaleFactor).toBeUndefined();
    const derivative = await readFile(sceneVersionProductionImagePath(root, story.slug, 1, "scene-001", 1));
    expect(imageDimensions(derivative)).toEqual({ width: 1280, height: 720 });
    expect((await readFile(join(paths.scenesDirectory, "scene-001.png"))).equals(derivative)).toBe(true);
  });

  it("skips normalization and upscaling in automatic mode when native generation exactly matches the target", async () => {
    const { root, story, paths } = await fixture({ outputResolution: "1080p" });
    const upscaler = new FakeUpscaler();
    const matchingImage = pngWithDims(1920, 1080);
    await generateStoredArtwork({ root, story, chapter: 1, provider: fakeImages(matchingImage), sceneId: "scene-001", upscaler });
    expect(upscaler.upscaleCalls).toHaveLength(0);
    expect(upscaler.normalizeCalls).toHaveLength(0);
    const version = (await readManifest(paths)).scenes[0]!.artwork.versions[0]!;
    expect(version.upscale?.status).toBe("skipped-not-required");
    expect((await readFile(join(paths.scenesDirectory, "scene-001.png"))).equals(matchingImage)).toBe(true);
  });

  it("derives nothing when upscaling is off", async () => {
    const { root, story, paths } = await fixture({ outputResolution: "2160p", upscaling: "off" });
    const upscaler = new FakeUpscaler();
    await generateStoredArtwork({ root, story, chapter: 1, provider: fakeImages(), sceneId: "scene-001", upscaler });
    expect(upscaler.upscaleCalls).toHaveLength(0);
    const version = (await readManifest(paths)).scenes[0]!.artwork.versions[0]!;
    expect(version.upscale?.status).toBe("skipped-not-required");
    expect(await exists(sceneVersionProductionImagePath(root, story.slug, 1, "scene-001", 1))).toBe(false);
    expect((await readFile(join(paths.scenesDirectory, "scene-001.png"))).equals(NATIVE)).toBe(true);
  });

  it("keeps the original as production asset with a warning when the upscaler is unavailable", async () => {
    const { root, story, paths } = await fixture({ outputResolution: "2160p" });
    const upscaler = new FakeUpscaler("realesrgan-x4plus", "unavailable");
    const result = await generateStoredArtwork({ root, story, chapter: 1, provider: fakeImages(), sceneId: "scene-001", upscaler });
    expect(result.generated).toBe(1);
    const version = (await readManifest(paths)).scenes[0]!.artwork.versions[0]!;
    expect(version.upscale?.status).toBe("unavailable");
    expect(version.upscale?.warning).toMatch(/Install Real-ESRGAN/);
    expect(result.warnings.some((warning) => /upscaler unavailable/i.test(warning))).toBe(true);
    expect((await readFile(join(paths.scenesDirectory, "scene-001.png"))).equals(NATIVE)).toBe(true);
    const asset = await bestProductionAsset(root, story, 1, "scene-001", version);
    expect(asset.upscaled).toBe(false);
  });

  it("keeps the original as production asset when the upscale run fails", async () => {
    const { root, story, paths } = await fixture({ outputResolution: "2160p" });
    const upscaler = new FakeUpscaler("realesrgan-x4plus", "fail");
    const result = await generateStoredArtwork({ root, story, chapter: 1, provider: fakeImages(), sceneId: "scene-001", upscaler });
    expect(result.generated).toBe(1);
    const version = (await readManifest(paths)).scenes[0]!.artwork.versions[0]!;
    expect(version.upscale?.status).toBe("failed");
    expect((await readFile(join(paths.scenesDirectory, "scene-001.png"))).equals(NATIVE)).toBe(true);
  });

  it("normalizes without an AI pass in always mode when native output exceeds the target", async () => {
    const { root, story, paths } = await fixture({ outputResolution: "2160p", upscaling: "always", provider: "gemini", model: "gemini-3.1-flash-image" });
    const images = fakeImages(NATIVE_4K, "gemini");
    const upscaler = new FakeUpscaler();
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001", upscaler });
    expect(upscaler.upscaleCalls).toHaveLength(0);
    expect(upscaler.normalizeCalls).toHaveLength(1);
    expect(upscaler.normalizeCalls[0]).toMatchObject({ sourceWidth: 5504, sourceHeight: 3072, targetWidth: 3840, targetHeight: 2160 });
    const version = (await readManifest(paths)).scenes[0]!.artwork.versions[0]!;
    expect(version.upscale).toMatchObject({ status: "applied", finalDimensions: { width: 3840, height: 2160 } });
    expect(version.upscale?.scaleFactor).toBeUndefined();
  });

  it("reuses originals across resolution changes and rebuilds only derivatives", async () => {
    const { root, story, paths } = await fixture();
    const images = fakeImages();
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001" });
    expect(images.calls).toHaveLength(1);

    // Changing the output resolution must not invalidate the ORIGINAL.
    const upscaled: Story = { ...story, artwork: { ...story.artwork, outputResolution: "2160p" } };
    const upscaler = new FakeUpscaler();
    const rerun = await generateStoredArtwork({ root, story: upscaled, chapter: 1, provider: images, sceneId: "scene-001", upscaler });
    expect(rerun.generated).toBe(0);
    expect(images.calls).toHaveLength(1);
    expect(upscaler.upscaleCalls).toHaveLength(1);
    let version = (await readManifest(paths)).scenes[0]!.artwork.versions[0]!;
    expect(version.upscale?.status).toBe("applied");
    expect((await readFile(join(paths.scenesDirectory, "scene-001.png"))).equals(await readFile(sceneVersionProductionImagePath(root, story.slug, 1, "scene-001", 1)))).toBe(true);

    // A second run with unchanged settings reuses the derivative too.
    const again = await generateStoredArtwork({ root, story: upscaled, chapter: 1, provider: images, sceneId: "scene-001", upscaler });
    expect(again.generated).toBe(0);
    expect(upscaler.upscaleCalls).toHaveLength(1);

    // Changing the upscaler model rebuilds the derivative only.
    const reModeled = new FakeUpscaler("realesrgan-x4plus-anime");
    await generateStoredArtwork({ root, story: upscaled, chapter: 1, provider: images, sceneId: "scene-001", upscaler: reModeled });
    expect(images.calls).toHaveLength(1);
    expect(reModeled.upscaleCalls).toHaveLength(1);
    version = (await readManifest(paths)).scenes[0]!.artwork.versions[0]!;
    expect(version.upscale?.model).toBe("realesrgan-x4plus-anime");

    // Changing generation quality still invalidates the original.
    const higherQuality: Story = { ...upscaled, artwork: { ...upscaled.artwork, quality: "high" } };
    const regen = await generateStoredArtwork({ root, story: higherQuality, chapter: 1, provider: images, sceneId: "scene-001", upscaler: reModeled });
    expect(regen.generated).toBe(1);
    expect(images.calls).toHaveLength(2);
  });

  it("re-upscales from preserved originals with zero provider calls", async () => {
    const { root, story } = await fixture({ outputResolution: "1080p" });
    const images = fakeImages();
    await generateStoredArtwork({ root, story, chapter: 1, provider: images });
    const upscaled: Story = { ...story, artwork: { ...story.artwork, outputResolution: "2160p" } };
    const upscaler = new FakeUpscaler();
    const result = await reupscaleStoredArtwork({ root, story: upscaled, chapter: 1, upscaler });
    expect(images.calls).toHaveLength(2);
    expect(upscaler.upscaleCalls).toHaveLength(2);
    expect(result.rederived).toHaveLength(2);
    expect(result.rederived[0]).toMatchObject({ sceneId: "scene-001", versionId: "v1", status: "applied" });
    // Idempotent: current derivatives are not rebuilt.
    const second = await reupscaleStoredArtwork({ root, story: upscaled, chapter: 1, upscaler });
    expect(second.rederived).toHaveLength(0);
    expect(upscaler.upscaleCalls).toHaveLength(2);
  });

  it("falls back to the original when the derivative is missing or corrupt", async () => {
    const { root, story, paths } = await fixture({ outputResolution: "2160p" });
    await generateStoredArtwork({ root, story, chapter: 1, provider: fakeImages(), sceneId: "scene-001", upscaler: new FakeUpscaler() });
    let version = (await readManifest(paths)).scenes[0]!.artwork.versions[0]!;
    expect((await bestProductionAsset(root, story, 1, "scene-001", version)).upscaled).toBe(true);
    await rm(sceneVersionProductionImagePath(root, story.slug, 1, "scene-001", 1));
    const asset = await bestProductionAsset(root, story, 1, "scene-001", version);
    expect(asset.upscaled).toBe(false);
    expect(asset.path).toBe(join(paths.scenesDirectory, "scene-001-v1.png"));
  });

  it("keeps approval on the version and protects the approved derivative on regen", async () => {
    const { root, story, paths } = await fixture({ outputResolution: "2160p" });
    const upscaler = new FakeUpscaler();
    await generateStoredArtwork({ root, story, chapter: 1, provider: fakeImages(), sceneId: "scene-001", upscaler });
    await reviewStoredArtwork({ root, story, chapter: 1, sceneId: "scene-001", review: "approved" });
    const derivative = await readFile(sceneVersionProductionImagePath(root, story.slug, 1, "scene-001", 1));
    expect((await readFile(join(paths.scenesDirectory, "scene-001.png"))).equals(derivative)).toBe(true);
    const upgraded: Story = { ...story, artwork: { ...story.artwork, model: "gpt-image-2.5-flare" } };
    await generateStoredArtwork({ root, story: upgraded, chapter: 1, provider: fakeImages(), sceneId: "scene-001", upscaler });
    const artwork = (await readManifest(paths)).scenes[0]!.artwork;
    expect(artwork.versions).toHaveLength(2);
    expect(artwork.approvedVersionId).toBe("v1");
    expect(artwork.versions[0]!.review).toBe("approved");
    expect((await readFile(join(paths.scenesDirectory, "scene-001.png"))).equals(derivative)).toBe(true);
  });

  it("sends ORIGINAL bytes as continuity references even when a 4K derivative exists", async () => {
    const plan = {
      scenes: [
        { summary: "Mara shelters in the warehouse, bleeding.", startSeconds: 0, endSeconds: 15, characters: ["Mara"], location: "Warehouse", visualPrompt: "Mara clutching her arm among crates", importance: "standard",
          visualChanges: { characters: [{ name: "Mara", op: "enter", set: { injuries: "bleeding left arm" } }], environment: { set: { description: "abandoned warehouse", timeOfDay: "night" } } } },
        { summary: "She binds the wound and moves on.", startSeconds: 15, endSeconds: 30, characters: ["Mara"], location: "Warehouse", visualPrompt: "Mara wrapping a bandage", importance: "standard" },
      ],
    };
    const { root, story } = await fixture({ outputResolution: "2160p", model: "gpt-image-2.5-flare" }, { plan });
    const images = fakeImages();
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001", upscaler: new FakeUpscaler() });
    await reviewStoredArtwork({ root, story, chapter: 1, sceneId: "scene-001", review: "approved" });
    images.calls.length = 0;
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-002", upscaler: new FakeUpscaler() });
    const reference = images.calls[0]!.referenceImages?.find((ref) => ref.role === "previous-scene");
    expect(reference).toBeDefined();
    // The reference is the bounded ORIGINAL provider image, not the 4K derivative.
    expect(reference!.data.equals(NATIVE)).toBe(true);
    expect(reference!.data.length).toBeLessThan(8 * 1024 * 1024);
  });

  it("exposes original/production dimensions and resolved behavior on the scenes dashboard", async () => {
    const { root, story } = await fixture({ outputResolution: "2160p" });
    await generateStoredArtwork({ root, story, chapter: 1, provider: fakeImages(), sceneId: "scene-001", upscaler: new FakeUpscaler() });
    const dashboard = await getScenesDashboard(root, story.slug, 1);
    expect(dashboard.resolvedBehavior).toMatchObject({ upscaling: "required", target: { width: 3840, height: 2160 } });
    expect(dashboard.resolvedBehavior.nativeEstimate).toContain("1536x1024");
    const version = dashboard.manifest!.scenes[0]!.artwork.versions[0]!;
    expect(version.original).toEqual({ width: 1536, height: 1024 });
    expect(version.production).toMatchObject({ width: 3840, height: 2160, upscaled: true, engine: "local-realesrgan" });
  });
});

describe("video resolution integration", () => {
  it("drives the canvas from resolution presets and never invalidates artwork", async () => {
    const { root, story, paths } = await fixture();
    const images = fakeImages();
    await generateStoredArtwork({ root, story, chapter: 1, provider: images });
    await reviewStoredArtwork({ root, story, chapter: 1, sceneId: "scene-001", review: "approved" });
    await reviewStoredArtwork({ root, story, chapter: 1, sceneId: "scene-002", review: "approved" });
    await generateStoredSubtitles({ root, story, chapter: 1 });

    const manifestBefore = await readFile(paths.scenesManifest, "utf8");
    const videoStory: Story = { ...story, video: { ...story.video, resolution: "2160p" } };
    const processor = new FakeVideo();
    const rendered = await renderStoredChapterVideo({ root, story: videoStory, chapter: 1, processor });
    expect(processor.calls[0]!.settings).toMatchObject({ width: 3840, height: 2160 });
    // Native artwork (1536x1024) is below the 4K canvas: surfaced, not fatal.
    expect(rendered.belowTargetResolution).toBe(true);
    expect(rendered.warnings.some((warning) => /below the 3840x2160 canvas/.test(warning))).toBe(true);
    // Video settings changes never touch artwork.
    expect(await readFile(paths.scenesManifest, "utf8")).toBe(manifestBefore);
    const manifest = await readManifest(paths);
    expect(artworkFingerprint(manifest.scenes[0]!, [], story, images.version)).toBe(artworkFingerprint(manifest.scenes[0]!, [], videoStory, images.version));

    // Explicit width/height still win when no preset is set.
    const custom: Story = { ...story, video: { ...story.video, width: 1280, height: 720 } };
    const customProcessor = new FakeVideo();
    await renderStoredChapterVideo({ root, story: custom, chapter: 1, processor: customProcessor });
    expect(customProcessor.calls[0]!.settings).toMatchObject({ width: 1280, height: 720 });
  });
});
