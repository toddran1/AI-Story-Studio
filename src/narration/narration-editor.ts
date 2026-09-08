import { LLMProvider } from "../llm/provider.js";
import { StageModelConfig } from "../domain/provider.js";
import { narrationInstructions } from "./prompts.js";

export async function polishNarration(provider: LLMProvider, config: StageModelConfig, english: string) {
  return provider.generateText({ model: config.model, instructions: narrationInstructions, input: `FAITHFUL ENGLISH TRANSLATION:\n${english}` });
}
