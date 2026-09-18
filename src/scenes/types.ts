import { z } from "zod";

export const sceneSettingsSchema = z.object({
  targetDurationSeconds: z.number().min(10).max(30).default(20),
  minimumDurationSeconds: z.number().min(5).max(30).default(10),
  maximumDurationSeconds: z.number().min(10).max(60).default(30),
  maximumScenesPerChapter: z.number().int().min(1).max(100).default(50),
}).refine((value) => value.maximumDurationSeconds >= value.minimumDurationSeconds, { message: "Scene maximum duration must be at least the minimum duration" })
  .refine((value) => value.targetDurationSeconds >= value.minimumDurationSeconds && value.targetDurationSeconds <= value.maximumDurationSeconds, { message: "Scene target duration must be between the minimum and maximum duration" })
  .default({ targetDurationSeconds: 20, minimumDurationSeconds: 10, maximumDurationSeconds: 30, maximumScenesPerChapter: 50 });

export const artworkSettingsSchema = z.object({
  provider: z.literal("openai").default("openai"),
  model: z.string().trim().min(1).default("gpt-image-1"),
  stylePrompt: z.string().trim().min(1).max(4000).default("cinematic illustrated fiction, dramatic natural lighting, consistent character design, widescreen composition"),
  aspectRatio: z.literal("16:9").default("16:9"),
  quality: z.enum(["low", "medium", "high"]).default("medium"),
  size: z.enum(["1536x1024", "1024x1024", "1024x1536"]).default("1536x1024"),
  outputFormat: z.literal("png").default("png"),
}).default({ provider: "openai", model: "gpt-image-1", stylePrompt: "cinematic illustrated fiction, dramatic natural lighting, consistent character design, widescreen composition", aspectRatio: "16:9", quality: "medium", size: "1536x1024", outputFormat: "png" });

export const artworkReviewSchema = z.enum(["unreviewed", "approved", "rejected", "needs-regeneration"]);
export const sceneImportanceSchema = z.enum(["transition", "standard", "major"]);
export const sceneArtworkSchema = z.object({
  status: z.enum(["pending", "running", "complete", "failed"]).default("pending"),
  review: artworkReviewSchema.default("unreviewed"),
  provider: z.string().optional(), model: z.string().optional(), fingerprint: z.string().optional(), imageFingerprint: z.string().optional(),
  generatedAt: z.string().optional(), error: z.string().optional(),
  manuallyEdited: z.boolean().optional(), prompt: z.string().max(12000).optional(),
  sourceType: z.enum(["chapter", "summary"]).optional(), sourceId: z.string().optional(), entityIds: z.array(z.string()).optional(),
  originalFingerprint: z.string().optional(), acceptedAt: z.string().datetime().optional(),
}).default({ status: "pending", review: "unreviewed" });

export const sceneSchema = z.object({
  id: z.string().regex(/^scene-\d{3}$/), summary: z.string().trim().min(1).max(1000),
  startSeconds: z.number().min(0), endSeconds: z.number().positive(),
  characters: z.array(z.string().trim().min(1)).max(20).default([]), location: z.string().trim().max(300).optional(),
  visualPrompt: z.string().trim().min(1).max(8000), importance: sceneImportanceSchema.default("standard"), artwork: sceneArtworkSchema,
  narrationText: z.string().max(1000000).optional(),
  narrationStartWord: z.number().int().nonnegative().optional(), narrationEndWord: z.number().int().positive().optional(),
  entityIds: z.array(z.string().trim().min(1)).max(100).optional(),
  visualType: z.enum(["image", "video"]).optional(),
  disabled: z.boolean().optional(),
}).refine((value) => value.endSeconds > value.startSeconds, { message: "Scene end must be after its start" });

export const productionSceneManifestSchema = z.object({
  version: z.literal(1), durationSeconds: z.number().positive(),
  sourceType: z.enum(["chapter", "summary"]), sourceId: z.string().trim().min(1),
  sourceChapters: z.array(z.number().int().positive()).optional(),
  timingMethod: z.enum(["estimated", "aligned"]).optional(),
  planningFingerprint: z.string(), planner: z.object({ provider: z.string(), model: z.string(), promptVersion: z.string() }),
  manualRevision: z.number().int().nonnegative().default(0), manuallyEdited: z.boolean().default(false),
  createdAt: z.string(), updatedAt: z.string(), scenes: z.array(sceneSchema).min(1).max(100),
});

// Preserve the existing chapter contract and serialized shape. Summary production
// uses the same manifest fields without inventing a synthetic chapter number.
export const sceneManifestSchema = productionSceneManifestSchema.omit({ sourceType: true, sourceId: true }).extend({
  chapter: z.number().int().positive(),
  sourceType: z.literal("chapter").optional(), sourceId: z.string().trim().min(1).optional(),
});

export const plannedSceneSchema = z.object({
  summary: z.string().trim().min(1).max(1000), startSeconds: z.number().min(0), endSeconds: z.number().positive(),
  characters: z.array(z.string().trim().min(1)).max(20).default([]), location: z.string().trim().max(300).nullish(),
  visualPrompt: z.string().trim().min(1).max(8000), importance: sceneImportanceSchema.default("standard"),
});
export const plannedScenesSchema = z.object({ scenes: z.array(plannedSceneSchema).min(1).max(100) });
export const summaryPlannedScenesSchema = z.object({ scenes: z.array(plannedSceneSchema.extend({
  narrationStartWord: z.number().int().nonnegative().nullish(), narrationEndWord: z.number().int().positive().nullish(),
})).min(1).max(100) });

export const characterVisualProfileSchema = z.object({
  name: z.string().trim().min(1), description: z.string().trim().default(""), hair: z.string().trim().default(""),
  clothing: z.string().trim().default(""), distinctiveFeatures: z.string().trim().default(""),
});

export type SceneSettings = z.infer<typeof sceneSettingsSchema>;
export type ArtworkSettings = z.infer<typeof artworkSettingsSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type SceneManifest = z.infer<typeof sceneManifestSchema>;
export type ProductionSceneManifest = z.infer<typeof productionSceneManifestSchema>;
export type CharacterVisualProfile = z.infer<typeof characterVisualProfileSchema>;
