import { LLMProvider } from "../llm/provider.js";
import { StageModelConfig } from "../domain/provider.js";
import { translationInput, translationInstructions } from "./prompts.js";

export async function translate(provider: LLMProvider, config: StageModelConfig, source: string, context: unknown) {
  return provider.generateText({ model: config.model, instructions: translationInstructions, input: translationInput(source, context) });
}
