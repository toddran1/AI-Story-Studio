import { z } from "zod";
import { canonicalEntitySchema } from "../domain/story-bible.js";
import { summaryIdSchema } from "../summaries/types.js";
import type { Scene } from "../scenes/types.js";
export const visualSceneSelectionSchema = z.object({ chapter: z.number().int().positive().optional(), summaryId: summaryIdSchema.optional(), sceneId: z.string().regex(/^scene-\d{3}$/) }).strict().refine(item => !!item.chapter !== !!item.summaryId, { message: "Select a chapter or a summary" });
export const visualRegenerationInputSchema = z.object({ entityId: canonicalEntitySchema.shape.id, selection: z.array(visualSceneSelectionSchema).min(1).max(100), includeProtected: z.boolean().default(false) }).strict();
export function visualSceneKey(item: { chapter?: number; summaryId?: string; sceneId: string }) { return `${item.chapter ? `chapter:${item.chapter}` : `summary:${item.summaryId}`}:${item.sceneId}`; }
export function artworkIsProtected(scene: Scene) { return scene.artwork.review === "approved" || !!scene.artwork.approvedVersionId || !!scene.artwork.manuallyEdited; }
