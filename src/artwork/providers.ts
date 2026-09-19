import { z } from "zod";
import { ArtworkError } from "../pipeline/errors.js";
import { Story } from "../domain/story.js";
import { ImageProvider } from "./provider.js";
import { ImageProviderRouter } from "./router.js";

export const imageProviderNameSchema = z.enum(["openai", "gemini"]);
export type ImageProviderName = z.infer<typeof imageProviderNameSchema>;

type ImageProviderCatalogEntry = { defaultModel: string; models: string[]; supportsReferenceImages: (model: string) => boolean };

export const IMAGE_PROVIDER_CATALOG: Record<ImageProviderName, ImageProviderCatalogEntry> = {
  openai: {
    defaultModel: "gpt-image-2.5-flare",
    models: ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-1", "gpt-image-1-mini"],
    // Only the GPT Image 2.5 family accepts reference-image input.
    supportsReferenceImages: (model) => model.startsWith("gpt-image-2.5"),
  },
  gemini: {
    defaultModel: "gemini-3.1-flash-image",
    models: ["gemini-3.1-flash-image"],
    supportsReferenceImages: (model) => /^gemini-.*-image/.test(model),
  },
};

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
