import "dotenv/config";
import { z } from "zod";
import { ConfigurationError } from "../pipeline/errors.js";

const optionalSecret = z.string().trim().min(1).optional().or(z.literal("").transform(() => undefined));
const envSchema = z.object({
  OPENAI_API_KEY: optionalSecret,
  OPENAI_DEFAULT_MODEL: z.string().default("gpt-5.6-terra"),
  GEMINI_API_KEY: optionalSecret,
  GEMINI_DEFAULT_MODEL: z.string().default("gemini-3.8-flash"),
  FISH_AUDIO_API_KEY: optionalSecret,
  FISH_AUDIO_MODEL: z.string().default("s2-pro"),
  FISH_AUDIO_REFERENCE_ID: optionalSecret,
  FISH_AUDIO_SPEED: z.coerce.number().min(0.5).max(2).default(1),
  FISH_AUDIO_SAMPLE_RATE: z.coerce.number().pipe(z.union([z.literal(32000), z.literal(44100)])).default(44100),
  FISH_AUDIO_MP3_BITRATE: z.coerce.number().pipe(z.union([z.literal(64), z.literal(128), z.literal(192)])).default(128),
  FISH_AUDIO_NORMALIZE: z.stringbool().default(true),
  FISH_AUDIO_MAX_CHARS: z.coerce.number().int().min(500).max(20_000).default(4000),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(900_000).default(120_000),
  WEB_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  WEB_REQUEST_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(500),
  WEB_MAX_RESPONSE_BYTES: z.coerce.number().int().min(100_000).max(50_000_000).default(5_000_000),
  WEB_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  WEB_CACHE_DIR: z.string().trim().transform((value) => value || undefined).optional().default(".cache/ai-story-studio/web"),
  WEB_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

export type Environment = z.infer<typeof envSchema>;

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const result = envSchema.safeParse(source);
  if (!result.success) throw new ConfigurationError(`Invalid environment configuration: ${z.prettifyError(result.error)}`);
  return result.data;
}

export function requireProviderKey(env: Environment, provider: "openai" | "gemini" | "fish"): string {
  const key = provider === "openai" ? env.OPENAI_API_KEY : provider === "gemini" ? env.GEMINI_API_KEY : env.FISH_AUDIO_API_KEY;
  if (!key) throw new ConfigurationError(`Missing required ${provider} credential (${provider === "fish" ? "FISH_AUDIO_API_KEY" : `${provider.toUpperCase()}_API_KEY`}). Add it to .env.`);
  return key;
}
