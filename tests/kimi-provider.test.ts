import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { KimiProvider } from "../src/llm/kimi/kimi.provider.js";
import { ConfigurationError, ProviderError } from "../src/pipeline/errors.js";
import { LLMRouter } from "../src/llm/router.js";
import { llmProviderNameSchema, stageModelConfigSchema } from "../src/domain/provider.js";

function stubClient(provider: KimiProvider, create: (params: Record<string, unknown>) => Promise<unknown>) {
  Object.assign(provider as unknown as Record<string, unknown>, { client: { chat: { completions: { create } } } });
}

const completion = (content: string) => ({
  id: "chatcmpl-test",
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 120, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 12 } },
});

describe("KimiProvider", () => {
  it("maps requests to Moonshot chat completions and returns text with usage", async () => {
    const provider = new KimiProvider("test-key");
    const create = vi.fn(async (_params: Record<string, unknown>) => completion("Translated chapter"));
    stubClient(provider, create);
    const result = await provider.generateText({ model: "kimi-k2-0905-preview", instructions: "Translate to English", input: "第一章" });
    expect(create).toHaveBeenCalledWith({
      model: "kimi-k2-0905-preview",
      messages: [
        { role: "system", content: "Translate to English" },
        { role: "user", content: "第一章" },
      ],
    });
    expect(result).toEqual({ text: "Translated chapter", usage: { requestId: "chatcmpl-test", inputTokens: 120, outputTokens: 40, cachedTokens: 12 } });
  });

  it("parses structured output with the request schema and reports usage", async () => {
    const provider = new KimiProvider("test-key");
    const create = vi.fn(async (_params: Record<string, unknown>) => completion(JSON.stringify({ value: "ok", count: 2 })));
    stubClient(provider, create);
    const schema = z.object({ value: z.string(), count: z.number().int() });
    const result = await provider.generateStructured({ model: "kimi-k2-0905-preview", instructions: "return data", input: "input", schemaName: "result", schema });
    expect(result.value).toEqual({ value: "ok", count: 2 });
    expect(result.usage?.inputTokens).toBe(120);
    const params = create.mock.calls[0]![0] as { response_format?: { type?: string }; messages: Array<{ role: string; content: string }> };
    expect(params.response_format).toEqual({ type: "json_object" });
    expect(params.messages[1]!.content).toContain("Return only a JSON object");
    expect(params.messages[1]!.content).toContain(JSON.stringify(z.toJSONSchema(schema)));
  });

  it("wraps malformed JSON and schema mismatches in ProviderError", async () => {
    const schema = z.object({ value: z.string() });
    const malformed = new KimiProvider("test-key");
    stubClient(malformed, async () => completion("{not-json"));
    await expect(malformed.generateStructured({ model: "m", instructions: "i", input: "x", schemaName: "result", schema })).rejects.toBeInstanceOf(ProviderError);

    const mismatch = new KimiProvider("test-key");
    stubClient(mismatch, async () => completion(JSON.stringify({ value: 42 })));
    await expect(mismatch.generateStructured({ model: "m", instructions: "i", input: "x", schemaName: "result", schema })).rejects.toBeInstanceOf(ProviderError);
  });

  it("throws ConfigurationError without an API key and never calls the provider", async () => {
    const provider = new KimiProvider(undefined);
    const create = vi.fn();
    stubClient(provider, create);
    await expect(provider.validateConfiguration()).rejects.toBeInstanceOf(ConfigurationError);
    await expect(provider.generateText({ model: "m", instructions: "i", input: "x" })).rejects.toBeInstanceOf(ConfigurationError);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("kimi provider name acceptance", () => {
  it("accepts kimi in story stage configuration and routes it", () => {
    expect(llmProviderNameSchema.parse("kimi")).toBe("kimi");
    const config = stageModelConfigSchema.parse({ provider: "kimi", model: "kimi-k2-0905-preview" });
    const router = new LLMRouter(new Map([["kimi", new KimiProvider("test-key")]]));
    expect(router.forStage(config).name).toBe("kimi");
  });
});
