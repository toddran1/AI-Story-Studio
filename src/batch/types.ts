import { z } from "zod";

export const discoveredChapterSchema = z.object({
  chapter: z.number().int().positive(),
  path: z.string().min(1),
  filename: z.string().min(1),
  source: z.object({
    type: z.enum(["text", "epub", "docx", "web", "fanqie", "manual", "original"]),
    sourceId: z.string(), originalTitle: z.string().optional(), fingerprint: z.string(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  }).optional(),
});
export type DiscoveredChapter = z.infer<typeof discoveredChapterSchema>;

export const retryConfigSchema = z.object({
  maxAttempts: z.number().int().min(1).max(20).default(3),
  initialDelayMs: z.number().int().min(0).default(1000),
  maxDelayMs: z.number().int().min(0).default(30000),
});
export type RetryConfig = z.infer<typeof retryConfigSchema>;

export const batchChapterStateSchema = z.object({
  status: z.enum(["pending", "running", "complete", "failed", "skipped", "cancelled"]),
  input: z.string(),
  attempts: z.number().int().nonnegative().default(0),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
});

const usageTotalsSchema = z.object({
  inputTokens: z.number().nonnegative().optional(), outputTokens: z.number().nonnegative().optional(),
  cachedTokens: z.number().nonnegative().optional(), requests: z.number().nonnegative().optional(),
  characters: z.number().nonnegative().optional(), bytes: z.number().nonnegative().optional(),
});

export const batchStateSchema = z.object({
  id: z.string().min(1), story: z.string().min(1), createdAt: z.string(), updatedAt: z.string(),
  inputDirectory: z.string(), selection: z.object({ from: z.number().int().positive(), to: z.number().int().positive() }),
  status: z.enum(["pending", "running", "completed", "completed_with_errors", "failed", "cancelled", "paused"]),
  stopReason: z.string().optional(),
  options: z.object({ allowGaps: z.boolean(), continueOnError: z.boolean(), delayMs: z.number(), force: z.string().optional() }),
  chapters: z.record(z.string(), batchChapterStateSchema),
  summary: z.object({ total: z.number(), complete: z.number(), failed: z.number(), pending: z.number(), skipped: z.number(), cancelled: z.number() }),
  usage: z.record(z.string(), usageTotalsSchema),
  elapsedMs: z.number().nonnegative().default(0),
});

export type BatchState = z.infer<typeof batchStateSchema>;
export type BatchChapterState = z.infer<typeof batchChapterStateSchema>;
