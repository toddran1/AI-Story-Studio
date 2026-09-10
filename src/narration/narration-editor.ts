import { LLMProvider } from "../llm/provider.js";
import { StageModelConfig } from "../domain/provider.js";
import { narrationInstructions } from "./prompts.js";

export async function polishNarration(provider: LLMProvider, config: StageModelConfig, text: string, language: string, context?: unknown) {
  return provider.generateText({ model: config.model, instructions: narrationInstructions(language), input: `RELEVANT CANONICAL STORY CONTEXT:\n${JSON.stringify(context ?? {}, null, 2)}\n\nFAITHFUL ${language.toUpperCase()} CHAPTER:\n${text}` });
}
