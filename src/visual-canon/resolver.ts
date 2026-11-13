import { referenceContext } from "./reference-selection.js";
import { sequencePrompt } from "../scenes/sequence.js";
import { NARRATIVE_APPEARANCE_POLICY, normalizeCharacterAppearance } from "./appearance-policy.js";
import { characterFigureTrait } from "./figure-guidance.js";
import { FALLBACK_CHARACTER_DESIGN_GUIDANCE, MATURE_FALLBACK_FEMALE_GUIDANCE } from "./character-design.js";
import { matchingIndividualCreatureEra } from "./creature-look.js";
import { CanonicalEntity, StoryBible } from "../domain/story-bible.js";
import { Story } from "../domain/story.js";
import { ArtDirectionPreset } from "../domain/art-direction.js";
import { isSceneAppearanceLook, VisualAppearanceEra, VisualEntityProfile, VisualReferenceImage } from "../domain/visual-profile.js";
import { Scene, SceneDirection, SceneOverrides, SceneCreatureGroup, sceneDirectionSchema, sceneOverridesSchema } from "../scenes/types.js";
import { resolveVisualEntities } from "../scenes/identity.js";
import { fingerprint } from "../utils/hash.js";
import { artworkCompositionGuidance, resolveArtworkAspectRatio } from "../artwork/composition.js";
import { resolveEntityVisualEvidence } from "../story-bible/visual-evidence.js";
import { resolveVisualEntityType, readVisualField } from "./fields.js";

export type ResolvedEntityCanon = {
  entityId: string;
  name: string;
  type: string;
  hasApprovedProfile: boolean;
  profileRevision?: number;
  appearanceEra?: { id: string; name: string; startChapter: number; endChapter?: number };
  description: string;
  wardrobe?: string;
  weapons?: string;
  visualPrompt?: string;
  references?: VisualReferenceImage[];
  useVisualProfile: boolean;
  groundingMode: "approved_profile" | "story_bible_fallback" | "profile_disabled";
};

export type ResolvedSceneVisualPrompt = {
  prompt: string;
  negativePrompt: string;
  artDirectionFingerprint: string;
  entityVisualFingerprints: Record<string, string>;
  sceneDirectionFingerprint: string;
  resolvedPromptFingerprint: string;
  visualContinuityFingerprint?: string;
  resolvedEntities: ResolvedEntityCanon[];
  referenceContextByEntity?: Record<string, import("./reference-selection.js").ReferenceContext>;
  referenceContext?: import("./reference-selection.js").ReferenceContext;
};

/** Fingerprint the effective direction rather than the serialized shape. The
 * editor writes defaults explicitly while older scenes may omit them; those
 * representations produce the same prompt and must therefore share a cache
 * identity. */
export function normalizeSceneDirectionForFingerprint(raw: SceneDirection | undefined): Record<string, unknown> {
  const direction = sceneDirectionSchema.parse(raw ?? {});
  const normalized: Record<string, unknown> = { ...direction };
  const characterExpressions = Object.fromEntries(Object.entries(direction.characterExpressions).filter(([, value]) => value.trim()));
  if (!Object.keys(characterExpressions).length) delete normalized.characterExpressions;
  else normalized.characterExpressions = characterExpressions;
  for (const key of ["useCharacterReferences", "useCreatureReferences", "useLocationReferences", "preserveWardrobeEquipment", "useStoryArtDirection"] as const) {
    if (direction[key]) delete normalized[key];
  }
  for (const key of ["lighting"] as const) if (!direction[key]?.trim()) delete normalized[key];
  return normalized;
}

/** Omitted inheritance and empty editor scaffolding are equivalent to the
 * default scene behavior. Meaningful pins and opt-outs remain fingerprinted. */
export function normalizeSceneOverridesForFingerprint(raw: SceneOverrides | undefined): Record<string, unknown> {
  const overrides = sceneOverridesSchema.parse(raw ?? {});
  const normalized: Record<string, unknown> = { ...overrides };
  const wardrobeOverrides = Object.fromEntries(Object.entries(overrides.wardrobeOverrides).filter(([, value]) => value.trim()));
  if (!Object.keys(wardrobeOverrides).length) delete normalized.wardrobeOverrides;
  else normalized.wardrobeOverrides = wardrobeOverrides;
  const appearanceEraOverrides = Object.fromEntries(Object.entries(overrides.appearanceEraOverrides ?? {}).filter(([, value]) => value.trim()));
  if (!Object.keys(appearanceEraOverrides).length) delete normalized.appearanceEraOverrides;
  else normalized.appearanceEraOverrides = appearanceEraOverrides;
  if (overrides.artDirectionMode === "inherit-summary") delete normalized.artDirectionMode;
  if (!overrides.customVisualPrompt?.trim()) delete normalized.customVisualPrompt;
  if (!overrides.customNegativePrompt?.trim()) delete normalized.customNegativePrompt;
  return normalized;
}

/**
 * Keep identity canon separate from a character's temporary state. This is
 * deliberately prompt-level guidance: scene narration and editorial overrides
 * are evidence for this one image, never a reason to mutate the profile.
 */
export const SCENE_STATE_PRIORITY_INSTRUCTION =
  NARRATIVE_APPEARANCE_POLICY + "\nSCENE-STATE PRIORITY: Preserve Story Bible identity and approved Visual Profile traits such as face, age, build, hair, eyes, and permanent distinguishing features. Treat profile attire, footwear, accessories, weapons, and equipment as defaults only. Current visual continuity, the current scene, scene direction, and explicit scene overrides take precedence for temporary clothing, injuries, blood, dirt, damage, equipment, pose, expression, and environmental effects. Do not infer a change from an omitted detail.";

// export const MATURE_ARTWORK_STYLING =
//   "MATURE CHARACTER STYLING: Clearly adult female characters have a seductive, alluring look with curvaceous figures, full busts and shapely hips. Keep it tasteful — alluring and elegant, never explicit or nude. Depict blood, injuries, and battle violence when the scene calls for it.";
export const MATURE_ARTWORK_STYLING =
  "MATURE CHARACTER STYLING: Clearly adult female characters have a seductive, alluring look with curvaceous figures, full busts and shapely hips. Preserve established figure choices; For unspecified-age women with no youth cues, use an adult 21+ rendering default; never apply this styling to minors or characters with child or adolescent cues. Keep it tasteful — alluring and elegant. Keep subjects clothed and non-explicit. Depict blood, injuries, and battle violence when the scene calls for it.";

export function resolveApprovedAppearanceEra(profile: VisualEntityProfile, chapter: number): VisualAppearanceEra | undefined {
  return profile.appearanceEras?.find((era) => era.status === "approved" && !isSceneAppearanceLook(era) && era.startChapter <= chapter && (era.endChapter === undefined || chapter <= era.endChapter));
}

