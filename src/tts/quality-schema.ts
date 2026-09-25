import { z } from "zod";

/** Browser-safe TTS quality shapes shared by summaries and server processing. */
export const ttsQualityIssueTypeSchema = z.enum([
  "unexpected_speech", "unexpected_vocalization", "segment_start_mismatch", "missing_speech", "repetition", "truncated", "suspected_gibberish",
  "abnormal_duration", "unexpected_silence", "invalid_audio", "transcription_failed",
]);
export type TtsQualityIssueType = z.infer<typeof ttsQualityIssueTypeSchema>;

export const ttsQualityIssueSchema = z.object({
  type: ttsQualityIssueTypeSchema,
  severity: z.number().min(0).max(1),
  detail: z.string().max(500).optional(),
});
export type TtsQualityIssue = z.infer<typeof ttsQualityIssueSchema>;

export const ttsQualityMetricsSchema = z.object({
  similarity: z.number().min(0).max(1).optional(),
  missingRatio: z.number().min(0).max(1).optional(),
  unexpectedRatio: z.number().min(0).optional(),
  repetitionRatio: z.number().min(0).max(1).optional(),
  durationRatio: z.number().positive().optional(),
});
export type TtsQualityMetrics = z.infer<typeof ttsQualityMetricsSchema>;

/** Verdict of a single verification attempt against one segment. */
export const ttsQualityAttemptStatusSchema = z.enum(["pass", "retry", "needs_review", "unverified"]);
export type TtsQualityAttemptStatus = z.infer<typeof ttsQualityAttemptStatusSchema>;

export const ttsQualityAttemptSchema = z.object({
  attempt: z.number().int().positive(),
  settings: z.object({ deliveryIntensity: z.enum(["none", "restrained", "expressive"]) }),
  status: ttsQualityAttemptStatusSchema,
  score: z.number().min(0).max(1).optional(),
  issues: z.array(ttsQualityIssueSchema).default([]),
  requestId: z.string().optional(),
});
export type TtsQualityAttempt = z.infer<typeof ttsQualityAttemptSchema>;

export const ttsSegmentStatusSchema = z.enum(["verified", "needs_review", "unverified", "manually_accepted"]);
export type TtsSegmentStatus = z.infer<typeof ttsSegmentStatusSchema>;

export const ttsSegmentQualitySchema = z.object({
  index: z.number().int().nonnegative(),
  expectedText: z.string(),
  transcription: z.string().optional(),
  score: z.number().min(0).max(1).optional(),
  status: ttsSegmentStatusSchema,
  issues: z.array(ttsQualityIssueSchema).default([]),
  attempts: z.array(ttsQualityAttemptSchema).default([]),
  finalAttempt: z.number().int().nonnegative().default(0),
  /** SHA-256 fingerprint of the current segment audio on disk. */
  audioFingerprint: z.string().optional(),
  /** Audio fingerprint at the time of manual acceptance. If audio changes, acceptance is discarded. */
  acceptedAudioFingerprint: z.string().optional(),
  /** Set when a human deliberately accepts audio the guard could not verify. */
  acceptedAt: z.string().optional(),
  acceptedReason: z.string().max(500).optional(),
});
export type TtsSegmentQuality = z.infer<typeof ttsSegmentQualitySchema>;

export const ttsQualitySummaryStatusSchema = z.enum(["verified", "needs_review", "unverified", "partial"]);
export type TtsQualitySummaryStatus = z.infer<typeof ttsQualitySummaryStatusSchema>;

export const ttsQualityReportSchema = z.object({
  version: z.literal(1),
  status: ttsQualitySummaryStatusSchema,
  segments: z.array(ttsSegmentQualitySchema),
  retried: z.number().int().nonnegative(),
});
export type TtsQualityReport = z.infer<typeof ttsQualityReportSchema>;

