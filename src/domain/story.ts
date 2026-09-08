import { z } from "zod";
import { stageModelConfigSchema, ttsStageConfigSchema } from "./provider.js";

export const storySchema = z.object({
  id: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1),
  originalTitle: z.string().optional(),
  author: z.string().optional(),
  sourceLanguage: z.string().min(2),
  outputLanguage: z.string().min(2),
  source: z.object({
    type: z.enum(["text", "epub", "docx", "pdf", "web", "manual", "original"]),
    url: z.string().url().optional(),
    externalId: z.string().optional(),
  }),
  pipeline: z.object({
    translation: stageModelConfigSchema,
    narration: stageModelConfigSchema,
    storyBible: stageModelConfigSchema,
    tts: ttsStageConfigSchema,
  }),
});

export type Story = z.infer<typeof storySchema>;