export function effectiveVisualProfile(profile: VisualEntityProfile, era: VisualAppearanceEra | undefined): VisualEntityProfile {
  if (!era) {
    const assigned = new Set([...(profile.appearanceEras?.flatMap((item) => item.referenceIds) ?? []), ...(profile.creatureForms?.flatMap(form => form.referenceIds) ?? [])]);
    return { ...profile, references: profile.references.filter((reference) => !assigned.has(reference.id)) };
  }
  const referenceIds = new Set(era.referenceIds);
  const hasEraText = Boolean(era.appearance.trim() || era.visualPrompt.trim());
  if (era.wardrobeEvidence?.length) {
    return {
      ...profile, appearance: era.appearance, visualPrompt: era.visualPrompt, negativePrompt: era.negativePrompt ?? "",
      character: { ...profile.character, defaultOutfit: era.character?.defaultOutfit, shoes: era.character?.shoes, accessories: era.character?.accessories },
      references: profile.references.filter(reference => referenceIds.has(reference.id)),
    };
  }
  const characterChanges = era.character && Object.keys(era.character).length ? era.character : undefined;
  const creatureChanges = era.creature && Object.keys(era.creature).length ? era.creature : undefined;
  return {
    ...profile,
    appearance: era.sceneAliases?.length ? [profile.appearance, era.appearance].filter(Boolean).join("\n") : era.appearance,
    visualPrompt: era.sceneAliases?.length ? [profile.visualPrompt, era.visualPrompt].filter(Boolean).join("\n") : era.visualPrompt,
    negativePrompt: era.negativePrompt ?? "",
    character: profile.visualType === "character" ? hasEraText && !era.sceneAliases?.length ? characterChanges : profile.character ? { ...profile.character, ...(characterChanges ? { additionalAppearanceNotes: undefined } : {}), ...characterChanges } : characterChanges : undefined,
    creature: profile.visualType === "creature" ? hasEraText ? creatureChanges : profile.creature ? { ...profile.creature, ...(creatureChanges ? { canonicalCreaturePrompt: undefined } : {}), ...creatureChanges } : creatureChanges : undefined,
    references: profile.references.filter((reference) => referenceIds.has(reference.id)),
  };
}


/** The one authoritative definition of entities visibly represented by a scene.
 * It intentionally uses scene identity fields only—not broad narration matching—
 * so preflight and prompt resolution cannot disagree about who is on screen. */
export function sceneAppearanceLook(scene: Scene, profile: VisualEntityProfile, chapter?: number) {
  const explicit = scene.overrides?.appearanceEraOverrides?.[profile.entityId];
  if (explicit) return profile.appearanceEras?.find(era => era.id === explicit && isSceneAppearanceLook(era));
  const cast = new Set(scene.characters.map(name => name.trim().toLowerCase()));
  const matches = profile.appearanceEras?.filter(era => era.sceneAliases?.some(alias => cast.has(alias.toLowerCase()))
    && (chapter === undefined || (era.startChapter <= chapter && (era.endChapter === undefined || chapter <= era.endChapter)))) ?? [];
  if (matches.length > 1) throw new Error("Several scene looks match the cast. Select the intended appearance in the scene preview.");
  return matches[0];
}

function sceneCast(scene: Scene, bible: StoryBible, profiles: Record<string, VisualEntityProfile>, chapter?: number) {
  const cast = new Map<string, { name: string; entityId?: string }>();
  for (const name of scene.characters) {
    const roleOwner = bible.canonicalEntities.find(entity => profiles[entity.id] && sceneAppearanceLook(scene, profiles[entity.id]!, chapter)?.sceneAliases?.some(alias => alias.toLowerCase() === name.trim().toLowerCase()));
    const person = roleOwner ?? resolveVisualEntities([name], bible.canonicalEntities).find(entity => entity.type === "character");
    const actor = { name, entityId: person?.id };
    cast.set(name.trim().toLowerCase(), actor);
    if (person) {
      cast.set(person.id, actor);
      cast.set(person.canonicalName.toLowerCase(), actor);
    }
  }
  return cast;
}

function sceneEquipmentEntities(bible: StoryBible, profiles: Record<string, VisualEntityProfile>) {
  return bible.canonicalEntities.filter(entity =>
    entity.type !== "ability" && ["item", "weapon", "object"].includes(resolveVisualEntityType(entity, profiles[entity.id])));
}

export function wornSceneItems(
  scene: Scene, bible: StoryBible, profiles: Record<string, VisualEntityProfile>, chapter?: number,
  frameState?: import("./continuity-state.js").VisualContinuityState,
) {
  const cast = sceneCast(scene, bible, profiles, chapter);
  const items = new Map<string, { entity: CanonicalEntity; wearer: string; wearerId?: string }>();
  const recorded = new Set<string>();
  const equipment = sceneEquipmentEntities(bible, profiles);
  const resolveItem = (name: string) => resolveVisualEntities([name], equipment)[0];
  const concealedBy = new Map<string, Set<string>>();
  for (const character of sceneCharacterFacts(scene, frameState)) {
    const actor = cast.get(character.entityId ?? "") ?? cast.get(character.name.trim().toLowerCase());
    if (actor && character.concealedItems?.length) {
      const ids = concealedBy.get(actor.name) ?? new Set<string>();
      for (const item of resolveVisualEntities(character.concealedItems, equipment)) ids.add(item.id);
      concealedBy.set(actor.name, ids);
    }
  }
  for (const delta of scene.visualChanges?.objects ?? []) {
    if (delta.op !== "remove") continue;
    const entity = resolveItem(delta.entityId ?? delta.name);
    if (entity) recorded.add(entity.id);
  }
  const objects = frameState?.objects ?? (scene.visualChanges?.objects ?? []).filter(delta => delta.op !== "remove").map(delta => ({ name: delta.name, entityId: delta.entityId, wornBy: delta.clearWornBy ? null : delta.set?.wornBy }));
  for (const object of objects) {
    if (object.wornBy === undefined) continue;
    const entity = resolveItem(object.entityId ?? object.name);
    if (!entity) continue;
    recorded.add(entity.id);
    const wearer = object.wornBy && cast.get(object.wornBy.trim().toLowerCase());
    if (wearer && !concealedBy.get(wearer.name)?.has(entity.id)) items.set(entity.id, { entity, wearer: wearer.name, wearerId: wearer.entityId });
  }
  for (const entity of bible.canonicalEntities) {
    const profile = profiles[entity.id];
    if (!profile) continue;
    const look = sceneAppearanceLook(scene, profile, chapter);
    if (!look) continue;
    const wearer = cast.get(entity.id);
    if (!wearer) continue;
    for (const itemId of look.wornItemIds ?? []) {
      const item = resolveItem(itemId);
      if (item && !recorded.has(item.id) && !concealedBy.get(wearer.name)?.has(item.id)) items.set(item.id, { entity: item, wearer: wearer.name, wearerId: wearer.entityId });
    }
  }
  return [...items.values()];
}

