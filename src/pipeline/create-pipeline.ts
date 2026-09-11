import { Environment } from "../config/env.js";
import { GeminiProvider } from "../llm/gemini/gemini.provider.js";
import { OpenAIProvider } from "../llm/openai/openai.provider.js";
import { LLMRouter } from "../llm/router.js";
import { FishAudioProvider } from "../tts/fish/fish-audio.provider.js";
import { ChapterPipeline } from "./chapter-pipeline.js";
import { LLMProvider } from "../llm/provider.js";
import { FfmpegMasteringProcessor } from "../audio/mastering.js";
import { OpenAIImageProvider } from "../artwork/openai-image.provider.js";
import { ImageProviderRouter } from "../artwork/router.js";
import { UsageSink } from "../cost/types.js";
import { TrackedImageProvider, TrackedLLMProvider, TrackedTTSProvider } from "../cost/context.js";

export function createPipeline(env: Environment): ChapterPipeline {
  return createPipelineRuntime(env).pipeline;
}

export function createPipelineRuntime(env: Environment, usage?: UsageSink) {
  const trackLlm = (provider: LLMProvider) => usage ? new TrackedLLMProvider(provider, usage) : provider;
  const router = new LLMRouter(new Map<string, LLMProvider>([
      ["openai", trackLlm(new OpenAIProvider(env.OPENAI_API_KEY, env.PROVIDER_TIMEOUT_MS))],
      ["gemini", trackLlm(new GeminiProvider(env.GEMINI_API_KEY, env.PROVIDER_TIMEOUT_MS))],
    ]));
  const rawTts = new FishAudioProvider(env.FISH_AUDIO_API_KEY, fetch, env.PROVIDER_TIMEOUT_MS, env.FISH_AUDIO_REFERENCE_ID);
  const tts = usage ? new TrackedTTSProvider(rawTts, usage) : rawTts;
  const audio = new FfmpegMasteringProcessor();
  const rawImage = new OpenAIImageProvider(env.OPENAI_API_KEY, env.PROVIDER_TIMEOUT_MS);
  const images = new ImageProviderRouter(new Map([["openai", usage ? new TrackedImageProvider(rawImage, usage) : rawImage]]));
  return { router, images, tts, audio, pipeline: new ChapterPipeline(router, tts, audio) };
}
