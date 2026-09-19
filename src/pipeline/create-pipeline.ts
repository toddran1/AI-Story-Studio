import { Environment } from "../config/env.js";
import { GeminiProvider } from "../llm/gemini/gemini.provider.js";
import { KimiProvider } from "../llm/kimi/kimi.provider.js";
import { OpenAIProvider } from "../llm/openai/openai.provider.js";
import { LLMRouter } from "../llm/router.js";
import { FishAudioProvider } from "../tts/fish/fish-audio.provider.js";
import { ChapterPipeline } from "./chapter-pipeline.js";
import { LLMProvider } from "../llm/provider.js";
import { FfmpegMasteringProcessor } from "../audio/mastering.js";
import { OpenAIImageProvider } from "../artwork/openai-image.provider.js";
import { GeminiImageProvider } from "../artwork/gemini-image.provider.js";
import { ImageProvider } from "../artwork/provider.js";
import { ImageProviderRouter } from "../artwork/router.js";
import { UsageSink } from "../cost/types.js";
import { TrackedImageProvider, TrackedLLMProvider, TrackedTTSProvider } from "../cost/context.js";
import { TTSProviderRouter } from "../tts/router.js";
import { FfmpegCensorAudioService } from "../tts/censor-audio.js";
import { WhisperCppSpeechTranscriber } from "../alignment/transcription.js";
import { alignmentConfig } from "../alignment/config.js";
import { resolveStudioRoot } from "../config/env.js";

export function createPipeline(env: Environment): ChapterPipeline {
  return createPipelineRuntime(env).pipeline;
}

export function createPipelineRuntime(env: Environment, usage?: UsageSink) {
  const trackLlm = (provider: LLMProvider) => usage ? new TrackedLLMProvider(provider, usage) : provider;
  const router = new LLMRouter(new Map<string, LLMProvider>([
      ["openai", trackLlm(new OpenAIProvider(env.OPENAI_API_KEY, env.PROVIDER_TIMEOUT_MS))],
      ["gemini", trackLlm(new GeminiProvider(env.GEMINI_API_KEY, env.PROVIDER_TIMEOUT_MS))],
      ["kimi", trackLlm(new KimiProvider(env.KIMI_API_KEY, env.PROVIDER_TIMEOUT_MS))],
    ]));
  const rawTts = new FishAudioProvider(env.FISH_AUDIO_API_KEY, fetch, env.PROVIDER_TIMEOUT_MS, env.FISH_AUDIO_REFERENCE_ID);
  const trackedTts = usage ? new TrackedTTSProvider(rawTts, usage) : rawTts;
  const tts = new TTSProviderRouter(new Map([[trackedTts.name, trackedTts]]));
  const audio = new FfmpegMasteringProcessor();
  const censor = new FfmpegCensorAudioService();
  const trackImage = (provider: ImageProvider) => usage ? new TrackedImageProvider(provider, usage) : provider;
  const images = new ImageProviderRouter(new Map<string, ImageProvider>([
    ["openai", trackImage(new OpenAIImageProvider(env.OPENAI_API_KEY, env.PROVIDER_TIMEOUT_MS))],
    ["gemini", trackImage(new GeminiImageProvider(env.GEMINI_API_KEY, env.PROVIDER_TIMEOUT_MS))],
  ]));
  const align = alignmentConfig(env, resolveStudioRoot(env));
  const transcriber = align.engine === "disabled" ? undefined : new WhisperCppSpeechTranscriber(align.executable, align.model, align.timeoutMs, undefined, align.device);
  return { router, images, tts, audio, censor, pipeline: new ChapterPipeline(router, tts, audio, censor, { transcriber }) };
}
