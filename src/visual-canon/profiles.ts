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
  await requireCanonicalStoryBibleEntity(root, slug, entityId);
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
      visualType: patch.visualType ?? "character",
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
      revision: 1,
      createdAt: now,
      updatedAt: now,
      approvedAt: patch.status === "approved" ? now : undefined,
    });
  }

  profiles[entityId] = next;
  await saveVisualProfiles(root, slug, profiles);
  return next;
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
  await requireCanonicalStoryBibleEntity(root, slug, entityId);
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

  // Layer 2: Character Visual Canon
  const characterPrompt = profile.visualPrompt || profile.appearance;
  const characterDetails: string[] = [
    characterPrompt ? `SUBJECT VISUAL TRAITS: ${characterPrompt}` : "",
    profile.character?.apparentAge ? `APPARENT AGE: ${profile.character.apparentAge}` : "",
    profile.character?.gender ? `GENDER: ${profile.character.gender}` : "",
    profile.character?.build ? `BUILD / PHYSIQUE: ${profile.character.build}` : "",
    profile.character?.hairColor || profile.character?.hairstyle
      ? `HAIR: ${[profile.character.hairColor, profile.character.hairstyle].filter(Boolean).join(", ")}`
      : "",
    profile.character?.faceShape ? `FACE SHAPE: ${profile.character.faceShape}` : "",
    profile.character?.defaultOutfit ? `DEFAULT COSTUME / WARDROBE: ${profile.character.defaultOutfit}` : "",
    profile.character?.weapons ? `SIGNATURE WEAPONS / GEAR: ${profile.character.weapons}` : "",
    profile.character?.distinguishingFeatures ? `DISTINGUISHING FEATURES: ${profile.character.distinguishingFeatures}` : "",
  ].filter(Boolean);

  // Layer 3: Style Sheet Requirements
  const styleSheetRequirements: string[] = [
    `CHARACTER MODEL SHEET / CONCEPT ART TURNAROUND: Multiple full-length views and expressions of the same subject on a clean neutral white background.`,
    `REQUIRED VIEWS: full-body front view, three-quarter angle, side profile, rear view, and close-up facial expression sheet (neutral, intense, emotional).`,
    `Crisp line work, consistent anatomical scale and costume details across all angles, professional animation model sheet layout, no text, no labels, no watermarks.`,
  ];

  const sheetPrompt = options.promptOverride ?? [
    artDirectionParts.join("\n"),
    characterDetails.join("\n"),
    styleSheetRequirements.join("\n"),
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

  return addVisualReferenceImage(root, slug, entityId, {
    role: options.role ?? "expression_sheet",
    data: result.data,
    ext,
    prompt: sheetPrompt,
    source: "style_sheet",
    approved: true,
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
