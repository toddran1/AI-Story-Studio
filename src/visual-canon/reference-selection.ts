import { z } from "zod";
import type { VisualReferenceImage } from "../domain/visual-profile.js";
import type { Scene } from "../scenes/types.js";

export const referenceApplicabilitySchema = z.object({
  fromChapter: z.number().int().positive().optional(), toChapter: z.number().int().positive().optional(),
  wardrobe: z.string().trim().max(1000).optional(), timeOfDay: z.string().trim().max(100).optional(),
  locationVariant: z.string().trim().max(500).optional(),
  activationTrigger: z.string().trim().min(1).max(300).optional(),
  state: z.enum(["baseline", "activated", "transformed"]).optional(),
}).refine(v => !v.fromChapter || !v.toChapter || v.toChapter >= v.fromChapter, "Reference end must follow its start chapter");
export type ReferenceContext = { chapter?: number; location?: string; wardrobe?: string; timeOfDay?: string; activeState?: boolean; activeAbilities?: string[]; transformation?: string; visibleEquipment?: string[]; text?: string };
export function referenceContext(scene: Scene, chapter?: number): ReferenceContext {
  return { chapter: scene.overrides?.appearanceChapter ?? chapter, location: scene.location, wardrobe: Object.values(scene.overrides?.wardrobeOverrides ?? {}).join(" ") || scene.visualChanges?.characters?.map(c => c.set?.wardrobe).filter(Boolean).join(" "), timeOfDay: scene.visualChanges?.environment?.set?.timeOfDay ?? scene.direction?.timeEnvironment, visibleEquipment: scene.visualChanges?.characters?.flatMap(c => c.set?.visibleEquipment ?? []), activeState: Boolean(scene.visualChanges?.characters?.some(c => c.set?.activeAbilities?.length || c.set?.transformation)), text: [scene.summary, scene.narrationText, scene.visualPrompt].filter(Boolean).join(" ") };
}
const matches = (a: string | undefined, b: string | undefined) => Boolean(a && b && (a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase())));
export function rankVisualReferences(refs: VisualReferenceImage[], context: ReferenceContext = {}) {
  return refs.filter(ref => ref.approved).map(ref => {
    const applicability = ref.applicability;
    const reasons: string[] = [];
    let eligible = true;
    let score = ref.role === "primary_reference" ? 300 : ["front", "face_portrait", "general_reference"].includes(ref.role) ? 70 : 40;
    if (applicability?.fromChapter && (context.chapter === undefined || context.chapter < applicability.fromChapter)) { eligible = false; reasons.push("Reference belongs to a later appearance"); }
    if (applicability?.toChapter && (context.chapter === undefined || context.chapter > applicability.toChapter)) { eligible = false; reasons.push("Reference is outside its chapter range"); }
    if (applicability?.state && applicability.state !== "baseline") {
      const trigger = applicability.activationTrigger;
      const states = applicability.state === "transformed" ? [context.transformation] : context.activeAbilities ?? [];
      if (!trigger || !states.some(state => matches(trigger, state))) {
        eligible = false;
        reasons.push(trigger ? "The required ability or transformation is not active in this frame" : "Conditional reference needs an explicit ability or transformation trigger");
      }
    }
    if (ref.role === "equipment_reference" && !(context.visibleEquipment ?? []).some(item => matches(applicability?.locationVariant ?? applicability?.wardrobe, item))) { eligible = false; reasons.push("Equipment is not established as visible"); }
    if (ref.role === "outfit_sheet" && !applicability?.wardrobe) { eligible = false; reasons.push("Outfit sheet needs a matching outfit label before automatic use"); }
    if (applicability?.wardrobe) {
      if (matches(applicability.wardrobe, context.wardrobe)) { score += 130; reasons.push("Matches the current outfit"); }
      else if (ref.role === "outfit_sheet") { eligible = false; reasons.push("Outfit is not established in this scene"); }
    }
    if (applicability?.timeOfDay) {
      if (matches(applicability.timeOfDay, context.timeOfDay)) { score += 120; reasons.push("Matches scene lighting/time"); }
      else if (ref.role === "environment_reference") { eligible = false; reasons.push("Lighting variant does not match the scene"); }
    }
    if (applicability?.locationVariant && ref.role === "environment_reference") {
      if (matches(applicability.locationVariant, context.location)) { score += 90; reasons.push("Matches the location variant"); }
      else { eligible = false; reasons.push("Location variant does not match the resolved setting"); }
    }
    if (!reasons.length) reasons.push(ref.role === "primary_reference" ? "Approved identity anchor" : "Approved supporting design");
    return { reference: ref, eligible, score, reason: reasons.join("; ") };
  }).sort((a,b) => b.score - a.score);
}
