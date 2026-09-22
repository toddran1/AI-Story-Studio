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
  approveVisualReference,
  handleEntityMerge,
  handleEntityDemote,
} from "../src/visual-canon/profiles.js";
import { applyVisualProfileProposal, inspectVisualProfile, proposeMissingVisualDetails, resolveVisualProfileConflict } from "../src/visual-canon/completion.js";
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
        canonicalEntitySchema.parse({ id: "ent_cccccccccccccccccccccccc", type: "location", canonicalName: "Necromancer Guild", aliases: [], description: "An ancient guild hall", firstAppearance: 1, lastKnownAppearance: 1 }),
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
    expect(result.reference.approved).toBe(false);
  });

  it("proposes only missing visual details and persists only selected acceptance", async () => {
    const bible = {
      ...emptyStoryBible(),
      canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: [], description: "A necromancer with silver hair and blue eyes.", firstAppearance: 1, lastKnownAppearance: 1 })],
    };
    await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);
    await updateVisualProfile(root, slug, entityId, { character: { hairColor: "silver", eyeColor: "blue" } });
    let calls = 0;
    const provider = { name: "fake", validateConfiguration: async () => {}, generateText: async () => ({ text: "" }), generateStructured: async () => { calls++; return { value: { values: { "character.build": "lean athletic", "character.faceShape": "angular with a narrow jaw", "character.hairColor": "black" }, rationale: "Role-informed design" } }; } };
    const proposal = await proposeMissingVisualDetails(root, slug, bible, entityId, provider as any, { provider: "openai", model: "fake" });
    expect(calls).toBe(1);
    expect(proposal.values).toMatchObject({ "character.build": "lean athletic", "character.faceShape": "angular with a narrow jaw" });
    expect(proposal.values["character.hairColor"]).toBeUndefined();
    expect((await getVisualProfile(root, slug, entityId))?.character?.build).toBeUndefined();
    const updated = await applyVisualProfileProposal(root, slug, bible, proposal, ["character.build"]);
    expect(updated.character?.build).toBe("lean athletic");
    expect(updated.character?.hairColor).toBe("silver");
    expect(updated.fieldProvenance?.["character.build"]?.source).toBe("ai_generated");
  });

  it("protects explicit canonical facts and locked manual visual fields", async () => {
    const bible = {
      ...emptyStoryBible(),
      canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: [], description: "Hair: white. Eyes: violet.", firstAppearance: 1, lastKnownAppearance: 1 })],
    };
    await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);
    await updateVisualProfile(root, slug, entityId, { character: { eyeColor: "violet" }, fieldProvenance: { "character.eyeColor": { source: "user_edit", locked: true } } });
    const inspection = await inspectVisualProfile(root, slug, bible, entityId);
    expect(inspection.protectedFields).toContain("character.hairColor");
    expect(inspection.protectedFields).toContain("character.eyeColor");
    const provider = { name: "fake", generateStructured: async () => ({ value: { values: { "character.hairColor": "black", "character.eyeColor": "red", "character.build": "lean" }, rationale: "" } }) };
    const proposal = await proposeMissingVisualDetails(root, slug, bible, entityId, provider as any, { provider: "openai", model: "fake" }, { regenerate: true, fields: ["character.hairColor", "character.eyeColor", "character.build"] });
    expect(proposal.values).toEqual({ "character.build": "lean" });
  });

  it("keeps generated references in review until explicitly approved as primary", async () => {
    await updateVisualProfile(root, slug, entityId, { visualPrompt: "distinct necromancer" });
    const provider = { name: "fake-image-provider", validateConfiguration: async () => {}, generate: async () => ({ data: Buffer.from("image"), mimeType: "image/png", provider: "fake", model: "fake" }) };
    const story: any = { slug, artwork: { provider: "openai", model: "dall-e-3", aspectRatio: "1:1", quality: "high", size: "1024x1024", outputFormat: "png" } };
    const created = await generateStyleSheet(root, slug, entityId, provider as any, story);
    expect(created.reference.approved).toBe(false);
    const approved = await approveVisualReference(root, slug, entityId, created.reference.id, true);
    expect(approved.references.find((item) => item.id === created.reference.id)).toMatchObject({ approved: true, role: "primary_reference" });
  });

  it("retains primary reference lineage when a replacement is generated", async () => {
    await updateVisualProfile(root, slug, entityId, { visualPrompt: "distinct necromancer" });
    const provider = { name: "fake-image-provider", validateConfiguration: async () => {}, generate: async () => ({ data: Buffer.from("image"), mimeType: "image/png", provider: "fake", model: "fake" }) };
    const story: any = { slug, artwork: { provider: "openai", model: "dall-e-3", aspectRatio: "1:1", quality: "high", size: "1024x1024", outputFormat: "png" } };
    const v1 = await generateStyleSheet(root, slug, entityId, provider as any, story);
    await approveVisualReference(root, slug, entityId, v1.reference.id, true);
    const v2 = await generateStyleSheet(root, slug, entityId, provider as any, story);
    expect(v2.reference.replacesReferenceId).toBe(v1.reference.id);
    const promoted = await approveVisualReference(root, slug, entityId, v2.reference.id, true);
    expect(promoted.references.find((item) => item.id === v2.reference.id)?.role).toBe("primary_reference");
    expect(promoted.references.find((item) => item.id === v1.reference.id)).toMatchObject({ approved: true, role: "general_reference" });
  });

  it("preserves an AI suggestion beside new source evidence until deliberately resolved", async () => {
    const bible = { ...emptyStoryBible(), canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: [], description: "Hair: emerald green.", firstAppearance: 1, lastKnownAppearance: 1 })] };
    await updateVisualProfile(root, slug, entityId, { character: { hairColor: "brown" }, fieldProvenance: { "character.hairColor": { source: "ai_generated", locked: false } } });
    const inspection = await inspectVisualProfile(root, slug, bible, entityId);
    expect(inspection.conflicts).toHaveLength(1);
    expect(inspection.conflicts[0]).toMatchObject({ field: "character.hairColor", visualValue: "brown", status: "needs_review" });
    const resolved = await resolveVisualProfileConflict(root, slug, bible, entityId, inspection.conflicts[0]!.id, "accept_canonical");
    expect(resolved.character?.hairColor).toBe("emerald");
    expect(resolved.conflicts?.[0]).toMatchObject({ status: "resolved", resolution: "accept_canonical" });
  });

  it("uses only entity-relevant summaries and requires explicit regeneration fields", async () => {
    const bible = { ...emptyStoryBible(), chapterSummaries: { 1: "Test Character protects the guild.", 2: "An unrelated battle in another empire." }, canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: [], description: "", firstAppearance: 1, lastKnownAppearance: 2 })] };
    const inspection = await inspectVisualProfile(root, slug, bible, entityId);
    expect((inspection.context.relevantStorySummaries as Array<{ chapter: number }>).map((item) => item.chapter)).toEqual([1]);
    const provider = { name: "fake", generateStructured: async () => ({ value: { values: {}, rationale: "" } }) };
    await expect(proposeMissingVisualDetails(root, slug, bible, entityId, provider as any, { provider: "openai", model: "fake" }, { regenerate: true })).rejects.toThrow("Choose one or more");
  });

  it("uses a persistent environment reference prompt for locations", async () => {
    const locationId = "ent_cccccccccccccccccccccccc";
    await updateVisualProfile(root, slug, locationId, { visualType: "location", location: { architecture: "black stone spires", recurringLandmarks: "a bone gate" } });
    let prompt = "";
    const provider = { name: "fake-image-provider", validateConfiguration: async () => {}, generate: async (input: { prompt: string }) => { prompt = input.prompt; return { data: Buffer.from("image"), mimeType: "image/png", provider: "fake", model: "fake" }; } };
    const story: any = { slug, artwork: { provider: "openai", model: "dall-e-3", aspectRatio: "1:1", quality: "high", size: "1024x1024", outputFormat: "png" } };
    const result = await generateStyleSheet(root, slug, locationId, provider as any, story);
    expect(result.reference.approved).toBe(false);
    expect(prompt).toContain("LOCATION REFERENCE");
    expect(prompt).not.toContain("CHARACTER MODEL SHEET");
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
