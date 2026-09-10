import { z } from "zod";

export const alignedWordSchema = z.object({
  text: z.string().min(1), start: z.number().nonnegative(), end: z.number().positive(),
  confidence: z.number().min(0).max(1).optional(), matched: z.boolean().default(true),
}).refine((word) => word.end > word.start, { message: "Aligned word end must be after start" });
export type AlignedWord = z.infer<typeof alignedWordSchema>;

export const alignmentMetricsSchema = z.object({
  matchedWordPercentage: z.number().min(0).max(100), averageConfidence: z.number().min(0).max(1).optional(),
  matchedWordCount: z.number().int().nonnegative(), unmatchedWordCount: z.number().int().nonnegative(),
  alignmentDurationSeconds: z.number().nonnegative(), audioDurationSeconds: z.number().positive(),
  maximumGapSeconds: z.number().nonnegative().default(0),
});
export type AlignmentMetrics = z.infer<typeof alignmentMetricsSchema>;

export const alignmentArtifactSchema = z.object({
  version: z.literal(1), chapter: z.number().int().positive(), mode: z.enum(["aligned", "estimated"]),
  engine: z.string().min(1), engineVersion: z.string().min(1), model: z.string().optional(),
  createdAt: z.string(), audioFingerprint: z.string().min(1), narrationFingerprint: z.string().min(1),
  inputFingerprint: z.string().min(1), warning: z.string().optional(),
  metrics: alignmentMetricsSchema, words: z.array(alignedWordSchema),
});
export type AlignmentArtifact = z.infer<typeof alignmentArtifactSchema>;

export type AlignmentObservation = { text: string; start: number; end: number; confidence?: number };
export type AlignmentRequest = { audioPath: string; narration: string; language: string; model?: string; device: "auto" | "cpu" | "gpu" };
export interface AlignmentEngine {
  readonly name: string;
  readonly version: string;
  validateConfiguration(): Promise<void>;
  align(request: AlignmentRequest): Promise<AlignmentObservation[]>;
}

export type AlignmentConfig = {
  engine: "whisper-cpp" | "disabled"; executable: string; model?: string; device: "auto" | "cpu" | "gpu";
  minimumMatchPercentage: number; minimumConfidence: number; maximumGapSeconds: number; timeoutMs: number;
};
