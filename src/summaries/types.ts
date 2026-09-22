import { z } from "zod";
import { productionSceneManifestSchema } from "../scenes/types.js";
import { alignmentArtifactSchema } from "../alignment/types.js";
import { scenePacingSchema } from "../scenes/pacing.js";
import { stageModelConfigSchema } from "../domain/provider.js";

export const summaryTypeSchema = z.enum(["brief", "detailed", "mini-chapter", "arc", "character-focused", "custom"]);
export const summarySourceModeSchema = z.enum(["original", "translated", "chapter-summaries"]);
export const summaryStatusSchema = z.enum(["generating", "complete", "failed"]);
export const summaryIdSchema = z.string().regex(/^sum_[a-f0-9-]{36}$/);
export const summaryArtDirectionOverrideSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("story-default") }).strict(),
  z.object({ mode: z.literal("preset"), presetId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ mode: z.literal("disabled") }).strict(),
]);
export type SummaryArtDirectionOverride = z.infer<typeof summaryArtDirectionOverrideSchema>;

export const SUMMARY_WORDS_PER_MINUTE = 150;
export function estimateSummaryMinutes(text: string, wordsPerMinute = SUMMARY_WORDS_PER_MINUTE) {
  return (text.trim() ? text.trim().split(/\s+/u).length : 0) / wordsPerMinute;
}
export const summaryDerivativeSchema = z.object({
  status: z.enum(["current", "stale", "generating", "failed"]),
  inputFingerprint: z.string(), outputFingerprint: z.string().optional(),
  sourceFingerprint: z.string().optional(), configurationFingerprint: z.string().optional(), namingFingerprint: z.string().optional(),
  editedAt: z.string().datetime().optional(),
  text: z.string().max(1_000_000).optional(), ttsText: z.string().max(1_000_000).optional(),
  manuallyEdited: z.boolean().default(false), reviewRequired: z.boolean().default(false),
  provider: z.string().optional(), model: z.string().optional(), voice: z.string().optional(),
  generatedAt: z.string().datetime().optional(), error: z.string().optional(),
  durationSeconds: z.number().nonnegative().optional(), bytes: z.number().int().nonnegative().optional(),
  censoredSegments: z.number().int().nonnegative().optional(), censorDurationSeconds: z.number().nonnegative().optional(),
  segmentFingerprints: z.array(z.string()).optional(),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), sceneCount: z.number().int().positive().optional(),
});
export type SummaryDerivative = z.infer<typeof summaryDerivativeSchema>;

export const summarySelectionSchema = z.object({
  from: z.number().int().positive().optional(),
  to: z.number().int().positive().optional(),
  chapters: z.array(z.number().int().positive()).min(1).max(10_000).optional(),
}).strict().superRefine((value, context) => {
  const hasRange = value.from !== undefined || value.to !== undefined;
  if (hasRange && (value.from === undefined || value.to === undefined)) context.addIssue({ code: "custom", message: "Chapter ranges require both from and to" });
  if (value.from !== undefined && value.to !== undefined && value.to < value.from) context.addIssue({ code: "custom", message: "Range end must be at or after range start" });
  if (hasRange === Boolean(value.chapters)) context.addIssue({ code: "custom", message: "Choose either a chapter range or a custom chapter list" });
});

export const summaryGenerationInputSchema = summarySelectionSchema.and(z.object({
  title: z.string().trim().min(1).max(200),
  summaryType: summaryTypeSchema.default("detailed"),
  sourceMode: summarySourceModeSchema.default("translated"),
  targetWords: z.number().int().min(50).max(20_000).default(800),
  targetMinutes: z.number().min(1/3).max(20_000 / SUMMARY_WORDS_PER_MINUTE).optional(),
  instructions: z.string().trim().max(5_000).optional(),
  focus: z.string().trim().max(500).optional(),
  model: stageModelConfigSchema.optional(),
  chunkSize: z.number().int().min(1).max(100).default(25),
  contextEligible: z.boolean().default(false),
})).transform((input) => ({ ...input, targetWords: input.targetMinutes === undefined ? input.targetWords : Math.round(input.targetMinutes * SUMMARY_WORDS_PER_MINUTE) }));

