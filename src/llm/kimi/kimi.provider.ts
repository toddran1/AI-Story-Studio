import OpenAI from "openai";
import { z } from "zod";
import { LLMProvider } from "../provider.js";
import { LLMRequest, StructuredLLMRequest } from "../types.js";
import { ConfigurationError, ProviderError } from "../../pipeline/errors.js";

const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";

export class KimiProvider implements LLMProvider {
  readonly name = "kimi" as const;
  private readonly client: OpenAI;
  constructor(private readonly apiKey?: string, timeoutMs = 120_000) {
    this.client = new OpenAI({ apiKey: apiKey ?? "missing", baseURL: MOONSHOT_BASE_URL, timeout: timeoutMs, maxRetries: 0 });
  }
  async validateConfiguration(): Promise<void> { if (!this.apiKey) throw new ConfigurationError("Missing required kimi credential (KIMI_API_KEY). Add it to .env."); }

  async generateText(request: LLMRequest) {
    await this.validateConfiguration();
    try {
      const response = await this.client.chat.completions.create({
        model: request.model,
        messages: [
          { role: "system", content: request.instructions },
          { role: "user", content: request.input },
        ],
      });
      const text = response.choices[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw new ProviderError("Kimi returned no output text");
      return { text, usage: usageFrom(response) };
    } catch (error) { if (error instanceof ConfigurationError) throw error; throw new ProviderError("Kimi chat completion request failed", { cause: error }); }
  }

  async generateStructured<T>(request: StructuredLLMRequest<T>) {
    await this.validateConfiguration();
    try {
      const response = await this.client.chat.completions.create({
        model: request.model,
        messages: [
          { role: "system", content: request.instructions },
          { role: "user", content: `${request.input}\n\n${jsonSchemaContract(request.schema)}` },
        ],
        response_format: { type: "json_object" },
      });
      const text = response.choices[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw new ProviderError("Kimi returned no structured output");
      return { value: request.schema.parse(JSON.parse(text)), usage: usageFrom(response) };
    } catch (error) { if (error instanceof ConfigurationError) throw error; throw new ProviderError("Kimi structured chat completion request failed", { cause: error }); }
  }
}

function jsonSchemaContract(schema: z.ZodType): string {
  // Moonshot's json_object mode constrains the response to JSON but not to a
  // schema, so the full Zod-generated contract travels in the prompt and Zod
  // remains the authoritative local validator.
  return `Return only a JSON object that conforms exactly to this JSON Schema. Do not use markdown fences:\n${JSON.stringify(z.toJSONSchema(schema))}`;
}

function usageFrom(response: { id: string; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number | null } | null } }) {
  return {
    requestId: response.id,
    inputTokens: response.usage?.prompt_tokens,
    outputTokens: response.usage?.completion_tokens,
    cachedTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? undefined,
  };
}
