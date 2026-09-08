import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { LLMProvider } from "../provider.js";
import { LLMRequest, StructuredLLMRequest } from "../types.js";
import { ConfigurationError, ProviderError } from "../../pipeline/errors.js";

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini" as const;
  private readonly client: GoogleGenAI;
  constructor(private readonly apiKey?: string) { this.client = new GoogleGenAI({ apiKey: apiKey ?? "missing" }); }
  async validateConfiguration(): Promise<void> { if (!this.apiKey) throw new ConfigurationError("Missing required gemini credential (GEMINI_API_KEY). Add it to .env."); }

  async generateText(request: LLMRequest) {
    await this.validateConfiguration();
    try {
      const interaction = await this.client.interactions.create({ model: request.model, input: `${request.instructions}\n\n${request.input}` });
      if (!interaction.output_text) throw new ProviderError("Gemini returned no output text");
      return { text: interaction.output_text, usage: { requestId: interaction.id } };
    } catch (error) { if (error instanceof ConfigurationError) throw error; throw new ProviderError("Gemini Interactions API request failed", { cause: error }); }
  }

  async generateStructured<T>(request: StructuredLLMRequest<T>) {
    await this.validateConfiguration();
    try {
      const interaction = await this.client.interactions.create({
        model: request.model, input: `${request.instructions}\n\n${request.input}`,
        response_format: { type: "text", mime_type: "application/json", schema: z.toJSONSchema(request.schema) },
      });
      if (!interaction.output_text) throw new ProviderError("Gemini returned no structured output");
      return { value: request.schema.parse(JSON.parse(interaction.output_text)), usage: { requestId: interaction.id } };
    } catch (error) { if (error instanceof ConfigurationError) throw error; throw new ProviderError("Gemini structured Interactions API request failed", { cause: error }); }
  }
}
