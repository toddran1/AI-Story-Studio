import type { CharacterVisualDetails } from "../domain/visual-profile.js";

/** Shared editorial figure setting for scenes and reference sheets. */
export function characterFigureTrait(character: CharacterVisualDetails | undefined, matureStyling: boolean): string | undefined {
  if (!matureStyling || character?.gender?.trim().toLowerCase() !== "female") return undefined;
  const age = character.apparentAge?.trim() ?? "";
  const ageNumber = /^(?:about\s+|approximately\s+)?(\d+(?:\.\d+)?)(?:[\s-]*(?:years?[\s-]*old|years?|yrs?))?$/i.exec(age)?.[1];
  const numeric = ageNumber === undefined ? undefined : Number(ageNumber);
  if (numeric !== undefined && numeric < 18 || /\b(?:child|minor|teen(?:ager)?|adolescent|infant|baby|preteen)\b/i.test(age)) return undefined;
  if (character.figure === "larger") return "Figure: exaggerated very curvaceous with an especially full bust, hips, and big round butt that pokes out from a side angle view. Breast size should be a minimum of a DDD cup or F cup.";
  if (character.figure === "normal") return "Figure: curvaceous with a full bust, hips, and big round butt that pokes out from a side angle view. Breast size should be a minimum of a DD cup or E cup.";
  return undefined;
}
export function referenceFigureRequirement(character: CharacterVisualDetails | undefined, matureStyling: boolean): string | undefined {
  const trait = characterFigureTrait(character, matureStyling);
  if (!trait) return undefined;
  return `REQUIRED EDITORIAL FIGURE — ${character!.figure}: ${trait}\nThis selected figure is a required target-design feature. Lean, compact, petite or athletic describes height, conditioning or musculature; retain those traits together with the selected curvaceous silhouette, rather than replacing it with a narrow straight torso. Keep the selected chest, waist and hip proportions consistent and legible in the clothed front, three-quarter, side and back views. Preserve the person's face, hair, age, costume and identity. If an identity reference uses a different figure, preserve its face/hair but render this explicitly selected target figure. Do not use nudity, exaggerated camera angles or pose tricks to substitute for the specified anatomy. Unspecified age defaults to 21+ only in the absence of youth cues; minors remain excluded.`;
}
