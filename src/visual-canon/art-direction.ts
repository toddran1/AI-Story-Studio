import { randomUUID } from "node:crypto";
import {
  ArtDirectionPreset,
  StoryArtDirection,
  artDirectionPresetSchema,
  createDefaultArtDirection,
  storyArtDirectionSchema,
} from "../domain/art-direction.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";

function nextUpdatedAt(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

export async function loadStoryArtDirection(root: string, slug: string): Promise<StoryArtDirection> {
  const path = storyPaths(root, slug, 1).artDirection;
  const raw = await readJsonIfExists<unknown>(path);
  if (!raw) return createDefaultArtDirection();
  const parsed = storyArtDirectionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Saved Art Direction for story '${slug}' is invalid and could not be loaded: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

export async function saveStoryArtDirection(
  root: string,
  slug: string,
  artDirection: StoryArtDirection,
): Promise<void> {
  const path = storyPaths(root, slug, 1).artDirection;
  await atomicWriteJson(path, storyArtDirectionSchema.parse(artDirection));
}

export function resolveActiveArtDirection(
  artDirection: StoryArtDirection,
  presetIdOverride?: string,
): ArtDirectionPreset {
  const targetId = presetIdOverride ?? artDirection.activePresetId;
  const match = artDirection.presets.find((p) => p.id === targetId);
  if (match) return match;
  const defaultPreset = artDirection.presets.find((p) => p.isDefault);
  if (defaultPreset) return defaultPreset;
  return artDirection.presets[0]!;
}

export async function createPreset(
  root: string,
  slug: string,
  input: Partial<ArtDirectionPreset> & { name: string },
): Promise<ArtDirectionPreset> {
  const artDirection = await loadStoryArtDirection(root, slug);
  const now = nextUpdatedAt(artDirection.updatedAt);
  const preset = artDirectionPresetSchema.parse({
    id: `preset_${randomUUID()}`,
    name: input.name,
    isDefault: false,
    artStyle: input.artStyle ?? "Manhwa",
    customStylePrompt: input.customStylePrompt ?? "",
    visualTone: input.visualTone ?? "Dark fantasy, progression fantasy, supernatural action",
    colorDirection: input.colorDirection ?? "Rich atmospheric palette, high contrast, muted shadows with vibrant magical accents",
    lightingDirection: input.lightingDirection ?? "Low-key cinematic lighting, deep shadows, controlled highlights",
    cameraStyle: input.cameraStyle ?? "Dynamic cinematic framing, strong depth, dramatic composition",
    compositionTendencies: input.compositionTendencies ?? "Action-oriented, clear character focus with expansive background scale",
    environmentStyle: input.environmentStyle ?? "Detailed atmospheric environments, immersive depth",
    characterRenderingGuidance: input.characterRenderingGuidance ?? "Crisp line work, consistent anatomical proportions, detailed expression",
    aspectRatio: input.aspectRatio ?? "16:9",
    characterConsistencyStrength: input.characterConsistencyStrength ?? 0.8,
    environmentConsistencyStrength: input.environmentConsistencyStrength ?? 0.8,
    globalNegativePrompt: input.globalNegativePrompt ?? "text, watermark, signature, logo, malformed anatomy, extra limbs, low resolution, blurry",
    additionalVisualInstructions: input.additionalVisualInstructions ?? "",
    createdAt: now,
    updatedAt: now,
  });

  artDirection.presets.push(preset);
  artDirection.updatedAt = now;
  await saveStoryArtDirection(root, slug, artDirection);
  return preset;
}

export async function updatePreset(
  root: string,
  slug: string,
  presetId: string,
  patch: Partial<ArtDirectionPreset>,
): Promise<ArtDirectionPreset> {
  const artDirection = await loadStoryArtDirection(root, slug);
  const index = artDirection.presets.findIndex((p) => p.id === presetId);
  if (index < 0) throw new Error(`Art direction preset '${presetId}' was not found`);

  const existing = artDirection.presets[index]!;
  const now = nextUpdatedAt(artDirection.updatedAt);
  const updated = artDirectionPresetSchema.parse({
    ...existing,
    ...patch,
    id: existing.id,
    isDefault: patch.isDefault !== undefined ? patch.isDefault : existing.isDefault,
    updatedAt: now,
  });

  artDirection.presets[index] = updated;
  artDirection.updatedAt = now;
  await saveStoryArtDirection(root, slug, artDirection);
  return updated;
}

export async function deletePreset(root: string, slug: string, presetId: string): Promise<void> {
  const artDirection = await loadStoryArtDirection(root, slug);
  const target = artDirection.presets.find((p) => p.id === presetId);
  if (!target) return;
  if (target.isDefault) {
    throw new Error("Cannot delete the default art direction preset");
  }
  artDirection.presets = artDirection.presets.filter((p) => p.id !== presetId);
  if (artDirection.activePresetId === presetId) {
    const fallback = artDirection.presets.find((p) => p.isDefault) ?? artDirection.presets[0]!;
    artDirection.activePresetId = fallback.id;
  }
  artDirection.updatedAt = nextUpdatedAt(artDirection.updatedAt);
  await saveStoryArtDirection(root, slug, artDirection);
}

export async function duplicatePreset(
  root: string,
  slug: string,
  presetId: string,
  newName?: string,
): Promise<ArtDirectionPreset> {
  const artDirection = await loadStoryArtDirection(root, slug);
  const source = artDirection.presets.find((p) => p.id === presetId);
  if (!source) throw new Error(`Art direction preset '${presetId}' was not found`);

  const now = nextUpdatedAt(artDirection.updatedAt);
  const duplicated = artDirectionPresetSchema.parse({
    ...source,
    id: `preset_${randomUUID()}`,
    name: newName ?? `${source.name} (Copy)`,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  });

  artDirection.presets.push(duplicated);
  artDirection.updatedAt = now;
  await saveStoryArtDirection(root, slug, artDirection);
  return duplicated;
}

export async function setDefaultPreset(root: string, slug: string, presetId: string): Promise<void> {
  const artDirection = await loadStoryArtDirection(root, slug);
  let found = false;
  for (const preset of artDirection.presets) {
    if (preset.id === presetId) {
      preset.isDefault = true;
      found = true;
    } else {
      preset.isDefault = false;
    }
  }
  if (!found) throw new Error(`Art direction preset '${presetId}' was not found`);
  artDirection.activePresetId = presetId;
  artDirection.updatedAt = nextUpdatedAt(artDirection.updatedAt);
  await saveStoryArtDirection(root, slug, artDirection);
}
