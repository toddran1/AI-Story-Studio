import { validateModelEffort } from "../effort.js";
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
    if (request.images?.length) throw new ConfigurationError("This Kimi adapter does not support image inputs. Choose an image-capable QA provider for visual checks.");
    await this.validateConfiguration();
    validateModelEffort(this.name, request.model, request.effort);
    let observedUsage: import("../types.js").LLMUsage | undefined;
    try {
      const response = await this.client.chat.completions.create({
        model: request.model,
        ...(request.effort ? { thinking: { type: request.effort } } : {}),
        messages: [
          { role: "system", content: request.instructions },
          { role: "user", content: request.input },
        ],
      });
      observedUsage = usageFrom(response);
      const text = response.choices[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw new ProviderError("Kimi returned no output text");
      return { text, usage: usageFrom(response) };
    } catch (error) { if (error instanceof ConfigurationError) throw error; const wrapped = new ProviderError("Kimi chat completion request failed", { cause: error, requestId: observedUsage?.requestId }); wrapped.usage = observedUsage; throw wrapped; }
  }

  async generateStructured<T>(request: StructuredLLMRequest<T>) {
    if (request.images?.length) throw new ConfigurationError("This Kimi adapter does not support image inputs. Choose an image-capable QA provider for visual checks.");
    await this.validateConfiguration();
    validateModelEffort(this.name, request.model, request.effort);
    let observedUsage: import("../types.js").LLMUsage | undefined;
    try {
      const response = await this.client.chat.completions.create({
        model: request.model,
        ...(request.effort ? { thinking: { type: request.effort } } : {}),
        messages: [
          { role: "system", content: request.instructions },
          { role: "user", content: `${request.input}\n\n${jsonSchemaContract(request.schema)}` },
        ],
        response_format: { type: "json_object" },
      });
      observedUsage = usageFrom(response);
      const text = response.choices[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw new ProviderError("Kimi returned no structured output");
      return { value: request.schema.parse(JSON.parse(text)), usage: usageFrom(response) };
    } catch (error) { if (error instanceof ConfigurationError) throw error; const wrapped = new ProviderError("Kimi structured chat completion request failed", { cause: error, requestId: observedUsage?.requestId }); wrapped.usage = observedUsage; throw wrapped; }
  }
}

function jsonSchemaContract(schema: z.ZodType): string {
  // Moonshot's json_object mode constrains the response to JSON but not to a
  // schema, so the full Zod-generated contract travels in the prompt and Zod
  // remains the authoritative local validator.
  return `Return only a JSON object that conforms exactly to this JSON Schema. Do not use markdown fences:\n${JSON.stringify(z.toJSONSchema(schema))}`;
}

function usageFrom(response: { id: string; usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number | null } | null; prompt_tokens_details?: { cached_tokens?: number | null } | null } }) {
  return {
    requestId: response.id,
    inputTokens: response.usage?.prompt_tokens,
    outputTokens: response.usage?.completion_tokens,
    reasoningTokens: response.usage?.completion_tokens_details?.reasoning_tokens ?? undefined,
    cachedTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? undefined,
  };
}
