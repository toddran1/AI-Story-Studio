import { normalizeSpeechForProvider } from "./speech-normalization.js";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
import { CensorManifest, type CensorAudioService, FfmpegCensorAudioService, planCensoredSpeech, speechForSynthesis } from "./censor-audio.js";
import { logger } from "../utils/logger.js";
import { safeErrorMessage } from "../errors/diagnostic.js";

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

export function createChapterTtsQualityArtifact(options: {
  chapter: number;
  config: Story["pipeline"]["tts"];
  report: TtsQualityReport;
  maxRetries: number;
  transcriber: string;
  thresholds?: Partial<QualityThresholds>;
  previous?: TtsQualityArtifact;
}): TtsQualityArtifact {
  const now = new Date().toISOString();
  const artifact: TtsQualityArtifact = {
    version: 1, chapter: options.chapter, createdAt: options.previous?.createdAt ?? now, updatedAt: now,
    provider: options.config.provider, model: options.config.model, referenceId: options.config.referenceId, voiceMode: options.config.voiceMode, deliveryIntensity: options.config.deliveryIntensity,
    status: options.report.status,
    verificationPolicy: { transcriber: options.transcriber, maxRetries: options.maxRetries, thresholds: { ...defaultQualityThresholds, ...options.thresholds }, fingerprint: verificationPolicyFingerprint({ transcriber: options.transcriber, maxRetries: options.maxRetries, thresholds: options.thresholds }) },
    // Human acceptances survive regeneration of the verification state UNLESS the
    // audio artifact has changed (acceptedAudioFingerprint does not match segment.audioFingerprint).
    segments: options.report.segments.map((segment) => {
      const accepted = options.previous?.segments.find((item) => item.index === segment.index && item.status === "manually_accepted" && item.expectedText === segment.expectedText);
      const audioChanged = Boolean(
        accepted?.acceptedAudioFingerprint &&
        segment.audioFingerprint &&
        accepted.acceptedAudioFingerprint !== segment.audioFingerprint
      );
      return accepted && segment.status !== "verified" && !audioChanged ? accepted : segment;
    }),
  };
  artifact.status = summarizeQuality(artifact.segments).status;
  return artifact;
}

