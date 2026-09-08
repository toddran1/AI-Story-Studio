import { describe, expect, it } from "vitest";
import { LLMRouter } from "../src/llm/router.js";
import { MockLLM } from "./helpers.js";

describe("LLMRouter", () => {
  it("selects providers independently per stage", () => {
    const gemini = new MockLLM("gemini"); const openai = new MockLLM("openai");
    const router = new LLMRouter(new Map([["gemini", gemini], ["openai", openai]]));
    expect(router.forStage({ provider: "gemini", model: "a" })).toBe(gemini);
    expect(router.forStage({ provider: "openai", model: "b" })).toBe(openai);
  });
});
