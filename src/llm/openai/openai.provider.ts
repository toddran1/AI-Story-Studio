import OpenAI from "openai";
import { z } from "zod";
import { LLMProvider } from "../provider.js";
import { LLMRequest, StructuredLLMRequest } from "../types.js";
import { ConfigurationError, ProviderError } from "../../pipeline/errors.js";

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;
  private readonly client: OpenAI;
  constructor(private readonly apiKey?: string) { this.client = new OpenAI({ apiKey: apiKey ?? "missing" }); }
  async validateConfiguration(): Promise<void> { if (!this.apiKey) throw new ConfigurationError("Missing required openai credential (OPENAI_API_KEY). Add it to .env."); }

  async generateText(request: LLMRequest) {
    await this.validateConfiguration();
    try {
      const response = await this.client.responses.create({ model: request.model, instructions: request.instructions, input: request.input, store: false });
      if (!response.output_text) throw new ProviderError("OpenAI returned no output text");
      return { text: response.output_text, usage: {
        inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens,
        cachedTokens: response.usage?.input_tokens_details?.cached_tokens, requestId: response.id,
      }};
    } catch (error) { if (error instanceof ConfigurationError) throw error; throw new ProviderError("OpenAI Responses API request failed", { cause: error }); }
  }

  async generateStructured<T>(request: StructuredLLMRequest<T>) {
    await this.validateConfiguration();
    try {
      const response = await this.client.responses.create({
        model: request.model, instructions: request.instructions, input: request.input, store: false,
        text: { format: { type: "json_schema", name: request.schemaName, strict: true, schema: z.toJSONSchema(request.schema) } },
      });
      if (!response.output_text) throw new ProviderError("OpenAI returned no structured output");
      return { value: request.schema.parse(JSON.parse(response.output_text)), usage: {
        inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens,
        cachedTokens: response.usage?.input_tokens_details?.cached_tokens, requestId: response.id,
      }};
    } catch (error) { if (error instanceof ConfigurationError) throw error; throw new ProviderError("OpenAI structured Responses API request failed", { cause: error }); }
  }
}
