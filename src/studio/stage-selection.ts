import { z } from "zod";

export const batchStageSchema = z.enum(["translation", "narration", "qa", "storyBible", "continuity", "tts", "audioMastering", "alignment", "subtitles", "scenePlanning", "artwork", "video"]);
export type BatchStage = z.infer<typeof batchStageSchema>;
export const BATCH_STAGES = batchStageSchema.options;

export const STAGE_SELECTION_PRESETS = {
  coreText: ["translation", "narration", "qa", "storyBible", "continuity"],
  narrationQa: ["narration", "qa"],
  audio: ["tts", "audioMastering", "alignment", "subtitles"],
  visuals: ["scenePlanning", "artwork", "video"],
} as const satisfies Record<string, readonly BatchStage[]>;
