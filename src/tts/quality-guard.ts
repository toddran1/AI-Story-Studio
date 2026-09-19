import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AlignmentObservation } from "../alignment/types.js";
import { FfmpegTools } from "../audio/ffmpeg.js";
import { atomicWrite } from "../storage/atomic-write.js";
import { fingerprint } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import { FISH_S2_CONTROL_CUES } from "./fish/control-cues.js";
import type { TTSProvider } from "./provider.js";
import type { TTSRequest, TTSResult } from "./types.js";
import { scanVocalizations } from "./vocalizations.js";

export const TTS_QUALITY_GUARD_VERSION = "tts-quality-guard-v1";

export const ttsQualityIssueTypeSchema = z.enum([
  "unexpected_speech", "missing_speech", "repetition", "truncated", "suspected_gibberish",
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

/** Verifies generated speech by transcribing it. Implementations must reject on
 * unreadable input rather than returning an empty transcription. */
export interface SpeechTranscriber {
  readonly name: string;
  validateConfiguration(): Promise<void>;
  transcribe(request: { audioPath: string; language: string }): Promise<AlignmentObservation[]>;
}

export type QualityThresholds = {
  passScore: number;
  missingRatio: number;
  unexpectedRatio: number;
  /** Small absolute ASR slips at or below this token count are always tolerated. */
  toleratedTokenMistakes: number;
  repetitionRatio: number;
  truncationSuffixRatio: number;
  expectedWordsPerSecond: number;
  durationRatioLow: number;
  durationRatioHigh: number;
  silenceGapSeconds: number;
  gibberishConfidence: number;
  gibberishRatio: number;
};

export const defaultQualityThresholds: QualityThresholds = {
  passScore: 0.9, missingRatio: 0.1, unexpectedRatio: 0.15, toleratedTokenMistakes: 1,
  repetitionRatio: 0.05, truncationSuffixRatio: 0.2, expectedWordsPerSecond: 3,
  durationRatioLow: 0.4, durationRatioHigh: 2.5, silenceGapSeconds: 6,
  gibberishConfidence: 0.5, gibberishRatio: 0.3,
};

export type CompareOptions = {
  thresholds?: Partial<QualityThresholds>;
  /** True when the expected speech intentionally contains rendered vocalizations. */
  expectedVocalizations?: boolean;
  /** Active pronunciation custom/phonetic renderings: either form may be transcribed. */
  toleratedTerms?: Array<{ surface: string; spoken: string }>;
  durationSeconds?: number;
};

export type SpokenComparison = { score: number; metrics: TtsQualityMetrics; issues: TtsQualityIssue[] };

/** Retry sampling policy: the neutral control is delivery intensity; the Fish
 * adapter alone maps intensity to sampling parameters. Attempt 1 keeps the
 * configured delivery, attempt 2 steps one level more conservative, attempt 3+
 * synthesizes with no delivery direction. */
export function deliveryIntensityForAttempt(configured: TTSRequest["deliveryIntensity"], attempt: number): NonNullable<TTSRequest["deliveryIntensity"]> {
  const base = configured ?? "restrained";
  if (attempt <= 1) return base;
  if (attempt === 2) return base === "expressive" ? "restrained" : "none";
  return "none";
}

const contractions: Array<[RegExp, string]> = [
  [/can't\b/g, "cannot"], [/won't\b/g, "will not"], [/(\w+)n't\b/g, "$1 not"],
  [/'re\b/g, " are"], [/'ve\b/g, " have"], [/'ll\b/g, " will"], [/'m\b/g, " am"], [/'d\b/g, " would"], [/'s\b/g, " is"],
];

const numberWords = new Map([["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10],
  ["eleven", 11], ["twelve", 12], ["thirteen", 13], ["fourteen", 14], ["fifteen", 15], ["sixteen", 16], ["seventeen", 17], ["eighteen", 18], ["nineteen", 19], ["twenty", 20],
  ["thirty", 30], ["forty", 40], ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80], ["ninety", 90]]);
const wordsToNumber = new Map([...numberWords.entries()].map(([word, value]) => [value, word]));

function numberToWords(value: number): string[] {
  if (value < 0 || value > 99 || !Number.isInteger(value)) return [String(value)];
  if (value <= 20) return [wordsToNumber.get(value)!];
  const tens = Math.floor(value / 10) * 10; const rest = value % 10;
  return rest ? [wordsToNumber.get(tens)!, wordsToNumber.get(rest)!] : [wordsToNumber.get(tens)!];
}

const fishControlCueSet = new Set<string>(FISH_S2_CONTROL_CUES);

export function isKnownFishControlCue(cue: string): boolean {
  return fishControlCueSet.has(cue.trim().toLowerCase());
}

export function hasFishControlCues(text: string): boolean {
  return /\[([^\]]+)\]/.test(text) && Array.from(text.matchAll(/\[([^\]]+)\]/g)).some((m) => isKnownFishControlCue(m[1]!));
}

/** Normalizes both sides the same way: lowercase, contraction expansion,
 * punctuation stripped, digit tokens expanded to number words.
 * Strips speaker syntax (<|speaker:\d+|>) and known Fish S2 control cues in brackets.
 * Preserves ordinary bracketed words like [REDACTED] and parenthesized phrases like (Variant Two). */
export function tokenizeSpoken(text: string): string[] {
  let normalized = text.replace(/<\|speaker:\d+\|>/g, " ");
  normalized = normalized.replace(/\[([^\]]+)\]/g, (_, cue: string) => {
    return isKnownFishControlCue(cue) ? " " : ` ${cue} `;
  });
  normalized = normalized.toLocaleLowerCase();
  for (const [pattern, replacement] of contractions) normalized = normalized.replace(pattern, replacement);
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const output: string[] = [];
  for (const token of tokens) {
    const digits = token.replace(/,/g, "");
    if (/^\d+$/.test(digits)) output.push(...numberToWords(Number(digits)));
    else output.push(token);
  }
  return output;
}

