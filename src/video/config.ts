import { z } from "zod";

export const videoSettingsSchema = z.object({
  width: z.number().int().min(640).max(3840).default(1920), height: z.number().int().min(360).max(2160).default(1080),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).default(30), codec: z.literal("libx264").default("libx264"),
  quality: z.number().int().min(0).max(40).default(20), subtitleMode: z.enum(["none", "burn", "soft", "both"]).default("burn"),
  subtitleStyle: z.enum(["default", "large", "minimal"]).default("default"), backgroundMode: z.enum(["cover", "gradient", "kenBurns"]).default("cover"),
  introDurationSeconds: z.number().min(0).max(10).default(3),
}).default({ width: 1920, height: 1080, fps: 30, codec: "libx264", quality: 20, subtitleMode: "burn", subtitleStyle: "default", backgroundMode: "cover", introDurationSeconds: 3 });
export type VideoSettings = z.infer<typeof videoSettingsSchema>;
