import { z } from "zod";
import { fingerprint } from "../utils/hash.js";
import { sceneImportanceSchema, type Scene } from "./types.js";
import { sceneEditableState } from "./editable-state.js";

export const sceneRegenerationModeSchema = z.enum(["image_prompt", "full_visual_direction"]);
export const sceneVisualSnapshotSchema = z.object({
  summary: z.string().trim().min(1).max(1000),
  visualPrompt: z.string().trim().min(1).max(8000),
  characters: z.array(z.string().trim().min(1)).max(20),
  entityIds: z.array(z.string().trim().min(1)).max(100),
  location: z.string().max(300).optional(),
  importance: sceneImportanceSchema,
}).strict();
export const sceneRegenerationProposalSchema = z.object({
  sceneId: z.string().regex(/^scene-\d{3}$/),
  mode: sceneRegenerationModeSchema,
  sourceFingerprint: z.string().min(1),
  current: sceneVisualSnapshotSchema,
  proposed: sceneVisualSnapshotSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
}).strict();
export type SceneRegenerationProposal = z.infer<typeof sceneRegenerationProposalSchema>;

export function sceneVisualSnapshot(scene: Scene) {
  return sceneVisualSnapshotSchema.parse({
    summary: scene.summary, visualPrompt: scene.visualPrompt, characters: scene.characters,
    entityIds: scene.entityIds ?? [], location: scene.location, importance: scene.importance,
  });
}
export function sceneProposalSourceFingerprint(scene: Scene, continuityState?: unknown) {
  return fingerprint({
    scene: sceneEditableState(scene), narrationText: scene.narrationText,
    narrationStartWord: scene.narrationStartWord, narrationEndWord: scene.narrationEndWord,
    continuityState,
  });
}
