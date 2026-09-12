import { LLMProvider } from "../llm/provider.js";
import { StageModelConfig } from "../domain/provider.js";
import { TranslationError } from "../pipeline/errors.js";
import { translationInput, translationInstructions } from "./prompts.js";

export async function translate(provider: LLMProvider, config: StageModelConfig, source: string, context: unknown, sourceLanguage: string, outputLanguage: string) {
  const result = await provider.generateText({ model: config.model, instructions: translationInstructions(sourceLanguage, outputLanguage), input: translationInput(source, context, sourceLanguage) });
  assertUsableTranslation(result.text);
  return result;
}

/**
 * Providers occasionally return a policy refusal followed by a synopsis.  That
 * is not a chapter translation, and allowing it into the next stages wastes
 * narration/QA calls while hiding the real provider response.  Keep this
 * intentionally narrow: ordinary dialogue which happens to contain one of
 * these phrases must not be rejected.
 */
export function assertUsableTranslation(text: string) {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  const refusal = /^(?:i(?:'m| am) unable to provide (?:a )?(?:verbatim |full |complete )?translation|i(?:'m| am) sorry[,;:]? (?:but )?i (?:can(?:not|'t)|am unable to) (?:provide|translate)|i can(?:not|'t) provide (?:a )?(?:verbatim |full |complete )?translation)/.test(normalized);
  const summarySubstitution = /\b(?:can|could) offer (?:a |only )?(?:general )?summary\b|\bwould you like (?:a |me to provide )?(?:general )?summary\b/.test(normalized);
  if (refusal || (normalized.length < 600 && summarySubstitution && /\b(?:unable|cannot|can't|sorry)\b/.test(normalized))) {
    throw new TranslationError("The translation provider refused the chapter and returned a summary instead. Choose a translation model/provider that permits the source material, or paste a manual translation before retrying. No narration or QA work was started.");
  }
}
