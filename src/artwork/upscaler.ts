import { fingerprint } from "../utils/hash.js";
import { ImageDimensions } from "./resolution.js";

export type ImageUpscaleRequest = {
  sourcePath: string;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  outputPath: string;
  model?: string;
};

export type ImageUpscaleResult = {
  outputPath: string;
  sourceDimensions: ImageDimensions;
  finalDimensions: ImageDimensions;
  engine: string;
  model?: string;
  scaleFactor?: number;
  fit: "exact" | "crop" | "pad";
};

/** Provider-neutral local image upscaler contract. Implementations wrap local
 * engines (CLI binaries); they never record paid provider usage. */
export interface ImageUpscaler {
  readonly name: string;
  readonly version: string;
  readonly model?: string;
  validateConfiguration(): Promise<void>;
  /** AI upscale pass from the ORIGINAL provider image, followed by a
   * deterministic normalization to the exact target when needed. */
  upscale(request: ImageUpscaleRequest): Promise<ImageUpscaleResult>;
  /** Deterministic resize/pad/crop to the exact target — no AI pass. */
  normalize(request: ImageUpscaleRequest): Promise<ImageUpscaleResult>;
}

/** Derivative fingerprint: deliberately separate from the generation
 * fingerprint (artworkFingerprint). Changing outputResolution/upscaling/
 * upscaler settings rebuilds the derivative only; the preserved original
 * provider image stays valid. */
export function upscaleFingerprint(input: {
  originalFingerprint: string;
  resolution: string;
  upscaling: string;
  engine: string;
  model?: string;
  target?: ImageDimensions;
}): string {
  return fingerprint({
    original: input.originalFingerprint,
    resolution: input.resolution,
    upscaling: input.upscaling,
    engine: input.engine,
    model: input.model,
    target: input.target,
    version: "artwork-upscale-v1",
  });
}
