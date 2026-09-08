import { z } from "zod";

export const stageNameSchema = z.enum(["ingestion", "translation", "narration", "storyBible", "tts"]);
export type StageName = z.infer<typeof stageNameSchema>;

const usageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cachedTokens: z.number().optional(),
  requestId: z.string().optional(),
}).optional();

export const stageStateSchema = z.object({
  status: z.enum(["pending", "running", "complete", "failed"]),
  fingerprint: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  usage: usageSchema,
  error: z.object({ message: z.string(), cause: z.string().optional() }).optional(),
});

export const chapterSchema = z.object({
  chapter: z.number().int().positive(),
  originalTitle: z.string().optional(),
  translatedTitle: z.string().optional(),
  sourceLanguage: z.string(),
  outputLanguage: z.string(),
  counts: z.object({ originalCharacters: z.number(), englishWords: z.number(), narrationWords: z.number() }),
  createdAt: z.string(),
  updatedAt: z.string(),
  stages: z.record(stageNameSchema, stageStateSchema),
});

export type Chapter = z.infer<typeof chapterSchema>;
export type StageState = z.infer<typeof stageStateSchema>;
