import { z } from "zod";
import { ArtworkError } from "../pipeline/errors.js";
import { Story } from "../domain/story.js";
import { ImageNativeTier, ImageProvider } from "./provider.js";
import { ImageProviderRouter } from "./router.js";

export const imageProviderNameSchema = z.enum(["openai", "gemini"]);
export type ImageProviderName = z.infer<typeof imageProviderNameSchema>;

type ImageProviderCatalogEntry = {
  defaultModel: string;
  models: string[];
  supportsReferenceImages: (model: string) => boolean;
  /** Native generation tiers per aspect ratio, ordered ascending. Providers
   * are only ever asked for these tiers — never arbitrary dimensions. */
  nativeTiers:
    | Partial<Record<"16:9" | "1:1" | "9:16", ImageNativeTier[]>>
    | ((model: string) => Partial<Record<"16:9" | "1:1" | "9:16", ImageNativeTier[]>> | undefined);
};

const GEMINI_FULL_TIERS: Record<"16:9" | "1:1" | "9:16", ImageNativeTier[]> = {
  "16:9": [
    { label: "1K", width: 1376, height: 768 },
    { label: "2K", width: 2752, height: 1536 },
    { label: "4K", width: 5504, height: 3072 },
  ],
  "1:1": [
    { label: "1K", width: 1024, height: 1024 },
    { label: "2K", width: 2048, height: 2048 },
    { label: "4K", width: 4096, height: 4096 },
  ],
  "9:16": [
    { label: "1K", width: 768, height: 1376 },
    { label: "2K", width: 1536, height: 2752 },
    { label: "4K", width: 3072, height: 5504 },
  ],
};

const GEMINI_1K_TIERS: Record<"16:9" | "1:1" | "9:16", ImageNativeTier[]> = {
  "16:9": [{ label: "1K", width: 1376, height: 768 }],
  "1:1": [{ label: "1K", width: 1024, height: 1024 }],
  "9:16": [{ label: "1K", width: 768, height: 1376 }],
};

export function geminiSupportedImageSizes(model: string): string[] {
  return model === "gemini-2.5-flash-image" ? ["1K"] : ["1K", "2K", "4K"];
}

export const IMAGE_PROVIDER_CATALOG: Record<ImageProviderName, ImageProviderCatalogEntry> = {
  openai: {
    defaultModel: "gpt-image-2.5-flare",
    models: ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-1", "gpt-image-1-mini"],
    // Only the GPT Image 2.5 family accepts reference-image input.
    supportsReferenceImages: (model) => model.startsWith("gpt-image-2.5"),
    nativeTiers: {
      "16:9": [{ label: "1536x1024", width: 1536, height: 1024 }],
      "1:1": [{ label: "1024x1024", width: 1024, height: 1024 }],
      "9:16": [{ label: "1024x1536", width: 1024, height: 1536 }],
    },
  },
  gemini: {
    defaultModel: "gemini-3.1-flash-image",
    models: ["gemini-3.1-flash-image", "gemini-2.5-flash-image"],
    supportsReferenceImages: (model) => /^gemini-.*-image/.test(model),
    // Quality intent selects the tier: low -> 1K, medium -> 2K, high -> 4K (or 1K only on 1K-native models).
    nativeTiers: (model: string) => (model === "gemini-2.5-flash-image" ? GEMINI_1K_TIERS : GEMINI_FULL_TIERS),
  },
};

export function imageNativeTiers(provider: string, aspectRatio: "16:9" | "1:1" | "9:16", model?: string): ImageNativeTier[] | undefined {
  const entry = IMAGE_PROVIDER_CATALOG[provider as ImageProviderName];
  if (!entry) return undefined;
  const tiers = typeof entry.nativeTiers === "function" ? entry.nativeTiers(model ?? entry.defaultModel) : entry.nativeTiers;
  return tiers?.[aspectRatio];
}

export const MAX_REFERENCE_IMAGES = 4;
export const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_REFERENCE_TOTAL_BYTES = 24 * 1024 * 1024;

export function defaultImageModel(provider: string): string {
  const entry = IMAGE_PROVIDER_CATALOG[provider as ImageProviderName];
  if (!entry) throw new ArtworkError(`Image provider '${provider}' is not supported`);
  return entry.defaultModel;
}

export function imageModelCompatible(provider: string, model: string): boolean {
  const entry = IMAGE_PROVIDER_CATALOG[provider as ImageProviderName];
  if (!entry) return false;
  return entry.models.includes(model);
}

export function assertImageModelCompatible(provider: string, model: string): void {
  const entry = IMAGE_PROVIDER_CATALOG[provider as ImageProviderName];
  if (!entry) throw new ArtworkError(`Image provider '${provider}' is not supported`);
  if (!entry.models.includes(model)) {
    throw new ArtworkError(
      `Artwork model '${model}' is not compatible with image provider '${provider}'. ` +
        `Supported models: ${entry.models.join(", ")} (default: ${entry.defaultModel}). Update story.json artwork settings before generating.`
    );
  }
}

export function providerSupportsReferenceImages(provider: string, model: string): boolean {
  const entry = IMAGE_PROVIDER_CATALOG[provider as ImageProviderName];
  return entry ? entry.supportsReferenceImages(model) : false;
}

export type ImageProviderSource = ImageProvider | ImageProviderRouter | ((story: Story) => ImageProvider);

/** Resolve the effective image provider for a story at execution time so
 * per-story artwork.provider settings are honored everywhere. */
export function resolveImageProvider(source: ImageProviderSource, story: Story): ImageProvider {
  if (typeof source === "function") return source(story);
  if (source instanceof ImageProviderRouter) return source.forName(story.artwork.provider);
  return source;
}
