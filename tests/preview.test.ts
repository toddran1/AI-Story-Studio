import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LLMRouter } from "../src/llm/router.js";
import { applyPreviewProfile } from "../src/preview/profile.js";
import { PreviewRunner } from "../src/preview/preview-runner.js";
import { PreviewPreset } from "../src/preview/types.js";
import { previewPaths, storyPaths } from "../src/storage/paths.js";
import { exists } from "../src/storage/story-files.js";
import { MockLLM, MockTTS, testStory } from "./helpers.js";

describe("A/B preview", () => {
  it("isolates outputs, creates short mocked audio, and applies the selected profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-preview-")); const input = join(root, "source.txt"); await writeFile(input, "章节正文", "utf8");
    const story = testStory();
    const presetA: PreviewPreset = { translation: story.pipeline.translation, narration: story.pipeline.narration, qa: story.pipeline.qa, tts: story.pipeline.tts };
    const presetB: PreviewPreset = { ...presetA, translation: { provider: "openai", model: "translation-b" }, narration: { provider: "openai", model: "narration-b" }, qa: { provider: "gemini", model: "qa-b" } };
    const gemini = new MockLLM("gemini", ["Translation A"]);
    const openai = new MockLLM("openai", ["Narration A", "Translation B", "Narration B"]);
    const tts = new MockTTS(); const runner = new PreviewRunner(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), tts);
    const manifest = await runner.run({ root, story, chapter: 1, inputPath: input, presets: { a: presetA, b: presetB }, audioPreview: true, id: "comparison" });
    const paths = previewPaths(root, story.slug, manifest.id);
    expect(await readFile(paths.translationA, "utf8")).toBe("Translation A");
    expect(await readFile(paths.translationB, "utf8")).toBe("Translation B");
    expect(await exists(paths.audioA)).toBe(true); expect(await exists(paths.audioB)).toBe(true); expect(tts.calls).toBe(2);
    expect(await exists(storyPaths(root, story.slug, 1).english)).toBe(false);
    const updated = await applyPreviewProfile(root, story, manifest.id, "b");
    expect(updated.pipeline.translation).toEqual(presetB.translation);
    expect(JSON.parse(await readFile(storyPaths(root, story.slug, 1).storyConfig, "utf8")).pipeline.qa).toEqual(presetB.qa);
  });
});
