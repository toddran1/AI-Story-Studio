import { StageModelConfig } from "../domain/provider.js";
import { generatedQaResultSchema, QaResult, normalizeQaResult } from "../domain/qa.js";
import { StoryBible } from "../domain/story-bible.js";
import { LLMProvider } from "../llm/provider.js";
import type { NarrationProfanityMode } from "../domain/story.js";
import { authorizedNarrationNaming, qaInstructionsFor } from "./prompts.js";

export async function validateChapterQuality(
  provider: LLMProvider,
  config: StageModelConfig,
  input: { chapter: number; sourceLanguage: string; outputLanguage: string; source: string; translation: string; narration: string; context: StoryBible; profanityMode?: NarrationProfanityMode; includeChapterTitle?: boolean },
): Promise<{ value: QaResult; usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; requestId?: string } }> {
  const result = await provider.generateStructured({
    model: config.model,
    instructions: qaInstructionsFor(input.profanityMode, input.includeChapterTitle),
    input: [
      `CHAPTER NUMBER: ${input.chapter}`,
      `SOURCE LANGUAGE: ${input.sourceLanguage}`,
      `OUTPUT LANGUAGE: ${input.outputLanguage}`,
      `ESTABLISHED STORY BIBLE:\n${JSON.stringify(input.context, null, 2)}`,
      authorizedNarrationNaming(input.context),
      `SOURCE CHAPTER:\n${input.source}`,
      `TRANSLATION:\n${input.translation}`,
      `NARRATION:\n${input.narration}`,
    ].join("\n\n"),
    schemaName: "chapter_qa",
    schema: generatedQaResultSchema,
  });
  return { ...result, value: normalizeQaResult(result.value) };
}
