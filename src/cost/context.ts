import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { fingerprint } from "../utils/hash.js";
import { ImageGenerationRequest, ImageGenerationResult, ImageProvider } from "../artwork/provider.js";
import { LLMProvider } from "../llm/provider.js";
import { LLMRequest, StructuredLLMRequest } from "../llm/types.js";
import { TTSProvider } from "../tts/provider.js";
import { TTSRequest } from "../tts/types.js";
import { calculateCost, pricingFor } from "./pricing.js";
import { ProviderUsageRecord, UsageScope, UsageSink } from "./types.js";

type Active = { scope: UsageScope; attempts: Map<string, number> };
const storage = new AsyncLocalStorage<Active>();
export function withUsageScope<T>(scope: UsageScope, action: () => Promise<T>): Promise<T> { return storage.run({ scope, attempts: new Map() }, action); }

function next(operation: string, model: string) { const active = storage.getStore(); if (!active) return undefined; const key = `${operation}:${model}`; const attempt = (active.attempts.get(key) ?? 0) + 1; active.attempts.set(key, attempt); return { ...active.scope, attempt }; }
function category(error: unknown) { const value = error as { cause?: { status?: number }; name?: string }; const status = value.cause?.status; return status === 429 ? "rate_limit" : status && status >= 500 ? "transient" : value.name === "ConfigurationError" ? "configuration" : "provider"; }
function base(scope: ReturnType<typeof next>, provider: string, model: string, operation: ProviderUsageRecord["operation"], attemptedAt: string, success: boolean, requestId?: string): Omit<ProviderUsageRecord, "id" | "idempotencyKey" | "completedAt" | "retry" | "costStatus"> {
  if (!scope) throw new Error("Missing usage scope");
  return { version: 1, ...scope, provider, model, operation, attemptedAt, success, requestId };
}
async function persist(sink: UsageSink, data: Omit<ProviderUsageRecord, "id" | "idempotencyKey" | "completedAt" | "retry" | "costStatus">) {
  const pricing = pricingFor(data.provider, data.model, {quality:data.imageQuality,size:data.imageSize}); const costUsd = calculateCost(pricing, data); const completedAt = new Date().toISOString();
  const idempotencyKey = data.requestId ? `${data.provider}:${data.requestId}` : fingerprint({ scope: data.story, chapter: data.chapter, run: data.productionRunId, job: data.queueJobId, stage: data.stage, operation: data.operation, model: data.model, attempt: data.attempt, attemptedAt: data.attemptedAt });
  await sink.record({ ...data, id: randomUUID(), idempotencyKey, completedAt, retry: data.attempt > 1, pricing: costUsd === undefined ? undefined : pricing, costUsd, costStatus: costUsd === undefined ? "unavailable" : "calculated" });
}

export class TrackedLLMProvider implements LLMProvider {
  readonly name; constructor(private readonly inner: LLMProvider, private readonly sink: UsageSink) { this.name = inner.name; }
  validateConfiguration() { return this.inner.validateConfiguration(); }
  generateText(request: LLMRequest) { return this.run("llm_text", request, () => this.inner.generateText(request)); }
  generateStructured<T>(request: StructuredLLMRequest<T>) { return this.run("llm_structured", request, () => this.inner.generateStructured(request)); }
  private async run<T extends { usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; requestId?: string } }>(operation: "llm_text" | "llm_structured", request: LLMRequest, action: () => Promise<T>) {
    const scope = next(operation, request.model); if (!scope) return action(); const attemptedAt = new Date().toISOString();
    try { const result = await action(); await persist(this.sink, { ...base(scope, this.name, request.model, operation, attemptedAt, true, result.usage?.requestId), inputTokens: result.usage?.inputTokens, cachedInputTokens: result.usage?.cachedTokens, outputTokens: result.usage?.outputTokens, inputCharacters: [...request.input].length, inputUtf8Bytes: Buffer.byteLength(request.input) }); return result; }
    catch (error) { await persist(this.sink, { ...base(scope, this.name, request.model, operation, attemptedAt, false), inputCharacters: [...request.input].length, inputUtf8Bytes: Buffer.byteLength(request.input), errorCategory: category(error) }); throw error; }
  }
}

export class TrackedTTSProvider implements TTSProvider {
  readonly name; constructor(private readonly inner: TTSProvider, private readonly sink: UsageSink) { this.name = inner.name; }
  resolveReferenceId(id?: string) { return this.inner.resolveReferenceId?.(id); } validateConfiguration() { return this.inner.validateConfiguration(); }
  async synthesize(request: TTSRequest) { const scope = next("tts", request.model); if (!scope) return this.inner.synthesize(request); const attemptedAt = new Date().toISOString();
    try { const result = await this.inner.synthesize(request); await persist(this.sink, { ...base(scope, this.name, request.model, "tts", attemptedAt, true, result.requestIds?.join(",")), inputCharacters: [...request.text].length, inputUtf8Bytes: Buffer.byteLength(request.text), outputBytes: result.audio.byteLength }); return result; }
    catch (error) { await persist(this.sink, { ...base(scope, this.name, request.model, "tts", attemptedAt, false), inputCharacters: [...request.text].length, inputUtf8Bytes: Buffer.byteLength(request.text), errorCategory: category(error) }); throw error; }
  }
}

export class TrackedImageProvider implements ImageProvider {
  readonly name; readonly version; constructor(private readonly inner: ImageProvider, private readonly sink: UsageSink) { this.name = inner.name; this.version = inner.version; }
  validateConfiguration() { return this.inner.validateConfiguration(); }
  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> { const scope = next("image", request.model); if (!scope) return this.inner.generate(request); const attemptedAt = new Date().toISOString();
    try { const result = await this.inner.generate(request); await persist(this.sink, { ...base(scope, this.name, request.model, "image", attemptedAt, true, result.requestId), inputCharacters: [...request.prompt].length, inputUtf8Bytes: Buffer.byteLength(request.prompt), outputBytes: result.data.byteLength, imageCount: 1, imageQuality: request.quality, imageSize: request.size }); return result; }
    catch (error) { await persist(this.sink, { ...base(scope, this.name, request.model, "image", attemptedAt, false), inputCharacters: [...request.prompt].length, inputUtf8Bytes: Buffer.byteLength(request.prompt), imageCount: 0, imageQuality: request.quality, imageSize: request.size, errorCategory: category(error) }); throw error; }
  }
}