export function hasWornLookItems(look: VisualAppearanceEra, wearerId: string, worn: ReturnType<typeof wornSceneItems>) {
  return (look.wornItemIds ?? []).every(id => worn.some(item => item.wearerId === wearerId && item.entity.id === id));
}

function sceneCharacterFacts(scene: Scene, frameState?: import("./continuity-state.js").VisualContinuityState) {
  return frameState?.characters ?? (scene.visualChanges?.characters ?? [])
    .filter(delta => delta.op !== "exit")
    .map(delta => ({ name: delta.name, entityId: delta.entityId, ...delta.set }));
}

function visibleSceneEquipment(
  scene: Scene, bible: StoryBible, profiles: Record<string, VisualEntityProfile>, chapter?: number,
  frameState?: import("./continuity-state.js").VisualContinuityState,
) {
  const characters = sceneCharacterFacts(scene, frameState);
  if (!characters.some(character => character.visibleEquipment?.length)) return [];
  const cast = sceneCast(scene, bible, profiles, chapter);
  const equipment = sceneEquipmentEntities(bible, profiles);
  const items = new Map<string, { entity: CanonicalEntity; holder: string }>();
  for (const character of characters) {
    const holder = cast.get(character.entityId ?? "") ?? cast.get(character.name.trim().toLowerCase());
    if (!holder || !character.visibleEquipment?.length) continue;
    const concealed = new Set(resolveVisualEntities(character.concealedItems ?? [], equipment).map(item => item.id));
    for (const entity of resolveVisualEntities(character.visibleEquipment, equipment)) {
      if (!concealed.has(entity.id)) items.set(entity.id, { entity, holder: holder.name });
    }
  }
  return [...items.values()];
}

function visibleSceneEffects(
  scene: Scene, bible: StoryBible, profiles: Record<string, VisualEntityProfile>, chapter?: number,
  frameState?: import("./continuity-state.js").VisualContinuityState,
) {
  const characters = sceneCharacterFacts(scene, frameState);
  if (!characters.some(character => character.visibleEffects?.length)) return [];
  const cast = sceneCast(scene, bible, profiles, chapter);
  const canon = bible.canonicalEntities.filter(entity => entity.type === "ability" || entity.type === "concept");
  const effects = new Map<string, { entity: CanonicalEntity; actors: Set<string>; ability: boolean; transformation: boolean }>();
  for (const character of characters) {
    const actor = cast.get(character.entityId ?? "") ?? cast.get(character.name.trim().toLowerCase());
    if (!actor || !character.visibleEffects?.length) continue;
    const active = new Set(resolveVisualEntities(character.activeAbilities ?? [], canon).map(entity => entity.id));
    const form = character.transformation && resolveVisualEntities([character.transformation], canon)[0];
    for (const entity of resolveVisualEntities(character.visibleEffects, canon)) {
      const ability = active.has(entity.id);
      const transformation = Boolean(form && form.id === entity.id);
      if (!ability && !transformation) continue;
      const effect = effects.get(entity.id) ?? { entity, actors: new Set<string>(), ability: false, transformation: false };
      effect.actors.add(actor.name);
      effect.ability ||= ability;
      effect.transformation ||= transformation;
      effects.set(entity.id, effect);
    }
  }
  return [...effects.values()];
}

export function resolveVisuallyRelevantCanonicalEntities(scene: Scene, bible: StoryBible, profiles?: Record<string, VisualEntityProfile>, chapter?: number, frameState?: import("./continuity-state.js").VisualContinuityState): CanonicalEntity[] {
  const matchedEntities = new Map<string, CanonicalEntity>();
  const lookOwners = new Map<string, string>();
  const cast = profiles && sceneCast(scene, bible, profiles, scene.overrides?.appearanceChapter ?? chapter);
  if (profiles) for (const entity of bible.canonicalEntities) {
    const profile = profiles[entity.id];
    const look = profile && sceneAppearanceLook(scene, profile, scene.overrides?.appearanceChapter ?? chapter);
    if (!look || (!cast?.has(entity.id) && !look.sceneAliases?.some(alias => cast?.has(alias.toLowerCase())))) continue;
    for (const alias of look.sceneAliases ?? []) {
      const key = alias.toLowerCase();
      if (!scene.characters.some(name => name.trim().toLowerCase() === key)) continue;
      if (lookOwners.has(key) && lookOwners.get(key) !== entity.id) throw new Error(`Scene name “${alias}” matches several character profiles.`);
      lookOwners.set(key, entity.id);
    }
    matchedEntities.set(entity.id, entity);
  }
  for (const id of scene.entityIds ?? []) {
    const found = bible.canonicalEntities.find((entity) => entity.id === id || entity.mergedFromIds?.includes(id));
    // An attached ID is explicit visual evidence only for things an image can
    // depict directly. Context-only concepts, abilities, and organizations do
    // not become on-screen just because planning linked them to the scene.
    if (found && found.type !== "ability" && ["character", "creature", "item", "weapon", "object"].includes(resolveVisualEntityType(found))) matchedEntities.set(found.id, found);
  }
  for (const entity of resolveVisualEntities(scene.characters.filter(name => !lookOwners.has(name.trim().toLowerCase())), bible.canonicalEntities)) {
    if (["character", "creature"].includes(resolveVisualEntityType(entity))) matchedEntities.set(entity.id, entity);
  }
  for (const group of scene.creatureGroups ?? []) {
    const entity = resolveVisualEntities([group.entity], bible.canonicalEntities)[0];
    if (!entity || resolveVisualEntityType(entity) !== "creature") throw new Error(`Creature group '${group.label}' does not resolve to a canonical creature: ${group.entity}`);
    matchedEntities.set(entity.id, entity);
  }
  if (scene.location) {
    const normalizedLocation = scene.location.trim().toLowerCase();
    const location = bible.canonicalEntities.find((entity) => entity.type === "location" && (
      entity.canonicalName.toLowerCase() === normalizedLocation ||
      entity.aliases.some((alias) => alias.toLowerCase() === normalizedLocation) ||
      entity.originalName?.toLowerCase() === normalizedLocation
    ));
    if (location) matchedEntities.set(location.id, location);
  }
  if (profiles) {
    const effectiveChapter = scene.overrides?.appearanceChapter ?? chapter;
    for (const { entity } of wornSceneItems(scene, bible, profiles, effectiveChapter, frameState)) matchedEntities.set(entity.id, entity);
    for (const { entity } of [
      ...visibleSceneEquipment(scene, bible, profiles, effectiveChapter, frameState),
      ...visibleSceneEffects(scene, bible, profiles, effectiveChapter, frameState),
    ]) {
      const profile = profiles[entity.id];
      if (profile?.status === "approved" && profile.references.some(ref => ref.approved)) matchedEntities.set(entity.id, entity);
    }
  }
  return [...matchedEntities.values()];
}

