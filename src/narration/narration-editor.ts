import { LLMProvider } from "../llm/provider.js";
import { StageModelConfig } from "../domain/provider.js";
import { narrationInstructions } from "./prompts.js";

export async function polishNarration(provider: LLMProvider, config: StageModelConfig, text: string, language: string) {
  return provider.generateText({ model: config.model, instructions: narrationInstructions(language), input: `FAITHFUL ${language.toUpperCase()} CHAPTER:\n${text}` });
}
