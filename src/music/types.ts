import { z } from "zod";

export const musicTrackIdSchema = z.string().regex(/^mus_[a-f0-9]{24}$/);
export const musicTrackSchema = z.object({
  id: musicTrackIdSchema, title: z.string().trim().min(1).max(200), filename: z.string().regex(/^mus_[a-f0-9]{24}\.(mp3|wav|m4a|flac|ogg)$/),
  durationSeconds: z.number().positive(), fingerprint: z.string().min(1), source: z.string().max(500).optional(), sourceUrl: z.string().url().optional(),
  license: z.string().max(500).optional(), attribution: z.string().max(1000).optional(), commercialUse: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export type MusicTrack = z.infer<typeof musicTrackSchema>;
export const musicLibrarySchema = z.object({ version: z.literal(1), tracks: z.array(musicTrackSchema).default([]) });
const backgroundMusicSettingsBaseSchema = z.object({
  defaultTrackId: musicTrackIdSchema.optional(), level: z.enum(["very_soft", "subtle", "balanced", "present", "custom"]).default("subtle"),
  customGainDb: z.number().min(-40).max(-6).optional(),
  ducking: z.object({ enabled: z.boolean().default(true), strength: z.enum(["gentle", "normal", "strong"]).default("normal") }).default({ enabled: true, strength: "normal" }),
  fadeInSeconds: z.number().min(0).max(30).default(1.5), fadeOutSeconds: z.number().min(0).max(30).default(2),
  loopMode: z.enum(["continuous", "restart_chapter"]).default("continuous"),
});
export const backgroundMusicSettingsSchema = backgroundMusicSettingsBaseSchema.superRefine((value, context) => { if (value.level === "custom" && value.customGainDb === undefined) context.addIssue({ code: "custom", path: ["customGainDb"], message: "Custom music level requires customGainDb" }); });
export const exportMusicSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }), z.object({ mode: z.literal("story_default") }), z.object({ mode: z.literal("track"), trackId: musicTrackIdSchema }),
]);
export type ExportMusicSelection = z.infer<typeof exportMusicSelectionSchema>;
export const musicOverridesSchema = z.object({
  level: z.enum(["very_soft", "subtle", "balanced", "present", "custom"]).optional(),
  customGainDb: z.number().min(-40).max(-6).optional(),
  ducking: z.object({ enabled: z.boolean().optional(), strength: z.enum(["gentle", "normal", "strong"]).optional() }).optional(),
  fadeInSeconds: z.number().min(0).max(30).optional(), fadeOutSeconds: z.number().min(0).max(30).optional(),
  loopMode: z.enum(["continuous", "restart_chapter"]).optional(),
});
export type ResolvedExportMusic = {
  mode: "story_default" | "track"; track: MusicTrack; path: string; gainDb: number;
  ducking: { enabled: boolean; strength: "gentle" | "normal" | "strong" };
  fadeInSeconds: number; fadeOutSeconds: number; loopMode: "continuous" | "restart_chapter";
};
export const MUSIC_PRESET_GAIN_DB = { very_soft: -26, subtle: -22, balanced: -18, present: -15 } as const;
