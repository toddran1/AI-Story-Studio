import { Environment } from "../config/env.js";
import { GeminiProvider } from "../llm/gemini/gemini.provider.js";
import { OpenAIProvider } from "../llm/openai/openai.provider.js";
import { LLMRouter } from "../llm/router.js";
import { FishAudioProvider } from "../tts/fish/fish-audio.provider.js";
import { ChapterPipeline } from "./chapter-pipeline.js";
import { LLMProvider } from "../llm/provider.js";

export function createPipeline(env: Environment): ChapterPipeline {
  return new ChapterPipeline(
    new LLMRouter(new Map<string, LLMProvider>([
      ["openai", new OpenAIProvider(env.OPENAI_API_KEY)],
      ["gemini", new GeminiProvider(env.GEMINI_API_KEY)],
    ])),
    new FishAudioProvider(env.FISH_AUDIO_API_KEY),
  );
}
