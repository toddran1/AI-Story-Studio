import { z } from "zod";
import { visualContinuityChangeInputSchema, visualContinuityChangeSchema } from "../visual-canon/continuity-state.js";
import { artworkOutputResolutionSchema, artworkUpscalingModeSchema, upscalerEngineSchema } from "../artwork/resolution.js";

export const sceneSettingsSchema = z.object({
  targetDurationSeconds: z.number().min(10).max(30).default(20),
  minimumDurationSeconds: z.number().min(5).max(30).default(10),
  maximumDurationSeconds: z.number().min(10).max(60).default(30),
  maximumScenesPerChapter: z.number().int().min(1).max(100).default(50),
}).refine((value) => value.maximumDurationSeconds >= value.minimumDurationSeconds, { message: "Scene maximum duration must be at least the minimum duration" })
  .refine((value) => value.targetDurationSeconds >= value.minimumDurationSeconds && value.targetDurationSeconds <= value.maximumDurationSeconds, { message: "Scene target duration must be between the minimum and maximum duration" })
  .default({ targetDurationSeconds: 20, minimumDurationSeconds: 10, maximumDurationSeconds: 30, maximumScenesPerChapter: 50 });

export const artworkSettingsSchema = z.object({
  provider: z.enum(["openai", "gemini"]).default("openai"),
  model: z.string().trim().min(1).default("gpt-image-2.5-flare"),
  stylePrompt: z.string().trim().min(1).max(4000).default("cinematic illustrated fiction, dramatic natural lighting, consistent character design, widescreen composition"),
  aspectRatio: z.enum(["16:9", "1:1", "9:16"]).default("16:9"),
  // Generation effort only — final output resolution is controlled separately.
  quality: z.enum(["low", "medium", "high"]).default("medium"),
  size: z.enum(["1536x1024", "1024x1024", "1024x1536"]).default("1536x1024"),
  outputFormat: z.literal("png").default("png"),
  outputResolution: artworkOutputResolutionSchema.default("native"),
  upscaling: artworkUpscalingModeSchema.default("automatic"),
  upscaler: upscalerEngineSchema.default("local-realesrgan"),
}).default({ provider: "openai", model: "gpt-image-2.5-flare", stylePrompt: "cinematic illustrated fiction, dramatic natural lighting, consistent character design, widescreen composition", aspectRatio: "16:9", quality: "medium", size: "1536x1024", outputFormat: "png", outputResolution: "native", upscaling: "automatic", upscaler: "local-realesrgan" });

export const artworkReviewSchema = z.enum(["unreviewed", "approved", "rejected", "needs-regeneration"]);
export const sceneImportanceSchema = z.enum(["transition", "standard", "major"]);

export const shotTypeSchema = z.enum([
  "extreme_wide",
  "wide",
  "medium_wide",
  "medium",
  "medium_close_up",
  "close_up",
  "extreme_close_up",
]);
export type ShotType = z.infer<typeof shotTypeSchema>;

export const cameraAngleSchema = z.enum([
  "eye_level",
  "low_angle",
  "high_angle",
  "overhead",
  "dutch_angle",
  "pov",
  "over_shoulder",
]);
export type CameraAngle = z.infer<typeof cameraAngleSchema>;

export const compositionTendencySchema = z.enum([
  "balanced",
  "centered",
  "rule_of_thirds",
  "dynamic",
  "symmetrical",
  "environmental",
  "character_focused",
]);
export type CompositionTendency = z.infer<typeof compositionTendencySchema>;

export const sceneDirectionSchema = z.object({
  shotType: shotTypeSchema.optional(),
  cameraAngle: cameraAngleSchema.optional(),
  composition: compositionTendencySchema.optional(),
  lighting: z.string().trim().max(500).optional(),
  timeEnvironment: z.enum(["dawn", "day", "sunset", "dusk", "night", "interior", "custom"]).optional(),
  characterExpressions: z.record(z.string(), z.string().trim().max(300)).default({}),
  useCharacterReferences: z.boolean().default(true),
  useCreatureReferences: z.boolean().default(true),
  useLocationReferences: z.boolean().default(true),
  preserveWardrobeEquipment: z.boolean().default(true),
  useStoryArtDirection: z.boolean().default(true),
});
export type SceneDirection = z.infer<typeof sceneDirectionSchema>;

export const sceneOverridesSchema = z.object({
  wardrobeOverrides: z.record(z.string(), z.string().trim().max(1000)).default({}),
  artDirectionMode: z.enum(["inherit-summary", "story-default"]).optional(),
  artDirectionPresetId: z.string().optional(),
  customVisualPrompt: z.string().trim().max(8000).optional(),
  customNegativePrompt: z.string().trim().max(2000).optional(),
});
export type SceneOverrides = z.infer<typeof sceneOverridesSchema>;

export const artworkUpscaleStatusSchema = z.enum(["applied", "skipped-not-required", "unavailable", "failed"]);
export type ArtworkUpscaleStatus = z.infer<typeof artworkUpscaleStatusSchema>;

