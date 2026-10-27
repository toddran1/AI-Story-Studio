// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach } from "vitest";
import { z } from "zod";
import { ModelFields } from "../apps/web/src/ModelFields.js";
import { stageModelConfigSchema } from "../src/domain/provider.js";
import { LLMRouter } from "../src/llm/router.js";
import { resolveModelRouting } from "../src/config/model-routing.js";

afterEach(() => vi.unstubAllGlobals());
const request = { model: "gpt-6-luna", instructions: "Extract", input: "Chapter", effort: "low" as const };
describe("model effort", () => {
  it("preserves legacy defaults and rejects unsupported provider/model combinations", () => {
    expect(stageModelConfigSchema.parse({ provider: "openai", model: "custom" })).not.toHaveProperty("effort");
    expect(stageModelConfigSchema.parse({ provider: "openai", model: "gpt-6-luna", effort: "none" }).effort).toBe("none");
    for (const config of [{ provider: "openai", model: "gpt-6-astra", effort: "none" }, { provider: "gemini", model: "gemini-3.8-flash", effort: "max" }, { provider: "kimi", model: "kimi-k2-0905-preview", effort: "low" }]) expect(stageModelConfigSchema.safeParse(config).success).toBe(false);
  });
  it("shows only supported choices and clears effort when switching providers", () => {
    const onChange = vi.fn();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    act(() => root.render(<ModelFields label="Story Bible" value={{ provider: "openai", model: "gpt-6-luna", effort: "max" }} onChange={onChange} />));
    expect(host.querySelector('[aria-label="Story Bible effort"]')!.textContent).toContain("Extra high");
    act(() => { const select = host.querySelector('[aria-label="Story Bible effort"]') as HTMLSelectElement; select.value = "high"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith({ provider: "openai", model: "gpt-6-luna", effort: "high" });
    act(() => { const select = host.querySelector('[aria-label="Story Bible provider"]') as HTMLSelectElement; select.value = "gemini"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith({ provider: "gemini", model: "gpt-6-luna", effort: undefined });
    act(() => root.render(<ModelFields label="Story Bible" value={{ provider: "kimi", model: "kimi-k2.5" }} onChange={onChange} />));
    expect(host.querySelector('[aria-label="Story Bible effort"]')!.textContent).toContain("Thinking off");
    expect(host.querySelector('[aria-label="Story Bible effort"]')!.textContent).not.toContain("Extra high");
    act(() => root.unmount()); host.remove();
  });
  it("routes selected effort for text and structured requests without cross-stage leakage", async () => {
    const base = { name: "openai" as const, validateConfiguration: vi.fn(), generateText: vi.fn().mockResolvedValue({ text: "ok" }), generateStructured: vi.fn().mockResolvedValue({ value: { ok: true } }) };
    const router = new LLMRouter(new Map([["openai", base]]));
    await router.forStage({ provider: "openai", model: request.model, effort: "low" }).generateText({ ...request, effort: undefined });
    expect(base.generateText).toHaveBeenLastCalledWith(expect.objectContaining({ effort: "low" }));
    expect(router.forStage({ provider: "openai", model: request.model })).toBe(base);
    await router.forStage({ provider: "openai", model: request.model, effort: "high" }).generateStructured({ ...request, schemaName: "test", schema: z.object({ ok: z.boolean() }) });
    expect(base.generateStructured).toHaveBeenLastCalledWith(expect.objectContaining({ effort: "high" }));
  });
  it("retains effort in inheritance and distinguishes an effort-only override", () => {
    const stage = { provider: "openai" as const, model: "gpt-6-luna", effort: "low" as const };
    expect(resolveModelRouting({ stage: "qa", globalSettings: { qa: stage }, env: { OPENAI_API_KEY: "fake" } })).toMatchObject({ effort: "low", source: "application_default" });
    expect(resolveModelRouting({ stage: "qa", globalSettings: { qa: stage }, story: { pipeline: { qa: { ...stage, effort: "high" } } }, env: { OPENAI_API_KEY: "fake" } })).toMatchObject({ effort: "high", isOverride: true });
  });
});
