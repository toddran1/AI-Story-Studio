import { ffmpegResizer, type DeterministicResizer } from "./local-realesrgan.upscaler.js";
import type { ImageUpscaleRequest, ImageUpscaleResult, ImageUpscaler } from "./upscaler.js";

/** Composition-preserving local resize. It never invokes an image model. */
export class FfmpegLanczosUpscaler implements ImageUpscaler {
  readonly name = "ffmpeg-lanczos";
  readonly version = "ffmpeg-lanczos-v1";

  constructor(private readonly resizer: DeterministicResizer = ffmpegResizer()) {}

  async validateConfiguration(): Promise<void> {}

  async upscale(request: ImageUpscaleRequest): Promise<ImageUpscaleResult> {
    const sourceDimensions = { width: request.sourceWidth, height: request.sourceHeight };
    const finalDimensions = { width: request.targetWidth, height: request.targetHeight };
    const { fit } = await this.resizer(request.sourcePath, request.outputPath, sourceDimensions, finalDimensions);
    return { outputPath: request.outputPath, sourceDimensions, finalDimensions, engine: this.name, fit };
  }

  normalize(request: ImageUpscaleRequest): Promise<ImageUpscaleResult> {
    return this.upscale(request);
  }
}
