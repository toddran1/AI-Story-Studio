import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { LLMProvider } from "../provider.js";
import { LLMRequest, StructuredLLMRequest } from "../types.js";
import { ConfigurationError, ProviderError } from "../../pipeline/errors.js";

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;
  private readonly client: OpenAI;
  constructor(private readonly apiKey?: string, timeoutMs = 120_000) {
    this.client = new OpenAI({ apiKey: apiKey ?? "missing", timeout: timeoutMs, maxRetries: 0 });
  }

  async validateConfiguration(): Promise<void> {
    if (!this.apiKey || this.apiKey === "missing") {
      throw new ConfigurationError("Missing required openai credential (OPENAI_API_KEY). Add it to .env.");
    }
  }

  async generateText(request: LLMRequest) {
    await this.validateConfiguration();
    try {
      const response = await this.client.responses.create({
        model: request.model,
        instructions: request.instructions,
        input: request.input,
        store: false,
      });
      if (!response.output_text?.trim()) {
        throw new ProviderError("OpenAI returned no output text", {
          provider: "openai",
          model: request.model,
          category: "unknown_provider_error",
          requestId: response.id,
        });
      }
      return {
        text: response.output_text,
        usage: {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          cachedTokens: response.usage?.input_tokens_details?.cached_tokens,
          requestId: response.id,
        },
      };
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      throw toOpenAiProviderError(error, "OpenAI Responses API request failed", request.model);
    }
  }

  async generateStructured<T>(request: StructuredLLMRequest<T>) {
    await this.validateConfiguration();
    try {
      const format = toOpenAiTextFormat(request.schema, request.schemaName);
      const response = await this.client.responses.create({
        model: request.model,
        instructions: request.instructions,
        input: request.input,
        store: false,
        text: { format },
      });
      if (!response.output_text?.trim()) {
        throw new ProviderError("OpenAI returned no structured output", {
          provider: "openai",
          model: request.model,
          category: "unknown_provider_error",
          requestId: response.id,
        });
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(response.output_text);
      } catch (jsonErr) {
        throw new ProviderError("OpenAI returned unparseable JSON text", {
          cause: jsonErr,
          provider: "openai",
          model: request.model,
          category: "response_parse_error",
          requestId: response.id,
        });
      }
      let value: T;
      try {
        value = request.schema.parse(parsedJson);
      } catch (zodErr) {
        throw new ProviderError("OpenAI structured output failed schema validation", {
          cause: zodErr,
          provider: "openai",
          model: request.model,
          category: "validation_error",
          requestId: response.id,
        });
      }
      return {
        value,
        usage: {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          cachedTokens: response.usage?.input_tokens_details?.cached_tokens,
          requestId: response.id,
        },
      };
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      if (error instanceof ProviderError) throw error;
      throw toOpenAiProviderError(error, "OpenAI structured Responses API request failed", request.model);
    }
  }
}

export function toOpenAiTextFormat(schema: z.ZodType, name: string) {
  try {
    return zodTextFormat(schema, name);
  } catch {
    const raw = z.toJSONSchema(schema);
    return { type: "json_schema" as const, name, strict: true, schema: normalizeForOpenAiStrict(raw) as Record<string, unknown> };
  }
}

export function normalizeForOpenAiStrict(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeForOpenAiStrict);
  const copy: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
  if (copy.type === "object" && copy.properties && typeof copy.properties === "object") {
    copy.additionalProperties = false;
    const properties = copy.properties as Record<string, unknown>;
    const propKeys = Object.keys(properties);
    const existingRequired = new Set(Array.isArray(copy.required) ? (copy.required as string[]) : []);
    for (const key of propKeys) {
      let propSchema = normalizeForOpenAiStrict(properties[key]) as Record<string, unknown>;
      if (!existingRequired.has(key) && propSchema && typeof propSchema === "object") {
        if (propSchema.type && typeof propSchema.type === "string" && propSchema.type !== "null") {
          propSchema = { ...propSchema, type: [propSchema.type, "null"] };
        } else if (Array.isArray(propSchema.type) && !propSchema.type.includes("null")) {
          propSchema = { ...propSchema, type: [...propSchema.type, "null"] };
        } else if (!propSchema.type && !propSchema.anyOf) {
          propSchema = { anyOf: [propSchema, { type: "null" }] };
        }
      }
      properties[key] = propSchema;
    }
    copy.required = propKeys;
  }
  if (copy.items) copy.items = normalizeForOpenAiStrict(copy.items);
  if (Array.isArray(copy.anyOf)) copy.anyOf = copy.anyOf.map(normalizeForOpenAiStrict);
  if (Array.isArray(copy.allOf)) copy.allOf = copy.allOf.map(normalizeForOpenAiStrict);
  return copy;
}

export function extractOpenAiErrorInfo(error: unknown) {
  if (!error || typeof error !== "object") return { message: String(error) };
  const err = error as Record<string, unknown>;
  const status = typeof err.status === "number" ? err.status : typeof err.statusCode === "number" ? err.statusCode : undefined;
  const code = typeof err.code === "string" ? err.code : undefined;
  const type = typeof err.type === "string" ? err.type : undefined;
  const param = typeof err.param === "string" ? err.param : undefined;
  const headers = err.headers as Record<string, unknown> | undefined;
  const requestId = typeof err.request_id === "string"
    ? err.request_id
    : typeof err.requestId === "string"
    ? err.requestId
    : typeof headers?.["x-request-id"] === "string"
    ? headers["x-request-id"]
    : undefined;
  const providerMessage = typeof err.message === "string" ? err.message : undefined;
  return { status, code, type, param, requestId, providerMessage };
}

export function toOpenAiProviderError(error: unknown, fallbackSummary: string, model: string): ProviderError {
  const info = extractOpenAiErrorInfo(error);
  const status = info.status;
  const code = info.code;
  const requestId = info.requestId;
  const providerMessage = info.providerMessage ?? (error instanceof Error ? error.message : String(error));

  let category = "unknown_provider_error";
  let retryable = false;
  let summary = fallbackSummary;

  if (status === 401 || status === 403 || code === "invalid_api_key") {
    category = "authentication_error";
    retryable = false;
    summary = `OpenAI authentication failed: ${providerMessage}`;
  } else if (status === 429 || code === "insufficient_quota" || code === "rate_limit_exceeded") {
    category = "rate_limited";
    retryable = true;
    summary = `OpenAI rate limit or quota exceeded: ${providerMessage}`;
  } else if (status === 400 && (/schema|response_format|json_schema|strict/i.test(providerMessage) || code === "invalid_request_error")) {
    category = "structured_output_error";
    retryable = false;
    summary = `OpenAI structured-output request rejected: ${providerMessage}`;
  } else if (status === 408 || status === 504 || /timeout/i.test(providerMessage)) {
    category = "timeout";
    retryable = true;
    summary = `OpenAI request timed out: ${providerMessage}`;
  } else if (status && status >= 500) {
    category = "provider_unavailable";
    retryable = true;
    summary = `OpenAI service unavailable (${status}): ${providerMessage}`;
  } else {
    summary = `${fallbackSummary}: ${providerMessage}`;
  }

  return new ProviderError(summary, {
    cause: error,
    status,
    code,
    category,
    requestId,
    provider: "openai",
    model,
    retryable,
  });
}
