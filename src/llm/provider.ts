import { LLMRequest, LLMResponse, StructuredLLMRequest } from "./types.js";

export interface LLMProvider {
  readonly name: "openai" | "gemini";
  generateText(request: LLMRequest): Promise<LLMResponse>;
  generateStructured<T>(request: StructuredLLMRequest<T>): Promise<{ value: T; usage?: LLMResponse["usage"] }>;
  validateConfiguration(): Promise<void>;
}