const provenanceBatchSchema = z.object({ batch: z.number().int().positive(), chapters: z.array(z.number().int().positive()), inputCharacters: z.number().int().nonnegative() });
export const summarySchema = z.object({
  id: summaryIdSchema,
  storyId: z.string().min(1),
  title: z.string().min(1).max(200),
  chapters: z.array(z.number().int().positive()).min(1),
  chapterRange: z.object({ from: z.number().int().positive(), to: z.number().int().positive() }).optional(),
  summaryType: summaryTypeSchema,
  sourceMode: summarySourceModeSchema,
  targetLength: z.object({ words: z.number().int().min(50).max(20_000) }),
  focus: z.string().max(500).optional(),
  instructions: z.string().max(5_000).optional(),
  text: z.string().max(1_000_000),
  status: summaryStatusSchema,
  origin: z.enum(["generated", "manual"]),
  manuallyEdited: z.boolean().default(false),
  contextEligible: z.boolean().default(false),
  error: z.string().max(10_000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  narration: summaryDerivativeSchema.optional(),
  tts: summaryDerivativeSchema.optional(),
  audio: summaryDerivativeSchema.optional(),
  scenes: summaryDerivativeSchema.optional(),
  artwork: summaryDerivativeSchema.optional(), video: summaryDerivativeSchema.optional(),
  scenePacing: scenePacingSchema.optional(),
  /** Omitted on older summaries means Story Default. */
  artDirectionOverride: summaryArtDirectionOverrideSchema.optional(),
  alignment: alignmentArtifactSchema.omit({ chapter: true }).extend({ sourceType: z.literal("summary"), sourceId: summaryIdSchema }).optional(),
  scenePlan: productionSceneManifestSchema.extend({ sourceType: z.literal("summary") }).optional(),
  provenance: z.object({
    model: stageModelConfigSchema,
    promptVersion: z.string(),
    chapterSources: z.array(z.object({ chapter: z.number().int().positive(), mode: summarySourceModeSchema, characters: z.number().int().nonnegative(), fingerprint: z.string() })),
    levels: z.array(z.object({ level: z.number().int().nonnegative(), batches: z.array(provenanceBatchSchema) })),
  }),
});

export type StorySummary = z.infer<typeof summarySchema>;

// Manual-operation eligibility is availability-based: valid-but-stale inputs are consumable.
// Freshness (current/stale) is surfaced as a warning, never treated as missing.
export function summaryNarrationTextAvailable(summary: Pick<StorySummary, "narration">) {
  return Boolean(summary.narration?.text?.trim());
}
export function summaryScenePlanAvailable(summary: Pick<StorySummary, "scenePlan">) {
  return Boolean(summary.scenePlan?.scenes.some((scene) => !scene.disabled));
}
export function summaryAudioAvailable(summary: Pick<StorySummary, "audio">) {
  return Boolean(summary.audio?.outputFingerprint && summary.audio.durationSeconds);
}
export type SummaryGenerationInput = z.infer<typeof summaryGenerationInputSchema>;
export type SummaryType = z.infer<typeof summaryTypeSchema>;
export type SummarySourceMode = z.infer<typeof summarySourceModeSchema>;
export type SummaryProgress = { phase: "preparing" | "summarizing" | "combining" | "finalizing" | "complete"; completed: number; total: number; level?: number; chapters?: number[] };

export function normalizeSummaryChapters(input: z.input<typeof summarySelectionSchema>): number[] {
  const selection = summarySelectionSchema.parse({ from: input.from, to: input.to, chapters: input.chapters });
  if (selection.chapters) return [...new Set(selection.chapters)].sort((a, b) => a - b);
  return Array.from({ length: selection.to! - selection.from! + 1 }, (_, index) => selection.from! + index);
}

export function contiguousRange(chapters: number[]) {
  return chapters.every((chapter, index) => index === 0 || chapter === chapters[index - 1]! + 1) ? { from: chapters[0]!, to: chapters.at(-1)! } : undefined;
}
