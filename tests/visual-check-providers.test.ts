import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenAIProvider } from "../src/llm/openai/openai.provider.js";
import { GeminiProvider } from "../src/llm/gemini/gemini.provider.js";
import { KimiProvider } from "../src/llm/kimi/kimi.provider.js";
const data = Buffer.from("mock image bytes");
const request = { model: "gpt-6-luna", instructions: "Inspect", input: "Compare image", images: [{ data, mimeType: "image/png" as const }], schemaName: "check", schema: z.object({ result: z.string() }) };
describe("visual check provider transport", () => {
  it("sends local image bytes and structured output to OpenAI", async () => {
    const provider = new OpenAIProvider("test-key");
    const create = vi.fn(async () => ({ id: "check", output_text: '{"result":"match"}' }));
    Object.assign(provider, { client: { responses: { create } } });
    expect((await provider.generateStructured(request)).value.result).toBe("match");
    expect(create.mock.calls[0]).toBeDefined();
    const sent = (create.mock.calls as unknown as Array<[any]>)[0]![0];
    expect(sent.input[0].content).toEqual([{ type: "input_text", text: request.input }, { type: "input_image", image_url: `data:image/png;base64,${data.toString("base64")}`, detail: "auto" }]);
    expect(sent.text.format.type).toBe("json_schema");
  });
  it("retains the images through Gemini's schema fallback", async () => {
    const provider = new GeminiProvider("test-key"); const calls: any[] = [];
    Object.assign(provider, { client: { interactions: { create: async (sent: any) => {
      calls.push(sent); if (calls.length === 1) throw Object.assign(new Error("400 Request contains an invalid argument."), { status: 400 });
      return { id: "check", output_text: '{"result":"match"}' };
    } } } });
    expect((await provider.generateStructured({ ...request, model: "test-model" })).value.result).toBe("match");
    expect(calls).toHaveLength(2);
    for (const sent of calls) expect(sent.input[1]).toEqual({ type: "image", data: data.toString("base64"), mime_type: "image/png" });
  });
  it("rejects images in the text-only Kimi adapter before requesting a response", async () => {
    const provider = new KimiProvider("test-key");
    await expect(provider.generateStructured(request)).rejects.toThrow(/image/i);
  });
});
