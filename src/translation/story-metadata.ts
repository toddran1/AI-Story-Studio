import { z } from "zod";
import { Story } from "../domain/story.js";
import { StageModelConfig } from "../domain/provider.js";
import { LLMProvider } from "../llm/provider.js";

export const translatedStoryMetadataSchema = z.object({
  title: z.string().trim().min(1).max(200),
  author: z.string().trim().max(200).optional(),
  description: z.string().trim().max(10_000),
  tags: z.array(z.string().trim().min(1).max(60)).max(30),
});

export type StoryMetadataSource = NonNullable<Story["metadataTranslationSource"]>;

export function storyMetadataSource(story: Story): StoryMetadataSource {
  return story.metadataTranslationSource ?? {
    title: story.originalTitle ?? story.title,
    author: story.author,
    description: story.description,
    tags: story.tags,
    language: story.sourceLanguage,
  };
}

export async function translateStoryMetadata(provider: LLMProvider, config: StageModelConfig, story: Story) {
  const source = storyMetadataSource(story);
  const result = await provider.generateStructured({
    model: config.model,
    schemaName: "story_metadata_translation",
    schema: translatedStoryMetadataSchema,
    instructions: `Translate reader-facing story metadata from ${source.language} to ${story.outputLanguage}. Preserve proper names and established terms unless a conventional ${story.outputLanguage} rendering is clearly appropriate. Keep the author name unchanged unless transliteration is necessary. Translate the title, description, and tags faithfully; do not invent plot details, accolades, or marketing claims. Return only the requested structured fields.`,
    input: JSON.stringify({ title: source.title, author: source.author, description: source.description, tags: source.tags }, null, 2),
  });
  return { source, translated: result.value, usage: result.usage };
}