const imageDimensionsSchema = z.object({ width: z.number().int().positive(), height: z.number().int().positive() });

export const artworkVersionUpscaleSchema = z.object({
  engine: z.string(),
  model: z.string().optional(),
  sourceFingerprint: z.string(),
  sourceDimensions: imageDimensionsSchema,
  targetDimensions: imageDimensionsSchema,
  finalDimensions: imageDimensionsSchema.optional(),
  scaleFactor: z.number().optional(),
  status: artworkUpscaleStatusSchema,
  fingerprint: z.string().optional(),
  outputFingerprint: z.string().optional(),
  fit: z.enum(["exact", "crop", "pad"]).optional(),
  warning: z.string().optional(),
});
export type ArtworkVersionUpscale = z.infer<typeof artworkVersionUpscaleSchema>;

export const artworkVersionSchema = z.object({
  id: z.string().min(1),
  versionNumber: z.number().int().positive(),
  sceneId: z.string().regex(/^scene-\d{3}$/),
  imagePath: z.string().min(1),
  imageFingerprint: z.string(),
  createdAt: z.string().datetime(),
  provider: z.string(),
  model: z.string(),
  prompt: z.string().max(12000),
  promptFingerprint: z.string(),
  resolvedVisualProfileReferences: z.array(z.object({
    entityId: z.string(),
    name: z.string().optional(),
    role: z.string().optional(),
    referenceId: z.string().optional(),
  })).default([]),
  artDirectionFingerprint: z.string().default(""),
  settings: z.object({
    quality: z.string().optional(),
    size: z.string().optional(),
    aspectRatio: z.string().optional(),
    outputFormat: z.string().optional(),
  }).default({}),
  original: imageDimensionsSchema.extend({
    fingerprint: z.string(),
    provider: z.string(),
    model: z.string(),
  }).optional(),
  upscale: artworkVersionUpscaleSchema.optional(),
  cost: z.object({
    requests: z.number().optional(),
    estimatedCostUsd: z.number().optional(),
  }).optional(),
  review: artworkReviewSchema.default("unreviewed"),
  provenance: z.record(z.string(), z.unknown()).optional(),
});
export type ArtworkVersion = z.infer<typeof artworkVersionSchema>;

export const sceneArtworkSchema = z.object({
  status: z.enum(["pending", "running", "complete", "failed"]).default("pending"),
  review: artworkReviewSchema.default("unreviewed"),
  provider: z.string().optional(), model: z.string().optional(), fingerprint: z.string().optional(), imageFingerprint: z.string().optional(),
  generatedAt: z.string().optional(), error: z.string().optional(),
  manuallyEdited: z.boolean().optional(), prompt: z.string().max(12000).optional(),
  sourceType: z.enum(["chapter", "summary"]).optional(), sourceId: z.string().optional(), entityIds: z.array(z.string()).optional(),
  originalFingerprint: z.string().optional(), acceptedAt: z.string().datetime().optional(),
  versions: z.array(artworkVersionSchema).optional().default([]),
  approvedVersionId: z.string().optional(),
}).default({ status: "pending", review: "unreviewed", versions: [] });

export const characterResolutionKindSchema = z.enum([
  "exact_id",
  "canonical_name",
  "preferred_name",
  "localized_name",
  "original_name",
  "alias",
  "unresolved",
]);
export type CharacterResolutionKind = z.infer<typeof characterResolutionKindSchema>;

export const resolvedSceneCharacterSchema = z.object({
  name: z.string(),
  entityId: z.string().optional(),
  canonicalName: z.string().optional(),
  profileStatus: z.enum(["draft", "approved", "missing"]).optional(),
  visualProfileId: z.string().optional(),
  resolution: characterResolutionKindSchema,
});
export type ResolvedSceneCharacter = z.infer<typeof resolvedSceneCharacterSchema>;

export const sceneSchema = z.object({
  id: z.string().regex(/^scene-\d{3}$/), summary: z.string().trim().min(1).max(1000),
  startSeconds: z.number().min(0), endSeconds: z.number().positive(),
  characters: z.array(z.string().trim().min(1)).max(20).default([]), location: z.string().trim().max(300).optional(),
  visualPrompt: z.string().trim().min(1).max(8000), importance: sceneImportanceSchema.default("standard"), artwork: sceneArtworkSchema,
  narrationText: z.string().max(1000000).optional(),
  narrationStartWord: z.number().int().nonnegative().optional(), narrationEndWord: z.number().int().positive().optional(),
  entityIds: z.array(z.string().trim().min(1)).max(100).optional().default([]),
  resolvedCharacters: z.array(resolvedSceneCharacterSchema).optional(),
  visualType: z.enum(["image", "video"]).optional(),
  disabled: z.boolean().optional(),
  direction: sceneDirectionSchema.optional(),
  overrides: sceneOverridesSchema.optional(),
  visualChanges: visualContinuityChangeSchema.optional(),
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
  visualChanges: visualContinuityChangeInputSchema.nullish(),
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
