import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { chapterSchema } from "../domain/chapter.js";
import type { Story } from "../domain/story.js";
import { StorageError } from "../pipeline/errors.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { exists, readJsonIfExists } from "../storage/story-files.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { fingerprint } from "../utils/hash.js";
import { dependentProcessingStages } from "../studio/stage-execution.js";
import type { TTSProvider } from "./provider.js";
import {
  QualityThresholds, SpeechTranscriber, TTS_QUALITY_GUARD_VERSION, TtsQualityReport, TtsSegmentQuality,
  compareSpokenText, defaultQualityThresholds, hasFishControlCues, summarizeQuality, ttsSegmentQualitySchema, ttsQualitySummaryStatusSchema,
} from "./quality-guard.js";
import { scanVocalizations } from "./vocalizations.js";

/** Durable per-chapter verification artifact. Provenance and policy live here so
 * re-verification can run later without any TTS call. Never part of canonical
 * narration; regenerated audio rewrites it wholesale. */
export const ttsQualityArtifactSchema = z.object({
  version: z.literal(1),
  chapter: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  provider: z.string().min(1),
  model: z.string().min(1),
  referenceId: z.string().optional(),
  voiceMode: z.string().optional(),
  deliveryIntensity: z.enum(["none", "restrained", "expressive"]).optional(),
  status: ttsQualitySummaryStatusSchema,
  verificationPolicy: z.object({
    transcriber: z.string().min(1),
    maxRetries: z.number().int().min(0).max(5),
    thresholds: z.record(z.string(), z.number()),
    fingerprint: z.string().min(1),
  }),
  segments: z.array(ttsSegmentQualitySchema),
});
export type TtsQualityArtifact = z.infer<typeof ttsQualityArtifactSchema>;

export function verificationPolicyFingerprint(policy: { transcriber: string; maxRetries: number; thresholds?: Partial<QualityThresholds> }): string {
  return fingerprint({ version: TTS_QUALITY_GUARD_VERSION, transcriber: policy.transcriber, maxRetries: policy.maxRetries, thresholds: { ...defaultQualityThresholds, ...policy.thresholds } });
}

export async function loadChapterTtsQuality(root: string, slug: string, chapter: number): Promise<TtsQualityArtifact | undefined> {
  const raw = await readJsonIfExists(storyPaths(root, slug, chapter).ttsQuality);
  return raw ? ttsQualityArtifactSchema.parse(raw) : undefined;
}

export async function removeChapterTtsQuality(root: string, slug: string, chapter: number): Promise<void> {
  await rm(storyPaths(root, slug, chapter).ttsQuality, { force: true });
}

export async function persistChapterTtsQuality(options: {
  root: string; story: Story; chapter: number; report: TtsQualityReport; maxRetries: number; transcriber: string; thresholds?: Partial<QualityThresholds>;
}): Promise<TtsQualityArtifact> {
  const paths = storyPaths(options.root, options.story.slug, options.chapter);
  const previous = await loadChapterTtsQuality(options.root, options.story.slug, options.chapter).catch(() => undefined);
  const now = new Date().toISOString();
  const config = options.story.pipeline.tts;
  const artifact: TtsQualityArtifact = {
    version: 1, chapter: options.chapter, createdAt: previous?.createdAt ?? now, updatedAt: now,
    provider: config.provider, model: config.model, referenceId: config.referenceId, voiceMode: config.voiceMode, deliveryIntensity: config.deliveryIntensity,
    status: options.report.status,
    verificationPolicy: { transcriber: options.transcriber, maxRetries: options.maxRetries, thresholds: { ...defaultQualityThresholds, ...options.thresholds }, fingerprint: verificationPolicyFingerprint({ transcriber: options.transcriber, maxRetries: options.maxRetries, thresholds: options.thresholds }) },
    // Human acceptances survive regeneration of the verification state UNLESS the
    // audio artifact has changed (acceptedAudioFingerprint does not match segment.audioFingerprint).
    segments: options.report.segments.map((segment) => {
      const accepted = previous?.segments.find((item) => item.index === segment.index && item.status === "manually_accepted" && item.expectedText === segment.expectedText);
      const audioChanged = Boolean(
        accepted?.acceptedAudioFingerprint &&
        segment.audioFingerprint &&
        accepted.acceptedAudioFingerprint !== segment.audioFingerprint
      );
      return accepted && segment.status !== "verified" && !audioChanged ? accepted : segment;
    }),
  };
  artifact.status = summarizeQuality(artifact.segments).status;
  await atomicWriteJson(paths.ttsQuality, artifact);
  return artifact;
}

