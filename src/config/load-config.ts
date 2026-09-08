import { readFile } from "node:fs/promises";
import { Environment } from "./env.js";
import { Story, storySchema } from "../domain/story.js";
import { ConfigurationError } from "../pipeline/errors.js";

export function defaultStory(slug: string, env: Environment): Story {
  const title = slug.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
  return storySchema.parse({
    id: slug, slug, title, sourceLanguage: "zh-CN", outputLanguage: "en-US",
    source: { type: "text" },
    pipeline: {
      translation: { provider: "gemini", model: env.GEMINI_DEFAULT_MODEL },
      narration: { provider: "openai", model: env.OPENAI_DEFAULT_MODEL },
      storyBible: { provider: "gemini", model: env.GEMINI_DEFAULT_MODEL },
      tts: {
        provider: "fish", model: env.FISH_AUDIO_MODEL, referenceId: env.FISH_AUDIO_REFERENCE_ID,
        speed: env.FISH_AUDIO_SPEED, format: "mp3", sampleRate: env.FISH_AUDIO_SAMPLE_RATE,
        bitrate: env.FISH_AUDIO_MP3_BITRATE, normalize: env.FISH_AUDIO_NORMALIZE,
        maxCharsPerRequest: env.FISH_AUDIO_MAX_CHARS,
      },
    },
  });
}

export async function loadStory(path: string): Promise<Story> {
  try { return storySchema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { throw new ConfigurationError(`Unable to load story configuration at ${path}`, { cause: error }); }
}
