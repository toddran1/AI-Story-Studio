import { GoogleGenAI } from "@google/genai";
import { ConfigurationError, ArtworkError, ProviderError } from "../pipeline/errors.js";
import { ImageGenerationRequest, ImageGenerationResult, ImageProvider, ImageProviderCapabilities, ImageQualityIntent } from "./provider.js";
import { IMAGE_PROVIDER_CATALOG, MAX_REFERENCE_IMAGES } from "./providers.js";
import { geminiSupportedImageSizes, IMAGE_PROVIDER_CATALOG, MAX_REFERENCE_IMAGES } from "./providers.js";

const IMAGE_SIZE_BY_QUALITY: Record<ImageQualityIntent, string> = { low: "1K", medium: "2K", high: "4K" };

export class GeminiImageProvider implements ImageProvider {
  readonly name = "gemini"; readonly version = "gemini-images-v1";
  readonly capabilities: ImageProviderCapabilities = {
    supportsReferenceImages: true,
    maxReferenceImages: MAX_REFERENCE_IMAGES,
    aspectRatios: ["16:9", "1:1", "9:16"],
    models: IMAGE_PROVIDER_CATALOG.gemini.models,
    defaultModel: IMAGE_PROVIDER_CATALOG.gemini.defaultModel,
  };
  private readonly client: GoogleGenAI;
  constructor(private readonly apiKey?: string, timeoutMs = 180_000, client?: GoogleGenAI) {
    this.client = client ?? new GoogleGenAI({ apiKey: apiKey ?? "missing", httpOptions: { timeout: timeoutMs } });
  }
  async validateConfiguration() { if (!this.apiKey) throw new ConfigurationError("Missing required gemini credential (GEMINI_API_KEY). Add it to .env."); }
  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    await this.validateConfiguration();
    const text = request.negativePrompt ? `${request.prompt}\n\nAVOID: ${request.negativePrompt}` : request.prompt;
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [{ text }];
    for (const reference of (request.referenceImages ?? []).slice(0, this.capabilities.maxReferenceImages)) {
      parts.push({ inlineData: { mimeType: reference.mimeType, data: reference.data.toString("base64") } });
    }
    const desiredSize = IMAGE_SIZE_BY_QUALITY[request.quality];
    const legalSizes = geminiSupportedImageSizes(request.model);
    const imageSize = legalSizes.includes(desiredSize) ? desiredSize : legalSizes[legalSizes.length - 1] ?? "1K";
    try {
      const response = await this.client.models.generateContent({
        model: request.model,
        contents: [{ role: "user", parts }],
        config: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: request.aspectRatio, imageSize: IMAGE_SIZE_BY_QUALITY[request.quality] },
          imageConfig: { aspectRatio: request.aspectRatio, imageSize },
        },
      });
      return decodeGeminiImageResponse(response);
    } catch (error) {
      if (error instanceof ConfigurationError || error instanceof ArtworkError) throw error;
      throw toGeminiImageProviderError(error, request.model);
    }
  }
}

function decodeGeminiImageResponse(response: {
  responseId?: string;
  promptFeedback?: { blockReason?: unknown; blockReasonMessage?: string };
  candidates?: Array<{ finishReason?: unknown; content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> } }>;
}): ImageGenerationResult {
  const requestId = typeof response.responseId === "string" ? response.responseId : undefined;
  const blocked = response.promptFeedback?.blockReason;
  if (blocked) {
    throw new ArtworkError(
      `Gemini blocked the image request (${String(blocked)}${response.promptFeedback?.blockReasonMessage ? `: ${response.promptFeedback.blockReasonMessage}` : ""})`
    );
  }
  const candidate = response.candidates?.[0];
  if (candidate?.finishReason && !["STOP", "MAX_TOKENS"].includes(String(candidate.finishReason))) {
    throw new ArtworkError(`Gemini image generation finished abnormally (${String(candidate.finishReason)})`);
  }
  const part = candidate?.content?.parts?.find((item) => item.inlineData?.data);
  const raw = part?.inlineData?.data;
  if (!raw) throw new ArtworkError("Gemini returned no image data");
  const data = Buffer.from(raw, "base64");
  if (!data.length) throw new ArtworkError("Gemini returned an empty image");
  return { data, mimeType: "image/png", requestId };
}

function toGeminiImageProviderError(error: unknown, model: string): ProviderError {
  const err = (error ?? {}) as Record<string, unknown>;
  const status = typeof err.status === "number" ? err.status : typeof err.statusCode === "number" ? err.statusCode : undefined;
  const message = typeof err.message === "string" ? err.message : String(error);
  let category = "unknown_provider_error";
  let retryable = false;
  let summary = `Gemini image generation request failed: ${message}`;
  if (status === 401 || status === 403 || /api key|permission|unauthorized/i.test(message)) {
    category = "authentication_error";
    summary = `Gemini authentication failed: ${message}`;
  } else if (status === 429 || /quota|rate limit|resource exhausted/i.test(message)) {
    category = "rate_limited";
    retryable = true;
    summary = `Gemini rate limit or quota exceeded: ${message}`;
  } else if (/safety|blocked/i.test(message)) {
    category = "content_blocked";
    summary = `Gemini image generation was blocked: ${message}`;
  } else if (status && status >= 500) {
    category = "provider_unavailable";
    retryable = true;
    summary = `Gemini service unavailable (${status}): ${message}`;
  }
  return new ProviderError(summary, { cause: error, status, category, provider: "gemini", model, retryable });
}
