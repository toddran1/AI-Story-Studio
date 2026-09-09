import { z } from "zod";
import { qaCategorySchema, qaStatusSchema } from "./qa.js";

export const stageNameSchema = z.enum(["ingestion", "translation", "narration", "qa", "storyBible", "tts", "audioMastering", "subtitles", "video"]);
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

const rawChapterSchema = z.object({
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
  quality: z.object({ status: qaStatusSchema, score: z.number().min(0).max(1), issueCategories: z.array(qaCategorySchema) }).optional(),
  audio: z.object({ durationSeconds: z.number().positive(), codec: z.string(), container: z.string(), sampleRate: z.number().positive().optional(), bitrate: z.number().positive().optional() }).optional(),
  subtitle: z.object({ cueCount: z.number().int().positive(), durationSeconds: z.number().positive() }).optional(),
  video: z.object({ durationSeconds: z.number().positive(), codec: z.string(), width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
});

export const chapterSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object") return value;
  const chapter = value as Record<string, unknown>;
  const stages = chapter.stages;
  if (!stages || typeof stages !== "object") return value;
  const normalized = { ...(stages as Record<string, unknown>) };
  if (!("qa" in normalized)) normalized.qa = { status: "pending" };
  if (!("audioMastering" in normalized)) normalized.audioMastering = { status: "pending" };
  if (!("subtitles" in normalized)) normalized.subtitles = { status: "pending" };
  if (!("video" in normalized)) normalized.video = { status: "pending" };
  return { ...chapter, stages: normalized };
}, rawChapterSchema);

export type Chapter = z.infer<typeof chapterSchema>;
export type StageState = z.infer<typeof stageStateSchema>;
