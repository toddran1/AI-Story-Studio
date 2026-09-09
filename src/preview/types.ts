import { z } from "zod";
import { stageModelConfigSchema, ttsStageConfigSchema } from "../domain/provider.js";
import { qaStatusSchema } from "../domain/qa.js";

export const previewPresetSchema = z.object({
  translation: stageModelConfigSchema,
  narration: stageModelConfigSchema,
  qa: stageModelConfigSchema,
  tts: ttsStageConfigSchema,
});

export const previewManifestSchema = z.object({
  id: z.string().min(1), story: z.string().min(1), chapter: z.number().int().positive(), createdAt: z.string(),
  inputFingerprint: z.string(), audioPreview: z.boolean(),
  presets: z.object({ a: previewPresetSchema, b: previewPresetSchema }),
  results: z.object({
    a: z.object({ qaStatus: qaStatusSchema, qaScore: z.number(), audioGenerated: z.boolean() }),
    b: z.object({ qaStatus: qaStatusSchema, qaScore: z.number(), audioGenerated: z.boolean() }),
  }),
});

export type PreviewPreset = z.infer<typeof previewPresetSchema>;
export type PreviewManifest = z.infer<typeof previewManifestSchema>;