/** Shared policy for both preflight and prompt resolution. When a scene turns
 * off a profile category, its Story Bible description remains available but no
 * profile or reference-image decision is required. */
export function shouldUseVisualProfileForEntity(scene: Scene, entity: CanonicalEntity): boolean {
  if (entity.type === "character") return scene.direction?.useCharacterReferences !== false;
  if (resolveVisualEntityType(entity) === "creature") return scene.direction?.useCreatureReferences !== false;
  if (entity.type === "location") return scene.direction?.useLocationReferences !== false;
  return true;
}

/** Avoid passing obviously mixed identity/presentation prose when structured
 * character identity is unavailable. We discard the whole legacy field rather
 * than attempting brittle regex edits that might damage identity details. */
function legacyCharacterTextLooksLikePresentation(text: string): boolean {
  const tokens = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return [
    "outfit", "clothing", "clothes", "wear", "wears", "wearing", "dressed", "attire",
    "robe", "coat", "jacket", "shirt", "dress", "pants", "trousers", "boots", "shoes",
    "armor", "armour", "uniform", "cloak", "gloves", "hat", "helmet", "accessory", "accessories",
    "weapon", "weapons", "sword", "staff", "rifle", "bow", "dagger", "spear", "shield",
    "equipment", "gear", "pack", "satchel", "amulet", "necklace", "ring", "belt",
  ].some((term) => tokens.has(term));
}

/** Canonical descriptions accumulate plot history as a story grows. An image
 * prompt needs the character's identity and visible traits, not thousands of
 * later events (often repeating another character's name and appearance). */
export function fallbackArtworkDescription(description: string): string {
  const sentences = description.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const appearance = sentences.slice(2).find((sentence) =>
    /^(?:he|she|they|his|her|their)\b/i.test(sentence) &&
    /\b(?:hair|eyes|face|skin|complexion|build|height|tall|wears|wearing|outfit|clothing|attire|scar|beard)\b/i.test(sentence)
  );
  const concise = [...sentences.slice(0, 2), ...(appearance ? [appearance] : [])].join(" ");
  if (concise.length <= 650) return concise;
  const clipped = concise.slice(0, 650);
  return clipped.slice(0, Math.max(clipped.lastIndexOf(" "), 0)).trimEnd();
}