const isSoundToken = (token: string) => !/[\p{L}\p{N}]/u.test(token);

function tokensEquivalent(left: string, right: string, tolerated: Map<string, Set<string>>): boolean {
  if (left === right) return true;
  if (tolerated.get(left)?.has(right) || tolerated.get(right)?.has(left)) return true;
  return left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left));
}

function toleratedVariants(terms: Array<{ surface: string; spoken: string }>): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (from: string, to: string) => { if (from !== to) map.set(from, new Set([...(map.get(from) ?? []), to])); };
  for (const term of terms) for (const surface of tokenizeSpoken(term.surface)) for (const spoken of tokenizeSpoken(term.spoken)) { add(surface, spoken); add(spoken, surface); }
  return map;
}

/** Deterministic token-level comparison of expected spoken text against a
 * transcription. Same inputs always produce the same score, metrics, and issues. */
export function compareSpokenText(expected: string, observations: AlignmentObservation[], opts: CompareOptions = {}): SpokenComparison {
  const thresholds = { ...defaultQualityThresholds, ...opts.thresholds };
  const expectedTokens = tokenizeSpoken(expected);
  // Each observation contributes normalized tokens; sound-only observations
  // (music notes, breath marks) are tracked separately for vocalization tolerance.
  const words = observations.map((observation) => ({ observation, tokens: tokenizeSpoken(observation.text), sound: isSoundToken(observation.text) }));
  const transcribedTokens = words.flatMap((word) => word.tokens);
  const tolerated = toleratedVariants(opts.toleratedTerms ?? []);
  const issues: TtsQualityIssue[] = [];

  // Greedy forward-window matching (same idea as alignment reconciliation):
  // each expected token claims the first equivalent unmatched transcription token.
  const matchedTranscribed = new Set<number>();
  const matchedExpected = new Set<number>();
  let cursor = 0;
  for (let index = 0; index < expectedTokens.length; index++) {
    let best = -1;
    for (let candidate = cursor; candidate < Math.min(transcribedTokens.length, cursor + 16); candidate++) {
      if (matchedTranscribed.has(candidate)) continue;
      if (tokensEquivalent(expectedTokens[index]!, transcribedTokens[candidate]!, tolerated)) { best = candidate; break; }
    }
    if (best >= 0) { matchedExpected.add(index); matchedTranscribed.add(best); cursor = best + 1; }
  }

  const expectedCount = Math.max(1, expectedTokens.length);
  const missing = expectedTokens.length - matchedExpected.size;
  const missingRatio = missing / expectedCount;
  // Sound-only observations (music notes, breath marks — anything without
  // letters/numbers) are ignored when the segment intentionally contains
  // vocalizations; otherwise they count as unexplained output. Real unmatched
  // WORD tokens are never excused by vocalization tolerance.
  const soundOnly = words.filter((word) => word.sound && !word.tokens.length).length;
  const unexpected = transcribedTokens.filter((_token, index) => !matchedTranscribed.has(index)).length + (opts.expectedVocalizations ? 0 : soundOnly);
  const unexpectedRatio = unexpected / expectedCount;
  const similarity = matchedExpected.size / expectedCount;

  // Consecutive n-gram duplication present in the transcription but not in the
  // expected text (intentional written repetition stays tolerated). Larger
  // phrases are claimed first; short single-word runs are ordinary speech.
  const duplicatedInExpected = (sequence: string[]) => {
    for (let index = 0; index + sequence.length * 2 <= expectedTokens.length; index++) {
      if (expectedTokens.slice(index, index + sequence.length).join(" ") === sequence.join(" ") && expectedTokens.slice(index + sequence.length, index + sequence.length * 2).join(" ") === sequence.join(" ")) return true;
    }
    return false;
  };
  const repeated = new Set<number>();
  for (let size = 8; size >= 1; size--) {
    for (let index = 0; index + size * 2 <= transcribedTokens.length; index++) {
      if ([...Array(size * 2).keys()].some((offset) => repeated.has(index + offset))) continue;
      const run = consecutiveRun(transcribedTokens, index, size);
      if (run < 2 || (size === 1 && run < 4)) continue;
      if (duplicatedInExpected(transcribedTokens.slice(index, index + size))) continue;
      for (let offset = 0; offset < size * run; offset++) repeated.add(index + offset);
    }
  }
  const repetitionRatio = repeated.size / Math.max(1, transcribedTokens.length);

  const lastMatched = matchedExpected.size ? Math.max(...matchedExpected) : -1;
  const suffixMissing = expectedTokens.length - 1 - lastMatched;
  const truncated = suffixMissing / expectedCount >= thresholds.truncationSuffixRatio && missingRatio >= thresholds.missingRatio;

  const durationSeconds = opts.durationSeconds ?? (observations.length ? Math.max(...observations.map((observation) => observation.end)) : undefined);
  const expectedDuration = expectedTokens.length / thresholds.expectedWordsPerSecond;
  const durationRatio = durationSeconds !== undefined && expectedDuration > 0 ? durationSeconds / expectedDuration : undefined;

  let maximumGap = 0;
  const timed = observations.filter((observation) => Number.isFinite(observation.start) && Number.isFinite(observation.end)).sort((a, b) => a.start - b.start);
  for (let index = 1; index < timed.length; index++) maximumGap = Math.max(maximumGap, timed[index]!.start - timed[index - 1]!.end);

  let tokenOffset = 0;
  const wordSpans = words.map((word) => { const span = { word, start: tokenOffset, end: tokenOffset + word.tokens.length }; tokenOffset = span.end; return span; });
  const unmatchedLowConfidence = wordSpans.filter(({ word, start, end }) => !word.sound && end > start && (word.observation.confidence ?? 1) < thresholds.gibberishConfidence
    && [...Array(end - start).keys()].some((offset) => !matchedTranscribed.has(start + offset))).length;
  const gibberishRatio = unmatchedLowConfidence / Math.max(1, wordSpans.filter(({ word, start, end }) => !word.sound && end > start).length);

  if (!expectedTokens.length) issues.push({ type: "invalid_audio", severity: 1, detail: "Expected spoken text is empty" });
  if (missing > thresholds.toleratedTokenMistakes && missingRatio >= thresholds.missingRatio)
    issues.push({ type: "missing_speech", severity: Math.min(1, missingRatio), detail: `${missing} of ${expectedTokens.length} expected tokens were not transcribed` });
  if (unexpected > thresholds.toleratedTokenMistakes && unexpectedRatio >= thresholds.unexpectedRatio)
    issues.push({ type: "unexpected_speech", severity: Math.min(1, unexpectedRatio), detail: `${unexpected} transcribed tokens were not in the expected text` });
  if (repetitionRatio >= thresholds.repetitionRatio)
    issues.push({ type: "repetition", severity: Math.min(1, repetitionRatio * 4), detail: `${repeated.size} transcribed tokens are consecutive duplicates not present in the expected text` });
  if (truncated) issues.push({ type: "truncated", severity: Math.min(1, suffixMissing / expectedCount), detail: `The final ${suffixMissing} expected tokens were not transcribed` });
  if (durationRatio !== undefined && (durationRatio < thresholds.durationRatioLow || durationRatio > thresholds.durationRatioHigh))
    issues.push({ type: "abnormal_duration", severity: 0.4, detail: `Audio duration is ${durationRatio.toFixed(2)}x the expected reading time` });
  if (timed.length > 2 && maximumGap > thresholds.silenceGapSeconds)
    issues.push({ type: "unexpected_silence", severity: 0.4, detail: `Transcription contains a ${maximumGap.toFixed(1)}s mid-segment silence` });
  if (gibberishRatio >= thresholds.gibberishRatio && unmatchedLowConfidence >= 2)
    issues.push({ type: "suspected_gibberish", severity: Math.min(1, gibberishRatio), detail: `${unmatchedLowConfidence} unmatched low-confidence tokens suggest gibberish` });

  let score = 1;
  if (issues.some((issue) => issue.type === "missing_speech")) score -= Math.min(0.7, missingRatio * 1.5);
  if (issues.some((issue) => issue.type === "unexpected_speech")) score -= Math.min(0.6, unexpectedRatio);
  if (issues.some((issue) => issue.type === "repetition")) score -= 0.25;
  if (issues.some((issue) => issue.type === "truncated")) score -= 0.3;
  if (issues.some((issue) => issue.type === "abnormal_duration")) score -= 0.1;
  if (issues.some((issue) => issue.type === "unexpected_silence")) score -= 0.1;
  if (issues.some((issue) => issue.type === "suspected_gibberish")) score -= 0.25;
  if (issues.some((issue) => issue.type === "invalid_audio")) score = 0;

  return { score: roundScore(score), issues, metrics: { similarity, missingRatio, unexpectedRatio, repetitionRatio, ...(durationRatio === undefined ? {} : { durationRatio }) } };
}