export async function persistChapterTtsQuality(options: {
  root: string; story: Story; chapter: number; report: TtsQualityReport; maxRetries: number; transcriber: string; thresholds?: Partial<QualityThresholds>;
}): Promise<TtsQualityArtifact> {
  const paths = storyPaths(options.root, options.story.slug, options.chapter);
  const previous = await loadChapterTtsQuality(options.root, options.story.slug, options.chapter).catch(() => undefined);
  const artifact = createChapterTtsQualityArtifact({
    chapter: options.chapter,
    config: options.story.pipeline.tts,
    report: options.report,
    maxRetries: options.maxRetries,
    transcriber: options.transcriber,
    thresholds: options.thresholds,
    previous,
  });
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
  const maxRetries = 0;
  const thresholds = { ...defaultQualityThresholds, ...artifact.verificationPolicy.thresholds, ...options.thresholds };

  let segmentDirEntries: string[] = [];
  try {
    segmentDirEntries = await readdir(paths.segments);
  } catch {
    // Segments directory may not exist
  }
  const diskSegmentNumbers: number[] = [];
  for (const entry of segmentDirEntries) {
    const match = /^(\d+)\.mp3$/.exec(entry);
    if (match) {
      diskSegmentNumbers.push(parseInt(match[1]!, 10));
    }
  }
  diskSegmentNumbers.sort((a, b) => a - b);
  const expectedIndices = new Set(artifact.segments.map((s) => s.index));
  const extraFiles = diskSegmentNumbers.filter((num) => !expectedIndices.has(num - 1));
  if (extraFiles.length > 0) {
    logger.warn({
      event: "tts.verify.extra_segments_detected",
      chapter,
      extraFiles: extraFiles.map((num) => `${String(num).padStart(4, "0")}.mp3`),
      count: extraFiles.length,
    });
  }

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
    if (!diskFingerprint) {
      segments.push({
        ...segment,
        audioFingerprint: undefined,
        status: "unverified",
        score: undefined,
        transcription: undefined,
        issues: [{ type: "transcription_failed", severity: 0.5, detail: "Segment audio file is missing" }],
      });
      continue;
    }
    if (!available) {
      segments.push({
        ...segment,
        audioFingerprint: diskFingerprint,
        status: "unverified",
        score: undefined,
        transcription: undefined,
        issues: [{ type: "transcription_failed", severity: 0.5, detail: "Speech transcriber is unavailable" }],
      });
      continue;
    }
    try {
      const observations = await transcriber.transcribe({ audioPath: file, language: story.outputLanguage });
      if (!observations.length) throw new Error("Transcription produced no speech tokens");
      const comparison = compareSpokenText(segment.expectedSpokenText ?? segment.expectedText, observations, {
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
    } catch (error) {
      const sanitized = safeErrorMessage(error, 200);
      logger.warn({
        event: "tts.verify.transcription_failed",
        chapter,
        segment: segment.index,
        transcriber: transcriber.name,
        error: sanitized,
      });
      segments.push({
        ...segment,
        audioFingerprint: diskFingerprint,
        status: "unverified",
        score: undefined,
        transcription: undefined,
        issues: [{
          type: "transcription_failed",
          severity: 0.5,
          detail: sanitized ? `Speech transcription failed: ${sanitized}` : "Speech transcription failed",
        }],
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

/** Read-only preflight shared by single and bulk regeneration. */
export async function prepareStoredChapterTtsSegment(options: { root: string; story: Story; chapter: number; segment: number; provider: TTSProvider; allowedChangedSegments?: number[]; artifact?: TtsQualityArtifact }) {
  const { root, story, chapter, provider } = options;
  const paths = storyPaths(root, story.slug, chapter);
  const artifact = options.artifact ?? await loadChapterTtsQuality(root, story.slug, chapter);
  if (!artifact) throw new StorageError(`Chapter ${chapter} has no TTS quality artifact; run TTS first`);
  let current = artifact.segments.find(segment => segment.index === options.segment);
  if (!current) throw new StorageError(`Chapter ${chapter} has no TTS segment ${options.segment + 1}`);
  if (!await exists(segmentFile(root, story.slug, chapter, current.index))) throw new StorageError(`Chapter ${chapter} segment ${current.index + 1} audio is missing; rerun the TTS stage`);
  const config = story.pipeline.tts;
  const existingCensor = await readJsonIfExists<CensorManifest>(paths.censorManifest);
  if (existingCensor?.items.some(item => item.kind === "tone") && story.narrationSettings.bleepStrongProfanity !== true) throw new StorageError("This chapter contains saved bleep tones but bleeping is now disabled. Regenerate the full chapter audio to restore the censored words safely.");
  const savedScript = await exists(paths.narrationTts) ? await readFile(paths.narrationTts, "utf8") : undefined;
  const savedNarration = await exists(paths.narration) ? await readFile(paths.narration, "utf8") : undefined;
  const script = savedScript?.trim() || savedNarration?.trim();
  if (!script && (savedScript !== undefined || savedNarration !== undefined)) throw new StorageError("Saved narration is empty; save the intended narration before regenerating speech.");
  if (script && provider.prepareSegments) {
    const speech = normalizeSpeechForProvider(script, story.outputLanguage, story.narrationSettings, provider, config.model);
    const prepare = (text: string) => provider.prepareSegments!({ text, model: config.model, referenceId: config.referenceId, secondaryReferenceId: config.secondaryReferenceId, voiceMode: config.voiceMode, deliveryIntensity: config.deliveryIntensity, speed: config.speed, format: config.format, sampleRate: config.sampleRate, bitrate: config.bitrate, normalize: config.normalize, maxCharsPerRequest: config.maxCharsPerRequest });
    const plan = existingCensor ? planCensoredSpeech(speech.normalized.text) : undefined;
    const prepared = plan ? plan.flatMap((part, index) => part.kind === "speech" ? prepare(speechForSynthesis(plan, index)) : []) : prepare(speech.normalized.text);
    // Older Fish artifacts put the narration reset immediately after dialogue;
    // current formatting puts it before the following narration. Current formatting also
    // repeats soft cues for adjacent dialogue. Neither change alters
    // the words in untouched audio and neither should block an edit.
    const comparableText = (text: string | undefined) => provider.name === "fish" ? text?.replace(/\[(?:calm|soft)\]/gi, " ").replace(/\s+/g, " ").trim() : text;
    const unchangedOthers = artifact.segments.every(segment => segment.index === options.segment || options.allowedChangedSegments?.includes(segment.index) || comparableText(prepared[segment.index]) === comparableText(segment.expectedText));
    // Edits in another segment are allowed: they remain pending for that segment's
    // own regeneration. Require the same paragraph at every join so we cannot
    // silently duplicate or omit narration by replacing a shifted chunk.
    const lastParagraph = (text: string | undefined) => comparableText(text?.trim().split(/\n\s*\n/).at(-1));
    const stableJoins = artifact.segments.slice(0, -1).every(segment => lastParagraph(prepared[segment.index]) === lastParagraph(segment.expectedText));
    let refreshed = prepared;
    if (prepared.length !== artifact.segments.length || (!unchangedOthers && !stableJoins)) {
      // Repacking by character count can move an unchanged paragraph into the
      // next chunk. Preserve the existing joins using unique closing paragraphs.
      const paragraphs = prepared.join("\n\n").split(/\n\s*\n/).map(text => text.trim()).filter(Boolean);
      const normalized = paragraphs.map(comparableText);
      const restored: string[] = [];
      let cursor = 0;
      for (const segment of artifact.segments.slice(0, -1)) {
        const anchor = lastParagraph(segment.expectedText);
        const positions = normalized.flatMap((text, index) => text === anchor ? [index] : []);
        if (!anchor || anchor.length < 20 || positions.length !== 1 || positions[0]! < cursor) break;
        const boundary = positions[0]! + 1;
        restored.push(paragraphs.slice(cursor, boundary).join("\n\n")); cursor = boundary;
      }
      if (restored.length === artifact.segments.length - 1 && cursor < paragraphs.length) {
        restored.push(paragraphs.slice(cursor).join("\n\n")); refreshed = restored;
      } else refreshed = [];
    }
    if (!refreshed[options.segment] || refreshed.length !== artifact.segments.length || refreshed[options.segment]!.length > 20_000) throw new StorageError(`Chapter ${chapter}, segment ${options.segment + 1}: the saved narration cannot be matched safely to the existing segment boundaries. Regenerate the full chapter audio. No segment audio was generated.`);
    current = { ...current, expectedText: refreshed[options.segment]! };
  } else if (script) {
    const metadata = await readJsonIfExists(paths.chapterMeta).then(raw => raw ? chapterSchema.parse(raw) : undefined);
    if (metadata?.stages.tts.status !== "complete") throw new StorageError("Saved narration changed. This provider cannot refresh individual segment text; regenerate the full chapter audio.");
  }
  return current;
}

/** Regenerates exactly one failed segment through the guard-wrapped provider,
 * replaces its audio file atomically, and marks mastering and downstream stages
 * pending. Mastered audio is never silently reassembled here. */
export async function regenerateStoredChapterTtsSegment(options: { root: string; story: Story; chapter: number; segment: number; provider: TTSProvider; maxRetries: number; censor?: CensorAudioService; allowedChangedSegments?: number[] }): Promise<TtsQualityArtifact> {
  const { root, story, chapter, provider } = options;
  const paths = storyPaths(root, story.slug, chapter);
  const artifact = await loadChapterTtsQuality(root, story.slug, chapter);
  if (!artifact) throw new StorageError(`Chapter ${chapter} has no TTS quality artifact; run TTS first`);
  let current = artifact.segments.find((segment) => segment.index === options.segment);
  if (!current) throw new StorageError(`Chapter ${chapter} has no TTS segment ${options.segment + 1}`);
  const targetSegmentFile = segmentFile(root, story.slug, chapter, current.index);
  if (!(await exists(targetSegmentFile))) throw new StorageError(`Chapter ${chapter} segment ${current.index + 1} audio is missing; rerun the TTS stage`);

  // Read existing files for potential rollback
  const oldSegmentAudio = await readFile(targetSegmentFile);
  const oldQualityJson = await readFile(paths.ttsQuality);
  const censorManifest = await readJsonIfExists<CensorManifest>(paths.censorManifest);
  const oldAudioRawExists = await exists(paths.audioRaw);
  const oldAudioRaw = oldAudioRawExists ? await readFile(paths.audioRaw) : undefined;
  const oldChapterMetaJson = (await exists(paths.chapterMeta)) ? await readFile(paths.chapterMeta) : undefined;

  const config = story.pipeline.tts;
  current = await prepareStoredChapterTtsSegment({ ...options, artifact });
  const result = await (options.censor ?? new FfmpegCensorAudioService()).synthesize(provider, {
    text: current.expectedText, exactChunk: true, singleAttempt: true, model: config.model, referenceId: config.referenceId, secondaryReferenceId: config.secondaryReferenceId,
    voiceMode: config.voiceMode, deliveryIntensity: config.deliveryIntensity, qualityGuard: true,
    providerQualityGuard: config.providerQualityGuard,
    bleepStrongProfanity: story.narrationSettings.bleepStrongProfanity === true,
    speed: config.speed, format: config.format, sampleRate: config.sampleRate, bitrate: config.bitrate,
    normalize: config.normalize, maxCharsPerRequest: config.maxCharsPerRequest,
  });
  const replacement = result.assembled ? result.audio : result.segments.length === 1 ? result.segments[0]! : result.audio;
  if (!replacement.byteLength) throw new StorageError("Segment regeneration returned empty audio; keeping the previous segment");

  const stagedSegmentPath = `${targetSegmentFile}.staged-${randomUUID()}.mp3`;
  let stagedRawPath: string | undefined;

  try {
    await atomicWrite(stagedSegmentPath, replacement);
    const newFingerprint = await fileFingerprint(stagedSegmentPath);

    if (censorManifest) {
      stagedRawPath = `${paths.audioRaw}.staged-${randomUUID()}.mp3`;
      const censorService = options.censor?.reassemble ? options.censor : new FfmpegCensorAudioService();
      const overrides = new Map<number, string>([[current.index, stagedSegmentPath]]);
      await censorService.reassemble!(paths.segments, censorManifest, stagedRawPath, config, overrides);
      const stagedRawFp = await fileFingerprint(stagedRawPath);
      if (!stagedRawFp) {
        throw new StorageError("Staged censored raw audio reassembly produced empty or missing file");
      }
    }

    const parts = result.quality?.segments;
    // One editable segment may now contain several speech fragments plus tones.
    // Preserve its original joins and verify all fragments, not only the first.
    const verified = result.assembled && parts?.length ? {
      expectedText: current.expectedText,
      expectedSpokenText: parts.map(part => part.expectedText).join(" "),
      transcription: parts.map(part => part.transcription ?? "").join(" ").trim() || undefined,
      status: parts.some(part => part.status === "needs_review") ? "needs_review" as const
        : parts.every(part => part.status === "verified") ? "verified" as const : "unverified" as const,
      score: parts.every(part => part.score !== undefined) ? Math.min(...parts.map(part => part.score!)) : undefined,
      issues: parts.flatMap(part => part.issues),
      attempts: [{ attempt: 1, settings: { deliveryIntensity: config.deliveryIntensity },
        status: parts.some(part => part.status === "needs_review") ? "needs_review" as const
          : parts.every(part => part.status === "verified") ? "pass" as const : "unverified" as const,
        issues: parts.flatMap(part => part.issues), requestId: result.requestIds?.join(",") || undefined }],
      finalAttempt: 1,
    } : parts?.[0];
    const segments = artifact.segments.map((segment) => segment.index === current.index
      ? {
          ...(verified ?? { expectedText: current.expectedText, status: "unverified" as const, issues: [{ type: "transcription_failed" as const, severity: 0.5, detail: "Regenerated segment was not verified" }], attempts: [], finalAttempt: 0 }),
          expectedText: current.expectedText,
          ...(result.assembled ? { expectedSpokenText: result.segmentTexts?.join(" ") ?? planCensoredSpeech(current.expectedText).flatMap(part => part.kind === "speech" ? [part.text] : []).join(" ") } : {}),
          index: current.index,
          audioFingerprint: newFingerprint,
          acceptedAt: undefined,
          acceptedReason: undefined,
          acceptedAudioFingerprint: undefined,
        }
      : segment);
    const updated: TtsQualityArtifact = { ...artifact, segments, status: summarizeQuality(segments).status, updatedAt: new Date().toISOString() };

    let segmentPromoted = false;
    let audioRawPromoted = false;
    let qualityFilePromoted = false;
    let chapterSummaryPromoted = false;
    let downstreamStatePromoted = false;

    try {
      await atomicWrite(targetSegmentFile, replacement);
      segmentPromoted = true;

      if (stagedRawPath) {
        const stagedRawBytes = await readFile(stagedRawPath);
        await atomicWrite(paths.audioRaw, stagedRawBytes);
        audioRawPromoted = true;
      }

      await atomicWriteJson(paths.ttsQuality, updated);
      qualityFilePromoted = true;

      await syncChapterQualitySummary(root, story.slug, chapter, updated);
      chapterSummaryPromoted = true;

      await markStagesPending(root, story.slug, chapter, ["audioMastering", ...dependentProcessingStages("audioMastering")]);
      downstreamStatePromoted = true;

      return updated;
    } catch (promotionError) {
      const rollbackErrors: unknown[] = [];
      if (segmentPromoted) {
        try {
          await atomicWrite(targetSegmentFile, oldSegmentAudio);
        } catch (err) {
          rollbackErrors.push(err);
        }
      }
      if (audioRawPromoted) {
        try {
          if (oldAudioRaw !== undefined) {
            await atomicWrite(paths.audioRaw, oldAudioRaw);
          } else {
            await rm(paths.audioRaw, { force: true });
          }
        } catch (err) {
          rollbackErrors.push(err);
        }
      }
      if (qualityFilePromoted) {
        try {
          await atomicWrite(paths.ttsQuality, oldQualityJson);
        } catch (err) {
          rollbackErrors.push(err);
        }
      }
      if (chapterSummaryPromoted || downstreamStatePromoted) {
        try {
          if (oldChapterMetaJson !== undefined) {
            await atomicWrite(paths.chapterMeta, oldChapterMetaJson);
          }
        } catch (err) {
          rollbackErrors.push(err);
        }
      }

      if (rollbackErrors.length > 0) {
        throw new StorageError(
          `Segment promotion failed and rollback of promoted files failed: ${rollbackErrors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ")}`,
          { cause: new AggregateError([promotionError, ...rollbackErrors]) }
        );
      }
      const failureMessage = !segmentPromoted
        ? `Failed to promote regenerated segment: ${promotionError instanceof Error ? promotionError.message : String(promotionError)}`
        : !audioRawPromoted && stagedRawPath
          ? `Failed to promote censored raw audio; rolled back audio file: ${promotionError instanceof Error ? promotionError.message : String(promotionError)}`
          : !qualityFilePromoted
            ? `Failed to persist quality metadata after regenerating segment; rolled back audio file: ${promotionError instanceof Error ? promotionError.message : String(promotionError)}`
            : !chapterSummaryPromoted
              ? `Failed to sync chapter quality summary after regenerating segment; rolled back audio file: ${promotionError instanceof Error ? promotionError.message : String(promotionError)}`
              : `Failed to mark downstream stages pending after regenerating segment; rolled back audio file: ${promotionError instanceof Error ? promotionError.message : String(promotionError)}`;
      throw new StorageError(failureMessage, { cause: promotionError });
    }
  } finally {
    await rm(stagedSegmentPath, { force: true }).catch(() => {});
    if (stagedRawPath) {
      await rm(stagedRawPath, { force: true }).catch(() => {});
    }
  }
}

/** A deliberate, auditable human acceptance of a segment the guard could not
 * verify. Never reported as objectively passed. */
export async function acceptStoredChapterTtsSegment(options: { root: string; slug: string; chapter: number; segment: number; reason?: string }): Promise<TtsQualityArtifact> {
  const { root, slug, chapter } = options;
  const artifact = await loadChapterTtsQuality(root, slug, chapter);
  if (!artifact) throw new StorageError(`Chapter ${chapter} has no TTS quality artifact`);
  let current = artifact.segments.find((segment) => segment.index === options.segment);
  if (!current) throw new StorageError(`Chapter ${chapter} has no TTS segment ${options.segment + 1}`);
  const file = segmentFile(root, slug, chapter, current.index);
  const diskFingerprint = await fileFingerprint(file);
  if (!diskFingerprint) {
    throw new StorageError("Segment audio is missing; regenerate or rerun TTS before accepting it.");
  }
  const acceptedAudioFingerprint = diskFingerprint;
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
