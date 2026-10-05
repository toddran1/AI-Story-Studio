import { characterFigureTrait } from "./figure-guidance.js";
import { FALLBACK_CHARACTER_DESIGN_GUIDANCE, MATURE_FALLBACK_FEMALE_GUIDANCE } from "./character-design.js";
import { matchingIndividualCreatureEra } from "./creature-look.js";
import { CanonicalEntity, StoryBible } from "../domain/story-bible.js";
import { Story } from "../domain/story.js";
import { ArtDirectionPreset } from "../domain/art-direction.js";
import { VisualAppearanceEra, VisualEntityProfile, VisualReferenceImage } from "../domain/visual-profile.js";
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
  "SCENE-STATE PRIORITY: Preserve Story Bible identity and approved Visual Profile traits such as face, age, build, hair, eyes, and permanent distinguishing features. Treat profile attire, footwear, accessories, weapons, and equipment as defaults only. Current visual continuity, the current scene, scene direction, and explicit scene overrides take precedence for temporary clothing, injuries, blood, dirt, damage, equipment, pose, expression, and environmental effects. Do not infer a change from an omitted detail.";

// export const MATURE_ARTWORK_STYLING =
//   "MATURE CHARACTER STYLING: Clearly adult female characters have a seductive, alluring look with curvaceous figures, full busts and shapely hips. Keep it tasteful — alluring and elegant, never explicit or nude. Depict blood, injuries, and battle violence when the scene calls for it.";
export const MATURE_ARTWORK_STYLING =
  "MATURE CHARACTER STYLING: Clearly adult female characters have a seductive, alluring look with curvaceous figures, full busts and shapely hips. Preserve established figure choices; For unspecified-age women with no youth cues, use an adult 21+ rendering default; never apply this styling to minors or characters with child or adolescent cues. Keep it tasteful — alluring and elegant. Keep subjects clothed and non-explicit. Depict blood, injuries, and battle violence when the scene calls for it.";

export function resolveApprovedAppearanceEra(profile: VisualEntityProfile, chapter: number): VisualAppearanceEra | undefined {
  return profile.appearanceEras?.find((era) => era.status === "approved" && era.startChapter <= chapter && (era.endChapter === undefined || chapter <= era.endChapter));
}

export function effectiveVisualProfile(profile: VisualEntityProfile, era: VisualAppearanceEra | undefined): VisualEntityProfile {
  if (!era) {
    const assigned = new Set([...(profile.appearanceEras?.flatMap((item) => item.referenceIds) ?? []), ...(profile.creatureForms?.flatMap(form => form.referenceIds) ?? [])]);
    return { ...profile, references: profile.references.filter((reference) => !assigned.has(reference.id)) };
  }
  const referenceIds = new Set(era.referenceIds);
  const hasEraText = Boolean(era.appearance.trim() || era.visualPrompt.trim());
  const characterChanges = era.character && Object.keys(era.character).length ? era.character : undefined;
  const creatureChanges = era.creature && Object.keys(era.creature).length ? era.creature : undefined;
  return {
    ...profile,
    appearance: era.appearance,
    visualPrompt: era.visualPrompt,
    negativePrompt: era.negativePrompt ?? "",
    character: profile.visualType === "character" ? hasEraText ? characterChanges : profile.character ? { ...profile.character, ...(characterChanges ? { additionalAppearanceNotes: undefined } : {}), ...characterChanges } : characterChanges : undefined,
    creature: profile.visualType === "creature" ? hasEraText ? creatureChanges : profile.creature ? { ...profile.creature, ...(creatureChanges ? { canonicalCreaturePrompt: undefined } : {}), ...creatureChanges } : creatureChanges : undefined,
    references: profile.references.filter((reference) => referenceIds.has(reference.id)),
  };
}


/** The one authoritative definition of entities visibly represented by a scene.
 * It intentionally uses scene identity fields only—not broad narration matching—
 * so preflight and prompt resolution cannot disagree about who is on screen. */
