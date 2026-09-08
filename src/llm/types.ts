import { z } from "zod";

export type LLMRequest = { model: string; instructions: string; input: string };
export type LLMUsage = { inputTokens?: number; outputTokens?: number; cachedTokens?: number; requestId?: string };
export type LLMResponse = { text: string; usage?: LLMUsage };
export type StructuredLLMRequest<T> = LLMRequest & { schemaName: string; schema: z.ZodType<T> };
