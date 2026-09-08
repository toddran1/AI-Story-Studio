import { z } from "zod";

export const llmProviderNameSchema = z.enum(["openai", "gemini"]);
export const ttsProviderNameSchema = z.literal("fish");

export type LLMProviderName = z.infer<typeof llmProviderNameSchema>;
export type TTSProviderName = z.infer<typeof ttsProviderNameSchema>;

export const stageModelConfigSchema = z.object({
  provider: llmProviderNameSchema,
  model: z.string().min(1),
});

export const ttsStageConfigSchema = z.object({
  provider: ttsProviderNameSchema,
  model: z.string().min(1),
  referenceId: z.string().min(1).optional(),
  speed: z.number().min(0.5).max(2).default(1),
  format: z.literal("mp3").default("mp3"),
  sampleRate: z.union([z.literal(32000), z.literal(44100)]).default(44100),
  bitrate: z.union([z.literal(64), z.literal(128), z.literal(192)]).default(128),
  normalize: z.boolean().default(true),
  maxCharsPerRequest: z.number().int().min(500).max(20_000).default(4000),
});

export type StageModelConfig = z.infer<typeof stageModelConfigSchema>;
export type TTSStageConfig = z.infer<typeof ttsStageConfigSchema>;
