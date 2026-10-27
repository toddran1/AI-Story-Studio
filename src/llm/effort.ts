import { openAiEfforts } from "./openai/effort.js";
import { geminiEfforts } from "./gemini/effort.js";
import { kimiEfforts } from "./kimi/effort.js";
import { ConfigurationError } from "../pipeline/errors.js";

export function modelEfforts(provider: string, model: string): string[] {
  return provider === "openai" ? openAiEfforts(model) : provider === "gemini" ? geminiEfforts(model) : provider === "kimi" ? kimiEfforts(model) : [];
}
export function validateModelEffort(provider: string, model: string, effort?: string): void {
  if (effort !== undefined && !modelEfforts(provider, model).includes(effort)) throw new ConfigurationError(`Effort '${effort}' is not supported for ${provider} model '${model}'. Choose Provider default or a supported level.`);
}
