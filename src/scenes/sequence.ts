import { z } from "zod";
import type { Scene } from "./types.js";

export const sceneSequenceSchema = z.object({
  id: z.string().trim().min(1).max(100),
  beat: z.enum(["establishing", "interaction", "reaction", "detail", "action", "transition"]),
  axis: z.string().trim().max(500).optional(),
  positions: z.array(z.object({ name: z.string().trim().min(1).max(200), position: z.enum(["left", "center", "right", "background", "foreground"]), facing: z.enum(["left", "right", "camera", "away", "unspecified"]), movement: z.string().trim().max(200).optional() })).max(20).default([]),
  rationale: z.string().trim().max(500).optional(),
});
export const sceneSequenceInputSchema = sceneSequenceSchema.extend({
  axis: z.string().trim().max(500).nullish(), rationale: z.string().trim().max(500).nullish(),
  positions: z.array(sceneSequenceSchema.shape.positions.unwrap().element.extend({ movement: z.string().trim().max(200).nullish() })).max(20).nullish(),
});
export function normalizeSequence(raw: unknown) {
  if (!raw) return undefined;
  const clean = (value: unknown): unknown => Array.isArray(value) ? value.map(clean) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([,v]) => v != null).map(([k,v]) => [k,clean(v)])) : value;
  return sceneSequenceSchema.parse(clean(raw));
}

/** Fill sequence metadata for legacy/planner-omitted beats, never infer a
 * character position or mutate an editorial choice. */
export function groupVisualSequences(scenes: Scene[]): Scene[] {
  let number = 0; let step = 0; let previousSequence: Scene["sequence"];
  let previousTime: string | undefined;
  const used = new Set(scenes.flatMap(scene => scene.sequence ? [scene.sequence.id] : []));
  return scenes.map((scene, index) => {
    const previous = scenes[index - 1];
    const explicitTime = scene.visualChanges?.environment?.set?.timeOfDay;
    const timeChanged = explicitTime && previousTime && explicitTime.trim().toLowerCase() !== previousTime.trim().toLowerCase();
    const newSequence = !previous || scene.location !== previous.location || (scene.visualChanges?.transition && scene.visualChanges.transition !== "continuous") || Boolean(timeChanged);
    if (newSequence || scene.visualChanges?.environment?.clear?.includes("timeOfDay")) previousTime = undefined;
    previousTime = explicitTime ?? previousTime;
    if (newSequence) { number++; step = 0; }
    const beats = ["establishing", "interaction", "reaction", "detail"] as const;
    let fallbackId = !newSequence && previousSequence ? previousSequence.id : `sequence-${number}`;
    while (newSequence && used.has(fallbackId)) fallbackId = `sequence-${++number}`;
    const sequence = scene.sequence ?? { id: fallbackId, beat: beats[Math.min(step, 3)]!, positions: [], rationale: "Grouped by continuous location and narrative time; positions remain unspecified." };
    used.add(sequence.id); previousSequence = sequence;
    step++;
    return { ...scene, sequence };
  });
}
export function sequencePrompt(scene: Scene): string {
  if (!scene.sequence) return "";
  const sequence = scene.sequence;
  return `VISUAL SEQUENCE ${sequence.id}: ${sequence.beat} frame. ${sequence.axis ? `Maintain screen axis: ${sequence.axis}.` : ""}\n${sequence.positions.map(p => `${p.name}: ${p.position}, facing ${p.facing}${p.movement ? `, movement ${p.movement}` : ""}`).join("\n")}\nKeep established geography, eyelines and screen direction consistent. This is a single still image, not a multi-panel composition.`;
}
