import { z } from "zod";

export const subtitleSettingsSchema = z.object({
  maxCharactersPerLine: z.number().int().min(20).max(80).default(42),
  maxLines: z.number().int().min(1).max(3).default(2),
  minimumDurationSeconds: z.number().min(0.4).max(5).default(1.2),
  maximumDurationSeconds: z.number().min(2).max(12).default(6),
}).refine((value) => value.maximumDurationSeconds >= value.minimumDurationSeconds, { message: "maximum subtitle duration must be at least the minimum" })
  .default({ maxCharactersPerLine: 42, maxLines: 2, minimumDurationSeconds: 1.2, maximumDurationSeconds: 6 });
export type SubtitleSettings = z.infer<typeof subtitleSettingsSchema>;
export type SubtitleCue = { index: number; startSeconds: number; endSeconds: number; text: string };
export type SubtitleDocument = { version: string; durationSeconds: number; cues: SubtitleCue[] };
