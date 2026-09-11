import { LLMProvider } from "../llm/provider.js";
import { StageModelConfig } from "../domain/provider.js";
import { narrationInstructions } from "./prompts.js";

export async function polishNarration(provider: LLMProvider, config: StageModelConfig, text: string, language: string, context?: unknown, ttsProvider?: string, ttsModel?: string) {
  return provider.generateText({ model: config.model, instructions: narrationInstructions(language, ttsProvider, ttsModel), input: `RELEVANT CANONICAL STORY CONTEXT:\n${JSON.stringify(context ?? {}, null, 2)}\n\nFAITHFUL ${language.toUpperCase()} CHAPTER:\n${text}` });
}
