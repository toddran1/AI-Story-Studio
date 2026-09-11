import { z } from "zod";

export const pricingSnapshotSchema = z.object({
  catalogVersion: z.string(), priceId: z.string(), effectiveFrom: z.string(), currency: z.literal("USD"), sourceUrl: z.url(),
  basis: z.enum(["tokens", "utf8_bytes", "image"]), inputPerMillion: z.number().nonnegative().optional(), cachedInputPerMillion: z.number().nonnegative().optional(),
  outputPerMillion: z.number().nonnegative().optional(), utf8BytesPerMillion: z.number().nonnegative().optional(), imagePrice: z.number().nonnegative().optional(),
}).strict();
export type PricingSnapshot = z.infer<typeof pricingSnapshotSchema>;

export const providerUsageRecordSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), idempotencyKey: z.string().min(1), story: z.string().min(1), chapter: z.number().int().positive().optional(),
  productionRunId: z.string().optional(), queueJobId: z.string().optional(), stage: z.string().min(1), provider: z.string().min(1), model: z.string().min(1),
  operation: z.enum(["llm_text", "llm_structured", "tts", "image"]), attemptedAt: z.string(), completedAt: z.string(), attempt: z.number().int().positive(),
  inputTokens: z.number().int().nonnegative().optional(), cachedInputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(),
  inputCharacters: z.number().int().nonnegative().optional(), inputUtf8Bytes: z.number().int().nonnegative().optional(), outputBytes: z.number().int().nonnegative().optional(),
  audioDurationSeconds: z.number().nonnegative().optional(), imageCount: z.number().int().nonnegative().optional(), imageQuality: z.string().optional(), imageSize: z.string().optional(),
  requestId: z.string().optional(), success: z.boolean(), errorCategory: z.string().optional(), retry: z.boolean(),
  costUsd: z.number().nonnegative().optional(), costStatus: z.enum(["calculated", "unavailable"]), pricing: pricingSnapshotSchema.optional(),
}).strict();
export type ProviderUsageRecord = z.infer<typeof providerUsageRecordSchema>;

export type UsageScope = { story: string; chapter?: number; productionRunId?: string; queueJobId?: string; stage: string };
export interface UsageSink { record(record: ProviderUsageRecord): Promise<void>; }

export type CostFilters = { story?: string; chapterFrom?: number; chapterTo?: number; productionRunId?: string; queueJobId?: string; stage?: string; provider?: string; model?: string; fromDate?: string; toDate?: string; page?: number; pageSize?: number };
