import type { CharacterVisualDetails } from "../domain/visual-profile.js";

/** Identity references are not evidence of the state of a narrated frame. */
export const NARRATIVE_APPEARANCE_POLICY = `NARRATIVE APPEARANCE AND VISIBILITY: Preserve each character's recognizable face, age, body proportions and baseline physical identity. References establish identity, not mandatory costumes, equipment, poses, injuries or activated powers. Resolve attire from the current narrative, location, weather, time and activity, then inherited continuity, then profile defaults. Adapt unspecified clothing to the setting without contradicting stated clothing or inventing an off-screen costume change. Keep established outfits and their damage consistent across continuous scenes and chapters until a supported change, time jump or manual override. Owning a weapon, accessory, item or ability does not make it visible: show only equipment worn, held, used, or explicitly visible in this frame. Stored, sheathed, concealed or off-screen items must not appear drawn or in use. A known ability is not an active effect. Conditional eye/skin/hair changes, auras, transformations and supernatural features appear only when the current scene establishes their trigger; otherwise use the normal inactive appearance. Never apply a temporary observation from another scene or a later chapter to the current frame. In a recap, resolve each beat at its own narrated time, not from the final chapter's state. If baseline appearance is unknown, leave it unspecified rather than using an activated form as the default.`;

export const REFERENCE_BASELINE_POLICY = `REFERENCE BASELINE: Render the ordinary inactive identity in neutral clothing from the saved baseline design. Conditional appearance notes describe rules, not features to activate in this reference. Do not depict skill effects, transformed eyes, auras or battle states unless this specific reference request explicitly targets that state. Use the normal eye/skin/hair appearance; if unknown, do not invent a canonical baseline. Weapons, accessories and equipment are available design information, not required props. Omit held weapons and active abilities from a standard identity sheet; an equipment reference may show its requested gear. Keep any target-specific form or appearance-era request authoritative.`;

const conditionalCue = /\b(?:when|while|only\s+(?:when|during)|during|upon)\b[^.!?\n]{0,160}\b(?:activat\w*|cast\w*|using|uses|skill|abilit\w*|power|transform\w*|disguis\w*|combat|battle|enrag\w*)\b|\b(?:skill|ability|power)[^.!?\n]{0,70}\b(?:active|activated|activation)\b|(?:发动|發動|施展|激活|啟動|开启|開啟|催动|催動).{0,60}(?:技能|能力|时|時)/iu;
export function hasConditionalAppearance(value: string): boolean { return conditionalCue.test(value); }

/** Move explicit activation rules out of baseline fields without guessing a
 * replacement colour or discarding the user's description. Safe for old files. */
export function normalizeCharacterAppearance(character: CharacterVisualDetails | undefined): CharacterVisualDetails | undefined {
  if (!character) return character;
  const next = { ...character };
  const rules = [next.conditionalAppearance].filter((s): s is string => Boolean(s?.trim()));
  for (const field of ["eyeColor", "hairColor", "skinTone", "distinguishingFeatures"] as const) {
    const value = next[field];
    if (value && hasConditionalAppearance(value)) {
      const rule = `${field}: ${value}`;
      if (!rules.some(existing => existing.includes(rule))) rules.push(rule);
      delete next[field];
    }
  }
  if (rules.length) next.conditionalAppearance = rules.join("\n").slice(0, 5000);
  return next;
}

export function isConditionalVisualObservation(item: { field: string; value: string; condition?: string; excerpt?: string; provenance?: Array<{ excerpt: string }> }): boolean {
  if (item.field === "character.conditionalAppearance") return false;
  if (!/^character\.(?:eyeColor|hairColor|skinTone|distinguishingFeatures|additionalAppearanceNotes)$/.test(item.field)) return false;
  if (item.condition || hasConditionalAppearance(item.value)) return true;
  if (/\b(?:normally|baseline|inactive|natural(?:ly)?)\b|平时|平時|通常|正常/.test(item.value)) return false;
  return [item.excerpt, ...(item.provenance ?? []).map(p => p.excerpt)].some(excerpt => Boolean(excerpt && hasConditionalAppearance(excerpt) && /\b(?:turn(?:s|ed)?|becom(?:e|es|ing)|became|chang(?:e|es|ed)|glow(?:s|ed)?)\b|变成|變成|化为|化為|变得|變得|转为|轉為/i.test(excerpt)));
}

/** Bounded planning context: profile rules inform the plan but never invent
 * visible props or override the narrated moment. */
export function visualPlanningContext(
  profiles: Record<string, import("../domain/visual-profile.js").VisualEntityProfile>,
  bible: import("../domain/story-bible.js").StoryBible,
  chapter: number,
): string {
  const rows = bible.canonicalEntities.slice(0, 40).flatMap(entity => {
    const profile = profiles[entity.id];
    const character = normalizeCharacterAppearance(profile?.character);
    const conditional = entity.visualEvidence?.filter(item => item.chapter <= chapter && isConditionalVisualObservation(item)).slice(-5).map(item => ({ field: item.field, value: item.value, condition: item.condition, chapter: item.chapter }));
    if (!character && !conditional?.length) return [];
    return [{ entityId: entity.id, name: entity.canonicalName, status: profile?.status,
      normalEyes: character?.eyeColor, baselineOutfit: character?.defaultOutfit, footwear: character?.shoes,
      conditionalAppearance: character?.conditionalAppearance, conditionalEvidence: conditional,
      availableEquipmentNotAutomaticallyVisible: [character?.weapons, character?.accessories, character?.equipment].filter(Boolean),
      appearanceEras: profile?.appearanceEras?.filter(era => era.status === "approved" && era.startChapter <= chapter).map(era => ({ startChapter: era.startChapter, endChapter: era.endChapter, character: normalizeCharacterAppearance(era.character) })),
    }];
  });
  return JSON.stringify(rows).slice(0, 16000);
}
