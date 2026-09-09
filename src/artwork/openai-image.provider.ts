import OpenAI from "openai";
import { ConfigurationError, ArtworkError, ProviderError } from "../pipeline/errors.js";
import { ImageGenerationRequest, ImageGenerationResult, ImageProvider } from "./provider.js";

export class OpenAIImageProvider implements ImageProvider {
  readonly name = "openai"; readonly version = "openai-images-v1"; private readonly client: OpenAI;
  constructor(private readonly apiKey?: string, timeoutMs = 180_000) { this.client = new OpenAI({ apiKey: apiKey ?? "missing", timeout: timeoutMs, maxRetries: 0 }); }
  async validateConfiguration() { if (!this.apiKey) throw new ConfigurationError("Missing required OpenAI credential (OPENAI_API_KEY). Add it to .env."); }
  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    await this.validateConfiguration();
    try { const response = await this.client.images.generate({ model: request.model, prompt: request.prompt, n: 1, size: request.size, quality: request.quality, output_format: request.outputFormat }); const image = response.data?.[0]; if (!image?.b64_json) throw new ArtworkError("OpenAI returned no image data"); const data = Buffer.from(image.b64_json, "base64"); if (!data.length) throw new ArtworkError("OpenAI returned an empty image"); return { data, mimeType: "image/png", revisedPrompt: image.revised_prompt };
    } catch (error) { if (error instanceof ConfigurationError || error instanceof ArtworkError) throw error; throw new ProviderError("OpenAI image generation request failed", { cause: error }); }
  }
}
