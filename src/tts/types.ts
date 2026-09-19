export type TTSRequest = {
  pronunciation?: import("./pronunciation.js").PronunciationOccurrence[];
  text: string; model: string; referenceId?: string; secondaryReferenceId?: string;
  voiceMode?: "narrator-only" | "same-voice-dialogue" | "narrator-dialogue";
  deliveryIntensity?: "none" | "restrained" | "expressive";
  /** Post-generation quality guard: when true or omitted, speech is transcribed
   * and verified against expected text by AI Story Studio's QualityGuardTTSProvider.
   * Set false to disable post-generation verification. */
  qualityGuard?: boolean;
  /** Enables provider-native quality assistance when supported (e.g. Fish features: ["quality-guard"]). */
  providerQualityGuard?: boolean;
  bleepStrongProfanity?: boolean; speed: number; format: "mp3";
  sampleRate: 32000 | 44100; bitrate: 64 | 128 | 192; normalize: boolean; maxCharsPerRequest: number;
  /** When true, `text` is an exact pre-split chunk (e.g. retry from Quality Guard).
   * Providers must synthesize it without re-splitting, re-casting dialogue, or
   * re-normalizing speech. */
  exactChunk?: boolean;
};
export type TTSResult = {
  audio: Uint8Array; segments: Uint8Array[]; requestIds?: string[]; providerRequests?: number;
  /** Exact chunk texts sent to the provider, aligned 1:1 with `segments`. Omitted
   * when an assembly step (e.g. censor tones) makes that mapping impossible. */
  segmentTexts?: string[];
  /** Present when the post-generation quality guard verified this synthesis. */
  quality?: import("./quality-guard.js").TtsQualityReport;
};
