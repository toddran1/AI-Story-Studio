import { describe, expect, it } from "vitest";
import { LLMProvider } from "../src/llm/provider.js";
import { StructuredLLMRequest } from "../src/llm/types.js";
import { storyMetadataSource, translateStoryMetadata } from "../src/translation/story-metadata.js";
import { testStory } from "./helpers.js";

class MetadataProvider implements LLMProvider {
  readonly name = "gemini" as const;
  request?: StructuredLLMRequest<unknown>;
  async validateConfiguration() {}
  async generateText() { return { text: "unused" }; }
  async generateStructured<T>(request: StructuredLLMRequest<T>) {
    this.request = request;
    return { value: request.schema.parse({ title: "The Undead Calamity", author: "Original Author", description: "A necromancer awakens.", tags: ["fantasy", "necromancy"] }), usage: { inputTokens: 12, outputTokens: 9 } };
  }
}

describe("story metadata translation", () => {
  it("captures original reader metadata once and translates it with the story translation model", async () => {
    const story = testStory(); story.title = "亡灵天灾"; story.author = "原作者"; story.description = "死灵法师苏醒。"; story.tags = ["玄幻", "亡灵"];
    const provider = new MetadataProvider(); const result = await translateStoryMetadata(provider, story.pipeline.translation, story);
    expect(result.source).toEqual({ title: "亡灵天灾", author: "原作者", description: "死灵法师苏醒。", tags: ["玄幻", "亡灵"], language: "zh-CN" });
    expect(result.translated.title).toBe("The Undead Calamity");
    expect(provider.request).toMatchObject({ model: story.pipeline.translation.model, schemaName: "story_metadata_translation" });
    expect(provider.request?.instructions).toContain("zh-CN to en-US");
  });

  it("reuses the preserved original metadata for later output-language changes", () => {
    const story = testStory(); story.title = "The Undead Calamity"; story.metadataTranslationSource = { title: "亡灵天灾", description: "死灵法师苏醒。", tags: ["玄幻"], language: "zh-CN" };
    expect(storyMetadataSource(story)).toEqual(story.metadataTranslationSource);
  });
});
