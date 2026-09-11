import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GeminiProvider, geminiJsonSchema } from "../src/llm/gemini/gemini.provider.js";
import { storyBibleUpdateSchema } from "../src/domain/story-bible.js";

describe("Gemini structured output schema", () => {
  it("keeps only the Interactions API JSON Schema subset", () => {
    const serialized = JSON.stringify(geminiJsonSchema(storyBibleUpdateSchema));
    expect(serialized).not.toContain('"$schema"');
    expect(serialized).not.toContain('"default"');
    expect(serialized).not.toContain('"minLength"');
    expect(serialized).not.toContain('"maxLength"');
    expect(serialized).not.toContain('"exclusiveMinimum"');
    expect(serialized).toContain('"properties"');
    expect(serialized).toContain('"required"');
  });

  it("retries a provider-side schema rejection with a compact JSON-object format", async () => {
    const provider = new GeminiProvider("test-key");
    const calls: any[] = [];
    Object.assign(provider as unknown as Record<string, unknown>, {
      client: { interactions: { create: async (request: any) => {
        calls.push(request);
        if (calls.length === 1) throw Object.assign(new Error("400 Request contains an invalid argument."), { status: 400 });
        return { id: "fallback-request", output_text: '{"value":"ok"}' };
      } } },
    });
    await expect(provider.generateStructured({ model: "test-model", instructions: "Return data", input: "input", schemaName: "result", schema: z.object({ value: z.string() }) })).resolves.toMatchObject({ value: { value: "ok" } });
    expect(calls).toHaveLength(2);
    expect(calls[1].response_format.schema).toEqual({ type: "object" });
    expect(calls[1].input).toContain("conforms exactly to this JSON Schema");
  });

  it("uses a compact but still required-field-preserving schema for Story Bible output", async () => {
    const provider = new GeminiProvider("test-key");
    const calls: any[] = [];
    Object.assign(provider as unknown as Record<string, unknown>, {
      client: { interactions: { create: async (request: any) => {
        calls.push(request);
        return { id: "story-bible-request", output_text: JSON.stringify({ chapterSummary: "Nothing changed." }) };
      } } },
    });
    await provider.generateStructured({ model: "test-model", instructions: "Extract", input: "input", schemaName: "storyBible", schema: storyBibleUpdateSchema });
    expect(calls).toHaveLength(1);
    expect(calls[0].response_format.schema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["chapterSummary", "characters"]),
      properties: { chapterSummary: { type: "string" } },
    });
    expect(calls[0].response_format.schema.properties.characters.items).toMatchObject({
      required: expect.arrayContaining(["canonicalEnglishName", "firstSeenChapter", "lastSeenChapter"]),
    });
  });
});
