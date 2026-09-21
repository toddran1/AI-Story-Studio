import { z } from "zod";

const bounded = (max: number) => z.string().trim().min(1).max(max);

export const visualContinuityFactProvenanceSchema = z.enum([
  "visual_profile",
  "story_bible",
  "story_timeline",
  "previous_scene",
  "previous_chapter",
  "current_narration",
  "scene_plan",
  "approved_artwork",
  "manual_override",
]);
export type VisualContinuityFactProvenance = z.infer<typeof visualContinuityFactProvenanceSchema>;

export const visualCharacterStateSchema = z.object({
  entityId: bounded(100).optional(),
  name: bounded(200),
  appearanceDelta: bounded(300).optional(),
  wardrobe: bounded(300).optional(),
  equipment: bounded(300).optional(),
  carriedItems: z.array(bounded(120)).max(10).optional(),
  injuries: bounded(300).optional(),
  condition: bounded(300).optional(),
  transformation: bounded(300).optional(),
  visibleEmotionalState: bounded(200).optional(),
  location: bounded(300).optional(),
});
export type VisualCharacterState = z.infer<typeof visualCharacterStateSchema>;

export const visualEnvironmentStateSchema = z.object({
  locationId: bounded(100).optional(),
  description: bounded(300).optional(),
  timeOfDay: bounded(100).optional(),
  lighting: bounded(200).optional(),
  weather: bounded(200).optional(),
  condition: bounded(300).optional(),
  damage: bounded(300).optional(),
});
export type VisualEnvironmentState = z.infer<typeof visualEnvironmentStateSchema>;

export const visualObjectStateSchema = z.object({
  name: bounded(200),
  condition: bounded(300).optional(),
  possessedBy: bounded(200).optional(),
});
export type VisualObjectState = z.infer<typeof visualObjectStateSchema>;

export const visualContinuityStateSchema = z.object({
  characters: z.array(visualCharacterStateSchema).max(30).default([]),
  environment: visualEnvironmentStateSchema.optional(),
  objects: z.array(visualObjectStateSchema).max(20).default([]),
  spatial: bounded(500).optional(),
});
export type VisualContinuityState = z.infer<typeof visualContinuityStateSchema>;

const characterStatePatchSchema = visualCharacterStateSchema.partial().omit({ name: true, entityId: true });
const environmentPatchSchema = visualEnvironmentStateSchema.partial();
const characterStateFields = Object.keys(visualCharacterStateSchema.shape).filter((key) => key !== "name" && key !== "entityId");
const environmentStateFields = Object.keys(visualEnvironmentStateSchema.shape);

/** Structured, current-narration-derived transition emitted by the scene planner. */
export const visualContinuityChangeSchema = z.object({
  characters: z.array(z.object({
    name: bounded(200),
    entityId: bounded(100).optional(),
    op: z.enum(["enter", "exit", "update"]),
    set: characterStatePatchSchema.optional(),
    clear: z.array(z.enum(characterStateFields as [string, ...string[]])).max(12).optional(),
  })).max(10).optional(),
  environment: z.object({
    set: environmentPatchSchema.optional(),
    clear: z.array(z.enum(environmentStateFields as [string, ...string[]])).max(8).optional(),
  }).optional(),
  objects: z.array(z.object({
    name: bounded(200),
    op: z.enum(["add", "remove", "update"]),
    set: visualObjectStateSchema.partial().omit({ name: true }).optional(),
  })).max(10).optional(),
  note: bounded(500).optional(),
});
export type VisualContinuityChange = z.infer<typeof visualContinuityChangeSchema>;

const nullishCharacterPatch = z.object({
  appearanceDelta: bounded(300).nullish(),
  wardrobe: bounded(300).nullish(),
  equipment: bounded(300).nullish(),
  carriedItems: z.array(bounded(120)).max(10).nullish(),
  injuries: bounded(300).nullish(),
  condition: bounded(300).nullish(),
  transformation: bounded(300).nullish(),
  visibleEmotionalState: bounded(200).nullish(),
  location: bounded(300).nullish(),
});
const nullishEnvironmentPatch = z.object({
  locationId: bounded(100).nullish(),
  description: bounded(300).nullish(),
  timeOfDay: bounded(100).nullish(),
  lighting: bounded(200).nullish(),
  weather: bounded(200).nullish(),
  condition: bounded(300).nullish(),
  damage: bounded(300).nullish(),
});

/** LLM-facing variant: strict structured-output APIs require every property to
 * be required-or-nullable, so optionality is expressed with null here and
 * normalized back into the canonical change shape at the boundary. */
