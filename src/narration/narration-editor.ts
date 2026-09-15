import { LLMProvider } from "../llm/provider.js";
import { StageModelConfig } from "../domain/provider.js";
import { narrationInstructions } from "./prompts.js";
import type { NarrationProfanityMode } from "../domain/story.js";
import { softenStrongProfanity } from "./profanity.js";
import { applyNarrationNamingPreferences } from "./naming-preferences.js";
import type { DeliveryIntensity } from "./tts-direction.js";

export async function polishNarration(provider: LLMProvider, config: StageModelConfig, text: string, language: string, context?: unknown, ttsProvider?: string, ttsModel?: string, profanityMode: NarrationProfanityMode = "preserve", deliveryIntensity: DeliveryIntensity = "restrained", includeChapterTitle = true, sourceKind: "chapter" | "summary" = "chapter") {
  const result = await provider.generateText({ model: config.model, instructions: narrationInstructions(language, ttsProvider, ttsModel, profanityMode, deliveryIntensity, includeChapterTitle) + (sourceKind === "summary" ? "\nThis input is a canonical story recap, not a full chapter. Polish only the recap for spoken narration. Preserve its coverage, facts and approximate length; do not expand it into a chapter or introduce facts from context." : ""), input: `RELEVANT CANONICAL STORY CONTEXT:\n${JSON.stringify(context ?? {}, null, 2)}\n\nFAITHFUL ${language.toUpperCase()} ${sourceKind.toUpperCase()}:\n${text}` });
  let narration = softenStrongProfanity(applyNarrationNamingPreferences(result.text, context), profanityMode);
  if (!includeChapterTitle) narration = removeLeadingChapterTitle(narration);
  return { ...result, text: narration };
}

export function removeLeadingChapterTitle(text: string) {
  const normalized = text.replace(/^\uFEFF/, "");
  return normalized.replace(/^\s{0,3}#{1,6}[ \t]+[^\r\n]+(?:\r?\n)+/, "").trimStart();
}
