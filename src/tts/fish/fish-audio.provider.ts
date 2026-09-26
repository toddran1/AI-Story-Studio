import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ConfigurationError, ProviderError } from "../../pipeline/errors.js";
import { TTSProvider } from "../provider.js";
import { TTSRequest, safeProgress } from "../types.js";
import { splitForTTS } from "../split-text.js";
import { normalizeFishSpeechText } from "./speech-normalizer.js";
import { castQuotedDialogue, directQuotedDialogue, prepareFishMultiSpeakerChunks } from "./dialogue-casting.js";
import { isFishS2Model } from "./control-cues.js";
import { adaptPronunciationText } from "../pronunciation.js";
import type { VocalizationCapabilities, VocalizationRenderStrategy } from "../vocalizations.js";
import { logger } from "../../utils/logger.js";
import { atomicWrite, atomicWriteJson } from "../../storage/atomic-write.js";
import { readJsonIfExists, readTextIfExists } from "../../storage/story-files.js";
import { fingerprint } from "../../utils/hash.js";
import { findRetryAfterMs, isTransientError } from "../../batch/retry.js";
import { safeProviderDetail } from "../../errors/diagnostic.js";

export const fishChunkCheckpointSchema = z.object({
  version: z.literal(1),
  chunk: z.number().int().positive(),
  totalChunks: z.number().int().positive(),
  text: z.string().optional(),
  textFingerprint: z.string().optional(),
  fingerprint: z.string().min(1),
  createdAt: z.string(),
  requestId: z.string().optional(),
  characters: z.number().int().nonnegative(),
  utf8Bytes: z.number().int().nonnegative(),
});
export type FishChunkCheckpointMeta = z.infer<typeof fishChunkCheckpointSchema>;

