import { LLMProvider } from "../llm/provider.js";
import { StageModelConfig } from "../domain/provider.js";
import { StoryBible, storyBibleUpdateSchema } from "../domain/story-bible.js";
import { storyBibleInstructions } from "./prompts.js";

export async function extractStoryBible(provider: LLMProvider, config: StageModelConfig, chapter: number, narration: string, bible: StoryBible) {
  return provider.generateStructured({
    model: config.model,
    instructions: storyBibleInstructions,
    input: `CHAPTER NUMBER: ${chapter}\n\nESTABLISHED STORY BIBLE:\n${JSON.stringify(bible, null, 2)}\n\nPOLISHED CHAPTER:\n${narration}`,
    schemaName: "story_bible_update",
    schema: storyBibleUpdateSchema,
  });
}
