import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GeminiProvider } from "../src/llm/gemini/gemini.provider.js";
import { ProviderError } from "../src/pipeline/errors.js";

describe("structured provider errors", () => {
  it("wraps malformed structured model output with provider context", async () => {
    const provider = new GeminiProvider("test-key");
    Object.assign(provider as unknown as Record<string, unknown>, {
      client: { interactions: { create: async () => ({ id: "test-request", output_text: "{not-json" }) } },
    });
    await expect(provider.generateStructured({
      model: "test-model", instructions: "return data", input: "input", schemaName: "result",
      schema: z.object({ value: z.string() }),
    })).rejects.toBeInstanceOf(ProviderError);
  });
});
