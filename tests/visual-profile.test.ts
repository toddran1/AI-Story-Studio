import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadVisualProfiles,
  saveVisualProfiles,
  getVisualProfile,
  updateVisualProfile,
  deleteVisualProfile,
  addVisualReferenceImage,
  generateStyleSheet,
  handleEntityMerge,
  handleEntityDemote,
} from "../src/visual-canon/profiles.js";
import { VisualEntityProfile } from "../src/domain/visual-profile.js";
import { storyPaths } from "../src/storage/paths.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { emptyStoryBible, canonicalEntitySchema } from "../src/domain/story-bible.js";

describe("Visual Entity Profiles", () => {
  let root: string;
  const slug = "test-story";
  const entityId = "ent_0123456789abcdef01234567";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "visual-profile-test-"));
    // Ensure story directory exists
    await atomicWriteJson(storyPaths(root, slug, 1).storyConfig, { slug, title: "Test Story" });
    const testBible = {
      ...emptyStoryBible(),
      canonicalEntities: [
        canonicalEntitySchema.parse({
          id: entityId,
          type: "character",
          canonicalName: "Test Character",
          aliases: [],
          description: "Test description",
          firstAppearance: 1,
          lastKnownAppearance: 1,
        }),
        canonicalEntitySchema.parse({
          id: "ent_aaaaaaaaaaaaaaaaaaaaaaaa",
          type: "character",
          canonicalName: "Target Hero",
          aliases: [],
          description: "Target description",
          firstAppearance: 1,
          lastKnownAppearance: 1,
        }),
        canonicalEntitySchema.parse({
          id: "ent_bbbbbbbbbbbbbbbbbbbbbbbb",
          type: "character",
          canonicalName: "Source Hero",
          aliases: [],
          description: "Source description",
          firstAppearance: 1,
          lastKnownAppearance: 1,
        }),
      ],
    };
    await atomicWriteJson(storyPaths(root, slug, 1).bible, testBible);
    return async () => {
      await rm(root, { recursive: true, force: true });
    };
  });

  it("loads empty profiles if visual-profiles.json does not exist", async () => {
    const profiles = await loadVisualProfiles(root, slug);
    expect(profiles).toEqual({});
  });

  it("creates a draft profile when querying a non-existent entity via updateVisualProfile", async () => {
    const nonExistent = await getVisualProfile(root, slug, entityId);
    expect(nonExistent).toBeUndefined();

    const profile = await updateVisualProfile(root, slug, entityId, {});
    expect(profile.entityId).toBe(entityId);
    expect(profile.status).toBe("draft");
    expect(profile.visualType).toBe("character");
    expect(profile.references).toEqual([]);
    expect(profile.revision).toBe(1);
  });

  it("updates and approves a visual profile", async () => {
    const initial = await updateVisualProfile(root, slug, entityId, {});
    expect(initial.status).toBe("draft");

    const updated = await updateVisualProfile(root, slug, entityId, {
      appearance: "A towering figure clad in midnight blue armor.",
      visualPrompt: "towering dark knight, midnight blue armor, glowing cyan visor",
      status: "approved",
      character: {
        apparentAge: "30s",
        hairColor: "silver",
        eyeColor: "cyan",
        defaultOutfit: "Midnight blue plate armor",
      },
    });

    expect(updated.status).toBe("approved");
    expect(updated.approvedAt).toBeDefined();
    expect(updated.character?.hairColor).toBe("silver");
    expect(updated.appearance).toBe("A towering figure clad in midnight blue armor.");
    expect(updated.revision).toBe(2);

    const reloaded = await getVisualProfile(root, slug, entityId);
    expect(reloaded).toBeDefined();
    expect(reloaded?.status).toBe("approved");
    expect(reloaded?.visualPrompt).toContain("towering dark knight");
  });

  it("adds and stores visual reference images", async () => {
    const pngBuffer = Buffer.from("fake-png-content");
    const { reference: ref } = await addVisualReferenceImage(root, slug, entityId, {
      role: "front",
      source: "uploaded",
      buffer: pngBuffer,
      approved: true,
      prompt: "front view portrait",
    });

    expect(ref.entityId).toBe(entityId);
    expect(ref.role).toBe("front");
    expect(ref.approved).toBe(true);
    expect(ref.imagePath).toContain(entityId);

    const profile = await getVisualProfile(root, slug, entityId);
    expect(profile?.references).toHaveLength(1);
    expect(profile?.references[0]?.id).toBe(ref.id);
  });

  it("generates a multi-view style sheet and attaches it to references", async () => {
    await updateVisualProfile(root, slug, entityId, {
      visualPrompt: "young sorcerer with raven hair and gold spectacles",
      character: { hairColor: "raven", accessories: "gold spectacles" },
    });

    const fakeProvider = {
      name: "fake-image-provider",
      validateConfiguration: async () => {},
      generate: async () => ({
        data: Buffer.from("fake-style-sheet-bytes"),
        mimeType: "image/png",
        provider: "fake",
        model: "fake-v1",
      }),
    };

    const fakeStory: any = {
      slug,
      artwork: {
        provider: "openai",
        model: "dall-e-3",
        stylePrompt: "Cinematic anime style",
        quality: "high",
        size: "1024x1024",
        outputFormat: "png",
      },
    };

    const result = await generateStyleSheet(root, slug, entityId, fakeProvider as any, fakeStory);
    expect(result.reference.imagePath).toContain(entityId);
    expect(result.profile.references.some((r) => r.source === "style_sheet")).toBe(true);
  });

  it("merges visual profiles when entities are merged", async () => {
    const targetId = "ent_aaaaaaaaaaaaaaaaaaaaaaaa";
    const sourceId = "ent_bbbbbbbbbbbbbbbbbbbbbbbb";

    await updateVisualProfile(root, slug, targetId, {
      appearance: "Main Hero appearance",
      visualPrompt: "hero prompt",
      status: "approved",
    });
    await updateVisualProfile(root, slug, sourceId, {
      appearance: "Alias appearance notes",
      notes: "Secondary info from alias",
      negativePrompt: "low quality",
    });

    await handleEntityMerge(root, slug, targetId, [sourceId]);

    const targetProfile = await getVisualProfile(root, slug, targetId);
    expect(targetProfile?.notes).toContain("Secondary info from alias");
    expect(targetProfile?.negativePrompt).toContain("low quality");

    const allProfiles = await loadVisualProfiles(root, slug);
    expect(sourceId in allProfiles).toBe(false);
  });

  it("demotes an approved profile to draft when demoted in Story Bible", async () => {
    await updateVisualProfile(root, slug, entityId, {
      status: "approved",
      appearance: "Canon creature description",
    });

    await handleEntityDemote(root, slug, entityId);

    const profile = await getVisualProfile(root, slug, entityId);
    expect(profile?.status).toBe("draft");
  });

  it("deletes a visual profile", async () => {
    await updateVisualProfile(root, slug, entityId, { appearance: "To be deleted" });
    const deleted = await deleteVisualProfile(root, slug, entityId);
    expect(deleted).toBe(true);

    const profiles = await loadVisualProfiles(root, slug);
    expect(entityId in profiles).toBe(false);
  });
});