function consecutiveRun(tokens: string[], at: number, size: number) {
  const target = tokens.slice(at, at + size).join("");
  let run = 1;
  while (at + size * (run + 1) <= tokens.length && tokens.slice(at + size * run, at + size * (run + 1)).join("") === target) run++;
  return run;
}

const roundScore = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 10_000) / 10_000;

const criticalIssue = (issue: TtsQualityIssue) => ["unexpected_speech", "missing_speech", "repetition", "truncated", "suspected_gibberish", "invalid_audio", "transcription_failed"].includes(issue.type);

export function summarizeQuality(segments: Array<Pick<TtsSegmentQuality, "status" | "attempts">>): { status: TtsQualitySummaryStatus; needsReview: number; retried: number; manuallyAccepted: number } {
  const needsReview = segments.filter((segment) => segment.status === "needs_review").length;
  const manuallyAccepted = segments.filter((segment) => segment.status === "manually_accepted").length;
  const unverified = segments.filter((segment) => segment.status === "unverified").length;
  const retried = segments.filter((segment) => segment.attempts.length > 1).length;
  const status: TtsQualitySummaryStatus = needsReview ? "needs_review"
    : unverified === segments.length ? "unverified"
    : unverified || manuallyAccepted ? "partial"
    : "verified";
  return { status, needsReview, retried, manuallyAccepted };
}

