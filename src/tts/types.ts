import { logger } from "../utils/logger.js";

export type TtsChunkProgressStatus = "started" | "completed" | "reused" | "failed";

export type TtsChunkProgress = {
  currentChunk: number;
  totalChunks: number;
  status: TtsChunkProgressStatus;
  errorCategory?: string;
};

export type TtsQualityProgress = {
  currentChunk: number;
  totalChunks: number;
  status: "started" | "completed";
  attempt?: number;
  phase: "verify" | "retry";
};

export function safeProgress<T>(callback: ((progress: T) => void) | undefined, event: T): void {
  if (!callback) return;
  try {
    callback(event);
  } catch (error) {
    logger.warn({ event: "tts.progress_callback_error", error: error instanceof Error ? error.message : String(error) });
  }
}

export type TTSRequest = {
  pronunciation?: import("./pronunciation.js").PronunciationOccurrence[];
  text: string; model: string; referenceId?: string; secondaryReferenceId?: string;
  voiceMode?: "narrator-only" | "same-voice-dialogue" | "narrator-dialogue";
  deliveryIntensity?: "none" | "restrained" | "expressive";
  /** Used by the explicit verification wrapper. Ordinary production omits it. */
  qualityGuard?: boolean;
  /** Enables provider-native quality assistance when supported (e.g. Fish features: ["quality-guard"]). */
  providerQualityGuard?: boolean;
  bleepStrongProfanity?: boolean; speed: number; format: "mp3";
  sampleRate: 32000 | 44100; bitrate: 64 | 128 | 192; normalize: boolean; maxCharsPerRequest: number;
  /** When true, `text` is an exact pre-split chunk (e.g. retry from Quality Guard).
   * Providers must synthesize it without re-splitting, re-casting dialogue, or
   * re-normalizing speech. */
  exactChunk?: boolean;
  /** App-level Fish request progress, including the known logical chunk count. */
  onChunkProgress?: (progress: TtsChunkProgress) => void;
  /** Quality verification and retry progress across chunks. */
  onQualityProgress?: (progress: TtsQualityProgress) => void;
  /** In-progress checkpoint directory for safe resumable chunk generation. */
  checkpointDir?: string;
};
export type TTSResult = {
  audio: Uint8Array; segments: Uint8Array[]; requestIds?: string[]; providerRequests?: number;
  generatedCharacters?: number; generatedUtf8Bytes?: number;
  /** Exact chunk texts sent to the provider, aligned 1:1 with `segments`. Omitted
   * when an assembly step (e.g. censor tones) makes that mapping impossible. */
  segmentTexts?: string[];
  /** Present when the post-generation quality guard verified this synthesis. */
  quality?: import("./quality-guard.js").TtsQualityReport;
};
