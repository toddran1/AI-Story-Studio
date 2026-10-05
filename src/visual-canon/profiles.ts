import { CHARACTER_DESIGN_GUIDANCE, CHARACTER_DESIGN_VERSION, characterDesignContext } from "./character-design.js";
import { prepareReferenceSheetIdentity, IDENTITY_TRANSFORMATION_INSTRUCTION } from "./reference-identity.js";
import { effectiveVisualProfile } from "./resolver.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  VisualEntityProfile,
  VisualReferenceImage,
  VisualRole,
  VisualReferenceSource,
  visualProfileSchema,
  visualReferenceImageSchema,
} from "../domain/visual-profile.js";
import { canonicalEntitySchema, type CanonicalEntity } from "../domain/story-bible.js";
import { requireCanonicalStoryBibleEntity, loadStoryBibleWithCanonicalOverlay } from "../story-bible/canonical.js";
import { resolveEntityVisualEvidence } from "../story-bible/visual-evidence.js";
import { readVisualField, resolveVisualEntityType, validVisualField } from "./fields.js";
import { Story } from "../domain/story.js";
import { ImageProvider } from "../artwork/provider.js";
import { assertImageModelCompatible, imageProviderNameSchema } from "../artwork/providers.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths, visualProfileRefPath } from "../storage/paths.js";
import { exists, readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { loadStoryArtDirection, resolveActiveArtDirection } from "./art-direction.js";
import {
  deleteControlledVisualReferenceFiles,
  findVisualReferenceFile,
  isVisualReferenceExtension,
  normalizeVisualReferenceExtension,
  resolveVisualReferencePath,
  removeControlledVisualReferenceFile,
} from "./assets.js";


const visualProfilesFileSchema = z.record(z.string(), visualProfileSchema);

/** Approval records an editorial decision, independent of field completeness. */
export function canApproveVisualProfile(profile: VisualEntityProfile): boolean {
  const hasText = (value: string | undefined) => Boolean(value?.trim());
  return hasText(profile.appearance) || hasText(profile.visualPrompt)
    || visualFieldEntries(profile).some(([, value]) => hasText(value))
    || profile.references.some((reference) => reference.approved);
}

function visualFieldEntries(profile: VisualEntityProfile): Array<[string, string | undefined]> {
  const sections: Array<["character" | "location" | "creature" | "item", Record<string, string | undefined> | undefined]> = [
    ["character", profile.character], ["location", profile.location], ["creature", profile.creature], ["item", profile.item],
  ];
  return sections.flatMap(([section, values]) => Object.entries(values ?? {}).map(([field, value]): [string, string | undefined] => [`${section}.${field}`, value?.trim() || undefined]));
}

/** UI saves represent deliberate editorial decisions.  Preserve that intent at
 * field granularity unless a domain service supplied richer provenance. */
function preserveManualFieldDecisions(previous: VisualEntityProfile | undefined, next: VisualEntityProfile, patch: Partial<VisualEntityProfile>) {
  const previousValues = new Map(previous ? visualFieldEntries(previous) : []);
  for (const [path, value] of visualFieldEntries(next)) {
    if (previousValues.get(path) === value) continue;
    // A full UI save includes the old provenance map. If its entry is unchanged
    // while its value changed, that was a human edit and must become a locked
    // decision. Domain services supply a new provenance entry for AI/source
    // writes, which we preserve instead.
    const supplied = patch.fieldProvenance?.[path];
    const prior = previous?.fieldProvenance?.[path];
    if (supplied && JSON.stringify(supplied) !== JSON.stringify(prior)) continue;
    next.fieldProvenance ??= {};
    if (value) next.fieldProvenance[path] = { source: "user_edit", locked: true };
    else delete next.fieldProvenance[path];
  }
}

export async function loadVisualProfiles(root: string, slug: string): Promise<Record<string, VisualEntityProfile>> {
  const path = storyPaths(root, slug, 1).visualProfiles;
  const raw = await readJsonIfExists<unknown>(path);
  if (!raw) return {};
  const parsed = visualProfilesFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Saved Visual Profiles for story '${slug}' are invalid and could not be loaded: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

export async function saveVisualProfiles(
  root: string,
  slug: string,
  profiles: Record<string, VisualEntityProfile>,
): Promise<void> {
  const path = storyPaths(root, slug, 1).visualProfiles;
  await atomicWriteJson(path, visualProfilesFileSchema.parse(profiles));
}

export async function getVisualProfile(
  root: string,
  slug: string,
  entityId: string,
): Promise<VisualEntityProfile | undefined> {
  canonicalEntitySchema.shape.id.parse(entityId);
  const profiles = await loadVisualProfiles(root, slug);
  return profiles[entityId];
}

export async function updateVisualProfile(
  root: string,
  slug: string,
  entityId: string,
  patch: Partial<VisualEntityProfile> & { visualType?: VisualEntityProfile["visualType"] },
): Promise<VisualEntityProfile> {
  const entity = await requireCanonicalStoryBibleEntity(root, slug, entityId);
  const profiles = await loadVisualProfiles(root, slug);
  const existing = profiles[entityId];
  const now = new Date().toISOString();

  let next: VisualEntityProfile;
  if (existing) {
    const isNowApproved = patch.status === "approved" && existing.status !== "approved";
    next = visualProfileSchema.parse({
      ...existing,
      ...patch,
      entityId,
      revision: existing.revision + 1,
      updatedAt: now,
      approvedAt: isNowApproved ? now : patch.status === "draft" ? undefined : existing.approvedAt,
    });
  } else {
    next = visualProfileSchema.parse({
      id: `vprof_${randomUUID()}`,
      entityId,
      visualType: patch.visualType ?? resolveVisualEntityType(entity),
      status: patch.status ?? "draft",
      appearance: patch.appearance ?? "",
      visualPrompt: patch.visualPrompt ?? "",
      negativePrompt: patch.negativePrompt ?? "",
      notes: patch.notes ?? "",
      character: patch.character,
      location: patch.location,
      creature: patch.creature,
      item: patch.item,
      variants: patch.variants ?? [],
      appearanceEras: patch.appearanceEras ?? [],
      creatureIdentity: patch.creatureIdentity ?? entity.visualIdentityKind,
      creatureForms: patch.creatureForms ?? [],
      references: patch.references ?? [],
      fieldProvenance: patch.fieldProvenance ?? {},
      revision: 1,
      createdAt: now,
      updatedAt: now,
      approvedAt: patch.status === "approved" ? now : undefined,
    });
  }

  preserveManualFieldDecisions(existing, next, patch);

  if (next.status === "approved" && existing?.status !== "approved") {
    if (!canApproveVisualProfile(next)) throw new Error("Add at least one persistent visual detail or approve a reference image before approving this Visual Profile.");
    if (next.conflicts?.some((conflict) => conflict.status === "needs_review")) throw new Error("Resolve Visual Profile conflicts before approval.");
  }

  profiles[entityId] = next;
  await saveVisualProfiles(root, slug, profiles);
  return next;
}

/** Mark a generated/uploaded reference as usable canon.  References are
 * versioned entries; approval never deletes earlier visual identity evidence. */
export async function approveVisualReference(
  root: string,
  slug: string,
  entityId: string,
  refId: string,
  primary = false,
  creatureFormId?: string,
  appearanceEraId?: string,
): Promise<VisualEntityProfile> {
  canonicalEntitySchema.shape.id.parse(entityId);
  if (!/^[a-zA-Z0-9_-]+$/.test(refId)) throw new Error("Invalid reference image ID");
  const profiles = await loadVisualProfiles(root, slug);
  const profile = profiles[entityId];
  if (!profile) throw new Error(`Visual profile for entity '${entityId}' was not found`);
  const reference = profile.references.find((item) => item.id === refId);
  if (!reference) throw new Error(`Visual reference '${refId}' was not found`);
  if (creatureFormId && appearanceEraId) throw new Error("Select a form or an era, not both");
  if (appearanceEraId) {
    const era = profile.appearanceEras?.find(item => item.id === appearanceEraId);
    if (!era || !era.referenceIds.includes(refId)) throw new Error("Reference is not assigned to the selected appearance era");
    if (era.detectedChange?.needsReview) throw new Error("Review changed source evidence before approving this era");
    if (profile.conflicts?.some(conflict => conflict.status === "needs_review")) throw new Error("Resolve Visual Profile conflicts before approval");
    const next = profile.appearanceEras?.filter(item => item.id !== era.id && item.status === "approved" && item.startChapter > era.startChapter).sort((a,b) => a.startChapter-b.startChapter)[0];
    if (next) era.endChapter = Math.min(era.endChapter ?? Infinity, next.startChapter-1);
    if (era.detectedChange) for (const earlier of profile.appearanceEras ?? []) if (earlier.id !== era.id && earlier.status === "approved" && earlier.startChapter < era.startChapter && (earlier.endChapter === undefined || earlier.endChapter >= era.startChapter)) earlier.endChapter = era.startChapter-1;
    era.status = "approved"; profile.status = "approved"; profile.approvedAt ??= new Date().toISOString();
  }
  if (creatureFormId) {
    const form = profile.creatureForms?.find(item => item.id === creatureFormId);
    if (!form || !form.referenceIds.includes(refId)) throw new Error("Reference is not assigned to the selected creature form");
    if (profile.conflicts?.some(conflict => conflict.status === "needs_review")) throw new Error("Resolve Visual Profile conflicts before approval");
    if (form.detectedSource?.needsReview) throw new Error("Review changed source evidence before approving this form");
    form.status = "approved";
    profile.status = "approved";
    profile.approvedAt ??= new Date().toISOString();
  }
  const referenceScope = profile.appearanceEras?.find((era) => era.referenceIds.includes(refId))?.id ?? profile.creatureForms?.find(form => form.referenceIds.includes(refId))?.id;
  for (const item of profile.references) {
    const itemScope = profile.appearanceEras?.find((era) => era.referenceIds.includes(item.id))?.id ?? profile.creatureForms?.find(form => form.referenceIds.includes(item.id))?.id;
    if (primary && item.id !== refId && item.role === "primary_reference" && itemScope === referenceScope) item.role = "general_reference";
  }
  reference.approved = true;
  if (primary) reference.role = "primary_reference";
  profile.revision += 1;
  profile.updatedAt = new Date().toISOString();
  profiles[entityId] = visualProfileSchema.parse(profile);
  await saveVisualProfiles(root, slug, profiles);
  return profiles[entityId]!;
}

export async function deleteVisualProfile(root: string, slug: string, entityId: string): Promise<boolean> {
  canonicalEntitySchema.shape.id.parse(entityId);
  const profiles = await loadVisualProfiles(root, slug);
  const existsInCanon = Boolean(profiles[entityId]);

  // Remove owned asset directory idempotently
  const entityDir = join(storyPaths(root, slug, 1).visualProfilesDirectory, entityId);
  await rm(entityDir, { recursive: true, force: true });

  if (existsInCanon) {
    delete profiles[entityId];
    await saveVisualProfiles(root, slug, profiles);
    return true;
  }
  return false;
}

export async function deleteVisualReferenceImage(
  root: string,
  slug: string,
  entityId: string,
  refId: string,
): Promise<{ profile: VisualEntityProfile; deleted: boolean; cleanupWarnings?: string[] }> {
  canonicalEntitySchema.shape.id.parse(entityId);
  if (!/^[a-zA-Z0-9_-]+$/.test(refId)) throw new Error("Invalid reference image ID");
  const profiles = await loadVisualProfiles(root, slug);
  const profile = profiles[entityId];
  if (!profile) throw new Error(`Visual profile for entity '${entityId}' was not found`);

  const refIndex = profile.references.findIndex((r) => r.id === refId);
  if (refIndex === -1) {
    return { profile, deleted: false };
  }

  profile.references.splice(refIndex, 1);
  profile.appearanceEras = profile.appearanceEras?.map((era) => ({ ...era, referenceIds: era.referenceIds.filter((id) => id !== refId) }));
  profile.creatureForms = profile.creatureForms?.map(form => ({ ...form, referenceIds: form.referenceIds.filter(id => id !== refId) }));
  profile.revision += 1;
  profile.updatedAt = new Date().toISOString();
  await saveVisualProfiles(root, slug, profiles);

  // Safely remove file on disk strictly using controlled paths - NEVER arbitrary imagePath
  const cleanupResult = await deleteControlledVisualReferenceFiles(root, slug, entityId, refId);

  const cleanupWarnings = cleanupResult.errors.length > 0
    ? cleanupResult.errors.map(
        (e) => `Failed to delete physical reference file for format '${e.extension}': ${e.message}`
      )
    : undefined;

  return {
    profile,
    deleted: true,
    ...(cleanupWarnings ? { cleanupWarnings } : {}),
  };
}

export async function addVisualReferenceImage(
  root: string,
  slug: string,
  entityId: string,
  options: {
    role?: VisualRole;
    data?: Buffer;
    buffer?: Buffer;
    ext?: string;
    prompt?: string;
    source?: VisualReferenceSource;
    approved?: boolean;
    provenance?: Record<string, unknown>;
    replacesReferenceId?: string;
    appearanceEraId?: string;
    creatureFormId?: string;
  },
): Promise<{ profile: VisualEntityProfile; reference: VisualReferenceImage }> {
  await requireCanonicalStoryBibleEntity(root, slug, entityId);
  const fileBytes = options.data ?? options.buffer;
  if (!fileBytes) throw new Error("Image data buffer is required");
  const ext = normalizeVisualReferenceExtension(options.ext ?? "png");

  const profiles = await loadVisualProfiles(root, slug);
  let profile = profiles[entityId];
  if (!profile) {
    profile = await updateVisualProfile(root, slug, entityId, {});
  }

  const refId = `ref_${randomUUID().slice(0, 12)}`;
  const filePath = resolveVisualReferencePath(root, slug, entityId, refId, ext);

  await mkdir(dirname(filePath), { recursive: true });
  await atomicWrite(filePath, fileBytes);

  try {
    const reference = visualReferenceImageSchema.parse({
      id: refId,
      entityId,
      role: options.role ?? "general_reference",
      imagePath: filePath,
      createdAt: new Date().toISOString(),
      source: options.source ?? "uploaded",
      approved: options.approved ?? false,
      prompt: options.prompt,
      provenance: options.provenance,
      replacesReferenceId: options.replacesReferenceId,
    });

    if (options.appearanceEraId) {
      const era = profile.appearanceEras?.find(item => item.id === options.appearanceEraId);
      if (!era) throw new Error("Appearance era was not found");
      era.referenceIds.push(refId);
    }
    if (options.creatureFormId) {
      const form = profile.creatureForms?.find(item => item.id === options.creatureFormId);
      if (!form) throw new Error("Creature form was not found");
      form.referenceIds.push(refId);
    }
    profile.references.push(reference);
    profile.updatedAt = new Date().toISOString();
    profile.revision += 1;
    profiles[entityId] = profile;

    await saveVisualProfiles(root, slug, profiles);
    return { profile, reference };
  } catch (err) {
    try {
      await removeControlledVisualReferenceFile(root, slug, entityId, refId, ext);
    } catch (cleanupErr: unknown) {
      const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.warn(
        `[VisualCanon] Failed to clean up orphan reference asset: story='${slug}', entity='${entityId}', reference='${refId}', extension='${ext}': ${cleanupMsg}`
      );
    }
    throw err;
  }
}

export async function generateStyleSheet(
  root: string,
  slug: string,
  entityId: string,
  provider: ImageProvider,
  story: Story,
  options: {
    promptOverride?: string;
    role?: VisualRole;
    presetId?: string;
    appearanceEraId?: string;
    creatureFormId?: string;
  } = {},
): Promise<{ profile: VisualEntityProfile; reference: VisualReferenceImage }> {
  const entity = await requireCanonicalStoryBibleEntity(root, slug, entityId);
  const savedProfile = await getVisualProfile(root, slug, entityId);
  if (!savedProfile) throw new Error(`Visual profile for entity '${entityId}' was not found`);
  if (options.creatureFormId && options.appearanceEraId) throw new Error("Select a creature form or an appearance era, not both");
  const form = options.creatureFormId ? savedProfile.creatureForms?.find(item => item.id === options.creatureFormId) : undefined;
  if (options.creatureFormId && !form) throw new Error("Creature form was not found");
  const era = form ? { ...form, startChapter: 1 } : options.appearanceEraId ? savedProfile.appearanceEras?.find(item => item.id === options.appearanceEraId) : undefined;
  if (options.appearanceEraId && !era) throw new Error("Appearance era was not found");
  if (era && !era.appearance.trim() && !era.visualPrompt.trim() && !Object.values(era.character ?? era.creature ?? {}).some(value => typeof value === "string" && value.trim())) throw new Error("Describe this era's appearance before generating its reference sheet");
  const profile = effectiveVisualProfile(savedProfile, era);
  if (imageProviderNameSchema.safeParse(provider.name).success) assertImageModelCompatible(provider.name, story.artwork.model);

  const artDirectionDoc = await loadStoryArtDirection(root, slug);
  const activePreset = resolveActiveArtDirection(artDirectionDoc, options.presetId);

  // Layer 1: Active Story Art Direction Preset
  const artDirectionParts: string[] = [
    `ART STYLE: ${activePreset.artStyle}`,
    activePreset.customStylePrompt ? `STYLE DIRECTION: ${activePreset.customStylePrompt}` : "",
    activePreset.visualTone ? `VISUAL TONE: ${activePreset.visualTone}` : "",
    activePreset.colorDirection ? `COLOR DIRECTION: ${activePreset.colorDirection}` : "",
    activePreset.lightingDirection ? `LIGHTING DIRECTION: ${activePreset.lightingDirection}` : "",
    activePreset.characterRenderingGuidance ? `CHARACTER RENDERING: ${activePreset.characterRenderingGuidance}` : "",
    activePreset.additionalVisualInstructions ? `ADDITIONAL INSTRUCTIONS: ${activePreset.additionalVisualInstructions}` : "",
  ].filter(Boolean);

  // Layer 2: persistent entity visual canon (never scene-specific state).
  const character = profile.visualType === "character" ? profile.character : undefined;
  const entityDetails: string[] = [
    `ENTITY: ${entity.canonicalName} (${profile.visualType})`,
    profile.visualPrompt ? `SUBJECT VISUAL PROMPT: ${profile.visualPrompt}` : "",
    profile.appearance ? `GENERAL APPEARANCE: ${profile.appearance}` : "",
    character?.apparentAge ? `APPARENT AGE: ${character.apparentAge}` : "",
    character?.gender ? `GENDER: ${character.gender}` : "",
    character?.height ? `HEIGHT: ${character.height}` : "",
    character?.build ? `BUILD / PHYSIQUE: ${character.build}` : "",
    character?.skinTone ? `SKIN TONE: ${character.skinTone}` : "",
    character?.faceShape ? `FACE SHAPE: ${character.faceShape}` : "",
    character?.eyeColor ? `EYES: ${character.eyeColor}` : "",
    character?.hairColor || character?.hairstyle
      ? `HAIR: ${[character.hairColor, character.hairstyle].filter(Boolean).join(", ")}`
      : "",
    character?.facialHair ? `FACIAL HAIR: ${character.facialHair}` : "",
    character?.distinguishingFeatures ? `DISTINGUISHING FEATURES: ${character.distinguishingFeatures}` : "",
    character?.scars ? `SCARS / PERMANENT MARKS: ${character.scars}` : "",
    character?.tattoos ? `TATTOOS: ${character.tattoos}` : "",
    character?.defaultOutfit ? `DEFAULT COSTUME / WARDROBE: ${character.defaultOutfit}` : "",
    character?.shoes ? `FOOTWEAR: ${character.shoes}` : "",
    character?.accessories ? `ACCESSORIES: ${character.accessories}` : "",
    character?.weapons ? `SIGNATURE WEAPONS: ${character.weapons}` : "",
    character?.equipment ? `PERSISTENT EQUIPMENT: ${character.equipment}` : "",
    character?.additionalAppearanceNotes ? `ADDITIONAL PERSISTENT APPEARANCE NOTES: ${character.additionalAppearanceNotes}` : "",
    profile.location?.architecture ? `ARCHITECTURE: ${profile.location.architecture}` : "",
    profile.location?.terrain ? `TERRAIN: ${profile.location.terrain}` : "",
    profile.location?.lighting ? `LIGHTING IDENTITY: ${profile.location.lighting}` : "",
    profile.location?.colorPalette ? `COLOR PALETTE: ${profile.location.colorPalette}` : "",
    profile.location?.recurringLandmarks ? `LANDMARKS: ${profile.location.recurringLandmarks}` : "",
  ].filter(Boolean);
  if (profile.creature) entityDetails.push(`CREATURE TRAITS: ${JSON.stringify(profile.creature)}`);
  if (profile.item) entityDetails.push(`ITEM TRAITS: ${JSON.stringify(profile.item)}`);
  if (profile.status !== "approved" && !era) {
    const evidence = resolveEntityVisualEvidence(entity, Number.MAX_SAFE_INTEGER);
    const sourceFacts = Object.entries(evidence.values).filter(([path]) => validVisualField(profile.visualType, path) && !readVisualField(profile, path)).map(([path, item]) => `${path}: ${item.value}`);
    if (sourceFacts.length) entityDetails.push(`SOURCE-BACKED STORY BIBLE VISUAL FACTS (unapproved draft guidance): ${sourceFacts.join("; ")}`);
  }

  // Layer 3: reference requirements follow entity type; locations must never
  // receive a character turnaround prompt.
  const referenceRequirements = profile.visualType === "location"
    ? [
        `LOCATION REFERENCE / ENVIRONMENT CONCEPT ART: a clear, reusable establishing view of this location's stable architecture, terrain, palette, landmarks, and atmosphere.`,
        `Do not include transient weather, combat damage, temporary visitors, scene action, text, labels, or watermarks.`,
      ]
    : profile.visualType === "character" ? [
        `CHARACTER REFERENCE / MODEL SHEET FOR PERSISTENT IDENTITY: render one and only one consistent person across every panel, on a neutral simple background with generous separation between views.`,
        `REQUESTED VIEWS WHEN FEASIBLE: full-body front, full-body three-quarter, full-body side/profile, full-body back, head/face front, head/face three-quarter, and head/face side/profile. Full-body views must show head-to-feet with no cropped feet; use neutral relaxed reference poses and consistent scale.`,
        `IDENTITY CONSISTENCY IS THE PURPOSE: keep facial structure, apparent age, proportions, height/build, skin tone, hair color and style, eye appearance, scars/marks, accessories, persistent default outfit, and established signature equipment identical across every view.`,
        `Professional usable reference sheet, clear identifying lighting and face-detail panels. Avoid dramatic perspective, scene action, battle effects, cinematic backgrounds, temporary wounds, blood, torn clothing, weather, transient weapons, decorative typography, captions, labels, fake UI, watermarks, borders, overlapping figures, or cropped bodies.`,
      ] : [
        `PERSISTENT ENTITY REFERENCE: create a clean reusable reference image for this entity's stable visual identity, with neutral presentation and no transient scene action.`,
        `Avoid text, labels, watermarks, cinematic backgrounds, temporary damage, current emotion, weather, or chapter-specific state.`,
      ];

  const paletteGuidance = "COLOR AND CHARACTER: Where appearance details are unspecified, use a distinctive, story-appropriate mix of colors, materials, and small identifying accents. Avoid automatically making clothing all black or giving every person black hair and dark brown eyes. Preserve every established profile trait, approved reference detail, source fact, and story art-direction choice; do not recolor known features for variety.";

  const castDesigns = profile.visualType === "character" ? characterDesignContext(await loadStoryBibleWithCanonicalOverlay(root, slug), await loadVisualProfiles(root, slug), entityId) : [];
  const identity = await prepareReferenceSheetIdentity(root, slug, savedProfile, story, provider, options);
  const sheetPrompt = [options.promptOverride ?? [
    artDirectionParts.join("\n"),
    entityDetails.join("\n"),
    paletteGuidance,
    referenceRequirements.join("\n"),
  ].filter(Boolean).join("\n\n"), profile.visualType === "character" ? CHARACTER_DESIGN_GUIDANCE + "\nOTHER CAST DESIGNS (comparison only): " + JSON.stringify(castDesigns) : "", identity.images.length ? IDENTITY_TRANSFORMATION_INSTRUCTION : ""].filter(Boolean).join("\n\n");

  // Combined negative prompt
  const negativePromptParts = [
    activePreset.globalNegativePrompt,
    profile.negativePrompt,
    "text, labels, captions, watermarks, signature, split frame, complex background, photo borders",
  ].filter(Boolean);
  const combinedNegativePrompt = negativePromptParts.join(", ");

  const artDirectionFingerprint = fingerprint({
    id: activePreset.id,
    name: activePreset.name,
    artStyle: activePreset.artStyle,
    customStylePrompt: activePreset.customStylePrompt,
    visualTone: activePreset.visualTone,
    colorDirection: activePreset.colorDirection,
    lightingDirection: activePreset.lightingDirection,
    characterRenderingGuidance: activePreset.characterRenderingGuidance,
    globalNegativePrompt: activePreset.globalNegativePrompt,
  });

  const profileFingerprint = fingerprint({
    id: profile.id,
    entityId: profile.entityId,
    revision: profile.revision,
    appearance: profile.appearance,
    visualPrompt: profile.visualPrompt,
    character: profile.character,
  });

  const promptFingerprint = fingerprint({
    prompt: sheetPrompt,
    negativePrompt: combinedNegativePrompt,
  });

  await provider.validateConfiguration();
  const result = await provider.generate({
    model: story.artwork.model,
    prompt: sheetPrompt,
    negativePrompt: combinedNegativePrompt || undefined,
    aspectRatio: story.artwork.aspectRatio,
    quality: story.artwork.quality,
    size: story.artwork.size,
    outputFormat: story.artwork.outputFormat,
    referenceImages: identity.images.length ? identity.images : undefined,
  });

  const ext = "png";
  const primaryReference = profile.references.find((reference) => reference.approved && reference.role === "primary_reference");

  return addVisualReferenceImage(root, slug, entityId, {
    role: options.role ?? "expression_sheet",
    data: result.data,
    ext,
    prompt: sheetPrompt,
    source: "style_sheet",
    // Generated references require review before they become visual canon.
    approved: false,
    appearanceEraId: form ? undefined : era?.id,
    creatureFormId: form?.id,
    provenance: {
      imageFingerprint: createHash("sha256").update(result.data).digest("hex"),
      identityMode: identity.mode,
      identityReason: identity.reason,
      identityReferenceIds: identity.images.map(image => image.referenceId),
      identityReferenceFingerprints: identity.fingerprints,
      targetFingerprint: referenceSheetTargetFingerprint(savedProfile, story, activePreset, options, identity.fingerprints, entity, castDesigns),
      appearanceEraId: form ? undefined : era?.id,
      creatureFormId: form?.id,
      provider: provider.name,
      model: story.artwork.model,
      generatedAt: new Date().toISOString(),
      presetId: activePreset.id,
      presetName: activePreset.name,
      artDirectionFingerprint,
      profileRevision: profile.revision,
      profileFingerprint,
      promptFingerprint,
      negativePrompt: combinedNegativePrompt,
    },
    // Keep the earlier primary as retained history while a new candidate moves
    // through review. Approval can then atomically make this the active one.
    replacesReferenceId: primaryReference?.id,
  });
}

/** Fingerprint the design intent, not unapproved candidates or unrelated revisions. */
export function referenceSheetTargetFingerprint(profile: VisualEntityProfile, story: Story, direction: unknown, scope: { appearanceEraId?: string; creatureFormId?: string; promptOverride?: string }, identityFingerprints: string[] = [], entity?: CanonicalEntity, castDesigns: unknown[] = []) {
  const form = profile.creatureForms?.find(item => item.id === scope.creatureFormId);
  const era = scope.appearanceEraId ? profile.appearanceEras?.find(item => item.id === scope.appearanceEraId) : form ? { ...form, startChapter: 1 } : undefined;
  const effective = effectiveVisualProfile(profile, era);
  return fingerprint({ characterDesignVersion: profile.visualType === "character" ? CHARACTER_DESIGN_VERSION : undefined, castDesigns: profile.visualType === "character" ? castDesigns : undefined, entityId: profile.entityId, entityName: entity?.canonicalName, visualType: profile.visualType, sourceEvidence: profile.status !== "approved" && !era ? entity?.visualEvidence : undefined, scope: { appearanceEraId: scope.appearanceEraId, creatureFormId: scope.creatureFormId, promptOverride: scope.promptOverride }, appearance: effective.appearance, visualPrompt: effective.visualPrompt, negativePrompt: effective.negativePrompt, character: effective.character, creature: effective.creature, location: effective.location, item: effective.item, direction, artwork: story.artwork, identityFingerprints });
}

export interface PreparedVisualCanonMerge {
  targetEntityId: string;
  sourceEntityIds: string[];
  preparedProfiles: Record<string, VisualEntityProfile>;
  migratedTargetPaths: string[];
  migratedSourceDirs: string[];
}

export async function prepareVisualCanonMerge(
  root: string,
  slug: string,
  targetEntityId: string,
  sourceEntityIds: string[],
): Promise<PreparedVisualCanonMerge> {
  canonicalEntitySchema.shape.id.parse(targetEntityId);
  for (const id of sourceEntityIds) {
    canonicalEntitySchema.shape.id.parse(id);
  }

  const profiles = await loadVisualProfiles(root, slug);
  const target = profiles[targetEntityId];
  const sources = sourceEntityIds
    .filter((id) => id !== targetEntityId)
    .map((id) => profiles[id])
    .filter((p): p is VisualEntityProfile => Boolean(p));

  if (!sources.length) {
    return {
      targetEntityId,
      sourceEntityIds,
      preparedProfiles: structuredClone(profiles),
      migratedTargetPaths: [],
      migratedSourceDirs: [],
    };
  }

  const targetDir = join(storyPaths(root, slug, 1).visualProfilesDirectory, targetEntityId);
  await mkdir(targetDir, { recursive: true });

  const migratedTargetPaths: string[] = [];
  const migratedSourceDirs: string[] = [];
  const migratedRefIds = new Map<string, string>();

  const migrateRef = async (
    ref: VisualReferenceImage,
    sourceEntityId: string,
    existingIds: Set<string>,
  ): Promise<VisualReferenceImage> => {
    let finalRefId = ref.id;
    let collisionOccurred = false;
    if (existingIds.has(finalRefId)) {
      finalRefId = `ref_${randomUUID().slice(0, 12)}`;
      collisionOccurred = true;
    }
    existingIds.add(finalRefId);
    migratedRefIds.set(`${sourceEntityId}:${ref.id}`, finalRefId);

    let hintExt: string | undefined;
    if (ref.imagePath) {
      const match = /\.([a-zA-Z0-9]+)$/.exec(ref.imagePath);
      if (match && isVisualReferenceExtension(match[1]!)) {
        hintExt = match[1]!;
      }
    }

    const found = await findVisualReferenceFile(root, slug, sourceEntityId, ref.id, hintExt);
    const ext = found?.ext ?? (hintExt ? normalizeVisualReferenceExtension(hintExt) : "png");
    const targetPath = resolveVisualReferencePath(root, slug, targetEntityId, finalRefId, ext);

    if (found) {
      const bytes = await readFile(found.path);
      await atomicWrite(targetPath, bytes);
      migratedTargetPaths.push(targetPath);
    }

    const updatedProvenance = {
      ...(ref.provenance ?? {}),
      migratedFromEntityId: sourceEntityId,
      originalRefId: ref.id,
      ...(collisionOccurred ? { collisionResolvedTo: finalRefId } : {}),
    };

    return visualReferenceImageSchema.parse({
      ...ref,
      id: finalRefId,
      entityId: targetEntityId,
      imagePath: targetPath,
      provenance: updatedProvenance,
    });
  };

  const now = new Date().toISOString();
  const migratedEras = (source: VisualEntityProfile) => (source.appearanceEras ?? []).map((era) => ({
    ...era,
    referenceIds: era.referenceIds.map((id) => migratedRefIds.get(`${source.entityId}:${id}`) ?? id),
  }));
  const migratedForms = (source: VisualEntityProfile) => (source.creatureForms ?? []).map(form => ({ ...form, referenceIds: form.referenceIds.map(id => migratedRefIds.get(`${source.entityId}:${id}`) ?? id) }));
  const appendForms = (existing: NonNullable<VisualEntityProfile["creatureForms"]>, incoming: NonNullable<VisualEntityProfile["creatureForms"]>) => {
    const merged = [...existing];
    for (const form of incoming) merged.push({ ...form, id: merged.some(item => item.id === form.id) ? randomUUID() : form.id, status: merged.some(item => item.state === form.state && item.status === "approved") ? "draft" : form.status });
    return merged;
  };
  const appendEras = (existing: NonNullable<VisualEntityProfile["appearanceEras"]>, incoming: NonNullable<VisualEntityProfile["appearanceEras"]>) => {
    const merged = [...existing];
    for (const era of incoming) {
      const overlaps = era.status === "approved" && merged.some((item) => item.status === "approved"
        && era.startChapter <= (item.endChapter ?? Number.MAX_SAFE_INTEGER)
        && item.startChapter <= (era.endChapter ?? Number.MAX_SAFE_INTEGER));
      // Preserve both designs after an entity merge, but require editorial
      // review before a conflicting imported range can affect artwork.
      merged.push({ ...era, id: merged.some((item) => item.id === era.id) ? randomUUID() : era.id, status: overlaps ? "draft" : era.status });
    }
    return merged;
  };
  const preparedProfiles: Record<string, VisualEntityProfile> = structuredClone(profiles);

  try {
    if (!target) {
      const primary = sources[0]!;
      const remainingSources = sources.slice(1);

      const existingIds = new Set<string>();
      const migratedRefs: VisualReferenceImage[] = [];

      for (const ref of primary.references) {
        migratedRefs.push(await migrateRef(ref, primary.entityId, existingIds));
      }
      migratedSourceDirs.push(join(storyPaths(root, slug, 1).visualProfilesDirectory, primary.entityId));

      for (const src of remainingSources) {
        for (const ref of src.references) {
          migratedRefs.push(await migrateRef(ref, src.entityId, existingIds));
        }
        migratedSourceDirs.push(join(storyPaths(root, slug, 1).visualProfilesDirectory, src.entityId));
      }

      const combinedNotes = [primary.notes, ...remainingSources.map((s) => s.notes).filter(Boolean)].filter(Boolean).join("\n");
      const combinedNegative = [primary.negativePrompt, ...remainingSources.map((s) => s.negativePrompt).filter(Boolean)].filter(Boolean).join(", ");
      const combinedVariants = [...primary.variants];
      let combinedEras = migratedEras(primary);
      let combinedForms = migratedForms(primary);
      for (const src of remainingSources) {
        for (const v of src.variants) {
          if (!combinedVariants.some((existing) => existing.name.toLowerCase() === v.name.toLowerCase())) {
            combinedVariants.push(v);
          }
        }
        combinedEras = appendEras(combinedEras, migratedEras(src));
        combinedForms = appendForms(combinedForms, migratedForms(src));
      }

      preparedProfiles[targetEntityId] = visualProfileSchema.parse({
        ...primary,
        id: `vprof_${randomUUID()}`,
        entityId: targetEntityId,
        notes: combinedNotes,
        negativePrompt: combinedNegative,
        variants: combinedVariants,
        appearanceEras: combinedEras,
        creatureForms: combinedForms,
        references: migratedRefs,
        revision: primary.revision + 1,
        updatedAt: now,
      });

      for (const src of sources) {
        delete preparedProfiles[src.entityId];
      }
    } else {
      const preparedTarget = preparedProfiles[targetEntityId]!;
      const existingIds = new Set<string>(preparedTarget.references.map((r) => r.id));
      const allRefs = [...preparedTarget.references];

      for (const src of sources) {
        for (const ref of src.references) {
          const migrated = await migrateRef(ref, src.entityId, existingIds);
          allRefs.push(migrated);
        }
        migratedSourceDirs.push(join(storyPaths(root, slug, 1).visualProfilesDirectory, src.entityId));

        if (src.notes && !preparedTarget.notes.includes(src.notes)) {
          preparedTarget.notes = [preparedTarget.notes, src.notes].filter(Boolean).join("\n");
        }
        if (src.negativePrompt && !preparedTarget.negativePrompt.includes(src.negativePrompt)) {
          preparedTarget.negativePrompt = [preparedTarget.negativePrompt, src.negativePrompt].filter(Boolean).join(", ");
        }
        for (const v of src.variants) {
          if (!preparedTarget.variants.some((existing) => existing.name.toLowerCase() === v.name.toLowerCase())) {
            preparedTarget.variants.push(v);
          }
        }
        preparedTarget.appearanceEras = appendEras(preparedTarget.appearanceEras ?? [], migratedEras(src));
        preparedTarget.creatureForms = appendForms(preparedTarget.creatureForms ?? [], migratedForms(src));
        delete preparedProfiles[src.entityId];
      }

      preparedTarget.references = allRefs;
      preparedTarget.updatedAt = now;
      preparedTarget.revision += 1;
      preparedProfiles[targetEntityId] = visualProfileSchema.parse(preparedTarget);
    }
  } catch (err) {
    for (const p of migratedTargetPaths) {
      await rm(p, { force: true }).catch(() => undefined);
    }
    throw err;
  }

  return {
    targetEntityId,
    sourceEntityIds,
    preparedProfiles,
    migratedTargetPaths,
    migratedSourceDirs,
  };
}

export async function rollbackPreparedVisualCanonMerge(
  prepared: PreparedVisualCanonMerge,
): Promise<void> {
  for (const p of prepared.migratedTargetPaths) {
    await rm(p, { force: true }).catch(() => undefined);
  }
}

export async function commitVisualCanonMerge(
  root: string,
  slug: string,
  prepared: PreparedVisualCanonMerge,
): Promise<void> {
  await saveVisualProfiles(root, slug, prepared.preparedProfiles);
}

export async function finalizeVisualCanonMerge(
  prepared: PreparedVisualCanonMerge,
): Promise<{ cleanedDirs: string[]; errors: string[] }> {
  const cleanedDirs: string[] = [];
  const errors: string[] = [];

  for (const srcDir of prepared.migratedSourceDirs) {
    try {
      await rm(srcDir, { recursive: true, force: true });
      cleanedDirs.push(srcDir);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr?.code !== "ENOENT") {
        const msg = `Failed to clean up source directory '${srcDir}': ${nodeErr?.message ?? String(err)}`;
        errors.push(msg);
        console.warn(`[VisualCanon] ${msg}`);
      }
    }
  }

  return { cleanedDirs, errors };
}

export async function handleEntityMerge(
  root: string,
  slug: string,
  targetEntityId: string,
  sourceEntityIds: string[],
): Promise<void> {
  const prepared = await prepareVisualCanonMerge(root, slug, targetEntityId, sourceEntityIds);
  try {
    await commitVisualCanonMerge(root, slug, prepared);
  } catch (err) {
    await rollbackPreparedVisualCanonMerge(prepared);
    throw err;
  }
  await finalizeVisualCanonMerge(prepared);
}

export interface PreparedVisualCanonDemote {
  entityId: string;
  hadProfile: boolean;
  preDemoteProfile?: VisualEntityProfile;
  preparedProfiles: Record<string, VisualEntityProfile>;
}

export async function prepareVisualCanonDemote(
  root: string,
  slug: string,
  entityId: string,
): Promise<PreparedVisualCanonDemote> {
  canonicalEntitySchema.shape.id.parse(entityId);
  const profiles = await loadVisualProfiles(root, slug);
  const existing = profiles[entityId];
  if (!existing) {
    return {
      entityId,
      hadProfile: false,
      preparedProfiles: profiles,
    };
  }

  const preparedProfiles = { ...profiles };
  preparedProfiles[entityId] = {
    ...existing,
    status: "draft",
    notes: `${existing.notes}\n[Archived from demoted entity]`.trim(),
    updatedAt: new Date().toISOString(),
  };

  return {
    entityId,
    hadProfile: true,
    preDemoteProfile: structuredClone(existing),
    preparedProfiles,
  };
}

export async function commitVisualCanonDemote(
  root: string,
  slug: string,
  prepared: PreparedVisualCanonDemote,
): Promise<void> {
  if (prepared.hadProfile) {
    await saveVisualProfiles(root, slug, prepared.preparedProfiles);
  }
}

export async function rollbackPreparedVisualCanonDemote(
  root: string,
  slug: string,
  prepared: PreparedVisualCanonDemote,
): Promise<void> {
  if (prepared.hadProfile && prepared.preDemoteProfile) {
    const profiles = await loadVisualProfiles(root, slug);
    profiles[prepared.entityId] = prepared.preDemoteProfile;
    await saveVisualProfiles(root, slug, profiles);
  }
}

export async function handleEntityDemote(root: string, slug: string, entityId: string): Promise<void> {
  const prepared = await prepareVisualCanonDemote(root, slug, entityId);
  await commitVisualCanonDemote(root, slug, prepared);
}
