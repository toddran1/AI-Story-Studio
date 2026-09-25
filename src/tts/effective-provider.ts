import type { CanonicalEntity } from "../domain/story-bible.js";
import { pronunciationProvider } from "./pronunciation.js";
import type { TTSProvider } from "./provider.js";
import { QualityGuardTTSProvider, type QualityGuardOptions, type SpeechTranscriber } from "./quality-guard.js";

export type CreateEffectiveTtsProviderOptions = {
  baseProvider: TTSProvider;
  pronunciationEntities?: readonly CanonicalEntity[];
  qualityGuardEnabled?: boolean;
  maxQualityRetries?: number;
  language?: string;
  transcriber?: SpeechTranscriber;
  durationProbe?: QualityGuardOptions["durationProbe"];
  thresholds?: QualityGuardOptions["thresholds"];
  toleratedTerms?: QualityGuardOptions["toleratedTerms"];
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

  const qualityGuardEnabled = options.qualityGuardEnabled !== false;
  const provider = qualityGuardEnabled
    ? new QualityGuardTTSProvider(basePronunciationProvider, options.transcriber, {
        maxRetries: options.maxQualityRetries ?? 2,
        language: options.language ?? "en-US",
        durationProbe: options.durationProbe,
        thresholds: options.thresholds,
        toleratedTerms: options.toleratedTerms,
      })
    : basePronunciationProvider;

  return {
    provider,
    basePronunciationProvider,
    baseProvider,
  };
}

