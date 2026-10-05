import type { CanonicalEntity } from "../domain/story-bible.js";
import type { VisualAppearanceEra, VisualEntityProfile } from "../domain/visual-profile.js";
import type { SceneCreatureGroup } from "../scenes/types.js";

/** Proposed labels are reviewed with the era; never infer a skeleton from death. */
export function proposedCreatureState(description: string): SceneCreatureGroup["state"] | undefined {
  if (/\bzombie\b|僵尸|殭屍/iu.test(description)) return "zombie";
  if (/\bskeleton\b|\bskeletal\b|\bbone (?:dragon|goblin|creature)\b|骨龙|骨龍|骷髅|骷髏/iu.test(description)) return "skeleton";
  if (/\bundead\b|亡灵|亡靈/iu.test(description)) return "undead";
  if (/\bcorpse\b|尸体|屍體/iu.test(description)) return "dead";
  return undefined;
}

/** Named individuals can reuse their approved chapter-era without a second form approval. */
export function matchingIndividualCreatureEra(profile: VisualEntityProfile | undefined, entity: CanonicalEntity, group: SceneCreatureGroup, chapter?: number, eraId?: string): VisualAppearanceEra | undefined {
  if (!profile || group.formId || (group.count ?? 1) > 1 || (profile.creatureIdentity ?? entity.visualIdentityKind) !== "individual" || (!chapter && !eraId)) return undefined;
  const era = profile.appearanceEras?.find(item => item.status === "approved" && (eraId ? item.id === eraId : item.startChapter <= chapter! && (item.endChapter === undefined || chapter! <= item.endChapter)));
  if (!era) return undefined;
  const state = era.creatureState ?? proposedCreatureState([era.appearance,era.visualPrompt,era.creature?.anatomy,era.creature?.species].filter(Boolean).join(" ")) ?? "living";
  return state === group.state || group.state === "undead" && ["zombie","skeleton"].includes(state) ? era : undefined;
}
