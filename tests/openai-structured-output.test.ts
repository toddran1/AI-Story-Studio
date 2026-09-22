import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { plannedScenesSchema, summaryPlannedScenesSchema } from "../src/scenes/types.js";
import {
  OpenAIProvider,
  toOpenAiTextFormat,
  normalizeForOpenAiStrict,
  toOpenAiProviderError,
} from "../src/llm/openai/openai.provider.js";
import { ConfigurationError, ProviderError } from "../src/pipeline/errors.js";
import { OPENAI_TEXT_MODELS } from "../src/llm/openai/models.js";

function stubClient(provider: OpenAIProvider, create: (params: Record<string, unknown>) => Promise<unknown>) {
  Object.assign(provider as unknown as Record<string, unknown>, {
    client: { responses: { create } },
  });
}

describe("OpenAI structured output schemas", () => {
  it("generates compatible schema for plannedScenesSchema", () => {
    const format = zodTextFormat(plannedScenesSchema, "chapter_scene_plan");
    expect(format.name).toBe("chapter_scene_plan");
    expect(format.strict).toBe(true);
    const schema = format.schema as Record<string, any>;
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("scenes");
    const itemProps = schema.properties.scenes.items.properties;
    expect(itemProps).toHaveProperty("location");
    expect(schema.properties.scenes.items.required).toContain("location");
  });

  it("generates compatible schema for summaryPlannedScenesSchema", () => {
    const format = zodTextFormat(summaryPlannedScenesSchema, "summary_scene_plan");
    expect(format.name).toBe("summary_scene_plan");
    expect(format.strict).toBe(true);
    const schema = format.schema as Record<string, any>;
    const itemProps = schema.properties.scenes.items.properties;
    expect(itemProps).toHaveProperty("narrationStartWord");
    expect(itemProps).toHaveProperty("narrationEndWord");
    expect(schema.properties.scenes.items.required).toContain("narrationStartWord");
    expect(schema.properties.scenes.items.required).toContain("narrationEndWord");
  });

  it("normalizes schemas with optional properties to strict mode compatible schema", () => {
    const looseSchema = z.object({
      title: z.string(),
      subtitle: z.string().optional(),
    });
    const format = toOpenAiTextFormat(looseSchema, "loose");
    expect(format.strict).toBe(true);
    const schema = format.schema as Record<string, any>;
    expect(schema.required).toContain("title");
    expect(schema.required).toContain("subtitle");
  });
});

describe("OpenAIProvider execution & error diagnostics", () => {
  it.each(["gpt-6-sol", "gpt-6-luna"])("passes %s to Responses for text and structured output", async (model) => {
    expect(OPENAI_TEXT_MODELS).toContain(model);
    const provider = new OpenAIProvider("test-key");
    const create = vi.fn(async (params: Record<string, unknown>) => ({
      id: "resp_model",
      output_text: params.text ? JSON.stringify({ ok: true }) : "ready",
    }));
    stubClient(provider, create);

    expect((await provider.generateText({ model, instructions: "Translate", input: "你好" })).text).toBe("ready");
    expect((await provider.generateStructured({ model, instructions: "Check", input: "ready", schemaName: "check", schema: z.object({ ok: z.boolean() }) })).value).toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.every(([request]) => request.model === model)).toBe(true);
  });

  it("successfully parses structured response with usage", async () => {
    const provider = new OpenAIProvider("test-key");
    const output = {
      scenes: [
        {
          summary: "Mara enters the observatory.",
          startSeconds: 0,
          endSeconds: 15,
          characters: ["Mara"],
          location: "Observatory",
          visualPrompt: "Mara in brass chamber",
          importance: "standard",
        },
      ],
    };
    stubClient(provider, async () => ({
      id: "resp_123",
      output_text: JSON.stringify(output),
      usage: { input_tokens: 150, output_tokens: 80, input_tokens_details: { cached_tokens: 20 } },
    }));

    const res = await provider.generateStructured({
      model: "gpt-5.6-luna",
      instructions: "Plan scenes",
      input: "Audio text",
      schemaName: "chapter_scene_plan",
      schema: plannedScenesSchema,
    });

    expect(res.value.scenes).toHaveLength(1);
    expect(res.value.scenes[0]!.summary).toBe("Mara enters the observatory.");
    expect(res.usage?.requestId).toBe("resp_123");
    expect(res.usage?.inputTokens).toBe(150);
  });

  it("preserves HTTP 400 schema error details without swallowing", async () => {
    const provider = new OpenAIProvider("test-key");
    const schemaErr = Object.assign(
      new Error("Invalid schema for response_format: 'location' must be in required"),
      {
        status: 400,
        code: "invalid_request_error",
        type: "invalid_request_error",
        headers: { "x-request-id": "req_abc123" },
      }
    );
    stubClient(provider, async () => {
      throw schemaErr;
    });

    try {
      await provider.generateStructured({
        model: "gpt-5.6-luna",
        instructions: "Plan scenes",
        input: "Audio text",
        schemaName: "chapter_scene_plan",
        schema: plannedScenesSchema,
      });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.status).toBe(400);
      expect(err.code).toBe("invalid_request_error");
      expect(err.category).toBe("structured_output_error");
      expect(err.requestId).toBe("req_abc123");
      expect(err.provider).toBe("openai");
      expect(err.model).toBe("gpt-5.6-luna");
      expect(err.retryable).toBe(false);
      expect(err.message).toContain("location");
    }
  });

  it("maps HTTP 401 to authentication_error", () => {
    const err = Object.assign(new Error("Incorrect API key provided"), {
      status: 401,
      code: "invalid_api_key",
    });
    const providerErr = toOpenAiProviderError(err, "Failed", "gpt-5.6-luna");
    expect(providerErr.category).toBe("authentication_error");
    expect(providerErr.status).toBe(401);
    expect(providerErr.retryable).toBe(false);
  });

  it("maps HTTP 429 to rate_limited with retryable=true", () => {
    const err = Object.assign(new Error("Rate limit exceeded"), {
      status: 429,
      code: "rate_limit_exceeded",
    });
    const providerErr = toOpenAiProviderError(err, "Failed", "gpt-5.6-luna");
    expect(providerErr.category).toBe("rate_limited");
    expect(providerErr.status).toBe(429);
    expect(providerErr.retryable).toBe(true);
  });

  it("maps HTTP 503 to provider_unavailable with retryable=true", () => {
    const err = Object.assign(new Error("Service Unavailable"), {
      status: 503,
      code: "server_error",
    });
    const providerErr = toOpenAiProviderError(err, "Failed", "gpt-5.6-luna");
    expect(providerErr.category).toBe("provider_unavailable");
    expect(providerErr.status).toBe(503);
    expect(providerErr.retryable).toBe(true);
  });

  it("throws ConfigurationError when API key is missing", async () => {
    const provider = new OpenAIProvider(undefined);
    await expect(
      provider.generateStructured({
        model: "gpt-5.6-luna",
        instructions: "Plan scenes",
        input: "Audio text",
        schemaName: "test",
        schema: z.object({ ok: z.boolean() }),
      })
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});