export type QualityGuardOptions = {
  maxRetries: number;
  language: string;
  thresholds?: Partial<QualityThresholds>;
  /** Injectable for tests; defaults to ffprobe on the temporary segment file. */
  durationProbe?: (audioPath: string) => Promise<number | undefined>;
  toleratedTerms?: (expectedText: string) => Array<{ surface: string; spoken: string }>;
};

/** Post-generation verification wrapper. Sits outside the pronunciation wrapper so
 * it sees the final spoken text and per-segment audio; retries flow back through
 * the same (tracked) inner provider so every attempt is usage-recorded.
 * Degradation policy: when transcription is unavailable the generated audio is
 * ALWAYS kept and the segment is marked "unverified" — never reported as passed
 * and never allowed to block the chapter. */
export class QualityGuardTTSProvider implements TTSProvider {
  readonly name; readonly inputNormalizationVersion; readonly pronunciationCapabilities; readonly vocalizationCapabilities;
  private availability?: Promise<boolean>;
  constructor(
    private readonly inner: TTSProvider,
    private readonly transcriber?: SpeechTranscriber,
    private readonly options: QualityGuardOptions = { maxRetries: 2, language: "en-US" },
  ) {
    this.name = inner.name; this.inputNormalizationVersion = inner.inputNormalizationVersion;
    this.pronunciationCapabilities = inner.pronunciationCapabilities; this.vocalizationCapabilities = inner.vocalizationCapabilities;
  }
  vocalizationStrategy(model?: string) { return this.inner.vocalizationStrategy?.(model) ?? { kind: "safe_normalize" as const }; }
  resolveReferenceId(id?: string) { return this.inner.resolveReferenceId?.(id); }
  validateConfiguration() { return this.inner.validateConfiguration(); }