async function syncChapterQualitySummary(root: string, slug: string, chapter: number, artifact: TtsQualityArtifact): Promise<void> {
  const paths = storyPaths(root, slug, chapter);
  const raw = await readJsonIfExists(paths.chapterMeta);
  if (!raw) return;
  const meta = chapterSchema.parse(raw);
  const summary = summarizeQuality(artifact.segments);
  meta.stages.tts = { ...meta.stages.tts, usage: { ...meta.stages.tts?.usage, quality: { status: summary.status, segments: artifact.segments.length, needsReview: summary.needsReview, retried: summary.retried, manuallyAccepted: summary.manuallyAccepted } } };
  meta.updatedAt = new Date().toISOString();
  await atomicWriteJson(paths.chapterMeta, meta);
}

const segmentFile = (root: string, slug: string, chapter: number, index: number) => join(storyPaths(root, slug, chapter).segments, `${String(index + 1).padStart(4, "0")}.mp3`);

/** Re-runs verification against the EXISTING segment audio using the persisted
 * expected texts. Never calls a TTS provider. Manually accepted segments are
 * preserved exactly as accepted provided their audio artifact has not changed on disk. */
export async function verifyStoredChapterTts(options: {
  root: string;
  story: Story;
  chapter: number;
  transcriber: SpeechTranscriber;
  maxRetries?: number;
  thresholds?: Partial<QualityThresholds>;
}): Promise<TtsQualityArtifact> {
  const { root, story, chapter, transcriber } = options;
  const paths = storyPaths(root, story.slug, chapter);
  const artifact = await loadChapterTtsQuality(root, story.slug, chapter);
  if (!artifact) throw new StorageError(`Chapter ${chapter} has no TTS quality artifact to verify`);
  const available = await transcriber.validateConfiguration().then(() => true).catch(() => false);
  const maxRetries = options.maxRetries ?? story.pipeline.tts.maxQualityRetries ?? artifact.verificationPolicy.maxRetries;
  const thresholds = { ...defaultQualityThresholds, ...artifact.verificationPolicy.thresholds, ...options.thresholds };
  const segments: TtsSegmentQuality[] = [];
  for (const segment of artifact.segments) {
    const file = segmentFile(root, story.slug, chapter, segment.index);
    const diskFingerprint = await fileFingerprint(file);
    if (segment.status === "manually_accepted") {
      if (diskFingerprint && segment.acceptedAudioFingerprint && diskFingerprint === segment.acceptedAudioFingerprint) {
        segments.push({ ...segment, audioFingerprint: diskFingerprint });
        continue;
      }
      // If audio file changed on disk or is missing, or acceptedAudioFingerprint does not match,
      // manual acceptance is discarded and verification proceeds below.
    }
    if (!available || !diskFingerprint) {
      segments.push({
        ...segment,
        audioFingerprint: diskFingerprint,
        status: "unverified",
        score: undefined,
        transcription: undefined,
        issues: [{ type: "transcription_failed", severity: 0.5, detail: available ? "Segment audio file is missing" : "Speech transcriber is unavailable" }],
      });
      continue;
    }
    try {
      const observations = await transcriber.transcribe({ audioPath: file, language: story.outputLanguage });
      if (!observations.length) throw new Error("Transcription produced no speech tokens");
      const comparison = compareSpokenText(segment.expectedText, observations, {
        thresholds,
        expectedVocalizations: scanVocalizations(segment.expectedText).length > 0 || hasFishControlCues(segment.expectedText),
      });
      const passed = comparison.score >= thresholds.passScore && !comparison.issues.some((issue) => ["unexpected_speech", "unexpected_vocalization", "segment_start_mismatch", "missing_speech", "repetition", "truncated", "suspected_gibberish", "invalid_audio"].includes(issue.type));
      segments.push({
        ...segment,
        audioFingerprint: diskFingerprint,
        status: passed ? "verified" : "needs_review",
        score: comparison.score,
        transcription: observations.map((observation) => observation.text).join(" ").trim() || undefined,
        issues: comparison.issues,
      });
    } catch {
      segments.push({
        ...segment,
        audioFingerprint: diskFingerprint,
        status: "unverified",
        score: undefined,
        transcription: undefined,
        issues: [{ type: "transcription_failed", severity: 0.5, detail: "Segment audio could not be transcribed" }],
      });
    }
  }
  const policy = {
    transcriber: transcriber.name,
    maxRetries,
    thresholds,
    fingerprint: verificationPolicyFingerprint({ transcriber: transcriber.name, maxRetries, thresholds }),
  };
  const updated: TtsQualityArtifact = {
    ...artifact,
    segments,
    status: summarizeQuality(segments).status,
    verificationPolicy: policy,
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteJson(paths.ttsQuality, updated);
  await syncChapterQualitySummary(root, story.slug, chapter, updated);
  return updated;
}

/** Regenerates exactly one failed segment through the guard-wrapped provider,
 * replaces its audio file atomically, and marks mastering and downstream stages
 * pending. Mastered audio is never silently reassembled here. */
export async function regenerateStoredChapterTtsSegment(options: { root: string; story: Story; chapter: number; segment: number; provider: TTSProvider; maxRetries: number }): Promise<TtsQualityArtifact> {
  const { root, story, chapter, provider } = options;
  const artifact = await loadChapterTtsQuality(root, story.slug, chapter);
  if (!artifact) throw new StorageError(`Chapter ${chapter} has no TTS quality artifact; run TTS first`);
  const current = artifact.segments.find((segment) => segment.index === options.segment);
  if (!current) throw new StorageError(`Chapter ${chapter} has no TTS segment ${options.segment + 1}`);
  const file = segmentFile(root, story.slug, chapter, current.index);
  if (!(await exists(file))) throw new StorageError(`Chapter ${chapter} segment ${current.index + 1} audio is missing; rerun the TTS stage`);
  const config = story.pipeline.tts;
  const result = await provider.synthesize({
    text: current.expectedText, exactChunk: true, model: config.model, referenceId: config.referenceId, secondaryReferenceId: config.secondaryReferenceId,
    voiceMode: config.voiceMode, deliveryIntensity: config.deliveryIntensity, qualityGuard: true,
    providerQualityGuard: config.providerQualityGuard,
    speed: config.speed, format: config.format, sampleRate: config.sampleRate, bitrate: config.bitrate,
    normalize: config.normalize, maxCharsPerRequest: config.maxCharsPerRequest,
  });
  const replacement = result.segments.length === 1 ? result.segments[0]! : result.audio;
  if (!replacement.byteLength) throw new StorageError("Segment regeneration returned empty audio; keeping the previous segment");
  await atomicWrite(file, replacement);
  const newFingerprint = await fileFingerprint(file);
  const verified = result.quality?.segments[0];
  const segments = artifact.segments.map((segment) => segment.index === current.index
    ? {
        ...(verified ?? { expectedText: current.expectedText, status: "unverified" as const, issues: [{ type: "transcription_failed" as const, severity: 0.5, detail: "Regenerated segment was not verified" }], attempts: [], finalAttempt: 0 }),
        index: current.index,
        audioFingerprint: newFingerprint,
        acceptedAt: undefined,
        acceptedReason: undefined,
        acceptedAudioFingerprint: undefined,
      }
    : segment);
  const updated: TtsQualityArtifact = { ...artifact, segments, status: summarizeQuality(segments).status, updatedAt: new Date().toISOString() };
  await atomicWriteJson(storyPaths(root, story.slug, chapter).ttsQuality, updated);
  await syncChapterQualitySummary(root, story.slug, chapter, updated);
  // Mastering consumes the segment files; it and its dependents must rerun.
  await markStagesPending(root, story.slug, chapter, ["audioMastering", ...dependentProcessingStages("audioMastering")]);
  return updated;
}

/** A deliberate, auditable human acceptance of a segment the guard could not
 * verify. Never reported as objectively passed. */
export async function acceptStoredChapterTtsSegment(options: { root: string; slug: string; chapter: number; segment: number; reason?: string }): Promise<TtsQualityArtifact> {
  const { root, slug, chapter } = options;
  const artifact = await loadChapterTtsQuality(root, slug, chapter);
  if (!artifact) throw new StorageError(`Chapter ${chapter} has no TTS quality artifact`);
  const current = artifact.segments.find((segment) => segment.index === options.segment);
  if (!current) throw new StorageError(`Chapter ${chapter} has no TTS segment ${options.segment + 1}`);
  const file = segmentFile(root, slug, chapter, current.index);
  const diskFingerprint = await fileFingerprint(file);
  const acceptedAudioFingerprint = diskFingerprint ?? current.audioFingerprint;
  const segments = artifact.segments.map((segment) => segment.index === current.index
    ? {
        ...segment,
        status: "manually_accepted" as const,
        acceptedAt: new Date().toISOString(),
        acceptedReason: options.reason,
        audioFingerprint: acceptedAudioFingerprint,
        acceptedAudioFingerprint,
      }
    : segment);
  const updated: TtsQualityArtifact = { ...artifact, segments, status: summarizeQuality(segments).status, updatedAt: new Date().toISOString() };
  await atomicWriteJson(storyPaths(root, slug, chapter).ttsQuality, updated);
  await syncChapterQualitySummary(root, slug, chapter, updated);
  return updated;
}

async function markStagesPending(root: string, slug: string, chapter: number, stages: string[]) {
  const paths = storyPaths(root, slug, chapter);
  const raw = await readJsonIfExists(paths.chapterMeta);
  if (!raw) return;
  const meta = chapterSchema.parse(raw);
  for (const stage of stages) if (stage in meta.stages) { const key = stage as keyof typeof meta.stages; if (meta.stages[key]?.provider === "manual" && !meta.stages[key]?.manualAcceptance) continue; meta.stages[key] = { status: "pending" }; }
  meta.updatedAt = new Date().toISOString();
  await atomicWriteJson(paths.chapterMeta, meta);
}
