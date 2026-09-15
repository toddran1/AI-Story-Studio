export type TTSRequest = {
  text: string; model: string; referenceId?: string; secondaryReferenceId?: string;
  voiceMode?: "narrator-only" | "same-voice-dialogue" | "narrator-dialogue";
  deliveryIntensity?: "none" | "restrained" | "expressive";
  qualityGuard?: boolean; bleepStrongProfanity?: boolean; speed: number; format: "mp3";
  sampleRate: 32000 | 44100; bitrate: 64 | 128 | 192; normalize: boolean; maxCharsPerRequest: number;
};
export type TTSResult = { audio: Uint8Array; segments: Uint8Array[]; requestIds?: string[]; providerRequests?: number };
