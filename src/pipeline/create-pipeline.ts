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

export function createPipeline(env: Environment): ChapterPipeline {
  return createPipelineRuntime(env).pipeline;
}

export function createPipelineRuntime(env: Environment) {
  const router = new LLMRouter(new Map<string, LLMProvider>([
      ["openai", new OpenAIProvider(env.OPENAI_API_KEY, env.PROVIDER_TIMEOUT_MS)],
      ["gemini", new GeminiProvider(env.GEMINI_API_KEY, env.PROVIDER_TIMEOUT_MS)],
    ]));
  const tts = new FishAudioProvider(env.FISH_AUDIO_API_KEY, fetch, env.PROVIDER_TIMEOUT_MS);
  const audio = new FfmpegMasteringProcessor();
  const images = new ImageProviderRouter(new Map([["openai", new OpenAIImageProvider(env.OPENAI_API_KEY, env.PROVIDER_TIMEOUT_MS)]]));
  return { router, images, tts, audio, pipeline: new ChapterPipeline(router, tts, audio) };
}
