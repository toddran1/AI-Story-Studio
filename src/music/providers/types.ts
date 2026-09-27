import { z } from "zod";

export const musicGenerationRequestSchema = z.object({
  prompt: z.string().trim().min(10).max(4100), durationSeconds: z.number().int().min(3).max(600).optional(),
  instrumental: z.boolean().default(true), title: z.string().trim().min(1).max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  mood: z.array(z.string().max(60)).max(8).optional(), genre: z.array(z.string().max(60)).max(8).optional(),
  energy: z.enum(["very_low", "low", "medium", "high"]).default("low"),
  purpose: z.enum(["background_narration", "story_theme", "chapter_theme", "character_theme", "scene_music", "intro", "outro"]).default("background_narration"),
  loopFriendly: z.boolean().default(true), model: z.string().optional(),
}).strict();
export type MusicGenerationRequest = z.infer<typeof musicGenerationRequestSchema>;
export type MusicProviderCapabilities = { generation: boolean; asyncGeneration: boolean; instrumentalControl: boolean; durationControl: boolean; loopingControl: boolean; structuredComposition: boolean; searchCatalog: boolean; commercialUseMetadata: boolean; maxDurationSeconds?: number };
export type MusicGenerationResult = { audio: Uint8Array; providerGenerationId?: string; model?: string };
export interface MusicGenerationProvider {
  readonly id: string; readonly displayName: string;
  capabilities(): MusicProviderCapabilities;
  generate(request: MusicGenerationRequest): Promise<MusicGenerationResult>;
}
