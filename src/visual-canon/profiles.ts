import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  VisualEntityProfile,
  VisualReferenceImage,
  VisualRole,
  VisualReferenceSource,
  visualProfileSchema,
  visualReferenceImageSchema,
} from "../domain/visual-profile.js";
import { Story } from "../domain/story.js";
import { ImageProvider } from "../artwork/provider.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths, visualProfileRefPath } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";

const visualProfilesFileSchema = z.record(z.string(), visualProfileSchema);

export async function loadVisualProfiles(root: string, slug: string): Promise<Record<string, VisualEntityProfile>> {
  const path = storyPaths(root, slug, 1).visualProfiles;
  const raw = await readJsonIfExists<unknown>(path);
  if (!raw) return {};
  const parsed = visualProfilesFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
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
  const profiles = await loadVisualProfiles(root, slug);
  return profiles[entityId];
}

export async function updateVisualProfile(
  root: string,
  slug: string,
  entityId: string,
  patch: Partial<VisualEntityProfile> & { visualType?: VisualEntityProfile["visualType"] },
): Promise<VisualEntityProfile> {
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
  const profiles = await loadVisualProfiles(root, slug);
  if (!profiles[entityId]) return false;
  delete profiles[entityId];
  await saveVisualProfiles(root, slug, profiles);
  return true;
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
  const fileBytes = options.data ?? options.buffer;
  if (!fileBytes) throw new Error("Image data buffer is required");
  const profiles = await loadVisualProfiles(root, slug);
  let profile = profiles[entityId];
  if (!profile) {
    profile = await updateVisualProfile(root, slug, entityId, {});
  }

  const refId = `ref_${randomUUID().slice(0, 12)}`;
  const ext = options.ext ?? "png";
  const filePath = visualProfileRefPath(root, slug, entityId, refId, ext);

  await mkdir(dirname(filePath), { recursive: true });
  await atomicWrite(filePath, fileBytes);

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
  } = {},
): Promise<{ profile: VisualEntityProfile; reference: VisualReferenceImage }> {
  const profile = await getVisualProfile(root, slug, entityId);
  if (!profile) throw new Error(`Visual profile for entity '${entityId}' was not found`);

  const characterPrompt = profile.visualPrompt || profile.appearance;
  const sheetPrompt = options.promptOverride ?? [
    `STORY-WIDE ART DIRECTION: ${story.artwork.stylePrompt}`,
    `CHARACTER STYLE SHEET / MODEL SHEET: Multiple views of the same subject on a clean neutral background.`,
    `VIEWS INCLUDED: full body front view, three-quarter angle, side profile, rear view, close-up facial expressions (neutral, determined, emotional).`,
    characterPrompt ? `SUBJECT VISUAL TRAITS: ${characterPrompt}` : "",
    profile.character?.defaultOutfit ? `DEFAULT COSTUME / WARDROBE: ${profile.character.defaultOutfit}` : "",
    profile.character?.weapons ? `SIGNATURE WEAPONS / GEAR: ${profile.character.weapons}` : "",
    `Crisp line work, consistent anatomical scale, professional animation model sheet layout, no text, no captions, no watermarks.`,
  ].filter(Boolean).join("\n");

  await provider.validateConfiguration();
  const result = await provider.generate({
    model: story.artwork.model,
    prompt: sheetPrompt,
    quality: story.artwork.quality,
    size: story.artwork.size,
    outputFormat: story.artwork.outputFormat,
  });

  return addVisualReferenceImage(root, slug, entityId, {
    role: options.role ?? "expression_sheet",
    data: result.data,
    ext: "png",
    prompt: sheetPrompt,
    source: "style_sheet",
    approved: true,
    provenance: {
      provider: provider.name,
      model: story.artwork.model,
      generatedAt: new Date().toISOString(),
    },
  });
}

export async function handleEntityMerge(
  root: string,
  slug: string,
  targetEntityId: string,
  sourceEntityIds: string[],
): Promise<void> {
  const profiles = await loadVisualProfiles(root, slug);
  const target = profiles[targetEntityId];
  const sources = sourceEntityIds.map((id) => profiles[id]).filter((p): p is VisualEntityProfile => Boolean(p));

  if (!sources.length) return;

  if (!target) {
    // If target has no profile, adopt the primary source's profile
    const primary = sources[0]!;
    profiles[targetEntityId] = {
      ...primary,
      entityId: targetEntityId,
      updatedAt: new Date().toISOString(),
      revision: primary.revision + 1,
    };
    for (const src of sources) {
      delete profiles[src.entityId];
    }
  } else {
    // Merge references and notes from sources into target
    const allRefs = [...target.references];
    for (const src of sources) {
      for (const ref of src.references) {
        if (!allRefs.some((existing) => existing.id === ref.id)) {
          allRefs.push({ ...ref, entityId: targetEntityId });
        }
      }
      if (src.notes && !target.notes.includes(src.notes)) {
        target.notes = [target.notes, src.notes].filter(Boolean).join("\n");
      }
      if (src.negativePrompt && !target.negativePrompt.includes(src.negativePrompt)) {
        target.negativePrompt = [target.negativePrompt, src.negativePrompt].filter(Boolean).join(", ");
      }
      delete profiles[src.entityId];
    }
    target.references = allRefs;
    target.updatedAt = new Date().toISOString();
    target.revision += 1;
    profiles[targetEntityId] = target;
  }

  await saveVisualProfiles(root, slug, profiles);
}

export async function handleEntityDemote(root: string, slug: string, entityId: string): Promise<void> {
  // Retain or archive the visual profile safely; don't break references
  const profiles = await loadVisualProfiles(root, slug);
  if (profiles[entityId]) {
    profiles[entityId] = {
      ...profiles[entityId]!,
      status: "draft",
      notes: `${profiles[entityId]!.notes}\n[Archived from demoted entity]`.trim(),
      updatedAt: new Date().toISOString(),
    };
    await saveVisualProfiles(root, slug, profiles);
  }
}