  private transcriberAvailable(): Promise<boolean> {
    if (!this.transcriber) return Promise.resolve(false);
    return this.availability ??= this.transcriber.validateConfiguration().then(() => true).catch((error) => {
      logger.warn({ event: "tts.quality.transcriber_unavailable", err: error instanceof Error ? error.message : String(error) }, "TTS quality guard transcriber is unavailable; segments will be marked unverified");
      return false;
    });
  }

  async synthesize(request: TTSRequest): Promise<TTSResult> {
    const result = await this.inner.synthesize(request);
    if (request.qualityGuard === false || !result.segmentTexts || result.segmentTexts.length !== result.segments.length) return result;
    const maxAttempts = 1 + Math.max(0, Math.min(5, this.options.maxRetries));
    const available = await this.transcriberAvailable();
    const directory = await mkdtemp(join(tmpdir(), "ai-story-tts-quality-"));
    try {
      const segments = [...result.segments];
      const quality: TtsSegmentQuality[] = [];
      for (const [index, expectedText] of result.segmentTexts.entries()) {
        quality.push(await this.verifySegment({ request, expectedText, index, segments, directory, available, maxAttempts }));
      }
      const summary = summarizeQuality(quality);
      return { ...result, audio: concat(segments), segments, quality: { version: 1, status: summary.status, segments: quality, retried: summary.retried } };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async verifySegment(context: {
    request: TTSRequest; expectedText: string; index: number; segments: Uint8Array[];
    directory: string; available: boolean; maxAttempts: number;
  }): Promise<TtsSegmentQuality> {
    const { request, expectedText, index, segments, directory, maxAttempts } = context;
    const configuredIntensity = request.deliveryIntensity ?? "restrained";
    const attempts: TtsQualityAttempt[] = [];
    const initialAudio = segments[index]!;
    const audioFingerprint = fingerprint(Buffer.from(initialAudio).toString("base64"));
    if (!initialAudio.byteLength) {
      attempts.push({ attempt: 1, settings: { deliveryIntensity: configuredIntensity }, status: "needs_review", issues: [{ type: "invalid_audio", severity: 1, detail: "Provider returned an empty segment" }] });
      return { index, expectedText, audioFingerprint, status: "needs_review", issues: attempts[0]!.issues, attempts, finalAttempt: 1 };
    }
    if (!context.available) {
      attempts.push({ attempt: 1, settings: { deliveryIntensity: configuredIntensity }, status: "unverified", issues: [{ type: "transcription_failed", severity: 0.5, detail: "Speech transcriber is unavailable" }] });
      return { index, expectedText, audioFingerprint, status: "unverified", issues: attempts[0]!.issues, attempts, finalAttempt: 1 };
    }
    let current = initialAudio;
    let best: { audio: Uint8Array; score: number; transcription?: string; issues: TtsQualityIssue[] } = { audio: current, score: -1, issues: [] };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const path = join(directory, `segment-${String(index + 1).padStart(4, "0")}-attempt-${attempt}.mp3`);
      await atomicWrite(path, current);
      let observations: AlignmentObservation[];
      try {
        observations = await this.transcriber!.transcribe({ audioPath: path, language: this.options.language });
        if (!observations.length) throw new Error("Transcription produced no speech tokens");
      } catch (error) {
        logger.warn({ event: "tts.quality.transcription_failed", segment: index + 1, attempt, err: error instanceof Error ? error.message : String(error) }, "TTS quality transcription failed; keeping generated audio");
        attempts.push({ attempt, settings: { deliveryIntensity: deliveryIntensityForAttempt(request.deliveryIntensity, attempt) }, status: "unverified", issues: [{ type: "transcription_failed", severity: 0.5, detail: error instanceof Error ? error.message.slice(0, 300) : String(error) }] });
        const finalAudio = best.score >= 0 ? best.audio : current;
        segments[index] = finalAudio;
        return { index, expectedText, audioFingerprint: fingerprint(Buffer.from(finalAudio).toString("base64")), transcription: best.transcription, score: best.score >= 0 ? best.score : undefined, status: "unverified", issues: attempts.at(-1)!.issues, attempts, finalAttempt: attempt };
      }
      const durationSeconds = this.options.durationProbe ? await this.options.durationProbe(path).catch(() => undefined) : undefined;
      const comparison = compareSpokenText(expectedText, observations, {
        thresholds: this.options.thresholds, durationSeconds,
        expectedVocalizations: scanVocalizations(expectedText).length > 0 || hasFishControlCues(expectedText),
        toleratedTerms: this.options.toleratedTerms?.(expectedText),
      });
      const transcription = observations.map((observation) => observation.text).join(" ").trim() || undefined;
      if (comparison.score > best.score) best = { audio: current, score: comparison.score, transcription, issues: comparison.issues };
      const settings = { deliveryIntensity: deliveryIntensityForAttempt(request.deliveryIntensity, attempt) };
      if (comparison.score >= (this.options.thresholds?.passScore ?? defaultQualityThresholds.passScore) && !comparison.issues.some(criticalIssue)) {
        attempts.push({ attempt, settings, status: "pass", score: comparison.score, issues: comparison.issues });
        segments[index] = current;
        return { index, expectedText, audioFingerprint: fingerprint(Buffer.from(current).toString("base64")), transcription, score: comparison.score, status: "verified", issues: comparison.issues, attempts, finalAttempt: attempt };
      }
      if (attempt >= maxAttempts) {
        attempts.push({ attempt, settings, status: "needs_review", score: comparison.score, issues: comparison.issues });
        // Retry exhaustion keeps the best-scoring audio; usable work is never deleted.
        segments[index] = best.audio;
        return { index, expectedText, audioFingerprint: fingerprint(Buffer.from(best.audio).toString("base64")), transcription: best.transcription, score: best.score >= 0 ? best.score : undefined, status: "needs_review", issues: best.issues, attempts, finalAttempt: attempt };
      }
      const retried = await this.inner.synthesize({
        ...request,
        text: expectedText,
        exactChunk: true,
        deliveryIntensity: deliveryIntensityForAttempt(request.deliveryIntensity, attempt + 1),
        maxCharsPerRequest: request.maxCharsPerRequest,
      });
      const requestId = retried.requestIds?.join(",");
      attempts.push({ attempt, settings, status: "retry", score: comparison.score, issues: comparison.issues, ...(requestId ? { requestId } : {}) });
      const replacement = retried.segments.length === 1 ? retried.segments[0]! : retried.audio;
      if (!replacement.byteLength) {
        attempts.push({ attempt: attempt + 1, settings: { deliveryIntensity: deliveryIntensityForAttempt(request.deliveryIntensity, attempt + 1) }, status: "needs_review", issues: [{ type: "invalid_audio", severity: 1, detail: "Retry returned empty audio" }] });
        segments[index] = best.audio;
        return { index, expectedText, audioFingerprint: fingerprint(Buffer.from(best.audio).toString("base64")), transcription: best.transcription, score: best.score >= 0 ? best.score : undefined, status: "needs_review", issues: attempts.at(-1)!.issues, attempts, finalAttempt: attempt + 1 };
      }
      current = replacement;
    }
    // Unreachable: the loop returns on pass, exhaustion, or empty retry audio.
    throw new Error("TTS quality verification exhausted attempts unexpectedly");
  }
}

function concat(segments: Uint8Array[]): Uint8Array {
  const length = segments.reduce((sum, segment) => sum + segment.length, 0);
  const audio = new Uint8Array(length); let offset = 0;
  for (const segment of segments) { audio.set(segment, offset); offset += segment.length; }
  return audio;
}

/** Default duration probe: ffprobe against the temporary segment file. */
export async function ffprobeDurationProbe(tools: FfmpegTools, audioPath: string): Promise<number | undefined> {
  try { return (await tools.probe(audioPath)).durationSeconds; } catch { return undefined; }
}
