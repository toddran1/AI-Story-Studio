import { z } from "zod";
import { resolveTargetDimensions } from "../artwork/resolution.js";

export const videoResolutionSchema = z.enum(["720p", "1080p", "1440p", "2160p"]);
export type VideoResolution = z.infer<typeof videoResolutionSchema>;
export const videoTransitionModeSchema = z.enum(["cut", "dissolve", "fade_black", "slide"]);
export type VideoTransitionMode = z.infer<typeof videoTransitionModeSchema>;
export const videoMotionModeSchema = z.enum(["still", "zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down", "auto_subtle"]);
export type VideoMotionMode = z.infer<typeof videoMotionModeSchema>;
export const videoTransitionSchema = z.object({ mode: videoTransitionModeSchema.default("dissolve"), durationSeconds: z.number().min(0).max(2).default(0.5) });
export const videoMotionSchema = z.object({ mode: videoMotionModeSchema.default("auto_subtle"), intensity: z.enum(["subtle", "normal"]).default("subtle") });

export const videoSettingsSchema = z.object({
  width: z.number().int().min(640).max(3840).default(1920), height: z.number().int().min(360).max(2160).default(1080),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).default(30), codec: z.literal("libx264").default("libx264"),
  quality: z.number().int().min(0).max(40).default(20), subtitleMode: z.enum(["none", "burn", "soft", "both"]).default("burn"),
  subtitleStyle: z.enum(["default", "large", "minimal"]).default("default"), backgroundMode: z.enum(["cover", "gradient", "kenBurns"]).default("cover"),
  introDurationSeconds: z.number().min(0).max(10).default(3),
  transition: videoTransitionSchema.default({ mode: "dissolve", durationSeconds: 0.5 }),
  motion: videoMotionSchema.default({ mode: "auto_subtle", intensity: "subtle" }),
  // Optional canvas preset (16:9). When set it drives width/height; explicit
  // width/height remain the advanced custom path when unset.
  resolution: videoResolutionSchema.optional(),
}).default({ width: 1920, height: 1080, fps: 30, codec: "libx264", quality: 20, subtitleMode: "burn", subtitleStyle: "default", backgroundMode: "cover", introDurationSeconds: 3, transition: { mode: "dissolve", durationSeconds: 0.5 }, motion: { mode: "auto_subtle", intensity: "subtle" } });
export type VideoSettings = z.infer<typeof videoSettingsSchema>;

/** Effective render settings: a resolution preset drives the canvas size. */
export function resolveVideoSettings(settings: VideoSettings): VideoSettings {
  if (!settings.resolution) return settings;
  const target = resolveTargetDimensions(settings.resolution, "16:9")!;
  return { ...settings, width: target.width, height: target.height };
}
