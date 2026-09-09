import { z } from "zod";
import { stageModelConfigSchema, ttsStageConfigSchema } from "./provider.js";
import { audioSettingsSchema } from "../audio/config.js";
import { subtitleSettingsSchema } from "../subtitles/types.js";
import { videoSettingsSchema } from "../video/config.js";
import { artworkSettingsSchema, sceneSettingsSchema } from "../scenes/types.js";
import { productionProfilesSchema } from "../production/types.js";

const rawStorySchema = z.object({
  id: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1),
  originalTitle: z.string().optional(),
  author: z.string().optional(),
  sourceLanguage: z.string().min(2),
  outputLanguage: z.string().min(2),
  source: z.object({
    type: z.enum(["text", "epub", "docx", "pdf", "web", "fanqie", "manual", "original"]),
    url: z.string().url().optional(),
    externalId: z.string().optional(),
    path: z.string().optional(),
  }),
  context: z.object({
    recentChapterSummaries: z.number().int().min(0).max(100).default(5),
  }).default({ recentChapterSummaries: 5 }),
  audio: audioSettingsSchema,
  subtitles: subtitleSettingsSchema,
  video: videoSettingsSchema,
  scenes: sceneSettingsSchema,
  artwork: artworkSettingsSchema,
  productionProfiles: productionProfilesSchema,
  pipeline: z.object({
    translation: stageModelConfigSchema,
    narration: stageModelConfigSchema,
    qa: stageModelConfigSchema,
    storyBible: stageModelConfigSchema,
    scenePlanner: stageModelConfigSchema,
    tts: ttsStageConfigSchema,
  }),
});

export const storySchema = z.preprocess((value) => {
  if (!value || typeof value !== "object") return value;
  const story = value as Record<string, unknown>;
  const withAudio = { ...story, audio: "audio" in story ? story.audio : undefined, subtitles: "subtitles" in story ? story.subtitles : undefined, video: "video" in story ? story.video : undefined, scenes: "scenes" in story ? story.scenes : undefined, artwork: "artwork" in story ? story.artwork : undefined };
  const pipeline = story.pipeline;
  if (!pipeline || typeof pipeline !== "object") return withAudio;
  const stages = pipeline as Record<string, unknown>;
  return { ...withAudio, pipeline: { ...stages, qa: stages.qa ?? stages.narration ?? stages.storyBible, scenePlanner: stages.scenePlanner ?? stages.narration ?? stages.storyBible } };
}, rawStorySchema);

export type Story = z.infer<typeof storySchema>;
