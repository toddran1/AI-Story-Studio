import { StageModelConfig, providerHasCapability } from "../domain/provider.js";
import { StoryBible } from "../domain/story-bible.js";
import { LLMProvider } from "../llm/provider.js";
import { ConfigurationError } from "../pipeline/errors.js";
import { scenePlannerInstructions, SCENE_PLANNER_PROMPT_VERSION } from "./prompts.js";
import { plannedScenesSchema, summaryPlannedScenesSchema, SceneSettings } from "./types.js";
import { tokenizeNarration } from "../alignment/quality.js";
import { withRetry } from "../batch/retry.js";
import { retryConfigSchema } from "../batch/types.js";

export async function planScenes(provider: LLMProvider, config: StageModelConfig, input: { chapter: number; title?: string; narration: string; durationSeconds: number; bible: StoryBible; settings: SceneSettings; subtitles?: string; visualContinuity?: string }) {
  const target = Math.max(1, Math.min(input.settings.maximumScenesPerChapter, Math.round(input.durationSeconds / input.settings.targetDurationSeconds)));
  return planVisualScenes(provider, config, {
    ...input, sourceType: "chapter", sourceId: String(input.chapter), targetSceneCount: target,
    sourceLabel: `CHAPTER: ${input.chapter}\nTITLE: ${input.title ?? `Chapter ${input.chapter}`}`,
  });
}

export type VisualPlanningInput = {
  sourceType: "chapter" | "summary"; sourceId: string; sourceLabel: string;
  narration: string; durationSeconds: number; bible: StoryBible;
  settings: SceneSettings; targetSceneCount: number; subtitles?: string;
  visualContinuity?: string;
  canonicalSummary?: string; sourceChapters?: number[];
  namingIdentities?: Array<{ entityId: string; canonicalName: string; originalName?: string; narrationNames: string[] }>;
};

/** Shared provider boundary. Callers supply bounded canonical context, not an entire novel. */
export async function planVisualScenes(provider: LLMProvider, config: StageModelConfig, input: VisualPlanningInput) {
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) throw new Error("Scene planning requires a positive audio duration");
  if (!Number.isInteger(input.targetSceneCount) || input.targetSceneCount < 1 || input.targetSceneCount > 100) throw new Error("Scene count must be between 1 and 100");
  if (!providerHasCapability(config.provider, "structured_output")) {
    throw new ConfigurationError(`Provider '${config.provider}' does not support required capability 'structured_output'`);
  }
  await provider.validateConfiguration();
  const summary = input.sourceType === "summary";
  const context = summary ? `\n\nSUMMARY ID: ${input.sourceId}\nSOURCE CHAPTERS: ${JSON.stringify(input.sourceChapters ?? [])}\nSUPPORTING CANONICAL SUMMARY:\n${input.canonicalSummary ?? "Unavailable"}\nCANONICAL / LOCALIZED IDENTITY MAP:\n${JSON.stringify(input.namingIdentities ?? [])}` : "";
  const generate = () => provider.generateStructured({ model: config.model,
    instructions: scenePlannerInstructions + (summary ? "\nPlan only the events in the final recap narration, not every event in its source chapters. Use semantic visual beats first; the target scene count is pacing guidance, not permission to omit the ending. Localized full/short names refer to the same canonical entity in the identity map. Use that entity's supported visual traits. Supporting canonical context must never expand or rewrite the narration. For each summary scene provide zero-based narrationStartWord (inclusive) and narrationEndWord (exclusive) using the supplied narration word array. Cover every word exactly once in chronological order." : ""),
    input: `${input.sourceLabel}\nAUDIO DURATION: ${input.durationSeconds.toFixed(3)} seconds\nTARGET SCENE COUNT: approximately ${input.targetSceneCount}\nSCENE DURATION GUIDANCE: ${input.settings.minimumDurationSeconds}-${input.settings.maximumDurationSeconds} seconds\n\nCANONICAL STORY BIBLE:\n${JSON.stringify(input.bible, null, 2)}${context}${input.visualContinuity ? `\n\nPREVIOUS VISUAL CONTINUITY (inherited temporary state — current narration is authoritative):\n${input.visualContinuity}` : ""}${summary ? `\nNARRATION WORDS (zero-indexed):\n${JSON.stringify(tokenizeNarration(input.narration))}` : ""}\n\nOPTIONAL SUBTITLE TIMING:\n${input.subtitles ?? "Unavailable"}\n\nFINAL NARRATION:\n${input.narration}`,
    schemaName: summary ? "summary_scene_plan" : "chapter_scene_plan", schema: summary ? summaryPlannedScenesSchema : plannedScenesSchema });
  return summary ? withRetry(generate, retryConfigSchema.parse({})) : generate();
}
export { SCENE_PLANNER_PROMPT_VERSION };