export class FishAudioProvider implements TTSProvider {
  readonly name = "fish" as const;
  readonly pronunciationCapabilities = { phoneticText: true } as const;
  // Fish docs (docs.fish.audio TTS): S2 models support natural-language expression
  // control. Tags are limited to the verified FISH_S2_CONTROL_CUES allowlist subset
  // that maps to vocalization types; disambiguateFishS2Brackets strips anything else.
  readonly vocalizationCapabilities: VocalizationCapabilities = { expressiveTags: true, supportedTypes: ["laugh", "chuckle", "throat_clear", "sigh", "gasp"], separateSegments: false };
  // Included in the TTS fingerprint so audio made before normalization or
  // deterministic dialogue casting changes is never silently reused.
  readonly inputNormalizationVersion: string;
  constructor(
    private readonly apiKey?: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 120_000,
    private readonly defaultReferenceId?: string,
    private readonly speechOptions: {
      tskRendering?: "preserve" | "direction";
      retryDelayMs?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.inputNormalizationVersion = speechOptions.tskRendering === "direction"
      ? "fish-speech-normalization-v10-multispeaker-safe-chunks-tsk-direction"
      : "fish-speech-normalization-v10-multispeaker-safe-chunks";
  }

  resolveReferenceId(referenceId?: string): string | undefined {
    return normalizeFishReferenceId(referenceId) ?? normalizeFishReferenceId(this.defaultReferenceId);
  }

  /** Capability fallback: S2 models render the verified cue subset natively; s1 and
   * unknown models fall back to canonical short spoken forms. No guessed tags. */
  vocalizationStrategy(model?: string): VocalizationRenderStrategy {
    if (!isFishS2Model(model)) return { kind: "safe_normalize" };
    return { kind: "native_tags", tags: { laugh: "[laugh]", chuckle: "[laugh]", throat_clear: "[cough]", sigh: "[sigh]", gasp: "[gasp]" } };
  }

  async validateConfiguration(): Promise<void> { if (!this.apiKey) throw new ConfigurationError("Missing required fish credential (FISH_AUDIO_API_KEY). Add it to .env."); }
  async synthesize(request: TTSRequest) {
    await this.validateConfiguration();
    const referenceId = this.resolveReferenceId(request.referenceId);
    const secondaryReferenceId = normalizeFishReferenceId(request.secondaryReferenceId);
    const multiSpeaker = request.voiceMode === "narrator-dialogue" && Boolean(referenceId) && Boolean(secondaryReferenceId) && isFishS2Model(request.model);
    const directedSingleVoice = request.voiceMode === "same-voice-dialogue" && request.deliveryIntensity !== "none" && isFishS2Model(request.model);
    const segments: Uint8Array[] = [];
    const requestIds: string[] = [];
    const reusedRequestIds: string[] = [];
    let reusedChunks = 0;
    const chunks = request.exactChunk
      ? [request.text]
      : (() => {
          const speechText = normalizeFishSpeechText(adaptPronunciationText(request.text, request.pronunciation ?? [], this.pronunciationCapabilities), request.model, this.speechOptions);
          if (!speechText) throw new ProviderError("Fish Audio narration is empty after speech normalization");
          const castText = multiSpeaker ? castQuotedDialogue(speechText) : directedSingleVoice ? directQuotedDialogue(speechText) : speechText;
          const prepared = multiSpeaker
            ? prepareFishMultiSpeakerChunks(castText, request.maxCharsPerRequest)
            : splitForTTS(castText, request.maxCharsPerRequest);
          if (prepared.some((chunk) => chunk.length > request.maxCharsPerRequest)) throw new ProviderError("Fish Audio chunk exceeds the configured character limit after speaker formatting");
          return prepared;
        })();

    let newBilledRequests = 0;
    let newBilledCharacters = 0;
    let newBilledBytes = 0;
    let newAudioBytes = 0;
    if (request.checkpointDir) {
      await mkdir(request.checkpointDir, { recursive: true });
    }

    const sleep = this.speechOptions.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

    for (const [index, text] of chunks.entries()) {
      const currentChunk = index + 1;
      const totalChunks = chunks.length;
      const chunkStem = String(currentChunk).padStart(4, "0");
      const metaPath = request.checkpointDir ? join(request.checkpointDir, `${chunkStem}.json`) : undefined;
      const audioPath = request.checkpointDir ? join(request.checkpointDir, `${chunkStem}.mp3`) : undefined;
      const chunkFp = fingerprint({
        text,
        model: request.model,
        referenceId,
        secondaryReferenceId,
        voiceMode: request.voiceMode,
        deliveryIntensity: request.deliveryIntensity,
        providerQualityGuard: request.providerQualityGuard,
        speed: request.speed,
        format: request.format,
        sampleRate: request.sampleRate,
        bitrate: request.bitrate,
        normalize: request.normalize,
        inputNormalizationVersion: this.inputNormalizationVersion,
      });

      if (metaPath && audioPath) {
        let existingMeta: FishChunkCheckpointMeta | undefined;
        let isCorrupt = false;
        try {
          const rawText = await readTextIfExists(metaPath);
          if (rawText) {
            const parsedJson = JSON.parse(rawText);
            const validated = fishChunkCheckpointSchema.safeParse(parsedJson);
            if (
              !validated.success ||
              validated.data.chunk !== currentChunk ||
              validated.data.totalChunks !== totalChunks
            ) {
              isCorrupt = true;
            } else {
              existingMeta = validated.data;
            }
          }
        } catch {
          isCorrupt = true;
        }

        if (isCorrupt) {
          logger.warn({
            event: "tts.fish.checkpoint_corrupt",
            chunk: currentChunk,
            totalChunks,
            metaPath,
          });
          await rm(metaPath, { force: true }).catch(() => {});
          await rm(audioPath, { force: true }).catch(() => {});
        } else if (existingMeta && existingMeta.fingerprint === chunkFp) {
          try {
            const existingAudio = await readFile(audioPath);
            if (existingAudio.byteLength > 0) {
              logger.info({ event: "tts.fish.chunk_reused", chunk: currentChunk, totalChunks });
              safeProgress(request.onChunkProgress, { currentChunk, totalChunks, status: "reused" });
              segments.push(existingAudio);
              reusedChunks++;
              if (existingMeta.requestId) reusedRequestIds.push(existingMeta.requestId);
              continue;
            }
          } catch {
            // Missing or unreadable audio, regenerate below
          }
        } else if (existingMeta) {
          logger.info({ event: "tts.fish.checkpoint_invalidated", chunk: currentChunk, totalChunks, reason: "fingerprint_mismatch" });
          await rm(metaPath, { force: true }).catch(() => {});
          await rm(audioPath, { force: true }).catch(() => {});
        }
      }

      safeProgress(request.onChunkProgress, { currentChunk, totalChunks, status: "started" });
      logger.debug({ event: "tts.fish.segment_input", segment: currentChunk, characters: text.length });

      for (let attempt = 1; attempt <= 3; attempt++) {
        let response: Response | undefined;
        let fetchError: unknown;
        try {
          response = await this.fetcher("https://api.fish.audio/v1/tts", {
            method: "POST",
            signal: AbortSignal.timeout(this.timeoutMs),
            headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", model: request.model },
            body: JSON.stringify({
              text,
              reference_id: multiSpeaker ? [referenceId!, secondaryReferenceId!] : referenceId,
              format: request.format,
              sample_rate: request.sampleRate,
              mp3_bitrate: request.bitrate,
              normalize: request.normalize,
              prosody: { speed: request.speed, volume: 0, normalize_loudness: true },
              ...(request.providerQualityGuard === false ? {} : { features: ["quality-guard"] }),
              ...fishS2Defaults(request.model, request.deliveryIntensity),
            }),
          });
        } catch (error) {
          fetchError = error;
        }

        if (fetchError !== undefined) {
          const isTransient = isTransientError(fetchError);
          if (isTransient && attempt < 3) {
            const retryAfterMs = findRetryAfterMs(fetchError);
            const delay = this.speechOptions.retryDelayMs !== undefined
              ? this.speechOptions.retryDelayMs
              : retryAfterMs !== undefined
                ? Math.min(15 * 60_000, Math.max(0, retryAfterMs))
                : Math.min(10_000, 500 * (2 ** (attempt - 1)));
            logger.warn({
              event: "tts.fish.transient_retry",
              chunk: currentChunk,
              totalChunks,
              attempt,
              model: request.model,
              error: fetchError instanceof Error ? fetchError.message : String(fetchError),
              retryAfterMs,
              delayMs: delay,
            });
            await sleep(delay);
            continue;
          }
          throw this.chunkFailure({
            message: "Network request failed",
            currentChunk,
            totalChunks,
            text,
            model: request.model,
            errorCategory: "transient",
            causeError: fetchError,
            newBilledRequests,
            newBilledCharacters,
            newBilledBytes,
            requestIds,
            newAudioBytes,
            onChunkProgress: request.onChunkProgress,
          });
        }

        const resp = response!;
        const requestId = resp.headers.get("x-request-id") ?? resp.headers.get("trace-id") ?? undefined;
        if (!resp.ok) {
          const rawDetail = (await resp.text()).slice(0, 1000);
          const status = resp.status;
          const isTransient = isTransientError({ status, headers: resp.headers, message: rawDetail });
          if (isTransient && attempt < 3) {
            const retryAfterMs = findRetryAfterMs({ headers: resp.headers, message: rawDetail });
            const delay = this.speechOptions.retryDelayMs !== undefined
              ? this.speechOptions.retryDelayMs
              : retryAfterMs !== undefined
                ? Math.min(15 * 60_000, Math.max(0, retryAfterMs))
                : Math.min(10_000, 1000 * (2 ** (attempt - 1)));
            logger.warn({
              event: "tts.fish.transient_retry",
              chunk: currentChunk,
              totalChunks,
              attempt,
              model: request.model,
              status,
              requestId,
              retryAfterMs,
              delayMs: delay,
            });
            await sleep(delay);
            continue;
          }
          const errorCategory = status === 429 ? "rate_limit" : status >= 500 ? "transient" : "provider";
          const userFacingSummary = status === 429 ? "HTTP 429 rate limit" : `HTTP ${status}`;
          const sanitizedDetail = safeProviderDetail(rawDetail, 300);
          throw this.chunkFailure({
            message: userFacingSummary,
            currentChunk,
            totalChunks,
            text,
            model: request.model,
            status,
            headers: resp.headers,
            requestId,
            errorCategory,
            providerDetail: sanitizedDetail,
            causeError: new Error(userFacingSummary),
            newBilledRequests,
            newBilledCharacters,
            newBilledBytes,
            requestIds,
            newAudioBytes,
            onChunkProgress: request.onChunkProgress,
          });
        }

        const contentType = resp.headers.get("content-type")?.toLowerCase();
        if (contentType && !contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
          throw this.chunkFailure({
            message: `Fish Audio returned unexpected content type: ${contentType}`,
            currentChunk,
            totalChunks,
            text,
            model: request.model,
            status: resp.status,
            headers: resp.headers,
            requestId,
            errorCategory: "provider",
            providerDetail: safeProviderDetail(`Fish Audio returned unexpected content type: ${contentType}`, 300),
            causeError: new Error(`Fish Audio returned unexpected content type: ${contentType}`),
            newBilledRequests,
            newBilledCharacters,
            newBilledBytes,
            requestIds,
            newAudioBytes,
            onChunkProgress: request.onChunkProgress,
          });
        }
        const audio = new Uint8Array(await resp.arrayBuffer());
        if (!audio.length) {
          throw this.chunkFailure({
            message: "Fish Audio returned an empty audio response",
            currentChunk,
            totalChunks,
            text,
            model: request.model,
            status: resp.status,
            headers: resp.headers,
            requestId,
            errorCategory: "provider",
            providerDetail: "Fish Audio returned an empty audio response",
            causeError: new Error("Fish Audio returned an empty audio response"),
            newBilledRequests,
            newBilledCharacters,
            newBilledBytes,
            requestIds,
            newAudioBytes,
            onChunkProgress: request.onChunkProgress,
          });
        }

        if (requestId) requestIds.push(requestId);
        if (metaPath && audioPath) {
          await atomicWrite(audioPath, audio);
          await atomicWriteJson(metaPath, {
            version: 1,
            chunk: currentChunk,
            totalChunks,
            textFingerprint: fingerprint(text),
            fingerprint: chunkFp,
            createdAt: new Date().toISOString(),
            requestId,
            characters: [...text].length,
            utf8Bytes: Buffer.byteLength(text),
          });
        }
        segments.push(audio);
        newBilledRequests++;
        newBilledCharacters += [...text].length;
        newBilledBytes += Buffer.byteLength(text);
        newAudioBytes += audio.byteLength;
        safeProgress(request.onChunkProgress, { currentChunk, totalChunks, status: "completed" });
        break;
      }
    }
    const length = segments.reduce((sum, segment) => sum + segment.length, 0);
    const audio = new Uint8Array(length); let offset = 0;
    for (const segment of segments) { audio.set(segment, offset); offset += segment.length; }
    return {
      audio,
      segments,
      requestIds: requestIds.length ? requestIds : undefined,
      reusedRequestIds: reusedRequestIds.length ? reusedRequestIds : undefined,
      providerRequests: newBilledRequests,
      reusedChunks: reusedChunks > 0 ? reusedChunks : undefined,
      generatedCharacters: newBilledCharacters,
      generatedUtf8Bytes: newBilledBytes,
      segmentTexts: chunks,
    };
  }

  private chunkFailure(options: {
    message: string;
    currentChunk: number;
    totalChunks: number;
    text: string;
    model: string;
    errorCategory: "transient" | "rate_limit" | "provider";
    causeError?: unknown;
    status?: number;
    headers?: Headers;
    requestId?: string;
    providerDetail?: string;
    newBilledRequests: number;
    newBilledCharacters: number;
    newBilledBytes: number;
    requestIds: string[];
    newAudioBytes: number;
    onChunkProgress?: TTSRequest["onChunkProgress"];
  }): ProviderError {
    safeProgress(options.onChunkProgress, {
      currentChunk: options.currentChunk,
      totalChunks: options.totalChunks,
      status: "failed",
      errorCategory: options.errorCategory,
    });
    logger.warn({
      event: "tts.fish.chunk_failure",
      chunk: options.currentChunk,
      totalChunks: options.totalChunks,
      model: options.model,
      status: options.status,
      requestId: options.requestId,
      errorCategory: options.errorCategory,
      error: options.providerDetail || (options.causeError instanceof Error ? options.causeError.message : String(options.causeError ?? options.message)),
    });
    const cause = Object.assign(
      options.causeError instanceof Error
        ? options.causeError
        : new Error(options.message),
      {
        status: options.status,
        headers: options.headers,
        requestId: options.requestId,
        chunk: options.currentChunk,
        totalChunks: options.totalChunks,
        chars: [...options.text].length,
        model: options.model,
        errorCategory: options.errorCategory,
        providerDetail: options.providerDetail,
      },
    );
    const err = new ProviderError(
      `Fish ${options.model} failed for chunk ${options.currentChunk} of ${options.totalChunks} (${[...options.text].length} chars): ${options.message}`,
      { cause },
    );
    Object.assign(err, {
      partialUsage: {
        successfulRequests: {
          providerRequests: options.newBilledRequests,
          generatedCharacters: options.newBilledCharacters,
          generatedUtf8Bytes: options.newBilledBytes,
          requestIds: [...options.requestIds],
          outputBytes: options.newAudioBytes,
        },
        failedRequest: {
          inputCharacters: [...options.text].length,
          inputUtf8Bytes: Buffer.byteLength(options.text),
          requestId: options.requestId,
          errorCategory: options.errorCategory,
        },
      },
    });
    return err;
  }
}

export { normalizeFishSpeechText, stripFishMarkdownEmphasis } from "./speech-normalizer.js";

/** Accept either the API model ID or a public fish.audio model URL. */
export function normalizeFishReferenceId(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.hostname === "fish.audio" || url.hostname.endsWith(".fish.audio")) {
      return /^\/app\/m\/([a-f0-9]{32})\/?$/i.exec(url.pathname)?.[1]?.toLowerCase() ?? trimmed;
    }
  } catch { /* A plain model ID is the normal API form. */ }
  return trimmed;
}

/** Documented S2/S2.1 production defaults. Other/unknown models retain the portable request shape. */
function fishS2Defaults(model: string, intensity: TTSRequest["deliveryIntensity"] = "restrained") {
  if (!new Set(["s2-pro", "s2.1-pro", "s2.1-pro-free"]).has(model.trim().toLowerCase())) return {};
  const sampling = intensity === "expressive" ? { temperature: 0.7, top_p: 0.7 }
    : intensity === "none" ? { temperature: 0.4, top_p: 0.5 }
    : { temperature: 0.5, top_p: 0.55 };
  return { ...sampling, chunk_length: 300, latency: "normal", max_new_tokens: 1024,
    repetition_penalty: 1.2, min_chunk_length: 50, condition_on_previous_chunks: true, early_stop_threshold: 1 };
}
