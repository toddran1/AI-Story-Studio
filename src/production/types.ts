import { z } from "zod";
import { stageNameSchema } from "../domain/chapter.js";

export const productionOutputSchema = z.enum(["audio", "audiobook", "video"]);
export const productionProfileSchema = z.object({
  outputs: z.array(productionOutputSchema).min(1), artwork: z.boolean().default(false), repairQa: z.boolean().default(true), audiobookFormat: z.enum(["mp3", "m4b"]).default("m4b"),
});
export type ProductionOutput = z.infer<typeof productionOutputSchema>;
export type ProductionProfile = z.infer<typeof productionProfileSchema>;
export const defaultProductionProfiles: Record<string, ProductionProfile> = {
  audio: { outputs: ["audio"], artwork: false, repairQa: true, audiobookFormat: "m4b" },
  audiobook: { outputs: ["audiobook"], artwork: false, repairQa: true, audiobookFormat: "m4b" },
  "story-video": { outputs: ["video"], artwork: true, repairQa: true, audiobookFormat: "m4b" },
  everything: { outputs: ["audiobook", "video"], artwork: true, repairQa: true, audiobookFormat: "m4b" },
};
export const productionProfilesSchema = z.record(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), productionProfileSchema).default(defaultProductionProfiles);

export const productionStageSchema = z.union([stageNameSchema, z.enum(["audiobook", "videoExport", "refresh"])]);
export type ProductionStage = z.infer<typeof productionStageSchema>;
export const productionForceSchema = z.enum(["ingestion", "translation", "narration", "qa", "story-bible", "tts", "audio", "subtitles", "scenes", "artwork", "video", "audiobook", "video-export", "all"]);
export type ProductionForce = z.infer<typeof productionForceSchema>;

const operationSchema = z.object({ status: z.enum(["pending", "running", "complete", "skipped", "failed"]), reused: z.boolean().default(false), attempts: z.number().int().nonnegative().default(0), startedAt: z.string().optional(), completedAt: z.string().optional(), error: z.string().optional() });
const chapterRunSchema = z.object({ chapter: z.number().int().positive(), status: z.enum(["pending", "running", "complete", "failed", "needs-review"]), operations: z.partialRecord(productionStageSchema, operationSchema), qa: z.enum(["pass", "warn", "fail"]).optional(), warning: z.string().optional(), error: z.string().optional() });
const summarySchema = z.object({ chapters: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), needsReview: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), reusedStages: z.number().int().nonnegative(), newStages: z.number().int().nonnegative(), qaWarnings: z.number().int().nonnegative(), qaFailures: z.number().int().nonnegative(), exports: z.record(z.string(), z.string()).default({}), elapsedMs: z.number().nonnegative() });
export const productionManifestSchema = z.object({
  version: z.literal(1), id: z.string(), story: z.string(), storyFingerprint: z.string(), createdAt: z.string(), updatedAt: z.string(), startedAt: z.string().optional(), completedAt: z.string().optional(),
  selection: z.object({ from: z.number().int().positive(), to: z.number().int().positive() }), options: z.object({ outputs: z.array(productionOutputSchema).min(1), artwork: z.boolean(), repairQa: z.boolean(), refresh: z.boolean(), audiobookFormat: z.enum(["mp3", "m4b"]), force: productionForceSchema.optional(), profile: z.string().optional(), dryRun: z.boolean() }),
  status: z.enum(["planned", "running", "completed", "completed_with_errors", "paused", "failed"]), current: z.object({ chapter: z.number().int().positive().optional(), stage: productionStageSchema.optional() }).default({}), chapters: z.record(z.string(), chapterRunSchema),
  retry: z.object({ maxProviderAttempts: z.number().int().positive(), maxQaRepairs: z.number().int().nonnegative() }), failures: z.array(z.object({ chapter: z.number().int().positive().optional(), stage: productionStageSchema, message: z.string(), at: z.string() })).default([]), summary: summarySchema,
});
export type ProductionManifest = z.infer<typeof productionManifestSchema>;
export type ProductionOperation = z.infer<typeof operationSchema>;

export type ProductionPlan = {
  story: string; from: number; to: number; chapters: number[]; requiredChapters: number[]; chapterRequirements: Record<string, ProductionStage[]>; outputs: ProductionOutput[]; artwork: boolean; stages: ProductionStage[];
  counts: Record<string, { required: number; reusable: number }>; estimates: { llmOperations: number; ttsOperations: number; imageOperations: number; imagesPendingPlanning: number };
  finalOutputs: string[];
};
