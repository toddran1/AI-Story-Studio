import { LLMProvider } from "../llm/provider.js";
import { StageModelConfig } from "../domain/provider.js";
import { narrationInstructions } from "./prompts.js";
import type { NarrationProfanityMode } from "../domain/story.js";
import { softenStrongProfanity } from "./profanity.js";
import { applyNarrationNamingPreferences } from "./naming-preferences.js";
import type { DeliveryIntensity } from "./tts-direction.js";

export async function polishNarration(provider: LLMProvider, config: StageModelConfig, text: string, language: string, context?: unknown, ttsProvider?: string, ttsModel?: string, profanityMode: NarrationProfanityMode = "preserve", deliveryIntensity: DeliveryIntensity = "restrained") {
  const result = await provider.generateText({ model: config.model, instructions: narrationInstructions(language, ttsProvider, ttsModel, profanityMode, deliveryIntensity), input: `RELEVANT CANONICAL STORY CONTEXT:\n${JSON.stringify(context ?? {}, null, 2)}\n\nFAITHFUL ${language.toUpperCase()} CHAPTER:\n${text}` });
  return { ...result, text: softenStrongProfanity(applyNarrationNamingPreferences(result.text, context), profanityMode) };
}
