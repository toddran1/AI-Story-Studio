import { z } from "zod";
import { ImageAspectRatio } from "./provider.js";

export const artworkOutputResolutionSchema = z.enum(["native", "720p", "1080p", "1440p", "2160p"]);
export type ArtworkOutputResolution = z.infer<typeof artworkOutputResolutionSchema>;
export const artworkUpscalingModeSchema = z.enum(["off", "automatic", "always"]);
export type ArtworkUpscalingMode = z.infer<typeof artworkUpscalingModeSchema>;
export const upscalerEngineSchema = z.enum(["local-realesrgan"]);
export type UpscalerEngine = z.infer<typeof upscalerEngineSchema>;

export type ImageDimensions = { width: number; height: number };

const TARGET_DIMENSIONS: Record<Exclude<ArtworkOutputResolution, "native">, Record<ImageAspectRatio, ImageDimensions>> = {
  "720p": { "16:9": { width: 1280, height: 720 }, "9:16": { width: 720, height: 1280 }, "1:1": { width: 720, height: 720 } },
  "1080p": { "16:9": { width: 1920, height: 1080 }, "9:16": { width: 1080, height: 1920 }, "1:1": { width: 1080, height: 1080 } },
  "1440p": { "16:9": { width: 2560, height: 1440 }, "9:16": { width: 1440, height: 2560 }, "1:1": { width: 1440, height: 1440 } },
  "2160p": { "16:9": { width: 3840, height: 2160 }, "9:16": { width: 2160, height: 3840 }, "1:1": { width: 2160, height: 2160 } },
};

/** The single source of truth for final output pixel dimensions. Returns
 * undefined for "native" (provider decides the dimensions). */
export function resolveTargetDimensions(resolution: ArtworkOutputResolution, aspectRatio: ImageAspectRatio): ImageDimensions | undefined {
  if (resolution === "native") return undefined;
  return TARGET_DIMENSIONS[resolution][aspectRatio];
}

export type ResolutionPlan = {
  target?: ImageDimensions;
  nativeRequest?: ImageDimensions;
  action: "none" | "upscale" | "normalize";
  upscaleRequired: boolean;
  reason: string;
};

/** The single place that answers: what final resolution was requested, what
 * the native generation result is (or is estimated to be), and whether a
 * derivative production asset must be derived from the original. */
export function planResolution(input: {
  requested: ArtworkOutputResolution;
  aspectRatio: ImageAspectRatio;
  upscaling: ArtworkUpscalingMode;
  nativeWidth?: number;
  nativeHeight?: number;
  nativeEstimate?: ImageDimensions;
}): ResolutionPlan {
  const target = resolveTargetDimensions(input.requested, input.aspectRatio);
  const native = input.nativeWidth && input.nativeHeight ? { width: input.nativeWidth, height: input.nativeHeight } : input.nativeEstimate;
  const base = { target, nativeRequest: native };
  if (!target) return { ...base, action: "none", upscaleRequired: false, reason: "native output resolution requested" };
  if (input.upscaling === "off") return { ...base, action: "none", upscaleRequired: false, reason: "upscaling disabled" };
  if (!native) return { ...base, action: "none", upscaleRequired: false, reason: "native dimensions unknown" };
  const nativeMeetsTarget = native.width >= target.width && native.height >= target.height;
  if (nativeMeetsTarget && input.upscaling === "automatic")
    return { ...base, action: "none", upscaleRequired: false, reason: "native generation already meets the target resolution" };
  if (nativeMeetsTarget)
    return native.width === target.width && native.height === target.height
      ? { ...base, action: "none", upscaleRequired: false, reason: "native generation already matches the target resolution" }
      : { ...base, action: "normalize", upscaleRequired: false, reason: "normalizing native output to the exact target dimensions" };
  return { ...base, action: "upscale", upscaleRequired: true, reason: `native generation ${native.width}x${native.height} is below the ${target.width}x${target.height} target` };
}

/** Estimate the native generation tier a provider/model will produce, from
 * catalog metadata (ordered ascending). Undefined when the provider has no
 * recorded tier information — never guess dimensions before generation. */
export function estimateNativeDimensions(
  tiers: Array<ImageDimensions & { label: string }> | undefined,
  qualityTier?: number
): (ImageDimensions & { label: string }) | undefined {
  if (!tiers?.length) return undefined;
  const index = qualityTier === undefined ? 0 : Math.min(Math.max(qualityTier, 0), tiers.length - 1);
  return tiers[index];
}

/** Map generation quality intent onto an ascending native-tier index. */
export function qualityTierIndex(quality: "low" | "medium" | "high"): number {
  return quality === "low" ? 0 : quality === "medium" ? 1 : 2;
}

/** Minimal PNG (IHDR) and JPEG (SOF) dimension parser so actual returned
 * image dimensions can be recorded without a new dependency. */
export function imageDimensions(data: Buffer): ImageDimensions | undefined {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 && data.readUInt32BE(4) === 0x0d0a1a0a) {
    if (data.toString("ascii", 12, 16) !== "IHDR") return undefined;
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset++; continue; }
      const marker = data[offset + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = data.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > data.length) return undefined;
      // Start-of-frame markers (excluding DHT/DAC/RST) carry dimensions.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        const height = data.readUInt16BE(offset + 5);
        const width = data.readUInt16BE(offset + 7);
        return width > 0 && height > 0 ? { width, height } : undefined;
      }
      offset += 2 + length;
    }
  }
  return undefined;
}
