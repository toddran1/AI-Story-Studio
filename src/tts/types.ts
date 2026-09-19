export type TTSRequest = {
  pronunciation?: import("./pronunciation.js").PronunciationOccurrence[];
  text: string; model: string; referenceId?: string; secondaryReferenceId?: string;
  voiceMode?: "narrator-only" | "same-voice-dialogue" | "narrator-dialogue";
  deliveryIntensity?: "none" | "restrained" | "expressive";
  qualityGuard?: boolean; bleepStrongProfanity?: boolean; speed: number; format: "mp3";
  sampleRate: 32000 | 44100; bitrate: 64 | 128 | 192; normalize: boolean; maxCharsPerRequest: number;
};
export type TTSResult = {
  audio: Uint8Array; segments: Uint8Array[]; requestIds?: string[]; providerRequests?: number;
  /** Exact chunk texts sent to the provider, aligned 1:1 with `segments`. Omitted
   * when an assembly step (e.g. censor tones) makes that mapping impossible. */
  segmentTexts?: string[];
  /** Present when the post-generation quality guard verified this synthesis. */
  quality?: import("./quality-guard.js").TtsQualityReport;
};
