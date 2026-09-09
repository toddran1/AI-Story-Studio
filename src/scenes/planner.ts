import { StageModelConfig } from "../domain/provider.js";
import { StoryBible } from "../domain/story-bible.js";
import { LLMProvider } from "../llm/provider.js";
import { scenePlannerInstructions, SCENE_PLANNER_PROMPT_VERSION } from "./prompts.js";
import { plannedScenesSchema, SceneSettings } from "./types.js";

export async function planScenes(provider: LLMProvider, config: StageModelConfig, input: { chapter: number; title?: string; narration: string; durationSeconds: number; bible: StoryBible; settings: SceneSettings; subtitles?: string }) {
  const target = Math.max(1, Math.min(input.settings.maximumScenesPerChapter, Math.round(input.durationSeconds / input.settings.targetDurationSeconds)));
  return provider.generateStructured({ model: config.model, instructions: scenePlannerInstructions,
    input: `CHAPTER: ${input.chapter}\nTITLE: ${input.title ?? `Chapter ${input.chapter}`}\nAUDIO DURATION: ${input.durationSeconds.toFixed(3)} seconds\nTARGET SCENE COUNT: approximately ${target}\nSCENE DURATION GUIDANCE: ${input.settings.minimumDurationSeconds}-${input.settings.maximumDurationSeconds} seconds\n\nCANONICAL STORY BIBLE:\n${JSON.stringify(input.bible, null, 2)}\n\nOPTIONAL SUBTITLE TIMING:\n${input.subtitles ?? "Unavailable"}\n\nFINAL NARRATION:\n${input.narration}`,
    schemaName: "chapter_scene_plan", schema: plannedScenesSchema });
}
export { SCENE_PLANNER_PROMPT_VERSION };
