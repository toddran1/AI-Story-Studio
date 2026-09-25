import { ConfigurationError, ProviderError } from "../../pipeline/errors.js";
import { TTSProvider } from "../provider.js";
import { TTSRequest } from "../types.js";
import { splitForTTS } from "../split-text.js";
import { normalizeFishSpeechText } from "./speech-normalizer.js";
import { castQuotedDialogue, directQuotedDialogue, ensureChunkSpeakers } from "./dialogue-casting.js";
import { castQuotedDialogue, directQuotedDialogue, ensureChunkSpeakers, prepareFishMultiSpeakerChunks } from "./dialogue-casting.js";
import { isFishS2Model } from "./control-cues.js";
import { adaptPronunciationText } from "../pronunciation.js";
import type { VocalizationCapabilities, VocalizationRenderStrategy } from "../vocalizations.js";
import { logger } from "../../utils/logger.js";

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
    private readonly speechOptions: { tskRendering?: "preserve" | "direction" } = {},
  ) { this.inputNormalizationVersion = speechOptions.tskRendering === "direction" ? "fish-speech-normalization-v9-large-chunks-tsk-direction" : "fish-speech-normalization-v9-large-chunks"; }

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
          const splitText = splitForTTS(castText, request.maxCharsPerRequest - (multiSpeaker ? 13 : 0));
          const prepared = multiSpeaker ? ensureChunkSpeakers(splitText) : splitText;
          const prepared = multiSpeaker
            ? prepareFishMultiSpeakerChunks(castText, request.maxCharsPerRequest)
            : splitForTTS(castText, request.maxCharsPerRequest);
          if (prepared.some((chunk) => chunk.length > request.maxCharsPerRequest)) throw new ProviderError("Fish Audio chunk exceeds the configured character limit after speaker formatting");
          return prepared;
        })();
    for (const [index, text] of chunks.entries()) {
      request.onChunkProgress?.({ currentChunk: index + 1, totalChunks: chunks.length, status: "started" });
      logger.debug({ event: "tts.fish.segment_input", segment: index + 1, originalText: request.text, fishSafeText: text, characters: text.length });
      let response: Response;
      try {
        response = await this.fetcher("https://api.fish.audio/v1/tts", {
          method: "POST",
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", model: request.model },
          body: JSON.stringify({ text, reference_id: multiSpeaker ? [referenceId!, secondaryReferenceId!] : referenceId, format: request.format, sample_rate: request.sampleRate,
            mp3_bitrate: request.bitrate, normalize: request.normalize, prosody: { speed: request.speed, volume: 0, normalize_loudness: true },
            // Upstream Fish Audio API feature "quality-guard" enables Fish's server-side
            // output quality checking when providerQualityGuard is enabled. This is separate
            // from AI Story Studio's post-generation speech transcriber verification guard (qualityGuard).
            ...(request.providerQualityGuard === false ? {} : { features: ["quality-guard"] }),
            ...fishS2Defaults(request.model, request.deliveryIntensity) }),
        });
      } catch (error) { throw new ProviderError("Fish Audio network request failed", { cause: error }); }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 1000); const cause = Object.assign(new Error(detail), { status: response.status, headers: response.headers });
        throw new ProviderError(`Fish Audio TTS failed (${response.status}): ${detail}`, { cause });
      }
      const requestId = response.headers.get("x-request-id") ?? response.headers.get("trace-id");
      if (requestId) requestIds.push(requestId);
      const contentType = response.headers.get("content-type")?.toLowerCase();
      if (contentType && !contentType.startsWith("audio/") && contentType !== "application/octet-stream") throw new ProviderError(`Fish Audio returned unexpected content type: ${contentType}`);
      const audio = new Uint8Array(await response.arrayBuffer());
      if (!audio.length) throw new ProviderError("Fish Audio returned an empty audio response");
      segments.push(audio);
      request.onChunkProgress?.({ currentChunk: index + 1, totalChunks: chunks.length, status: "completed" });
    }
    const length = segments.reduce((sum, segment) => sum + segment.length, 0);
    const audio = new Uint8Array(length); let offset = 0;
    for (const segment of segments) { audio.set(segment, offset); offset += segment.length; }
    return { audio, segments, requestIds, providerRequests: segments.length, generatedCharacters: chunks.reduce((sum, chunk) => sum + [...chunk].length, 0), generatedUtf8Bytes: chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0), segmentTexts: chunks };
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
