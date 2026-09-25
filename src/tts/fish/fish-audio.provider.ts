import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
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
import { readJsonIfExists } from "../../storage/story-files.js";
import { fingerprint } from "../../utils/hash.js";
import { isTransientError } from "../../batch/retry.js";

export type FishChunkCheckpointMeta = {
  version: 1;
  chunk: number;
  totalChunks: number;
  text: string;
  fingerprint: string;
  createdAt: string;
  requestId?: string;
  characters: number;
  utf8Bytes: number;
};

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
    private readonly speechOptions: { tskRendering?: "preserve" | "direction"; retryDelayMs?: number } = {},
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
    const segments: Uint8Array[] = []; const requestIds: string[] = [];
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
        const existingMeta = await readJsonIfExists<FishChunkCheckpointMeta>(metaPath);
        if (existingMeta && existingMeta.fingerprint === chunkFp) {
          try {
            const existingAudio = await readFile(audioPath);
            if (existingAudio.byteLength > 0) {
              logger.info({ event: "tts.fish.chunk_reused", chunk: currentChunk, totalChunks });
              safeProgress(request.onChunkProgress, { currentChunk, totalChunks, status: "reused" });
              segments.push(existingAudio);
              if (existingMeta.requestId) requestIds.push(existingMeta.requestId);
              continue;
            }
          } catch {
            // Missing or unreadable audio, regenerate below
          }
        } else if (existingMeta) {
          logger.info({ event: "tts.fish.checkpoint_invalidated", chunk: currentChunk, totalChunks, reason: "fingerprint_mismatch" });
          await rm(metaPath, { force: true });
          await rm(audioPath, { force: true });
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
            logger.warn({ event: "tts.fish.transient_retry", chunk: currentChunk, totalChunks, attempt, model: request.model, error: fetchError instanceof Error ? fetchError.message : String(fetchError) });
            const delay = this.speechOptions.retryDelayMs !== undefined ? this.speechOptions.retryDelayMs : Math.min(10_000, 500 * (2 ** (attempt - 1)));
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          safeProgress(request.onChunkProgress, { currentChunk, totalChunks, status: "failed", errorCategory: "transient" });
          logger.warn({ event: "tts.fish.chunk_failure", chunk: currentChunk, totalChunks, model: request.model, error: fetchError instanceof Error ? fetchError.message : String(fetchError) });
          const cause = Object.assign(new Error(fetchError instanceof Error ? fetchError.message : String(fetchError)), {
            chunk: currentChunk, totalChunks, chars: [...text].length, model: request.model, errorCategory: "transient",
          });
          const err = new ProviderError(`Fish ${request.model} failed for chunk ${currentChunk} of ${totalChunks} (${[...text].length} chars): Network request failed`, { cause });
          Object.assign(err, {
            partialUsage: {
              successfulRequests: {
                providerRequests: newBilledRequests,
                generatedCharacters: newBilledCharacters,
                generatedUtf8Bytes: newBilledBytes,
                requestIds: [...requestIds],
                outputBytes: newAudioBytes,
              },
              failedRequest: {
                inputCharacters: [...text].length,
                inputUtf8Bytes: Buffer.byteLength(text),
                errorCategory: "transient" as const,
              },
            },
          });
          throw err;
        }

        const resp = response!;
        const requestId = resp.headers.get("x-request-id") ?? resp.headers.get("trace-id") ?? undefined;
        if (!resp.ok) {
          const detail = (await resp.text()).slice(0, 1000);
          const status = resp.status;
          const isTransient = isTransientError({ status, message: detail });
          if (isTransient && attempt < 3) {
            logger.warn({ event: "tts.fish.transient_retry", chunk: currentChunk, totalChunks, attempt, model: request.model, status, requestId });
            const delay = this.speechOptions.retryDelayMs !== undefined ? this.speechOptions.retryDelayMs : Math.min(10_000, 1000 * (2 ** (attempt - 1)));
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          const errorCategory = status === 429 ? "rate_limit" : status >= 500 ? "transient" : "provider";
          safeProgress(request.onChunkProgress, { currentChunk, totalChunks, status: "failed", errorCategory });
          logger.warn({ event: "tts.fish.chunk_failure", chunk: currentChunk, totalChunks, model: request.model, status, requestId });
          const cause = Object.assign(new Error(detail), {
            status, headers: resp.headers, requestId, chunk: currentChunk, totalChunks, chars: [...text].length, model: request.model, errorCategory,
          });
          const err = new ProviderError(`Fish ${request.model} failed for chunk ${currentChunk} of ${totalChunks} (${[...text].length} chars): HTTP ${status}${detail ? ` - ${detail}` : ""}`, { cause });
          Object.assign(err, {
            partialUsage: {
              successfulRequests: {
                providerRequests: newBilledRequests,
                generatedCharacters: newBilledCharacters,
                generatedUtf8Bytes: newBilledBytes,
                requestIds: [...requestIds],
                outputBytes: newAudioBytes,
              },
              failedRequest: {
                inputCharacters: [...text].length,
                inputUtf8Bytes: Buffer.byteLength(text),
                requestId,
                errorCategory,
              },
            },
          });
          throw err;
        }

        if (requestId) requestIds.push(requestId);
        const contentType = resp.headers.get("content-type")?.toLowerCase();
        if (contentType && !contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
          throw new ProviderError(`Fish Audio returned unexpected content type: ${contentType}`);
        }
        const audio = new Uint8Array(await resp.arrayBuffer());
        if (!audio.length) {
          throw new ProviderError("Fish Audio returned an empty audio response");
        }
        if (metaPath && audioPath) {
          await atomicWrite(audioPath, audio);
          await atomicWriteJson(metaPath, {
            version: 1,
            chunk: currentChunk,
            totalChunks,
            text,
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
      requestIds,
      providerRequests: newBilledRequests,
      generatedCharacters: newBilledCharacters,
      generatedUtf8Bytes: newBilledBytes,
      segmentTexts: chunks,
    };
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
