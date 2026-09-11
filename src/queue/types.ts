import { z } from "zod";
import { productionForceSchema, productionOutputSchema } from "../production/types.js";

export const durableJobStatusSchema = z.enum(["queued", "running", "paused", "completed", "completed_with_warnings", "failed", "cancelled", "needs_review"]);
export const workItemStatusSchema = z.enum(["pending", "running", "completed", "warning", "retry_wait", "failed", "needs_review", "skipped"]);
export const failureCategorySchema = z.enum(["transient", "rate_limit", "configuration", "content_qa", "permanent"]);
export type DurableJobStatus = z.infer<typeof durableJobStatusSchema>;
export type WorkItemStatus = z.infer<typeof workItemStatusSchema>;
export type FailureCategory = z.infer<typeof failureCategorySchema>;

export const queueSubmissionSchema = z.object({
  from: z.number().int().positive(), to: z.number().int().positive(), profile: z.string().optional(),
  outputs: z.array(productionOutputSchema).min(1).optional(), artwork: z.boolean().optional(), repairQa: z.boolean().optional(),
  refresh: z.boolean().default(false), alignment: z.boolean().optional(), force: productionForceSchema.optional(), audiobookFormat: z.enum(["mp3", "m4b"]).optional(), maxProviderBudgetUsd: z.number().positive().max(1_000_000).optional(),
  dryRun: z.literal(false).optional(),
}).strict().refine((value) => value.to >= value.from, { message: "Range end must be at or after range start" });
export type QueueSubmission = z.infer<typeof queueSubmissionSchema>;

export type QueueJob = {
  id: string; story: string; from: number; to: number; profile?: string; options: QueueSubmission; plan: unknown; status: DurableJobStatus;
  pauseRequested: boolean; cancelRequested: boolean; currentChapter?: number; currentStage?: string;
  totalItems: number; completedItems: number; warningItems: number; reviewItems: number; failedItems: number;
  errorSummary?: string; createdAt: string; startedAt?: string; updatedAt: string; completedAt?: string;
  finalizationOwner?: string; finalizationToken?: string; finalizationExpiresAt?: string;
};
export type QueueWorkItem = {
  id: string; jobId: string; story: string; chapter: number; ordinal: number; status: WorkItemStatus; currentStage?: string;
  attemptCount: number; maxAttempts: number; lastError?: string; errorCategory?: FailureCategory; nextRetryAt?: string;
  lastAttemptAt?: string; startedAt?: string; completedAt?: string; reused: boolean; qaStatus?: "pass" | "warn" | "fail";
  requiredProviders: string[]; leaseOwner?: string; leaseToken?: string; leaseExpiresAt?: string;
};
export type QueueEvent = { id: string; jobId: string; workItemId?: string; type: string; message: string; data: Record<string, unknown>; createdAt: string };
export type QueuePage<T> = { items: T[]; page: number; pageSize: number; total: number; pages: number };
