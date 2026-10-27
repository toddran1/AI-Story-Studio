import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenAIProvider } from "../src/llm/openai/openai.provider.js";
import { GeminiProvider } from "../src/llm/gemini/gemini.provider.js";
import { KimiProvider } from "../src/llm/kimi/kimi.provider.js";
const request = { model: "gpt-6-luna", instructions: "Extract", input: "Chapter", effort: "low" as const };
describe("native effort parameters", () => {
  it.each(["openai", "gemini", "kimi"])("sends %s effort using its native API field", async name => {
    const create = vi.fn().mockResolvedValue({ output_text: '{"ok":true}', choices: [{ message: { content: '{"ok":true}' } }] });
    const provider = name === "openai" ? new OpenAIProvider("fake") : name === "gemini" ? new GeminiProvider("fake") : new KimiProvider("fake");
    Object.assign(provider, { client: name === "openai" ? { responses: { create } } : name === "gemini" ? { interactions: { create } } : { chat: { completions: { create } } } });
    const model = name === "openai" ? "gpt-6-luna" : name === "gemini" ? "gemini-3.8-flash" : "kimi-k2.5";
    const effort = name === "kimi" ? "disabled" as const : "low" as const;
    await provider.generateText({ ...request, model, effort });
    await provider.generateStructured({ ...request, model, effort, schemaName: "test", schema: z.object({ ok: z.boolean() }) });
    const expected = name === "openai" ? { reasoning: { effort } } : name === "gemini" ? { generation_config: { thinking_level: effort } } : { thinking: { type: effort } };
    expect(create).toHaveBeenCalledTimes(2);
    for (const [body] of create.mock.calls) expect(body).toMatchObject(expected);
  });
});

it("keeps effort through application-default and book-setting saves, including reset", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadEnvironment } = await import("../src/config/env.js");
  const { loadGlobalSettings, saveGlobalSettings, createBlankStory } = await import("../src/studio/projects.js");
  const { updateStorySettings } = await import("../apps/server/catalog.js");
  const root = await mkdtemp(join(tmpdir(), "effort-settings-"));
  try {
    const env = loadEnvironment({});
    const defaults = await loadGlobalSettings(root, env);
    await saveGlobalSettings(root, { ...defaults, storyBible: { provider: "openai", model: "gpt-6-luna", effort: "low" } });
    const story = await createBlankStory(root, env, { slug: "effort-story", title: "Effort story" });
    expect(story.pipeline.storyBible.effort).toBe("low");
    // The settings boundary accepts only editable fields, not the complete story object.
    const input = { title: story.title, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, recentChapterSummaries: 5, translation: story.pipeline.translation, narration: story.pipeline.narration, qa: story.pipeline.qa, storyBible: { provider: "openai", model: "gpt-6-luna", effort: "high" }, tts: { speed: 1 }, audio: story.audio, pipelineOverrides: { storyBible: true } };
    const saved = await updateStorySettings(root, story.slug, input);
    expect(saved.pipeline.storyBible.effort).toBe("high");
    const reset = await updateStorySettings(root, story.slug, { ...input, pipelineOverrides: { storyBible: false } });
    expect(reset.pipeline.storyBible.effort).toBe("low");
    expect((await loadGlobalSettings(root, env)).storyBible.effort).toBe("low");
  } finally { await rm(root, { recursive: true, force: true }); }
});
