import { randomUUID } from "node:crypto";
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
import { canonicalEntitySchema } from "../domain/story-bible.js";
import { requireCanonicalStoryBibleEntity } from "../story-bible/canonical.js";
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
): Promise<VisualEntityProfile> {
  canonicalEntitySchema.shape.id.parse(entityId);
  if (!/^[a-zA-Z0-9_-]+$/.test(refId)) throw new Error("Invalid reference image ID");
  const profiles = await loadVisualProfiles(root, slug);
  const profile = profiles[entityId];
  if (!profile) throw new Error(`Visual profile for entity '${entityId}' was not found`);
  const reference = profile.references.find((item) => item.id === refId);
  if (!reference) throw new Error(`Visual reference '${refId}' was not found`);
  for (const item of profile.references) {
    if (primary && item.id !== refId && item.role === "primary_reference") item.role = "general_reference";
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
  } = {},
): Promise<{ profile: VisualEntityProfile; reference: VisualReferenceImage }> {
  const entity = await requireCanonicalStoryBibleEntity(root, slug, entityId);
  const profile = await getVisualProfile(root, slug, entityId);
  if (!profile) throw new Error(`Visual profile for entity '${entityId}' was not found`);
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
  if (profile.status !== "approved") {
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

  const sheetPrompt = options.promptOverride ?? [
    artDirectionParts.join("\n"),
    entityDetails.join("\n"),
    referenceRequirements.join("\n"),
  ].filter(Boolean).join("\n\n");

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
    provenance: {
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
      for (const src of remainingSources) {
        for (const v of src.variants) {
          if (!combinedVariants.some((existing) => existing.name.toLowerCase() === v.name.toLowerCase())) {
            combinedVariants.push(v);
          }
        }
      }

      preparedProfiles[targetEntityId] = visualProfileSchema.parse({
        ...primary,
        id: `vprof_${randomUUID()}`,
        entityId: targetEntityId,
        notes: combinedNotes,
        negativePrompt: combinedNegative,
        variants: combinedVariants,
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
