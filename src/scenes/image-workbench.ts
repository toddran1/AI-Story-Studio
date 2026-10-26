import { z } from "zod";
import { summaryIdSchema } from "../summaries/types.js";
import { fingerprint } from "../utils/hash.js";
import type { Scene } from "./types.js";
import type { ResolvedSceneContinuity } from "../visual-canon/continuity-state.js";
export const imageScopeSchema = z.object({ chapters: z.array(z.number().int().positive()).max(100).default([]), summaryId: summaryIdSchema.optional() }).strict().refine(v => v.summaryId ? v.chapters.length === 0 : v.chapters.length > 0, "Choose chapters or one summary");
export const imageStoryboardInputSchema = imageScopeSchema.safeExtend({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(40) });
export const imageAutomationSchema = z.object({
  scope: imageScopeSchema, planMissingScenes: z.boolean().default(true),
  budgetUsd: z.number().positive().max(10000).default(10), maxRequests: z.number().int().min(1).max(1000).default(50), maxRepairs: z.number().int().min(0).max(3).default(1),
  imageAllowanceUsd: z.number().positive().max(100).default(1), checkAllowanceUsd: z.number().positive().max(100).default(.25), planningAllowanceUsd: z.number().positive().max(100).default(.5),
}).strict();
export type ImageAutomation = z.infer<typeof imageAutomationSchema>;
export class ImageBudgetExceeded extends Error {}
export class ImageRunBudget {
  reservedUsd = 0; requests = 0;
  constructor(readonly config: ImageAutomation, private readonly persist: (state: { reservedUsd: number; requests: number }) => Promise<void> = async () => {}) {}
  async reserve(kind: "image" | "check" | "planning") {
    const cost = kind === "image" ? this.config.imageAllowanceUsd : kind === "check" ? this.config.checkAllowanceUsd : this.config.planningAllowanceUsd;
    if (this.requests >= this.config.maxRequests || this.reservedUsd + cost > this.config.budgetUsd + 1e-9) throw new ImageBudgetExceeded("Image run reached its request or reserved-cost limit. Increase the budget and preview a new run to continue.");
    this.requests++; this.reservedUsd = Math.round((this.reservedUsd + cost) * 1e9) / 1e9;
    await this.persist({ reservedUsd: this.reservedUsd, requests: this.requests });
  }
}
export type StoryboardFlag = { kind: "repetition" | "missing_character" | "abrupt_change" | "pacing" | "spatial"; message: string };
export function storyboardFlags(scene: Scene, previous?: Scene): StoryboardFlag[] {
  const flags: StoryboardFlag[] = [];
  if (previous && !scene.disabled && !previous.disabled) {
    if (fingerprint(scene.visualPrompt.toLowerCase()) === fingerprint(previous.visualPrompt.toLowerCase()) || (scene.sequence?.id === previous.sequence?.id && scene.sequence?.beat === previous.sequence?.beat && scene.direction?.shotType && scene.direction.shotType === previous.direction?.shotType)) flags.push({ kind: "repetition", message: "Adjacent frames repeat the image prompt or the same shot and visual beat." });
    if (scene.location !== previous.location && !scene.visualChanges?.environment && !scene.visualChanges?.transition) flags.push({ kind: "abrupt_change", message: "Location changes without an explicit environment transition." });
    if (scene.sequence?.id === previous.sequence?.id) for (const position of scene.sequence?.positions ?? []) {
      const before = previous.sequence?.positions.find(p => p.name === position.name);
      if (before && position.position !== before.position && !position.movement && scene.visualChanges?.transition !== "time_jump") flags.push({ kind: "spatial", message: `${position.name} changes screen position without recorded movement.` });
    }
  }
  if (scene.endSeconds - scene.startSeconds < 2) flags.push({ kind: "pacing", message: "Frame lasts less than two seconds; review its narration boundary." });
  for (const character of scene.characters) if (scene.narrationText && !scene.narrationText.toLowerCase().includes(character.toLowerCase()) && !scene.visualPrompt.toLowerCase().includes(character.toLowerCase())) flags.push({ kind: "missing_character", message: `${character} is in the cast but not named in the image prompt or narration span; check their visibility.` });
  return flags;
}
export function explainAppearance(scene: Scene, state: ResolvedSceneContinuity | undefined) {
  const facts: Array<{ subject: string; field: string; value: unknown; source: string; passage?: string }> = [];
  for (const character of state?.endState.characters ?? []) {
    const delta = state?.changes?.characters?.find(c => c.name === character.name);
    for (const [field,value] of Object.entries(character)) if (!["name", "entityId"].includes(field)) {
      const override = (character.entityId ? scene.overrides?.wardrobeOverrides?.[character.entityId] : undefined) ?? scene.overrides?.wardrobeOverrides?.[character.name];
      const changed = delta?.set && field in delta.set;
      const manual = state?.manualOverride?.fields?.includes(`characters.${character.name}.${field}`);
      facts.push({ subject: character.name, field, value: field === "wardrobe" && override ? override : value, source: field === "wardrobe" && override ? "Scene wardrobe override" : manual ? "Manual continuity override" : changed ? "Current scene plan; compare with the supporting narration" : "Inherited continuity", passage: changed && !manual && !(field === "wardrobe" && override) ? scene.narrationText : undefined });
    }
    if (!character.activeAbilities?.length && !character.transformation) facts.push({ subject: character.name, field: "abilities", value: "Use normal inactive appearance; no active ability is established in the resolved frame", source: "Resolved scene state" });
    if (character.concealedItems?.length) facts.push({ subject: character.name, field: "visibility", value: `Omit concealed items: ${character.concealedItems.join(", ")}`, source: "Resolved scene state" });
  }
  for (const [field,value] of Object.entries(state?.endState.environment ?? {})) {
    const manual = state?.manualOverride?.fields?.includes(`environment.${field}`);
    const changed = state?.changes?.environment?.set && field in state.changes.environment.set;
    facts.push({ subject: scene.location ?? "Environment", field, value, source: manual ? "Manual continuity override" : changed ? "Current scene plan" : "Inherited environment", passage: changed && !manual ? scene.narrationText : undefined });
  }
  for (const [name,value] of Object.entries(scene.overrides?.wardrobeOverrides ?? {})) if (!facts.some(f => (f.subject === name || state?.endState.characters.some(c => c.entityId === name && c.name === f.subject)) && f.field === "wardrobe")) facts.push({ subject: name, field: "wardrobe", value, source: "Scene wardrobe override" });
  for (const object of state?.endState.objects ?? []) facts.push({ subject: object.name, field: "object", value: [object.condition, object.possessedBy && `held by ${object.possessedBy}`].filter(Boolean).join("; ") || "Present", source: state?.changes?.objects?.some(o => o.name === object.name) ? "Current scene plan" : "Inherited continuity" });
  if (state?.endState.spatial) facts.push({ subject: "Scene geography", field: "positions / screen direction", value: state.endState.spatial, source: scene.sequence?.positions.length || scene.sequence?.axis ? "Current sequence plan" : "Inherited continuity" });
  return facts;
}
