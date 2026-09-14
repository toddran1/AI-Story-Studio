import { LLMProvider } from "../llm/provider.js";
import { StageModelConfig } from "../domain/provider.js";
import { narrationInstructions } from "./prompts.js";
import type { NarrationProfanityMode } from "../domain/story.js";
import { softenStrongProfanity } from "./profanity.js";
import { applyNarrationNamingPreferences } from "./naming-preferences.js";
import type { DeliveryIntensity } from "./tts-direction.js";

export async function polishNarration(provider: LLMProvider, config: StageModelConfig, text: string, language: string, context?: unknown, ttsProvider?: string, ttsModel?: string, profanityMode: NarrationProfanityMode = "preserve", deliveryIntensity: DeliveryIntensity = "restrained", includeChapterTitle = true) {
  const result = await provider.generateText({ model: config.model, instructions: narrationInstructions(language, ttsProvider, ttsModel, profanityMode, deliveryIntensity, includeChapterTitle), input: `RELEVANT CANONICAL STORY CONTEXT:\n${JSON.stringify(context ?? {}, null, 2)}\n\nFAITHFUL ${language.toUpperCase()} CHAPTER:\n${text}` });
  let narration = softenStrongProfanity(applyNarrationNamingPreferences(result.text, context), profanityMode);
  if (!includeChapterTitle) narration = removeLeadingChapterTitle(narration);
  return { ...result, text: narration };
}

export function removeLeadingChapterTitle(text: string) {
  const normalized = text.replace(/^\uFEFF/, "");
  return normalized.replace(/^\s{0,3}#{1,6}[ \t]+[^\r\n]+(?:\r?\n)+/, "").trimStart();
}
