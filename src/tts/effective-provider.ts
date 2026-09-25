import type { CanonicalEntity } from "../domain/story-bible.js";
import { pronunciationProvider } from "./pronunciation.js";
import type { TTSProvider } from "./provider.js";
import { QualityGuardTTSProvider, type QualityGuardOptions, type SpeechTranscriber, type TtsQualityProgress } from "./quality-guard.js";

export type CreateEffectiveTtsProviderOptions = {
  baseProvider: TTSProvider;
  pronunciationEntities?: readonly CanonicalEntity[];
  /** @deprecated Use explicit qualityMode. */
  qualityGuardEnabled?: boolean;
  qualityMode?: "off" | "verify" | "auto_repair";
  maxQualityRetries?: number;
  language?: string;
  transcriber?: SpeechTranscriber;
  durationProbe?: QualityGuardOptions["durationProbe"];
  thresholds?: QualityGuardOptions["thresholds"];
  toleratedTerms?: QualityGuardOptions["toleratedTerms"];
  onQualityProgress?: (progress: TtsQualityProgress) => void;
};

export type EffectiveTtsProvider = {
  provider: TTSProvider;
  basePronunciationProvider: TTSProvider;
  baseProvider: TTSProvider;
};

/** Unified TTS provider builder.
 * Wrapping order:
 * baseProvider -> pronunciationProvider(baseProvider, entities) -> QualityGuardTTSProvider(pronunciationProvider, transcriber, options)
 */
export function createEffectiveTtsProvider(options: CreateEffectiveTtsProviderOptions): EffectiveTtsProvider {
  const baseProvider = options.baseProvider;
  const basePronunciationProvider = options.pronunciationEntities
    ? pronunciationProvider(baseProvider, options.pronunciationEntities)
    : baseProvider;

  const qualityMode = options.qualityMode ?? "off";
  const provider = qualityMode !== "off"
    ? new QualityGuardTTSProvider(basePronunciationProvider, options.transcriber, {
        maxRetries: qualityMode === "auto_repair" ? options.maxQualityRetries ?? 2 : 0,
        language: options.language ?? "en-US",
        durationProbe: options.durationProbe,
        thresholds: options.thresholds,
        toleratedTerms: options.toleratedTerms,
        onQualityProgress: options.onQualityProgress,
      })
    : basePronunciationProvider;

  return {
    provider,
    basePronunciationProvider,
    baseProvider,
  };
}