export function resolveVisualCanonPrompt(options: {
  scene: Scene;
  story: Story;
  bible: StoryBible;
  artDirection: ArtDirectionPreset;
  visualProfiles: Record<string, VisualEntityProfile>;
  visualContinuity?: string;
  frameState?: import("./continuity-state.js").VisualContinuityState;
  chapter?: number;
  allowUnprofiledEntityIds?: readonly string[];
}): ResolvedSceneVisualPrompt {
  const { scene, story, bible, artDirection, visualProfiles, visualContinuity } = options;

  // 1. Resolve canonical entities in the scene
  const matchedEntities = resolveVisuallyRelevantCanonicalEntities(scene, bible, visualProfiles, options.chapter, options.frameState);

  // 2. Build Entity Visual Canon & collect fingerprints
  const resolvedEntities: ResolvedEntityCanon[] = [];
  const entityVisualFingerprints: Record<string, string> = {};

  const direction: SceneDirection = scene.direction ?? sceneDirectionSchema.parse({});
  const overrides: SceneOverrides = scene.overrides ?? sceneOverridesSchema.parse({});
  const worn = wornSceneItems(scene, bible, visualProfiles, overrides.appearanceChapter ?? options.chapter, options.frameState);
  const wornIds = new Set(worn.map(({ entity }) => entity.id));
  const held = visibleSceneEquipment(scene, bible, visualProfiles, overrides.appearanceChapter ?? options.chapter, options.frameState);
  const visibleItemNames = new Map([...held, ...worn].map(({ entity }) => [entity.id, entity.canonicalName]));
  const effects = visibleSceneEffects(scene, bible, visualProfiles, overrides.appearanceChapter ?? options.chapter, options.frameState);
  const effectsById = new Map(effects.map(effect => [effect.entity.id, effect]));
  const selectedWardrobe: Record<string, string> = {};

  const entityCanonLines: string[] = [];
  const entityNegativePrompts: string[] = [];

  const bindings: Array<{ entity: CanonicalEntity; group?: SceneCreatureGroup }> = matchedEntities.flatMap(entity => {
    const groups = (scene.creatureGroups ?? []).filter(group => resolveVisualEntities([group.entity], [entity]).length > 0);
    return groups.length ? groups.map(group => ({ entity, group })) : [{ entity }];
  });
  for (const { entity, group } of bindings) {
    const entityId = entity.id;
    const useVisualProfile = shouldUseVisualProfileForEntity(scene, entity);
    const enforceForms = useVisualProfile && entity.visualProfilePolicy?.mode !== "skip" && !options.allowUnprofiledEntityIds?.includes(entityId);
    const savedProfile = enforceForms ? visualProfiles[entityId] : undefined;
    const individualEra = group ? matchingIndividualCreatureEra(savedProfile, entity, group, overrides.appearanceChapter ?? options.chapter, overrides.appearanceEraOverrides?.[entityId] ?? overrides.appearanceEraOverrides?.[entity.canonicalName]) : undefined;
    const conditionalEvidence = resolveEntityVisualEvidence(entity, overrides.appearanceChapter ?? options.chapter ?? Number.MAX_SAFE_INTEGER).conditional;
    if (conditionalEvidence.length) entityCanonLines.push(`CONDITIONAL VISUAL RULES [${entity.canonicalName}] — only when triggered in this frame: ${conditionalEvidence.slice(-6).map(item => `${item.field}: ${item.value}${item.condition ? `; trigger: ${item.condition}` : ""}; source chapter ${item.chapter}`).join(" | ")}`);
    const groupLabel = group ? `${group.count ?? ((savedProfile?.creatureIdentity ?? entity.visualIdentityKind) === "individual" ? 1 : "Unspecified number of")} ${group.label} [group ${group.id}; state ${group.state}]` : entity.canonicalName;
    const forms = savedProfile?.creatureForms?.filter(form => form.status === "approved" && form.state === group?.state) ?? [];
    const selectedForm = group && !individualEra ? group.formId ? forms.find(form => form.id === group.formId) : forms.length === 1 ? forms[0] : undefined : undefined;
    if (enforceForms && group && !individualEra && !group.formId && forms.length > 1) throw new Error(`Creature group '${group.label}' has several approved ${group.state} forms. Select a form ID before generating artwork.`);
    if (enforceForms && group?.formId && !selectedForm) throw new Error(`Creature group '${group.label}' requires an approved ${group.state} form matching '${group.formId}'. Review the creature forms before generating artwork.`);
    const eraOverride = overrides.appearanceEraOverrides?.[entityId] ?? overrides.appearanceEraOverrides?.[entity.canonicalName];
    const effectiveChapter = overrides.appearanceChapter ?? options.chapter;
    const look = savedProfile && sceneAppearanceLook(scene, savedProfile, effectiveChapter);
    const pinnedEra = savedProfile?.appearanceEras?.find((era) => era.id === (eraOverride ?? look?.id)
      && era.status === "approved" && hasWornLookItems(era, entityId, worn));
    const appearanceEra = individualEra ?? (group || (savedProfile?.creatureIdentity ?? entity.visualIdentityKind) === "template" ? undefined : pinnedEra ?? (savedProfile && effectiveChapter ? resolveApprovedAppearanceEra(savedProfile, effectiveChapter) : undefined));
    const profile = savedProfile ? selectedForm ? effectiveVisualProfile(savedProfile, { ...selectedForm, startChapter: 1 }) : group && !individualEra && group.state !== "living" ? undefined : effectiveVisualProfile(savedProfile, appearanceEra) : undefined;
    const isApproved = useVisualProfile && profile?.status === "approved";

    if (isApproved && profile) {
      if (profile.negativePrompt?.trim()) {
        entityNegativePrompts.push(profile.negativePrompt.trim());
      }
      // Calculate individual entity fingerprint (only for approved profiles)
      entityVisualFingerprints[group ? `${entityId}:${group.id}` : entityId] = fingerprint({
        id: profile.id,
        entityId: profile.entityId,
        appearanceEraId: appearanceEra?.id,
        creatureFormId: selectedForm?.id, creatureGroup: group,
        appearance: profile.appearance,
        visualPrompt: profile.visualPrompt,
        character: profile.character,
        location: profile.location,
        creature: profile.creature,
        item: profile.item,
        status: profile.status,
        references: profile.references.map((reference) => ({ id: reference.id, approved: reference.approved, role: reference.role, imagePath: reference.imagePath })),
      });

      // An editorial wardrobe override is the one exception to the profile's
      // default state. Other temporary state remains in continuity / scene
      // layers below, where it is explicitly higher priority.
      const wardrobeLook = appearanceEra?.wardrobeEvidence?.length ? profile.character?.defaultOutfit : undefined;
      const manualWardrobe = overrides.wardrobeOverrides?.[entityId] ?? overrides.wardrobeOverrides?.[entity.canonicalName];
      if (wardrobeLook && !manualWardrobe) selectedWardrobe[entity.canonicalName] = wardrobeLook;
      const wardrobeOverride = manualWardrobe ?? wardrobeLook;
      const preserveWardrobeEquipment = direction.preserveWardrobeEquipment !== false;
      const activeWardrobe = wardrobeOverride || (preserveWardrobeEquipment ? profile.character?.defaultOutfit : undefined);

      const traits: string[] = [];

      if (profile.visualType === "character" && profile.character) {
        const c = normalizeCharacterAppearance(profile.character)!;
        const figureTrait = characterFigureTrait(c, story.artwork.adultContent);
        const details = [
          c.apparentAge && `Age: ${c.apparentAge}`,
          c.gender && `Gender: ${c.gender}`,
          c.height && `Height: ${c.height}`,
          c.build && `Build: ${c.build}`,
          figureTrait,
          c.conditionalAppearance && `CONDITIONAL APPEARANCE RULES (not active by default): ${c.conditionalAppearance}`,
          c.skinTone && `Skin tone: ${c.skinTone}`,
          c.faceShape && `Face shape: ${c.faceShape}`,
          c.hairColor && c.hairstyle ? `Hair: ${c.hairColor}, ${c.hairstyle}` : c.hairColor ? `Hair: ${c.hairColor}` : c.hairstyle ? `Hair: ${c.hairstyle}` : undefined,
          c.eyeColor && `Eyes: ${c.eyeColor}`,
          c.facialHair && `Facial hair: ${c.facialHair}`,
          c.distinguishingFeatures && `Features: ${c.distinguishingFeatures}`,
          c.scars && `Scars: ${c.scars}`,
          c.tattoos && `Tattoos: ${c.tattoos}`,
          c.additionalAppearanceNotes && `Persistent appearance notes: ${c.additionalAppearanceNotes}`,
        ].filter(Boolean).join(", ");

        // visualPrompt/appearance are legacy free-text fields that often mix
        // identity with an outfit and carried gear. When temporary scene
        // presentation is requested, prefer the structured identity fields
        // above. Only consult mixed text if no structured identity is present;
        // do not try to regex-edit prose and risk corrupting identity details.
        if (preserveWardrobeEquipment) {
          if (profile.visualPrompt) traits.push(`REFERENCE DESIGN CONTEXT (identity only; clothing, props and effects require current-scene support): ${profile.visualPrompt}`);
          else if (profile.appearance) traits.push(`REFERENCE DESIGN CONTEXT (identity only): ${profile.appearance}`);
        } else if (!details && (profile.visualPrompt || profile.appearance)) {
          const legacyDescription = profile.visualPrompt || profile.appearance;
          if (!legacyCharacterTextLooksLikePresentation(legacyDescription)) {
            traits.push(`LEGACY VISUAL PROFILE (sparse structured identity; use only lasting physical identity details): ${legacyDescription}`);
          }
        }
        if (details) traits.push(details);
        if (wardrobeOverride) traits.push(`Scene override attire: ${wardrobeOverride}`);
        else if (preserveWardrobeEquipment && c.defaultOutfit) traits.push(`Default attire (overridable by current scene): ${c.defaultOutfit}`);
        if (preserveWardrobeEquipment && c.shoes) traits.push(`Default footwear (overridable by current scene): ${c.shoes}`);
        if (preserveWardrobeEquipment && c.accessories) traits.push(`Available accessories (not visible unless currently worn): ${c.accessories}`);
        if (preserveWardrobeEquipment && c.weapons) traits.push(`Owned weapons (not drawn or visible unless current action requires them): ${c.weapons}`);
        if (preserveWardrobeEquipment && c.equipment) traits.push(`Available equipment (not automatically visible): ${c.equipment}`);
      } else if (profile.visualType === "location" && profile.location) {
        if (profile.visualPrompt) traits.push(profile.visualPrompt);
        else if (profile.appearance) traits.push(profile.appearance);
        const l = profile.location;
        if (l.canonicalEnvironmentPrompt) traits.push(l.canonicalEnvironmentPrompt);
        if (l.architecture) traits.push(`Architecture: ${l.architecture}`);
        if (l.lighting) traits.push(`Typical location lighting (current scene time takes precedence): ${l.lighting}`);
        if (l.colorPalette) traits.push(`Palette: ${l.colorPalette}`);
      } else if (profile.visualType === "creature" && profile.creature) {
        if (profile.visualPrompt) traits.push(profile.visualPrompt);
        else if (profile.appearance) traits.push(profile.appearance);
        const cr = profile.creature;
        if (cr.canonicalCreaturePrompt) traits.push(cr.canonicalCreaturePrompt);
        if (cr.species) traits.push(`Species: ${cr.species}`);
        if (cr.scale) traits.push(`Scale: ${cr.scale}`);
        if (cr.anatomy) traits.push(`Anatomy: ${cr.anatomy}`);
        if (cr.coloration) traits.push(`Coloration: ${cr.coloration}`);
        if (cr.eyes) traits.push(`Eyes: ${cr.eyes}`);
        if (cr.armorFur) traits.push(`Armor or fur: ${cr.armorFur}`);
        if (cr.distinguishingFeatures) traits.push(`Distinguishing features: ${cr.distinguishingFeatures}`);
        if (cr.sizeRelativeToHuman) traits.push(`Size relative to humans: ${cr.sizeRelativeToHuman}`);
      } else if (["item", "weapon", "object"].includes(profile.visualType) && profile.item) {
        if (profile.visualPrompt) traits.push(profile.visualPrompt);
        else if (profile.appearance) traits.push(profile.appearance);
        const it = profile.item;
        if (it.canonicalObjectPrompt) traits.push(it.canonicalObjectPrompt);
        if (it.shape) traits.push(`Shape: ${it.shape}`);
        if (it.materials) traits.push(`Materials: ${it.materials}`);
        if (it.magicalEffects) traits.push(`Effects: ${it.magicalEffects}`);
      } else if (!profile.character && (profile.visualPrompt || profile.appearance)) {
        // Preserve legacy profiles that have no typed detail object.
        traits.push(profile.visualPrompt || profile.appearance);
      }

      const description = traits.join(". ");
      resolvedEntities.push({
        entityId,
        name: groupLabel,
        type: entity.type,
        hasApprovedProfile: true,
        profileRevision: profile.revision,
        appearanceEra: appearanceEra && { id: appearanceEra.id, name: appearanceEra.name, startChapter: appearanceEra.startChapter, endChapter: appearanceEra.endChapter },
        description,
        wardrobe: activeWardrobe,
        weapons: preserveWardrobeEquipment ? profile.character?.weapons : undefined,
        visualPrompt: preserveWardrobeEquipment ? profile.visualPrompt : undefined,
        references: profile.references,
        useVisualProfile,
        groundingMode: "approved_profile",
      });

      entityCanonLines.push(`CANONICAL ${entity.type.toUpperCase()} [${groupLabel}]: ${description}${group ? `\nSCENE GROUP STATE: ${group.state}. ${group.appearance} Apply these references only to this group; keep other groups distinct.` : ""}`);
    } else {
      // Fallback to Story Bible canonical description
      const namePrefix = entity.originalName ? `${entity.canonicalName} (${entity.originalName})` : entity.canonicalName;
      const visualDescription = group ? `${groupLabel}: ${group.appearance || group.state}. No approved form reference is available. Use only this group's narrated state; do not copy another group's living or undead appearance.` : entity.type === "character" ? fallbackArtworkDescription(entity.description ?? "") : entity.description;
      const evidence = resolveEntityVisualEvidence(entity, overrides.appearanceChapter ?? options.chapter ?? Number.MAX_SAFE_INTEGER);
      const persistent = group ? [] : Object.entries(evidence.values).filter(([, item]) => item.persistence === "persistent");
      const changing = group || (savedProfile?.creatureIdentity ?? entity.visualIdentityKind) === "template" ? [] : Object.entries(evidence.values).filter(([, item]) => item.persistence === "changed");
      const draft = profile && profile.status !== "approved" ? profile : undefined;
      const manual = Object.entries(draft?.fieldProvenance ?? {}).flatMap(([path, provenance]) => {
        if (!provenance.locked && provenance.source !== "manual_override" && provenance.source !== "user_edit") return [];
        const value = draft ? readVisualField(draft, path) : undefined;
        return value?.trim() ? [`${path}: ${value.trim()}`] : [];
      });
      const protectedPaths = new Set(manual.map((line) => line.split(":", 1)[0]));
      const lines = (items: typeof persistent) => items.filter(([path]) => !protectedPaths.has(path)).map(([path, item]) => `${path}: ${item.value} (source chapter ${item.chapter})`);
      const editorialFigure = entity.type === "character" ? visualProfiles[entityId]?.character?.figure : undefined;
      const fallbackContext = [
        editorialFigure ? `EDITORIAL BODY CHOICE: ${editorialFigure}. Preserve this user-selected figure; do not replace it with the generic mature default.` : "",
        manual.length ? `MANUAL VISUAL DECISIONS: ${manual.join("; ")}` : "",
        persistent.length ? `PERSISTENT IDENTITY: ${lines(persistent).join("; ")}` : "",
        changing.length ? `CURRENT CHAPTER VISUAL STATE: ${lines(changing).join("; ")}` : "",
        evidence.temporary.length || visualContinuity ? `CHAPTER OBSERVATIONS (apply only if this exact scene depicts the observation, never merely because it shares the chapter): ${evidence.temporary.map((item) => `${item.field}: ${item.value}`).join("; ")}${visualContinuity ? "; follow current visual continuity and scene overrides below" : ""}` : "",
        "UNKNOWN/UNSPECIFIED: Do not borrow another character's reference identity for details absent from this entity's evidence.",
      ].filter(Boolean).join("\n");
      const desc = `${namePrefix}${visualDescription ? `: ${visualDescription}` : ""}${fallbackContext ? `\n${fallbackContext}` : ""}`;
      resolvedEntities.push({
        entityId,
        name: groupLabel,
        type: entity.type,
        hasApprovedProfile: false,
        description: desc,
        useVisualProfile,
        groundingMode: useVisualProfile ? "story_bible_fallback" : "profile_disabled",
      });
      entityCanonLines.push(`STORY BIBLE ${entity.type.toUpperCase()} [${entity.canonicalName}]: ${desc}`);
    }
  }

  // 3. Compose Layers:
  const promptParts: string[] = [];

  // Layer 1: Story Art Direction
  const styleHeader = direction.useStoryArtDirection === false ? "" : [
    `ART STYLE: ${artDirection.artStyle}`,
    artDirection.customStylePrompt && `STYLE PROMPT: ${artDirection.customStylePrompt}`,
    artDirection.visualTone && `TONE: ${artDirection.visualTone}`,
    artDirection.colorDirection && `COLOR DIRECTION: ${artDirection.colorDirection}`,
    artDirection.lightingDirection && !direction.lighting && `LIGHTING: ${artDirection.lightingDirection}`,
    artDirection.cameraStyle && !direction.cameraAngle && `CAMERA: ${artDirection.cameraStyle}`,
    artDirection.compositionTendencies && !direction.composition && `COMPOSITION: ${artDirection.compositionTendencies}`,
    artDirection.characterRenderingGuidance && `CHARACTER RENDERING: ${artDirection.characterRenderingGuidance}`,
    artDirection.environmentStyle && `ENVIRONMENT: ${artDirection.environmentStyle}`,
    artDirection.additionalVisualInstructions && `INSTRUCTIONS: ${artDirection.additionalVisualInstructions}`,
  ].filter(Boolean).join(" | ");

  if (styleHeader) promptParts.push(`STORY ART DIRECTION: ${styleHeader}`);
  if (story.artwork.adultContent) promptParts.push(MATURE_ARTWORK_STYLING, MATURE_FALLBACK_FEMALE_GUIDANCE);
  promptParts.push(FALLBACK_CHARACTER_DESIGN_GUIDANCE);

  // Layer 2: Entity Visual Canon
  if (entityCanonLines.length > 0) {
    promptParts.push(`ENTITY VISUAL CANON:\n${entityCanonLines.join("\n")}`);
  }
  const characters = resolvedEntities.filter((entity) => entity.type === "character");
  if (characters.length > 1) {
    promptParts.push(`CHARACTER IDENTITY BLOCKS:\n${characters.map((entity) =>
      `CHARACTER IDENTITY — ${entity.name}\nGrounding: ${entity.groundingMode === "approved_profile" ? "Approved Visual Profile" : "Story Bible fallback"}\nAppearance: ${entity.description}`,
    ).join("\n\n")}`);
    if (characters.some((entity) => entity.groundingMode !== "approved_profile") || new Set(characters.map((entity) => entity.groundingMode)).size > 1) {
      promptParts.push(`CHARACTER IDENTITY SEPARATION:\n${characters.map((entity, index) => characters.slice(index + 1).map((other) =>
        `${entity.name} and ${other.name} are different people. Keep their faces, facial proportions, hairlines, hairstyles, eye shapes, body silhouettes, and distinctive identifying features separate; do not reuse either person's identity traits for the other. They must be distinguishable at a glance.`,
      ).join("\n")).filter(Boolean).join("\n")}`);
    }
  }

  // One shared hierarchy keeps profiles and reference images from freezing a
  // character in a default outfit, pose, or injury state.
  promptParts.push(SCENE_STATE_PRIORITY_INSTRUCTION);
  if (worn.length) promptParts.push(`WORN ITEMS: ${worn.map(({ entity, wearer }) => `${wearer} wears ${entity.canonicalName}. Match the approved item reference and show it attached to the wearer in the appropriate position.`).join(" ")}`);
  const visibleProps = held.filter(({ entity }) => !wornIds.has(entity.id));
  if (visibleProps.length) promptParts.push(`VISIBLE PROPS AND WEAPONS: ${visibleProps.map(({ entity, holder }) => `${entity.canonicalName} is visible with ${holder}. Match its reference when supplied, and depict its position and use as established in this frame.`).join(" ")}`);
  if (effects.length) promptParts.push(`ACTIVE VISIBLE EFFECTS: ${effects.map(({ entity, actors }) => `${entity.canonicalName} is visibly active for ${[...actors].join(", ")}. Apply any supplied sheet to the effect or transformed appearance only, preserving each character's identity and the scene's depicted phase.`).join(" ")}`);
  const removed = options.frameState?.objects.filter(object => object.wornBy === null).map(object => object.name)
    ?? scene.visualChanges?.objects?.filter(object => object.clearWornBy).map(object => object.name);
  if (removed?.length) promptParts.push(`REMOVED EQUIPMENT: ${removed.join(", ")}. Do not depict these items being worn, even if a character reference shows them.`);

  // Layer 2.5: Current Visual Continuity — temporary state, clearly delimited
  // from the permanent canon above. Manual Scene Studio overrides still win
  // (they are applied in a later layer).
  if (visualContinuity) {
    promptParts.push(`CURRENT VISUAL CONTINUITY (temporary state — overrides profile defaults and references while preserving canonical identity):\n${visualContinuity}`);
  }

  // Layer 3: Scene Content
  if (scene.sequence) promptParts.push(sequencePrompt(scene));
  promptParts.push(`NAMED ON-SCREEN CAST: ${scene.characters.length ? scene.characters.join(", ") : "No named characters established"}. Do not add other named people solely because they appear in inherited continuity or reference images. Depict additional crowds or creature groups only when the scene establishes them.`);
  promptParts.push(`SCENE BEAT: ${scene.visualPrompt}`);
  if (scene.narrationText?.trim()) promptParts.push(`EXACT NARRATED FRAME CONTEXT (authoritative for clothing, visibility and skill activation): ${scene.narrationText.slice(0, 8000)}`);
  if (scene.summary) {
    promptParts.push(`NARRATIVE CONTEXT: ${scene.summary}`);
  }
  if (scene.location) {
    promptParts.push(`LOCATION SETTING: ${scene.location}`);
  }

  // Layer 4: Scene Direction
  const directionLines: string[] = [];
  if (direction.shotType) directionLines.push(`Shot type: ${direction.shotType.replace("_", " ")}`);
  if (direction.cameraAngle) directionLines.push(`Camera angle: ${direction.cameraAngle.replace("_", " ")}`);
  if (direction.composition) directionLines.push(`Composition: ${direction.composition.replace("_", " ")}`);
  if (direction.lighting) directionLines.push(`Lighting: ${direction.lighting}`);
  if (direction.timeEnvironment) directionLines.push(`Atmosphere/Time: ${direction.timeEnvironment}`);

  // Character emotions
  if (direction.characterExpressions && Object.keys(direction.characterExpressions).length > 0) {
    const exprs = Object.entries(direction.characterExpressions)
      .map(([nameOrId, expr]) => `${nameOrId}: ${expr}`)
      .join("; ");
    directionLines.push(`Character expressions: ${exprs}`);
  }

  if (directionLines.length > 0) {
    promptParts.push(`SCENE DIRECTION: ${directionLines.join(" | ")}`);
  }

  // Layer 5: Scene-specific overrides
  const overrideLines: string[] = [];
  const wardrobeOverrides = { ...selectedWardrobe, ...overrides.wardrobeOverrides };
  if (Object.keys(wardrobeOverrides).length) overrideLines.push(`Wardrobe: ${Object.entries(wardrobeOverrides).map(([name, attire]) => `${name}: ${attire}`).join("; ")}`);
  if (overrides.customVisualPrompt) {
    overrideLines.push(`Prompt: ${overrides.customVisualPrompt}`);
  }
  if (overrideLines.length > 0) {
    promptParts.push(`SCENE OVERRIDES: ${overrideLines.join(" | ")}`);
  }

  // Layer 6: Aspect-ratio-aware composition guidance & guard instructions
  const aspectRatio = resolveArtworkAspectRatio(story, direction.useStoryArtDirection === false ? undefined : artDirection);
  promptParts.push(artworkCompositionGuidance(aspectRatio));
  promptParts.push("Create one polished still illustration. No text, captions, speech bubbles, logos, or watermarks.");

  const prompt = promptParts.filter(Boolean).join("\n\n");

  // Negative Prompt
  const negParts = [
    direction.useStoryArtDirection === false ? undefined : artDirection.globalNegativePrompt,
    ...entityNegativePrompts,
    overrides.customNegativePrompt,
    "text, watermark, subtitles, borders, split frame, multiple panels, collage",
  ].filter(Boolean);
  const negativePrompt = negParts.join(", ");

  // Fingerprints
  const artDirectionFingerprint = fingerprint(direction.useStoryArtDirection === false ? { disabled: true } : {
    id: artDirection.id,
    name: artDirection.name,
    artStyle: artDirection.artStyle,
    customStylePrompt: artDirection.customStylePrompt,
    visualTone: artDirection.visualTone,
    colorDirection: artDirection.colorDirection,
    lightingDirection: artDirection.lightingDirection,
    cameraStyle: artDirection.cameraStyle,
    compositionTendencies: artDirection.compositionTendencies,
    environmentStyle: artDirection.environmentStyle,
    characterRenderingGuidance: artDirection.characterRenderingGuidance,
    aspectRatio: artDirection.aspectRatio,
    characterConsistencyStrength: artDirection.characterConsistencyStrength,
    environmentConsistencyStrength: artDirection.environmentConsistencyStrength,
    globalNegativePrompt: artDirection.globalNegativePrompt,
    additionalVisualInstructions: artDirection.additionalVisualInstructions,
  });
  const sceneDirectionFingerprint = fingerprint({
    direction: normalizeSceneDirectionForFingerprint(scene.direction),
    overrides: normalizeSceneOverridesForFingerprint(scene.overrides),
  });
  const resolvedPromptFingerprint = fingerprint({ prompt, negativePrompt });
  const visualContinuityFingerprint = visualContinuity ? fingerprint(visualContinuity) : undefined;

  return {
    prompt,
    negativePrompt,
    artDirectionFingerprint,
    entityVisualFingerprints,
    sceneDirectionFingerprint,
    resolvedPromptFingerprint,
    ...(visualContinuityFingerprint ? { visualContinuityFingerprint } : {}),
    resolvedEntities,
    referenceContextByEntity: Object.fromEntries(resolvedEntities.map(entity => {
      const line = visualContinuity?.split("\n").find(line => line === `- ${entity.name}` || line.startsWith(`- ${entity.name} —`));
      const delta = scene.visualChanges?.characters?.find(c => c.entityId === entity.entityId || c.name === entity.name)?.set;
      const state = options.frameState?.characters.find(c => c.entityId === entity.entityId || c.name === entity.name || resolveVisualEntities([c.name], bible.canonicalEntities).some(e => e.id === entity.entityId));
      // Resolved state already includes clears and manual overrides. Never
      // reintroduce a raw planner delta after those decisions were applied.
      const facts = options.frameState !== undefined ? state : line !== undefined ? {
        wardrobe: /wardrobe: ([^;\n]+)/i.exec(line)?.[1],
        activeAbilities: /active abilities: ([^;\n]+)/i.exec(line)?.[1]?.split(",").map(s => s.trim()).filter(s => !s.startsWith("none")),
        transformation: /transformation: ([^;\n]+)/i.exec(line)?.[1],
        visibleEquipment: /visible equipment: ([^;\n]+)/i.exec(line)?.[1]?.split(",").map(s => s.trim()).filter(s => s !== "none"),
      } : delta;
      const base = referenceContext(scene, options.chapter);
      const visibleItemName = visibleItemNames.get(entity.entityId);
      const effect = effectsById.get(entity.entityId);
      const directedTime = scene.direction?.timeEnvironment && !["interior","custom"].includes(scene.direction.timeEnvironment) ? scene.direction.timeEnvironment : undefined;
      return [entity.entityId, { ...base,
        location: options.frameState?.environment?.description ?? base.location,
        wardrobe: scene.overrides?.wardrobeOverrides?.[entity.entityId] ?? scene.overrides?.wardrobeOverrides?.[entity.name] ?? selectedWardrobe[entity.name] ?? facts?.wardrobe,
        activeAbilities: effect?.ability ? [effect.entity.canonicalName, ...effect.entity.aliases] : facts?.activeAbilities,
        transformation: effect?.transformation ? effect.entity.canonicalName : facts?.transformation,
        visibleItemName, visibleEquipment: visibleItemName ? [visibleItemName] : facts?.visibleEquipment,
        activeState: Boolean(effect || facts?.activeAbilities?.length || facts?.transformation),
        timeOfDay: directedTime ?? options.frameState?.environment?.timeOfDay ?? base.timeOfDay ?? /time: ([^;\n]+)/i.exec(visualContinuity ?? "")?.[1],
      }];
    })),
    referenceContext: { ...referenceContext(scene, options.chapter), location: options.frameState?.environment?.description ?? scene.location, ...(options.visualContinuity ? { text: `${scene.narrationText ?? scene.summary}\n${options.visualContinuity}`, activeState: /Active abilities: (?!none)[^\n]+/i.test(options.visualContinuity), wardrobe: options.visualContinuity, timeOfDay: scene.direction?.timeEnvironment ?? /time: ([^;\n]+)/i.exec(options.visualContinuity)?.[1] } : {}) },
  };
}
