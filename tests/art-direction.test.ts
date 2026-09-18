import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadStoryArtDirection,
  saveStoryArtDirection,
  createPreset,
  updatePreset,
  deletePreset,
  duplicatePreset,
  setDefaultPreset,
  resolveActiveArtDirection,
} from "../src/visual-canon/art-direction.js";
import { storyPaths } from "../src/storage/paths.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";

describe("Story Art Direction Presets", () => {
  let root: string;
  const slug = "art-story";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "art-direction-test-"));
    await atomicWriteJson(storyPaths(root, slug, 1).storyConfig, {
      slug,
      title: "Art Story",
      artwork: { stylePrompt: "Cinematic webtoon illustration" },
    });
    return async () => {
      await rm(root, { recursive: true, force: true });
    };
  });

  it("loads default art direction preset if art-direction.json does not exist", async () => {
    const art = await loadStoryArtDirection(root, slug);
    expect(art.presets).toHaveLength(1);
    expect(art.presets[0]?.name).toBe("Main Style");
    expect(art.presets[0]?.isDefault).toBe(true);
    expect(art.activePresetId).toBe(art.presets[0]?.id);
  });

  it("creates, updates, and persists a new art direction preset", async () => {
    const newPreset = {
      name: "Flashback Sepia",
      isDefault: false,
      artStyle: "Manga" as const,
      customStylePrompt: "vintage sepia ink style, soft grain, washed-out highlights",
      visualTone: "Nostalgic, tragic",
      colorDirection: "Monochrome sepia tones, paper texture",
      lightingDirection: "Soft diffuse natural light",
      cameraStyle: "Static wide framing, observational",
      compositionTendencies: "Quiet, centered, symmetrical",
      environmentStyle: "Subtle minimalist background lines",
      characterRenderingGuidance: "Expressive eyes, vintage crosshatching",
      aspectRatio: "16:9" as const,
      characterConsistencyStrength: 0.85,
      environmentConsistencyStrength: 0.75,
      globalNegativePrompt: "vibrant colors, neon, modern clothing",
      additionalVisualInstructions: "",
    };

    const created = await createPreset(root, slug, newPreset);
    expect(created.id).toBeDefined();
    expect(created.name).toBe("Flashback Sepia");

    const updatedArt = await loadStoryArtDirection(root, slug);
    expect(updatedArt.presets).toHaveLength(2);
    expect(updatedArt.presets.some((p) => p.id === created.id)).toBe(true);

    const patched = await updatePreset(root, slug, created.id, {
      visualTone: "Dark nostalgic tragedy",
    });
    expect(patched.visualTone).toBe("Dark nostalgic tragedy");

    const reloaded = await loadStoryArtDirection(root, slug);
    const flashback = reloaded.presets.find((p) => p.id === created.id);
    expect(flashback?.visualTone).toBe("Dark nostalgic tragedy");
  });

  it("duplicates an existing preset", async () => {
    const art = await loadStoryArtDirection(root, slug);
    const mainId = art.presets[0]!.id;

    const copy = await duplicatePreset(root, slug, mainId);
    expect(copy.id).not.toBe(mainId);
    expect(copy.name).toBe("Main Style (Copy)");
    expect(copy.isDefault).toBe(false);

    const updatedArt = await loadStoryArtDirection(root, slug);
    expect(updatedArt.presets).toHaveLength(2);
  });

  it("sets a preset as default", async () => {
    const art = await loadStoryArtDirection(root, slug);
    const copy = await duplicatePreset(root, slug, art.presets[0]!.id);

    await setDefaultPreset(root, slug, copy.id);
    const updatedArt = await loadStoryArtDirection(root, slug);
    expect(updatedArt.activePresetId).toBe(copy.id);

    const newDefault = updatedArt.presets.find((p) => p.id === copy.id);
    expect(newDefault?.isDefault).toBe(true);
    const oldDefault = updatedArt.presets.find((p) => p.id === art.presets[0]!.id);
    expect(oldDefault?.isDefault).toBe(false);
  });

  it("deletes a preset, but forbids deleting the default preset", async () => {
    const art = await loadStoryArtDirection(root, slug);
    const copy = await duplicatePreset(root, slug, art.presets[0]!.id);

    await deletePreset(root, slug, copy.id);
    const afterDelete = await loadStoryArtDirection(root, slug);
    expect(afterDelete.presets).toHaveLength(1);

    await expect(deletePreset(root, slug, afterDelete.presets[0]!.id)).rejects.toThrow(
      "Cannot delete the default art direction preset",
    );
  });

  it("resolves the active preset using story default or scene override", async () => {
    const art = await loadStoryArtDirection(root, slug);
    const darkPreset = await duplicatePreset(root, slug, art.presets[0]!.id);
    await updatePreset(root, slug, darkPreset.id, {
      name: "Dark Battle",
      customStylePrompt: "grimdark battlefield illustration",
    });
    const currentArt = await loadStoryArtDirection(root, slug);

    // Case 1: Default resolution
    const resolvedDefault = resolveActiveArtDirection(currentArt);
    expect(resolvedDefault.id).toBe(art.presets[0]!.id);

    // Case 2: Scene override resolution
    const resolvedOverride = resolveActiveArtDirection(currentArt, darkPreset.id);
    expect(resolvedOverride.id).toBe(darkPreset.id);
    expect(resolvedOverride.customStylePrompt).toContain("grimdark battlefield");

    // Case 3: Non-existent override falls back to default
    const resolvedFallback = resolveActiveArtDirection(currentArt, "non_existent_preset");
    expect(resolvedFallback.id).toBe(art.presets[0]!.id);
  });
});