export const visualContinuityChangeInputSchema = z.object({
  characters: z.array(z.object({
    name: bounded(200),
    entityId: bounded(100).nullish(),
    op: z.enum(["enter", "exit", "update"]),
    set: nullishCharacterPatch.nullish(),
    clear: z.array(z.enum(characterStateFields as [string, ...string[]])).max(12).nullish(),
  })).max(10).nullish(),
  environment: z.object({
    set: nullishEnvironmentPatch.nullish(),
    clear: z.array(z.enum(environmentStateFields as [string, ...string[]])).max(8).nullish(),
  }).nullish(),
  objects: z.array(z.object({
    name: bounded(200),
    op: z.enum(["add", "remove", "update"]),
    set: z.object({ condition: bounded(300).nullish(), possessedBy: bounded(200).nullish() }).nullish(),
  })).max(10).nullish(),
  note: bounded(500).nullish(),
});

const stripNulls = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== null && entry !== undefined).map(([key, entry]) => [key, stripNulls(entry)]));
  return value;
};

/** Normalize planner-emitted (nullable) deltas into the canonical change shape. */
export function normalizeVisualContinuityChange(raw: unknown): VisualContinuityChange | undefined {
  if (raw === null || raw === undefined) return undefined;
  const parsed = visualContinuityChangeSchema.safeParse(stripNulls(raw));
  return parsed.success ? parsed.data : undefined;
}

export const visualContinuityHandoffSchema = z.object({
  version: z.literal(1),
  chapter: z.number().int().positive(),
  state: visualContinuityStateSchema,
  source: z.object({ chapter: z.number().int().positive(), sceneId: z.string().regex(/^scene-\d{3}$/) }),
  stateFingerprint: z.string().min(1),
  referenceArtwork: z.object({
    sceneId: z.string().regex(/^scene-\d{3}$/),
    versionId: z.string().min(1),
    versionNumber: z.number().int().positive(),
    imageFingerprint: z.string().min(1),
  }).optional(),
  origin: z.enum(["automatic", "manual"]),
  updatedAt: z.string().datetime(),
});
export type VisualContinuityHandoff = z.infer<typeof visualContinuityHandoffSchema>;

const manualStatePatchSchema = z.object({
  characters: z.array(visualCharacterStateSchema.partial().required({ name: true })).max(30).optional(),
  environment: environmentPatchSchema.optional(),
  objects: z.array(visualObjectStateSchema.partial().required({ name: true })).max(20).optional(),
  spatial: bounded(500).optional(),
});

export const visualContinuityOverrideEntrySchema = z.object({
  sceneId: z.string().regex(/^scene-\d{3}$/),
  note: bounded(1000).optional(),
  setState: manualStatePatchSchema.optional(),
  usePreviousReference: z.enum(["prefer", "avoid"]).optional(),
  revision: z.number().int().nonnegative().default(1),
  updatedAt: z.string().datetime(),
  sceneContentFingerprint: z.string().optional(),
});
export type VisualContinuityOverrideEntry = z.infer<typeof visualContinuityOverrideEntrySchema>;

export const visualContinuityOverlaySchema = z.object({
  version: z.literal(1),
  entries: z.array(visualContinuityOverrideEntrySchema).max(100).default([]),
});
export type VisualContinuityOverlay = z.infer<typeof visualContinuityOverlaySchema>;

export type VisualContinuityReferenceDecision = {
  kind: "previous-scene" | "previous-chapter" | "none";
  used: boolean;
  reason?: string;
  sourceChapter?: number;
  sourceSceneId?: string;
  versionId?: string;
  versionNumber?: number;
  imageFingerprint?: string;
};

export type VisualContinuityDecision = {
  kind: "carried" | "overridden" | "dropped" | "manual";
  summary: string;
  provenance: VisualContinuityFactProvenance;
};

export type ResolvedSceneContinuity = {
  sceneId: string;
  startState: VisualContinuityState;
  changes?: VisualContinuityChange;
  endState: VisualContinuityState;
  factProvenance: Record<string, VisualContinuityFactProvenance>;
  referenceDecision?: VisualContinuityReferenceDecision;
  manualOverride?: { note?: string; usePreviousReference?: "prefer" | "avoid"; revision: number; stale: boolean };
};

/**
 * Provider-neutral resolved continuity package. This is the contract a future
 * generative-video provider would consume per scene: canonical visual refs plus
 * the resolved start state, the desired end state, the previous approved frame
 * (referenceDecision), scene direction, and art direction — no vendor specifics.
 */
export type ResolvedVisualContinuity = {
  perScene: ResolvedSceneContinuity[];
  chapterEndState: VisualContinuityState;
  decisions: VisualContinuityDecision[];
};

export type ContinuitySceneInput = {
  id: string;
  location?: string;
  visualChanges?: VisualContinuityChange;
  approvedArtwork?: { versionId: string; versionNumber: number; imageFingerprint: string };
  contentFingerprint?: string;
};

