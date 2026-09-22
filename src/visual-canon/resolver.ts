import { CanonicalEntity, StoryBible } from "../domain/story-bible.js";
import { Story } from "../domain/story.js";
import { ArtDirectionPreset } from "../domain/art-direction.js";
import { VisualEntityProfile, VisualReferenceImage } from "../domain/visual-profile.js";
import { Scene, SceneDirection, SceneOverrides, sceneDirectionSchema, sceneOverridesSchema } from "../scenes/types.js";
import { resolveVisualEntities } from "../scenes/identity.js";
import { fingerprint } from "../utils/hash.js";
import { artworkCompositionGuidance, resolveArtworkAspectRatio } from "../artwork/composition.js";

export type ResolvedEntityCanon = {
  entityId: string;
  name: string;
  type: string;
  hasApprovedProfile: boolean;
  profileRevision?: number;
  description: string;
  wardrobe?: string;
  weapons?: string;
  visualPrompt?: string;
  references?: VisualReferenceImage[];
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

/**
 * Keep identity canon separate from a character's temporary state. This is
 * deliberately prompt-level guidance: scene narration and editorial overrides
 * are evidence for this one image, never a reason to mutate the profile.
 */
export const SCENE_STATE_PRIORITY_INSTRUCTION =
  "SCENE-STATE PRIORITY: Preserve Story Bible identity and approved Visual Profile traits such as face, age, build, hair, eyes, and permanent distinguishing features. Treat profile attire, footwear, accessories, weapons, and equipment as defaults only. Current visual continuity, the current scene, scene direction, and explicit scene overrides take precedence for temporary clothing, injuries, blood, dirt, damage, equipment, pose, expression, and environmental effects. Do not infer a change from an omitted detail.";

/** The one authoritative definition of entities visibly represented by a scene.
 * It intentionally uses scene identity fields only—not broad narration matching—
 * so preflight and prompt resolution cannot disagree about who is on screen. */
export function resolveVisuallyRelevantCanonicalEntities(scene: Scene, bible: StoryBible): CanonicalEntity[] {
  const matchedEntities = new Map<string, CanonicalEntity>();
  for (const id of scene.entityIds ?? []) {
    const found = bible.canonicalEntities.find((entity) => entity.id === id);
    if (found) matchedEntities.set(found.id, found);
  }
  for (const entity of resolveVisualEntities(scene.characters, bible.canonicalEntities)) {
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

export function resolveVisualCanonPrompt(options: {
  scene: Scene;
  story: Story;
  bible: StoryBible;
  artDirection: ArtDirectionPreset;
  visualProfiles: Record<string, VisualEntityProfile>;
  visualContinuity?: string;
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

  for (const entity of matchedEntities) {
    const entityId = entity.id;
    const profile = visualProfiles[entityId];
    const isApproved = profile?.status === "approved";

    if (isApproved && profile) {
      if (profile.negativePrompt?.trim()) {
        entityNegativePrompts.push(profile.negativePrompt.trim());
      }
      // Calculate individual entity fingerprint (only for approved profiles)
      entityVisualFingerprints[entityId] = fingerprint({
        id: profile.id,
        entityId: profile.entityId,
        revision: profile.revision,
        appearance: profile.appearance,
        visualPrompt: profile.visualPrompt,
        character: profile.character,
        location: profile.location,
        creature: profile.creature,
        item: profile.item,
        status: profile.status,
      });

      // An editorial wardrobe override is the one exception to the profile's
      // default state. Other temporary state remains in continuity / scene
      // layers below, where it is explicitly higher priority.
      const wardrobeOverride = overrides.wardrobeOverrides?.[entityId] ?? overrides.wardrobeOverrides?.[entity.canonicalName];
      const activeWardrobe = wardrobeOverride || profile.character?.defaultOutfit || undefined;

      const traits: string[] = [];
      if (profile.visualPrompt) traits.push(profile.visualPrompt);
      else if (profile.appearance) traits.push(profile.appearance);

      if (profile.character) {
        const c = profile.character;
        const details = [
          c.apparentAge && `Age: ${c.apparentAge}`,
          c.build && `Build: ${c.build}`,
          c.hairColor && c.hairstyle ? `Hair: ${c.hairColor}, ${c.hairstyle}` : c.hairColor ? `Hair: ${c.hairColor}` : c.hairstyle ? `Hair: ${c.hairstyle}` : undefined,
          c.eyeColor && `Eyes: ${c.eyeColor}`,
          c.distinguishingFeatures && `Features: ${c.distinguishingFeatures}`,
          c.scars && `Scars: ${c.scars}`,
          c.tattoos && `Tattoos: ${c.tattoos}`,
        ].filter(Boolean).join(", ");
        if (details) traits.push(details);
        if (wardrobeOverride) traits.push(`Scene override attire: ${wardrobeOverride}`);
        else if (c.defaultOutfit) traits.push(`Default attire (overridable by current scene): ${c.defaultOutfit}`);
        if (c.shoes) traits.push(`Default footwear (overridable by current scene): ${c.shoes}`);
        if (c.accessories) traits.push(`Default accessories (overridable by current scene): ${c.accessories}`);
        if (c.weapons) traits.push(`Default weapons (overridable by current scene): ${c.weapons}`);
        if (c.equipment) traits.push(`Default equipment (overridable by current scene): ${c.equipment}`);
      } else if (profile.location) {
        const l = profile.location;
        if (l.canonicalEnvironmentPrompt) traits.push(l.canonicalEnvironmentPrompt);
        if (l.architecture) traits.push(`Architecture: ${l.architecture}`);
        if (l.lighting) traits.push(`Lighting: ${l.lighting}`);
        if (l.colorPalette) traits.push(`Palette: ${l.colorPalette}`);
      } else if (profile.creature) {
        const cr = profile.creature;
        if (cr.canonicalCreaturePrompt) traits.push(cr.canonicalCreaturePrompt);
        if (cr.species) traits.push(`Species: ${cr.species}`);
        if (cr.scale) traits.push(`Scale: ${cr.scale}`);
        if (cr.anatomy) traits.push(`Anatomy: ${cr.anatomy}`);
        if (cr.coloration) traits.push(`Coloration: ${cr.coloration}`);
      } else if (profile.item) {
        const it = profile.item;
        if (it.canonicalObjectPrompt) traits.push(it.canonicalObjectPrompt);
        if (it.shape) traits.push(`Shape: ${it.shape}`);
        if (it.materials) traits.push(`Materials: ${it.materials}`);
        if (it.magicalEffects) traits.push(`Effects: ${it.magicalEffects}`);
      }

      const description = traits.join(". ");
      resolvedEntities.push({
        entityId,
        name: entity.canonicalName,
        type: entity.type,
        hasApprovedProfile: true,
        profileRevision: profile.revision,
        description,
        wardrobe: activeWardrobe,
        weapons: profile.character?.weapons,
        visualPrompt: profile.visualPrompt,
        references: profile.references,
      });

      entityCanonLines.push(`CANONICAL ${entity.type.toUpperCase()} [${entity.canonicalName}]: ${description}`);
    } else {
      // Fallback to Story Bible canonical description
      const namePrefix = entity.originalName ? `${entity.canonicalName} (${entity.originalName})` : entity.canonicalName;
      const desc = entity.description ? `${namePrefix}: ${entity.description}` : namePrefix;
      resolvedEntities.push({
        entityId,
        name: entity.canonicalName,
        type: entity.type,
        hasApprovedProfile: false,
        description: desc,
      });
      entityCanonLines.push(`STORY BIBLE ${entity.type.toUpperCase()} [${entity.canonicalName}]: ${desc}`);
    }
  }

  // 3. Compose Layers:
  const promptParts: string[] = [];

  // Layer 1: Story Art Direction
  const styleHeader = [
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

  promptParts.push(`STORY ART DIRECTION: ${styleHeader}`);

  // Layer 2: Entity Visual Canon
  if (entityCanonLines.length > 0) {
    promptParts.push(`ENTITY VISUAL CANON:\n${entityCanonLines.join("\n")}`);
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
  const aspectRatio = resolveArtworkAspectRatio(story, artDirection);
  promptParts.push(artworkCompositionGuidance(aspectRatio));
  promptParts.push("Create one polished still illustration. No text, captions, speech bubbles, logos, or watermarks.");

  const prompt = promptParts.filter(Boolean).join("\n\n");

  // Negative Prompt
  const negParts = [
    artDirection.globalNegativePrompt,
    ...entityNegativePrompts,
    overrides.customNegativePrompt,
    "text, watermark, subtitles, borders, split frame, multiple panels, collage",
  ].filter(Boolean);
  const negativePrompt = negParts.join(", ");

  // Fingerprints
  const artDirectionFingerprint = fingerprint({
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
    direction: scene.direction,
    overrides: scene.overrides,
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
