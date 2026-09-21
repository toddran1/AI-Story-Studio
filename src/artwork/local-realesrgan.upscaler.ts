import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runCommand, CommandRunner } from "../audio/ffmpeg.js";
import { ConfigurationError } from "../pipeline/errors.js";
import { Environment } from "../config/env.js";
import { ImageUpscaleRequest, ImageUpscaleResult, ImageUpscaler } from "./upscaler.js";

export const LOCAL_REALESRGAN_VERSION = "local-realesrgan-v1";

/** Deterministic FFmpeg resize to exact target dimensions. Matches the video
 * renderer's fit semantics (scale to cover, then crop — never stretch). */
export type DeterministicResizer = (input: string, output: string, source: { width: number; height: number }, target: { width: number; height: number }) => Promise<{ fit: "exact" | "crop" }>;

export function ffmpegResizer(ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg", runner: CommandRunner = runCommand, timeoutMs?: number): DeterministicResizer {
  return async (input, output, source, target) => {
    const aspectMatches = Math.abs(source.width / source.height - target.width / target.height) / (target.width / target.height) < 0.01;
    const filter = aspectMatches
      ? `scale=${target.width}:${target.height}:flags=lanczos`
      : `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase,crop=${target.width}:${target.height}`;
    await runner(ffmpegPath, ["-hide_banner", "-nostdin", "-y", "-i", input, "-vf", filter, output], timeoutMs);
    return { fit: aspectMatches ? "exact" : "crop" };
  };
}

/** Local Real-ESRGAN-style CLI adapter (realesrgan-ncnn-vulkan). Upscales at
 * 2x or 4x (smallest factor reaching the target on both axes), then applies a
 * deterministic FFmpeg normalization to the exact target dimensions. Never
 * consumes a derivative — the caller always passes the original image. */
export class LocalRealEsrganUpscaler implements ImageUpscaler {
  readonly name = "local-realesrgan";
  readonly version = LOCAL_REALESRGAN_VERSION;
  private validation?: Promise<void>;
  constructor(
    private readonly executable = "realesrgan-ncnn-vulkan",
    readonly model = "realesrgan-x4plus",
    private readonly timeoutMs = 1_800_000,
    private readonly runner: CommandRunner = runCommand,
    private readonly resizer: DeterministicResizer = ffmpegResizer()
  ) {}

  validateConfiguration() { return this.validation ??= this.checkConfiguration(); }

  private async checkConfiguration() {
    try { await this.runner(this.executable, ["--help"], Math.min(this.timeoutMs, 60_000)); }
    catch (error) {
      throw new ConfigurationError(
        `Upscaler executable '${this.executable}' is unavailable. Install Real-ESRGAN (e.g. 'brew install realesrgan-ncnn-vulkan' or the Upscayl ncnn binaries) or set UPSCALER_EXECUTABLE.`,
        { cause: error }
      );
    }
  }

  async upscale(request: ImageUpscaleRequest): Promise<ImageUpscaleResult> {
    await this.validateConfiguration();
    const factor = request.sourceWidth * 2 >= request.targetWidth && request.sourceHeight * 2 >= request.targetHeight ? 2 : 4;
    const directory = dirname(request.outputPath);
    await mkdir(directory, { recursive: true });
    const staged = join(directory, `.upscale-${randomUUID()}.png`);
    try {
      await this.runner(this.executable, ["-i", request.sourcePath, "-o", staged, "-n", request.model ?? this.model, "-s", String(factor), "-f", "png"], this.timeoutMs);
      return await this.finish(request, staged, factor);
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
  }

  async normalize(request: ImageUpscaleRequest): Promise<ImageUpscaleResult> {
    return this.finish(request, request.sourcePath, undefined);
  }

  private async finish(request: ImageUpscaleRequest, intermediate: string, factor: number | undefined): Promise<ImageUpscaleResult> {
    const source = { width: request.sourceWidth, height: request.sourceHeight };
    const target = { width: request.targetWidth, height: request.targetHeight };
    const scaled = { width: source.width * (factor ?? 1), height: source.height * (factor ?? 1) };
    let fit: "exact" | "crop" = "exact";
    if (scaled.width === target.width && scaled.height === target.height) {
      if (intermediate !== request.outputPath) await rename(intermediate, request.outputPath);
    } else {
      fit = (await this.resizer(intermediate, request.outputPath, scaled, target)).fit;
      if (intermediate !== request.sourcePath && intermediate !== request.outputPath) await rm(intermediate, { force: true });
    }
    return { outputPath: request.outputPath, sourceDimensions: source, finalDimensions: target, engine: this.name, model: request.model ?? this.model, scaleFactor: factor, fit };
  }
}

export function createLocalUpscaler(env: Pick<Environment, "UPSCALER_EXECUTABLE" | "UPSCALER_MODEL" | "UPSCALER_TIMEOUT_MS">): LocalRealEsrganUpscaler {
  return new LocalRealEsrganUpscaler(env.UPSCALER_EXECUTABLE, env.UPSCALER_MODEL, env.UPSCALER_TIMEOUT_MS);
}
