import { visualSceneSelectionSchema } from "../visual-canon/regeneration-selection.js";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { LLMProvider } from "../llm/provider.js";
import type { LLMImageInput } from "../llm/types.js";
import type { StageModelConfig } from "../domain/provider.js";
import { fingerprint } from "../utils/hash.js";
import { VISUAL_CHECK_INSTRUCTIONS, VISUAL_CHECK_PROMPT_VERSION } from "./visual-check-prompts.js";

export const artworkVisualCheckTargetSchema = visualSceneSelectionSchema.safeExtend({ versionId: z.string().min(1).max(200).optional() });
const finding = z.object({ status: z.enum(["match", "mismatch", "uncertain", "not_applicable"]), observation: z.string().min(1).max(1200) });
export const visualCheckResponseSchema = z.object({ summary: z.string().min(1).max(2000), identity: finding, creatureForm: finding, count: finding, signatureFeatures: finding, composition: finding });
export const visualCheckSchema = visualCheckResponseSchema.extend({ checkedAt: z.string().datetime(), imageFingerprint: z.string(), targetFingerprint: z.string(), promptVersion: z.string(), provider: z.string(), model: z.string(), requestId: z.string().optional() });
export type VisualCheck = z.infer<typeof visualCheckSchema>;
export const MAX_CHECK_IMAGE_BYTES = 16 * 1024 * 1024;
export async function readVisualCheckImage(path: string): Promise<{ image: LLMImageInput; fingerprint: string }> {
  const size = (await stat(path)).size;
  if (!size || size > MAX_CHECK_IMAGE_BYTES) throw new Error("Artwork is empty or exceeds the 16 MB visual-check image limit.");
  const data = await readFile(path);
  if (!data.length || data.length > MAX_CHECK_IMAGE_BYTES) throw new Error("Artwork exceeds the visual-check image limit.");
  if (!data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("Visual checks require a valid PNG artwork file.");
  return { image: { data, mimeType: "image/png" }, fingerprint: createHash("sha256").update(data).digest("hex") };
}
export function visualCheckTargetFingerprint(expected: string, referenceFingerprints: string[], model: StageModelConfig) {
  return fingerprint({ expected, referenceFingerprints, model, promptVersion: VISUAL_CHECK_PROMPT_VERSION });
}
export async function analyzeArtworkVisuals(options: { provider: LLMProvider; model: StageModelConfig; expected: string; images: LLMImageInput[]; imageFingerprint: string; targetFingerprint: string }): Promise<VisualCheck> {
  if (!options.provider.supportsImageInputs) throw new Error("The configured QA provider does not support image checks. Select an image-capable QA provider in book settings.");
  if (options.provider.name !== options.model.provider) throw new Error("Visual-check provider does not match the selected QA configuration.");
  if (!options.images.length || options.images.length > 5 || options.images.reduce((sum, image) => sum + image.data.length, 0) > 24 * 1024 * 1024) throw new Error("Visual-check image budget exceeded.");
  const response = await options.provider.generateStructured({ ...options.model, instructions: VISUAL_CHECK_INSTRUCTIONS, input: options.expected.slice(0, 64_000), images: options.images, schemaName: "artwork_visual_check", schema: visualCheckResponseSchema });
  return visualCheckSchema.parse({ ...response.value, checkedAt: new Date().toISOString(), imageFingerprint: options.imageFingerprint, targetFingerprint: options.targetFingerprint, promptVersion: VISUAL_CHECK_PROMPT_VERSION, provider: options.provider.name, model: options.model.model, requestId: response.usage?.requestId });
}
