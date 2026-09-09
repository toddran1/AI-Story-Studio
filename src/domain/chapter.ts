import { z } from "zod";

export const stageNameSchema = z.enum(["ingestion", "translation", "narration", "storyBible", "tts"]);
export type StageName = z.infer<typeof stageNameSchema>;

const usageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cachedTokens: z.number().optional(),
  requestId: z.string().optional(),
  requests: z.number().optional(),
  characters: z.number().optional(),
  bytes: z.number().optional(),
}).optional();

export const stageStateSchema = z.object({
  status: z.enum(["pending", "running", "complete", "failed"]),
  fingerprint: z.string().optional(),
  outputFingerprint: z.string().optional(),
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
  source: z.object({
    type: z.enum(["text", "epub", "docx", "web", "fanqie", "manual", "original"]),
    sourceId: z.string(),
    originalTitle: z.string().optional(),
    fingerprint: z.string(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  }).optional(),
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
