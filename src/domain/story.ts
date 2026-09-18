import { z } from "zod";
import { stageModelConfigSchema, ttsStageConfigSchema } from "./provider.js";
import { audioSettingsSchema } from "../audio/config.js";
import { subtitleSettingsSchema } from "../subtitles/types.js";
import { videoSettingsSchema } from "../video/config.js";
import { artworkSettingsSchema, sceneSettingsSchema } from "../scenes/types.js";
import { productionProfilesSchema } from "../production/types.js";
import { storyNovelSourceSchema } from "../source/novel-provider.js";

export const narrationSettingsSchema = z.object({
  profanityMode: z.enum(["preserve", "soften-strong"]).default("preserve"),
  bleepStrongProfanity: z.boolean().default(false),
  includeChapterTitle: z.boolean().optional(),
  speechNormalization: z.enum(["automatic", "enabled", "disabled"]).default("automatic"),
  timeSpeechMode: z.enum(["natural_12h", "natural_24h", "preserve"]).default("natural_12h"),
  speechAbbreviations: z.record(z.string().trim().regex(/^[A-Za-z][A-Za-z0-9-]{0,29}$/), z.string().trim().min(1).max(120)).default({}),
  speechVocalizations: z.object({
    mode: z.enum(["automatic", "preserve", "disabled"]).default("automatic"),
    fallback: z.enum(["safe_normalize", "omit_unsupported", "preserve"]).default("safe_normalize"),
  }).default({ mode: "automatic", fallback: "safe_normalize" }),
}).default({ profanityMode: "preserve", bleepStrongProfanity: false, speechNormalization: "automatic", timeSpeechMode: "natural_12h", speechAbbreviations: {}, speechVocalizations: { mode: "automatic", fallback: "safe_normalize" } });
export type NarrationProfanityMode = z.infer<typeof narrationSettingsSchema>["profanityMode"];

const rawStorySchema = z.object({
  id: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1),
  originalTitle: z.string().optional(),
  metadataTranslationSource: z.object({
    title: z.string().min(1),
    author: z.string().optional(),
    description: z.string().default(""),
    tags: z.array(z.string()).default([]),
    language: z.string().min(2),
  }).optional(),
  metadataTranslatedAt: z.string().datetime().optional(),
  author: z.string().optional(),
  description: z.string().default(""),
  tags: z.array(z.string().min(1)).default([]),
  notes: z.string().default(""),
  defaultProductionProfile: z.enum(["audio", "audiobook", "story-video", "everything"]).default("audiobook"),
  sourceLanguage: z.string().min(2),
  outputLanguage: z.string().min(2),
  source: z.object({
    type: z.enum(["text", "epub", "docx", "pdf", "web", "fanqie", "manual", "original"]),
    url: z.string().url().optional(),
    externalId: z.string().optional(),
    path: z.string().optional(),
  }),
  sources: z.array(storyNovelSourceSchema).default([]),
  context: z.object({
    recentChapterSummaries: z.number().int().min(0).max(100).default(5),
  }).default({ recentChapterSummaries: 5 }),
  narrationSettings: narrationSettingsSchema,
  qaMode: z.enum(["production", "thorough"]).default("production"),
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
  pipelineOverrides: z.record(z.string(), z.boolean()).default({}),
});

export const storySchema = z.preprocess((value) => {
  if (!value || typeof value !== "object") return value;
  const story = value as Record<string, unknown>;
  const withAudio = { ...story, audio: "audio" in story ? story.audio : undefined, subtitles: "subtitles" in story ? story.subtitles : undefined, video: "video" in story ? story.video : undefined, scenes: "scenes" in story ? story.scenes : undefined, artwork: "artwork" in story ? story.artwork : undefined };
  const pipeline = story.pipeline;
  if (!pipeline || typeof pipeline !== "object") return withAudio;
  const stages = pipeline as Record<string, unknown>;
  const rawTts = stages.tts;
  const tts = rawTts && typeof rawTts === "object"
    ? (() => {
        const config = rawTts as Record<string, unknown>;
        // A short-lived earlier default selected two-voice mode without a
        // secondary voice. Interpret that inert combination as the intended
        // same-voice dialogue treatment while preserving configured casts.
        return config.voiceMode === "narrator-dialogue" && !config.secondaryReferenceId
          ? { ...config, voiceMode: "same-voice-dialogue" }
          : config;
      })()
    : rawTts;
  return { ...withAudio, pipeline: { ...stages, tts, qa: stages.qa ?? stages.narration ?? stages.storyBible, scenePlanner: stages.scenePlanner ?? stages.narration ?? stages.storyBible } };
}, rawStorySchema);

export type Story = z.infer<typeof storySchema>;
