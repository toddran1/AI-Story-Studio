import { z } from "zod";

export const artStyleOptionSchema = z.enum([
  "Cinematic anime",
  "Manhwa",
  "Manga",
  "Semi-realistic",
  "Photorealistic",
  "Illustration",
  "Custom",
]);
export type ArtStyleOption = z.infer<typeof artStyleOptionSchema>;

export const artDirectionAspectRatioSchema = z.enum(["16:9", "1:1", "9:16", "4:3", "21:9"]);
export type ArtDirectionAspectRatio = z.infer<typeof artDirectionAspectRatioSchema>;

export const artDirectionPresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  isDefault: z.boolean().default(false),
  artStyle: artStyleOptionSchema.default("Manhwa"),
  customStylePrompt: z.string().trim().max(4000).default(""),
  visualTone: z.string().trim().max(1000).default("Dark fantasy, progression fantasy, supernatural action"),
  colorDirection: z.string().trim().max(1000).default("Rich atmospheric palette, high contrast, muted shadows with vibrant magical accents"),
  lightingDirection: z.string().trim().max(1000).default("Low-key cinematic lighting, deep shadows, controlled highlights"),
  cameraStyle: z.string().trim().max(1000).default("Dynamic cinematic framing, strong depth, dramatic composition"),
  compositionTendencies: z.string().trim().max(1000).default("Action-oriented, clear character focus with expansive background scale"),
  environmentStyle: z.string().trim().max(1000).default("Detailed atmospheric environments, immersive depth"),
  characterRenderingGuidance: z.string().trim().max(1000).default("Crisp line work, consistent anatomical proportions, detailed expression"),
  aspectRatio: artDirectionAspectRatioSchema.default("16:9"),
  characterConsistencyStrength: z.number().min(0).max(1).default(0.8),
  environmentConsistencyStrength: z.number().min(0).max(1).default(0.8),
  globalNegativePrompt: z.string().trim().max(2000).default("text, watermark, signature, logo, malformed anatomy, extra limbs, low resolution, blurry"),
  additionalVisualInstructions: z.string().trim().max(2000).default(""),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ArtDirectionPreset = z.infer<typeof artDirectionPresetSchema>;

// Preset IDs, default status, and timestamps are assigned by the server.
export const artDirectionPresetEditSchema = artDirectionPresetSchema
  .omit({ id: true, isDefault: true, createdAt: true, updatedAt: true })
  .partial()
  .strict();
export const createArtDirectionPresetSchema = artDirectionPresetEditSchema.required({ name: true });
export type CreateArtDirectionPresetInput = z.infer<typeof createArtDirectionPresetSchema>;
export type UpdateArtDirectionPresetInput = z.infer<typeof artDirectionPresetEditSchema>;

export const storyArtDirectionSchema = z.object({
  activePresetId: z.string().min(1).default("preset_main_style"),
  presets: z.array(artDirectionPresetSchema).min(1).default([
    {
      id: "preset_main_style",
      name: "Main Style",
      isDefault: true,
      artStyle: "Manhwa",
      customStylePrompt: "cinematic digital manhwa art, high quality webtoon illustration",
      visualTone: "Dark fantasy, progression fantasy, supernatural action",
      colorDirection: "Rich atmospheric palette, high contrast, muted shadows with vibrant magical accents",
      lightingDirection: "Low-key cinematic lighting, deep shadows, controlled highlights",
      cameraStyle: "Dynamic cinematic framing, strong depth, dramatic composition",
      compositionTendencies: "Action-oriented, clear character focus with expansive background scale",
      environmentStyle: "Detailed atmospheric environments, immersive depth",
      characterRenderingGuidance: "Crisp line work, consistent anatomical proportions, detailed expression",
      aspectRatio: "16:9",
      characterConsistencyStrength: 0.8,
      environmentConsistencyStrength: 0.8,
      globalNegativePrompt: "text, watermark, signature, logo, malformed anatomy, extra limbs, low resolution, blurry",
      additionalVisualInstructions: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]),
  updatedAt: z.string().datetime().default(() => new Date().toISOString()),
});
export type StoryArtDirection = z.infer<typeof storyArtDirectionSchema>;

export function createDefaultArtDirection(customStylePrompt = ""): StoryArtDirection {
  const epoch = "2026-01-01T00:00:00.000Z";
  return {
    activePresetId: "preset_main_style",
    presets: [
      {
        id: "preset_main_style",
        name: "Main Style",
        isDefault: true,
        artStyle: "Manhwa",
        customStylePrompt: customStylePrompt || "cinematic digital manhwa art, high quality webtoon illustration",
        visualTone: "Dark fantasy, progression fantasy, supernatural action",
        colorDirection: "Rich atmospheric palette, high contrast, muted shadows with vibrant magical accents",
        lightingDirection: "Low-key cinematic lighting, deep shadows, controlled highlights",
        cameraStyle: "Dynamic cinematic framing, strong depth, dramatic composition",
        compositionTendencies: "Action-oriented, clear character focus with expansive background scale",
        environmentStyle: "Detailed atmospheric environments, immersive depth",
        characterRenderingGuidance: "Crisp line work, consistent anatomical proportions, detailed expression",
        aspectRatio: "16:9",
        characterConsistencyStrength: 0.8,
        environmentConsistencyStrength: 0.8,
        globalNegativePrompt: "text, watermark, signature, logo, malformed anatomy, extra limbs, low resolution, blurry",
        additionalVisualInstructions: "",
        createdAt: epoch,
        updatedAt: epoch,
      },
    ],
    updatedAt: epoch,
  };
}
