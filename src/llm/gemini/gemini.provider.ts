import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { LLMProvider } from "../provider.js";
import { LLMRequest, StructuredLLMRequest } from "../types.js";
import { ConfigurationError, ProviderError } from "../../pipeline/errors.js";

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini" as const;
  private readonly client: GoogleGenAI;
  constructor(private readonly apiKey?: string, timeoutMs = 120_000) { this.client = new GoogleGenAI({ apiKey: apiKey ?? "missing", httpOptions: { timeout: timeoutMs } }); }
  async validateConfiguration(): Promise<void> { if (!this.apiKey) throw new ConfigurationError("Missing required gemini credential (GEMINI_API_KEY). Add it to .env."); }

  async generateText(request: LLMRequest) {
    await this.validateConfiguration();
    try {
      const interaction = await this.client.interactions.create({ model: request.model, input: `${request.instructions}\n\n${request.input}` });
      if (!interaction.output_text?.trim()) throw new ProviderError("Gemini returned no output text");
      return { text: interaction.output_text, usage: usageFrom(interaction) };
    } catch (error) { if (error instanceof ConfigurationError) throw error; throw new ProviderError("Gemini Interactions API request failed", { cause: error }); }
  }

  async generateStructured<T>(request: StructuredLLMRequest<T>) {
    await this.validateConfiguration();
    try {
      const input = `${request.instructions}\n\n${request.input}`;
      const providerSchema = geminiJsonSchema(request.schema);
      const useCompactSchema = JSON.stringify(providerSchema).length > MAX_GEMINI_RESPONSE_SCHEMA_CHARACTERS;
      const responseSchema = useCompactSchema ? compactGeminiSchema(providerSchema) : providerSchema;
      let interaction;
      try {
        interaction = await this.client.interactions.create({
          model: request.model,
          input,
          response_format: { type: "text", mime_type: "application/json", schema: responseSchema },
        });
      } catch (error) {
        // Gemini can reject an otherwise valid JSON Schema when it is too large
        // or deeply nested. Keep Zod as the authoritative local validator and
        // retry once with the complete contract in the prompt instead.
        if (useCompactSchema || !isGeminiSchemaRejection(error)) throw error;
        interaction = await this.client.interactions.create({
          model: request.model,
          input: `${input}\n\n${compactSchemaContract(request.schema)}`,
          response_format: { type: "text", mime_type: "application/json", schema: { type: "object" } },
        });
      }
      if (!interaction.output_text?.trim()) throw new ProviderError("Gemini returned no structured output");
      return { value: request.schema.parse(JSON.parse(interaction.output_text)), usage: usageFrom(interaction) };
    } catch (error) { if (error instanceof ConfigurationError) throw error; throw new ProviderError("Gemini structured Interactions API request failed", { cause: error }); }
  }
}

// Google does not publish a precise limit, but explicitly warns that very
// large schemas can be rejected. Keep enough headroom beneath the size at
// which the Story Bible schema was observed to fail.
const MAX_GEMINI_RESPONSE_SCHEMA_CHARACTERS = 6_000;

/**
 * Retain the complete response shape but strip every constraint Gemini does
 * not need to guarantee parseable output. In particular, nested objects keep
 * only their required properties; optional/defaulted data remains optional.
 * This reduces the Story Bible schema from 7,210 to a small, accepted shape
 * while still making chapterSummary and entity identity fields mandatory.
 */
function compactGeminiSchema(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((item) => compactGeminiSchema(item, depth));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (source.type !== undefined) result.type = source.type;
  if (source.enum !== undefined) result.enum = source.enum;
  if (source.items !== undefined) result.items = compactGeminiSchema(source.items, depth + 1);
  if (source.properties && typeof source.properties === "object") {
    const properties = source.properties as Record<string, unknown>;
    const required = Array.isArray(source.required) ? source.required.filter((key): key is string => typeof key === "string") : [];
    // The root contains the response sections. Nested records only need their
    // required fields; Zod supplies defaults for the remaining fields.
    const names = depth === 0 ? Object.keys(properties) : required;
    result.properties = Object.fromEntries(names.filter((name) => name in properties).map((name) => [name, compactGeminiSchema(properties[name], depth + 1)]));
    if (required.length) result.required = required.filter((name) => name in (result.properties as Record<string, unknown>));
  }
  return result;
}

function isGeminiSchemaRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; message?: unknown };
  return candidate.status === 400 && typeof candidate.message === "string" && /invalid argument|schema/i.test(candidate.message);
}

function compactSchemaContract(schema: z.ZodType): string {
  // This is prompt data, not a replacement for local validation, so preserve
  // the full Zod-generated contract for Gemini to follow.
  return `Return only a JSON object that conforms exactly to this JSON Schema. Do not use markdown fences:\n${JSON.stringify(z.toJSONSchema(schema))}`;
}

/**
 * Gemini Interactions accepts a deliberately small JSON Schema subset. Zod's
 * exporter includes useful local-validation keywords (such as `default`,
 * `minLength`, and `exclusiveMinimum`) that the endpoint rejects with HTTP
 * 400. Keep the full Zod schema for parsing locally, but send only Gemini's
 * documented structured-output vocabulary to the provider.
 */
export function geminiJsonSchema(schema: z.ZodType): unknown {
  return sanitizeGeminiSchema(z.toJSONSchema(schema));
}

const geminiSchemaKeys = new Set([
  "$defs", "$ref", "$anchor", "type", "format", "title", "description", "enum", "items", "prefixItems",
  "minItems", "maxItems", "minimum", "maximum", "anyOf", "oneOf", "properties", "additionalProperties",
  "required", "propertyOrdering",
]);

function sanitizeGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGeminiSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => geminiSchemaKeys.has(key))
    .map(([key, child]) => [key, key === "properties" || key === "$defs"
      ? Object.fromEntries(Object.entries(child as Record<string, unknown>).map(([name, nested]) => [name, sanitizeGeminiSchema(nested)]))
      : sanitizeGeminiSchema(child)]));
}

function usageFrom(interaction: { id: string; usage?: { total_input_tokens?: number; total_output_tokens?: number; total_cached_tokens?: number } }) {
  return {
    requestId: interaction.id,
    inputTokens: interaction.usage?.total_input_tokens,
    outputTokens: interaction.usage?.total_output_tokens,
    cachedTokens: interaction.usage?.total_cached_tokens,
  };
}
