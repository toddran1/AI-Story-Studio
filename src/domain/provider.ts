import { z } from "zod";

export const llmProviderNameSchema = z.enum(["openai", "gemini", "kimi"]);
export const ttsProviderNameSchema = z.enum(["fish"]);

export type LLMProviderName = z.infer<typeof llmProviderNameSchema>;
export type TTSProviderName = z.infer<typeof ttsProviderNameSchema>;

export type ProviderCapability =
  | "text_generation"
  | "structured_output"
  | "image_generation"
  | "tts"
  | "vision";

export const PROVIDER_CAPABILITIES: Record<string, ReadonlySet<ProviderCapability>> = {
  openai: new Set(["text_generation", "structured_output", "image_generation", "vision"]),
  gemini: new Set(["text_generation", "structured_output", "image_generation", "vision"]),
  kimi: new Set(["text_generation", "structured_output"]),
  fish: new Set(["tts"]),
};

export function providerHasCapability(provider: string, capability: ProviderCapability): boolean {
  return PROVIDER_CAPABILITIES[provider]?.has(capability) ?? false;
}

export const stageModelConfigSchema = z.object({
  provider: llmProviderNameSchema,
  model: z.string().min(1),
});

export const fishTtsStageConfigSchema = z.object({
  provider: ttsProviderNameSchema,
  model: z.string().min(1),
  referenceId: z.string().min(1).optional(),
  voiceMode: z.enum(["narrator-only", "same-voice-dialogue", "narrator-dialogue"]).default("same-voice-dialogue"),
  secondaryReferenceId: z.string().min(1).optional(),
  deliveryIntensity: z.enum(["none", "restrained", "expressive"]).default("restrained"),
  /**
   * Deprecated legacy field retained for backward-compatible parsing.
   * It no longer enables post-generation verification by itself.
   * Explicit qualityMode controls Off / Verify / Auto Repair behavior.
   */
  qualityGuard: z.boolean().default(false),
  qualityMode: z.enum(["off", "verify", "auto_repair"]).optional(),
  /** Upstream provider-native quality feature (e.g. Fish features: ["quality-guard"]).
   * Affects what is sent to the provider, so it is part of the synthesis fingerprint. */
  providerQualityGuard: z.boolean().default(true),
  /** Extra attempts only in explicit auto_repair or manual segment regeneration;
   * never part of the initial synthesis fingerprint. */
  maxQualityRetries: z.number().int().min(0).max(5).default(2),
  speed: z.number().min(0.5).max(2).default(1),
  format: z.literal("mp3").default("mp3"),
  sampleRate: z.union([z.literal(32000), z.literal(44100)]).default(44100),
  bitrate: z.union([z.literal(64), z.literal(128), z.literal(192)]).default(128),
  normalize: z.boolean().default(true),
  maxCharsPerRequest: z.number().int().min(500).max(20_000).default(1750),
});

// Provider-specific discriminated variants belong here. Adding a provider does
// not require teaching the pipeline about that provider's private settings.
export const ttsStageConfigSchema = z.discriminatedUnion("provider", [fishTtsStageConfigSchema]);

export type StageModelConfig = z.infer<typeof stageModelConfigSchema>;
export type TTSStageConfig = z.infer<typeof ttsStageConfigSchema>;

/** Legacy stories without explicit qualityMode default to "off". Explicit qualityMode is authoritative. */
export function ttsQualityMode(config: TTSStageConfig): "off" | "verify" | "auto_repair" {
  return config.qualityMode ?? "off";
}

/** Settings that change the initial synthesis. Verification policy fields
 * (qualityGuard, qualityMode, maxQualityRetries) are excluded so they never affect the
 * synthesis fingerprint or tts-stage staleness. */
export function ttsSynthesisSettings(config: TTSStageConfig) {
  const { qualityGuard: _qualityGuard, qualityMode: _qualityMode, maxQualityRetries: _maxQualityRetries, ...synthesis } = config;
  return synthesis;
}
