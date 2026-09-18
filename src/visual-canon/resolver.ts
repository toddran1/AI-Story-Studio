import { CanonicalEntity, StoryBible } from "../domain/story-bible.js";
import { Story } from "../domain/story.js";
import { ArtDirectionPreset } from "../domain/art-direction.js";
import { VisualEntityProfile, VisualReferenceImage } from "../domain/visual-profile.js";
import { Scene, SceneDirection, SceneOverrides, sceneDirectionSchema, sceneOverridesSchema } from "../scenes/types.js";
import { resolveVisualEntities } from "../scenes/identity.js";
import { fingerprint } from "../utils/hash.js";

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
  resolvedEntities: ResolvedEntityCanon[];
};

export function resolveVisualCanonPrompt(options: {
  scene: Scene;
  story: Story;
  bible: StoryBible;
  artDirection: ArtDirectionPreset;
  visualProfiles: Record<string, VisualEntityProfile>;
}): ResolvedSceneVisualPrompt {
  const { scene, story, bible, artDirection, visualProfiles } = options;

  // 1. Resolve canonical entities in the scene
  const matchedEntities = new Map<string, CanonicalEntity>();

  // Resolve from entityIds if populated
  if (scene.entityIds && scene.entityIds.length > 0) {
    for (const id of scene.entityIds) {
      const found = bible.canonicalEntities.find((e) => e.id === id);
      if (found) matchedEntities.set(found.id, found);
    }
  }

  // Also resolve from character names
  const characterEntities = resolveVisualEntities(scene.characters, bible.canonicalEntities);
  for (const entity of characterEntities) {
    matchedEntities.set(entity.id, entity);
  }

  // Also resolve location if matching a canonical location entity
  if (scene.location) {
    const locNorm = scene.location.trim().toLowerCase();
    const locEntity = bible.canonicalEntities.find(
      (e) =>
        e.type === "location" &&
        (e.canonicalName.toLowerCase() === locNorm ||
          e.aliases.some((a) => a.toLowerCase() === locNorm) ||
          (e.originalName && e.originalName.toLowerCase() === locNorm)),
    );
    if (locEntity) matchedEntities.set(locEntity.id, locEntity);
  }

  // 2. Build Entity Visual Canon & collect fingerprints
  const resolvedEntities: ResolvedEntityCanon[] = [];
  const entityVisualFingerprints: Record<string, string> = {};

  const direction: SceneDirection = scene.direction ?? sceneDirectionSchema.parse({});
  const overrides: SceneOverrides = scene.overrides ?? sceneOverridesSchema.parse({});

  const entityCanonLines: string[] = [];
  const entityNegativePrompts: string[] = [];

  for (const [entityId, entity] of matchedEntities.entries()) {
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

      // Wardrobe override check
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
        if (activeWardrobe) traits.push(`Attire: ${activeWardrobe}`);
        if (c.weapons) traits.push(`Weapons: ${c.weapons}`);
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

  // Layer 6: Guard instructions & framing
  const [width = 0, height = 0] = (story.artwork.size || "").split("x").map(Number);
  const isPortrait = artDirection.aspectRatio === "9:16" || (width > 0 && height > 0 && width < height);
  const orientation = isPortrait ? "portrait" : "landscape";
  promptParts.push(`Create one polished still illustration. ${orientation}-safe composition. No text, captions, speech bubbles, logos, or watermarks.`);

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

  return {
    prompt,
    negativePrompt,
    artDirectionFingerprint,
    entityVisualFingerprints,
    sceneDirectionFingerprint,
    resolvedPromptFingerprint,
    resolvedEntities,
  };
}