export function resolveVisuallyRelevantCanonicalEntities(scene: Scene, bible: StoryBible): CanonicalEntity[] {
  const matchedEntities = new Map<string, CanonicalEntity>();
  for (const id of scene.entityIds ?? []) {
    const found = bible.canonicalEntities.find((entity) => entity.id === id || entity.mergedFromIds?.includes(id));
    // An attached ID is explicit visual evidence only for things an image can
    // depict directly. Context-only concepts, abilities, and organizations do
    // not become on-screen just because planning linked them to the scene.
    if (found && found.type !== "ability" && ["character", "creature", "item", "weapon", "object"].includes(resolveVisualEntityType(found))) matchedEntities.set(found.id, found);
  }
  for (const entity of resolveVisualEntities(scene.characters, bible.canonicalEntities)) {
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
  chapter?: number;
  allowUnprofiledEntityIds?: readonly string[];
}): ResolvedSceneVisualPrompt {
  const { scene, story, bible, artDirection, visualProfiles, visualContinuity } = options;

  // 1. Resolve canonical entities in the scene
  const matchedEntities = resolveVisuallyRelevantCanonicalEntities(scene, bible);

  // 2. Build Entity Visual Canon & collect fingerprints
  const resolvedEntities: ResolvedEntityCanon[] = [];
  const entityVisualFingerprints: Record<string, string> = {};

  const direction: SceneDirection = scene.direction ?? sceneDirectionSchema.parse({});
  const overrides: SceneOverrides = scene.overrides ?? sceneOverridesSchema.parse({});

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
    const groupLabel = group ? `${group.count ?? ((savedProfile?.creatureIdentity ?? entity.visualIdentityKind) === "individual" ? 1 : "Unspecified number of")} ${group.label} [group ${group.id}; state ${group.state}]` : entity.canonicalName;
    const forms = savedProfile?.creatureForms?.filter(form => form.status === "approved" && form.state === group?.state) ?? [];
    const selectedForm = group && !individualEra ? group.formId ? forms.find(form => form.id === group.formId) : forms.length === 1 ? forms[0] : undefined : undefined;
    if (enforceForms && group && !individualEra && !group.formId && forms.length > 1) throw new Error(`Creature group '${group.label}' has several approved ${group.state} forms. Select a form ID before generating artwork.`);
    if (enforceForms && group?.formId && !selectedForm) throw new Error(`Creature group '${group.label}' requires an approved ${group.state} form matching '${group.formId}'. Review the creature forms before generating artwork.`);
    const eraOverride = overrides.appearanceEraOverrides?.[entityId] ?? overrides.appearanceEraOverrides?.[entity.canonicalName];
    const pinnedEra = savedProfile?.appearanceEras?.find((era) => era.id === eraOverride && era.status === "approved");
    const effectiveChapter = overrides.appearanceChapter ?? options.chapter;
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
      const wardrobeOverride = overrides.wardrobeOverrides?.[entityId] ?? overrides.wardrobeOverrides?.[entity.canonicalName];
      const preserveWardrobeEquipment = direction.preserveWardrobeEquipment !== false;
      const activeWardrobe = wardrobeOverride || (preserveWardrobeEquipment ? profile.character?.defaultOutfit : undefined);

      const traits: string[] = [];

      if (profile.visualType === "character" && profile.character) {
        const c = profile.character;
        const figureTrait = characterFigureTrait(c, story.artwork.adultContent);
        const details = [
          c.apparentAge && `Age: ${c.apparentAge}`,
          c.gender && `Gender: ${c.gender}`,
          c.height && `Height: ${c.height}`,
          c.build && `Build: ${c.build}`,
          figureTrait,
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
          if (profile.visualPrompt) traits.push(profile.visualPrompt);
          else if (profile.appearance) traits.push(profile.appearance);
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
        if (preserveWardrobeEquipment && c.accessories) traits.push(`Default accessories (overridable by current scene): ${c.accessories}`);
        if (preserveWardrobeEquipment && c.weapons) traits.push(`Default weapons (overridable by current scene): ${c.weapons}`);
        if (preserveWardrobeEquipment && c.equipment) traits.push(`Default equipment (overridable by current scene): ${c.equipment}`);
      } else if (profile.visualType === "location" && profile.location) {
        if (profile.visualPrompt) traits.push(profile.visualPrompt);
        else if (profile.appearance) traits.push(profile.appearance);
        const l = profile.location;
        if (l.canonicalEnvironmentPrompt) traits.push(l.canonicalEnvironmentPrompt);
        if (l.architecture) traits.push(`Architecture: ${l.architecture}`);
        if (l.lighting) traits.push(`Lighting: ${l.lighting}`);
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
        evidence.temporary.length || visualContinuity ? `SCENE-SPECIFIC STATE: ${evidence.temporary.map((item) => `${item.field}: ${item.value}`).join("; ")}${visualContinuity ? "; follow current visual continuity and scene overrides below" : ""}` : "",
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

  // Layer 2.5: Current Visual Continuity — temporary state, clearly delimited
  // from the permanent canon above. Manual Scene Studio overrides still win
  // (they are applied in a later layer).
  if (visualContinuity) {
    promptParts.push(`CURRENT VISUAL CONTINUITY (temporary state — overrides profile defaults and references while preserving canonical identity):\n${visualContinuity}`);
  }

  // Layer 3: Scene Content
  promptParts.push(`SCENE BEAT: ${scene.visualPrompt}`);
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
  if (overrides.wardrobeOverrides && Object.keys(overrides.wardrobeOverrides).length > 0) {
    const list = Object.entries(overrides.wardrobeOverrides)
      .map(([name, attire]) => `${name}: ${attire}`)
      .join("; ");
    overrideLines.push(`Wardrobe: ${list}`);
  }
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
  };
}
