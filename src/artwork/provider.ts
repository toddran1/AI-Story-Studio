export type ImageAspectRatio = "16:9" | "1:1" | "9:16";
export type ImageQualityIntent = "low" | "medium" | "high";
export type ImageSize = "1536x1024" | "1024x1024" | "1024x1536";

export type ImageReferenceImage = { data: Buffer; mimeType: string; role?: string; sourceKind?: "visual-profile" | "continuity"; entityId?: string; entityName?: string; referenceId?: string };

/** Provider-neutral generation intent. Each provider adapter translates this
 * into its own API parameters (size/quality/resolution/reference parts). */
export type ImageGenerationRequest = {
  model: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio: ImageAspectRatio;
  quality: ImageQualityIntent;
  size: ImageSize;
  outputFormat: "png";
  referenceImages?: ImageReferenceImage[];
};
export type ImageGenerationResult = { data: Buffer; mimeType: "image/png"; revisedPrompt?: string; requestId?: string; width?: number; height?: number };

/** A native generation tier a provider model can produce, ordered ascending. */
export type ImageNativeTier = { label: string; width: number; height: number };

export type ImageProviderCapabilities = {
  supportsReferenceImages: boolean;
  maxReferenceImages: number;
  aspectRatios: ImageAspectRatio[];
  models: string[];
  defaultModel: string;
};

export interface ImageProvider {
  readonly name: string;
  readonly version: string;
  readonly capabilities?: ImageProviderCapabilities;
  validateConfiguration(): Promise<void>;
  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
}
