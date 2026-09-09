import { z } from "zod";

/** -17 LUFS is a balanced audiobook target: consistent and clear without sounding over-compressed. */
export const audioSettingsSchema = z.object({
  loudnessTarget: z.number().min(-24).max(-12).default(-17),
  truePeak: z.number().min(-6).max(-0.1).default(-1.5),
  segmentGapSeconds: z.number().min(0).max(5).default(0.35),
  chapterGapSeconds: z.number().min(0).max(10).default(1.5),
  format: z.literal("mp3").default("mp3"),
  bitrate: z.enum(["64k", "96k", "128k", "160k", "192k", "256k", "320k"]).default("128k"),
  sampleRate: z.union([z.literal(32000), z.literal(44100), z.literal(48000)]).default(44100),
}).default({ loudnessTarget: -17, truePeak: -1.5, segmentGapSeconds: 0.35, chapterGapSeconds: 1.5, format: "mp3", bitrate: "128k", sampleRate: 44100 });

export type AudioSettings = z.infer<typeof audioSettingsSchema>;
