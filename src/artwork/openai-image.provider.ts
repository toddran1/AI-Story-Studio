import OpenAI, { toFile } from "openai";
import { openAiTransport } from "../llm/openai/transport.js";
import { ConfigurationError, ArtworkError } from "../pipeline/errors.js";
import { toOpenAiProviderError } from "../llm/openai/openai.provider.js";
import { ImageGenerationRequest, ImageGenerationResult, ImageProvider, ImageProviderCapabilities } from "./provider.js";
import { IMAGE_PROVIDER_CATALOG, MAX_REFERENCE_IMAGES } from "./providers.js";

export class OpenAIImageProvider implements ImageProvider {
  // The version contributes to artwork fingerprints. It stays "v1" because the
  // adapter's fingerprint-relevant behavior (prompt + story settings -> PNG) is
  // unchanged; new models invalidate artwork through story.artwork.model instead.
  readonly name = "openai"; readonly version = "openai-images-v1";
  readonly capabilities: ImageProviderCapabilities = {
    supportsReferenceImages: true,
    maxReferenceImages: MAX_REFERENCE_IMAGES,
    aspectRatios: ["16:9", "1:1", "9:16"],
    models: IMAGE_PROVIDER_CATALOG.openai.models,
    defaultModel: IMAGE_PROVIDER_CATALOG.openai.defaultModel,
  };
  private readonly client: OpenAI;
  constructor(private readonly apiKey?: string, timeoutMs = 180_000, client?: OpenAI) {
    this.client = client ?? new OpenAI({ ...openAiTransport, apiKey: apiKey ?? "missing", timeout: timeoutMs, maxRetries: 0 });
  }
  async validateConfiguration() { if (!this.apiKey) throw new ConfigurationError("Missing required OpenAI credential (OPENAI_API_KEY). Add it to .env."); }
  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    await this.validateConfiguration();
    const prompt = request.negativePrompt ? `${request.prompt}\n\nAVOID: ${request.negativePrompt}` : request.prompt;
    try {
      const references = (request.referenceImages ?? []).slice(0, this.capabilities.maxReferenceImages);
      if (references.length && IMAGE_PROVIDER_CATALOG.openai.supportsReferenceImages(request.model)) {
        const files = await Promise.all(
          references.map((reference, index) => toFile(reference.data, `reference-${index + 1}.png`, { type: reference.mimeType }))
        );
        const response = await this.client.images.edit({
          model: request.model,
          image: files,
          prompt,
          n: 1,
          size: request.size,
          quality: request.quality,
        });
        return { ...decode(response.data?.[0]), ...imageUsage(response) };
      }
      const response = await this.client.images.generate({
        model: request.model,
        prompt,
        n: 1,
        size: request.size,
        quality: request.quality,
        output_format: request.outputFormat,
        moderation: "low",
      });
      return { ...decode(response.data?.[0]), ...imageUsage(response) };
    } catch (error) {
      if (error instanceof ConfigurationError || error instanceof ArtworkError) throw error;
      throw toOpenAiProviderError(error, "OpenAI image generation request failed", request.model);
    }
  }
}

function decode(image: { b64_json?: string | null; revised_prompt?: string | null } | undefined): ImageGenerationResult {
  if (!image?.b64_json) throw new ArtworkError("OpenAI returned no image data");
  const data = Buffer.from(image.b64_json, "base64");
  if (!data.length) throw new ArtworkError("OpenAI returned an empty image");
  return { data, mimeType: "image/png", revisedPrompt: image.revised_prompt ?? undefined };
}

/** Retain provider-reported billing data for both generation and reference edits. */
function imageUsage(response: { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { text_tokens?: number; image_tokens?: number; cached_tokens?: number; cached_tokens_details?: { text_tokens?: number; image_tokens?: number } } }; _request_id?: string | null }) {
  const usage = response.usage, details = usage?.input_tokens_details;
  return { requestId: response._request_id ?? undefined, ...(usage ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, inputTextTokens: details?.text_tokens, inputImageTokens: details?.image_tokens, cachedInputTokens: details?.cached_tokens, cachedTextTokens: details?.cached_tokens_details?.text_tokens, cachedImageTokens: details?.cached_tokens_details?.image_tokens } } : {}) };
}
