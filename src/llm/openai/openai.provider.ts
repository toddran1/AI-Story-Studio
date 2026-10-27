import OpenAI from "openai";
import { validateModelEffort } from "../effort.js";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { LLMProvider } from "../provider.js";
import { LLMRequest, StructuredLLMRequest } from "../types.js";
import { ConfigurationError, ProviderError } from "../../pipeline/errors.js";

export function openAiRequestInput(request: LLMRequest) {
  if (!request.images?.length) return request.input;
  return [{ role: "user" as const, content: [{ type: "input_text" as const, text: request.input }, ...request.images.map(image => ({ type: "input_image" as const, image_url: `data:${image.mimeType};base64,${image.data.toString("base64")}`, detail: "auto" as const }))] }];
}

export class OpenAIProvider implements LLMProvider {
  readonly supportsImageInputs = true;
  readonly name = "openai" as const;
  private readonly client: OpenAI;
  constructor(private readonly apiKey?: string, private readonly timeoutMs = 120_000) {
    this.client = new OpenAI({ apiKey: apiKey ?? "missing", timeout: timeoutMs, maxRetries: 0 });
  }

  async validateConfiguration(): Promise<void> {
    if (!this.apiKey || this.apiKey === "missing") {
      throw new ConfigurationError("Missing required openai credential (OPENAI_API_KEY). Add it to .env.");
    }
  }

  async generateText(request: LLMRequest) {
    await this.validateConfiguration();
    validateModelEffort(this.name, request.model, request.effort);
    let observedUsage: import("../types.js").LLMUsage | undefined;
    const startedAt = Date.now();
    try {
      const response = await this.client.responses.create({
        model: request.model,
        ...(request.effort ? { reasoning: { effort: request.effort as "none" | "low" | "medium" | "high" | "xhigh" | "max" } } : {}),
        instructions: request.instructions,
        input: openAiRequestInput(request),
        store: false,
      });
      observedUsage = { requestId: response.id, inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens, cachedTokens: response.usage?.input_tokens_details?.cached_tokens, reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens, cacheWriteTokens: response.usage?.input_tokens_details?.cache_write_tokens, serviceTier: response.service_tier ?? undefined };
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
          reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens,
          cacheWriteTokens: response.usage?.input_tokens_details?.cache_write_tokens,
          serviceTier: response.service_tier ?? undefined,
          requestId: response.id,
        },
      };
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      const wrapped = toOpenAiProviderError(error, "OpenAI Responses API request failed", request.model, { timeoutMs: this.timeoutMs, elapsedMs: Date.now() - startedAt });
      wrapped.usage = observedUsage;
      throw wrapped;
    }
  }

  async generateStructured<T>(request: StructuredLLMRequest<T>) {
    await this.validateConfiguration();
    validateModelEffort(this.name, request.model, request.effort);
    let observedUsage: import("../types.js").LLMUsage | undefined;
    const startedAt = Date.now();
    try {
      const format = toOpenAiTextFormat(request.schema, request.schemaName);
      const response = await this.client.responses.create({
        model: request.model,
        ...(request.effort ? { reasoning: { effort: request.effort as "none" | "low" | "medium" | "high" | "xhigh" | "max" } } : {}),
        instructions: request.instructions,
        input: openAiRequestInput(request),
        store: false,
        text: { format },
      });
      observedUsage = { requestId: response.id, inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens, cachedTokens: response.usage?.input_tokens_details?.cached_tokens, reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens, cacheWriteTokens: response.usage?.input_tokens_details?.cache_write_tokens, serviceTier: response.service_tier ?? undefined };
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
        // Strict Responses schemas represent optional object properties as
        // required-but-nullable. Restore `null` to absence only where Zod says
        // that exact value has the wrong type. Required fields still fail the
        // second parse, so this never invents Story Bible facts or defaults.
        if (zodErr instanceof z.ZodError && removeInvalidOptionalNulls(parsedJson, zodErr)) {
          try { value = request.schema.parse(parsedJson); }
          catch { throw structuredValidationError(zodErr, request.model, response.id); }
        } else throw structuredValidationError(zodErr, request.model, response.id);
      }
      return {
        value,
        usage: {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          cachedTokens: response.usage?.input_tokens_details?.cached_tokens,
          reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens,
          cacheWriteTokens: response.usage?.input_tokens_details?.cache_write_tokens,
          serviceTier: response.service_tier ?? undefined,
          requestId: response.id,
        },
      };
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      if (error instanceof ProviderError) {
        error.usage = observedUsage ?? error.usage;
        throw error;
      }
      const wrapped = toOpenAiProviderError(error, "OpenAI structured Responses API request failed", request.model, { timeoutMs: this.timeoutMs, elapsedMs: Date.now() - startedAt });
      wrapped.usage = observedUsage;
      throw wrapped;
    }
  }
}

function structuredValidationError(cause: unknown, model: string, requestId: string | undefined) {
  return new ProviderError("OpenAI structured output failed schema validation", {
    cause, provider: "openai", model, category: "validation_error", requestId,
  });
}

/** Only delete invalid null-valued object properties. A subsequent schema
 * parse decides whether each field was genuinely optional. */
function removeInvalidOptionalNulls(value: unknown, error: z.ZodError): boolean {
  let changed = false;
  for (const issue of error.issues) {
    if (issue.code !== "invalid_type" || !issue.path.length) continue;
    let parent: unknown = value;
    for (const segment of issue.path.slice(0, -1)) {
      if (!parent || typeof parent !== "object") { parent = undefined; break; }
      parent = (parent as Record<string | number, unknown>)[segment as string | number];
    }
    const key = issue.path.at(-1);
    if (typeof key === "string" && parent && typeof parent === "object" && !Array.isArray(parent) && (parent as Record<string, unknown>)[key] === null) {
      delete (parent as Record<string, unknown>)[key];
      changed = true;
    }
  }
  return changed;
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
  const headerRequestId = headers instanceof Headers ? headers.get("x-request-id") : headers?.["x-request-id"];
  const requestId = typeof err.request_id === "string"
    ? err.request_id
    : typeof err.requestId === "string"
    ? err.requestId
    : typeof headerRequestId === "string"
    ? headerRequestId
    : undefined;
  const providerMessage = typeof err.message === "string" ? err.message : undefined;
  return { status, code, type, param, requestId, providerMessage };
}

export function toOpenAiProviderError(error: unknown, fallbackSummary: string, model: string, timing?: { timeoutMs: number; elapsedMs: number }): ProviderError {
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
  } else if (status === 408 || status === 504 || /timed?\s*out|timeout/i.test(providerMessage) || (error instanceof Error && error.name === "APIConnectionTimeoutError")) {
    category = "timeout";
    retryable = true;
    const deadline = timing ? ` (client deadline ${timing.timeoutMs / 1000}s; elapsed ${(timing.elapsedMs / 1000).toFixed(1)}s)` : "";
    const details = [status !== undefined ? `HTTP ${status}` : undefined, code ? `code=${code}` : undefined, info.type ? `type=${info.type}` : undefined, info.param ? `param=${info.param}` : undefined, requestId ? `request ID=${requestId}` : undefined].filter(Boolean).join("; ");
    summary = `OpenAI request timed out${deadline}: ${providerMessage}. ${status === undefined ? "No HTTP error response was received; the SDK did not provide an API error body. The underlying server outcome is unknown." : "The API returned a timeout response."}${details ? ` Details: ${details}.` : ""}`;
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
