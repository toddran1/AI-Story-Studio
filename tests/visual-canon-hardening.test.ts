import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { testStory } from "./helpers.js";
import { StoryBible, emptyStoryBible, canonicalEntitySchema } from "../src/domain/story-bible.js";
import {
  resolveSceneVisualEntity,
  resolveVisualEntities,
} from "../src/scenes/identity.js";
import {
  loadVisualProfiles,
  saveVisualProfiles,
  getVisualProfile,
  updateVisualProfile,
  deleteVisualProfile,
  deleteVisualReferenceImage,
  addVisualReferenceImage,
  generateStyleSheet,
  handleEntityMerge,
  handleEntityDemote,
} from "../src/visual-canon/profiles.js";
import {
  loadStoryArtDirection,
  saveStoryArtDirection,
  createPreset,
} from "../src/visual-canon/art-direction.js";
import { createDefaultArtDirection } from "../src/domain/art-direction.js";
import { visualProfileRefPath, storyPaths } from "../src/storage/paths.js";
import { exists } from "../src/storage/story-files.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { ImageProvider } from "../src/artwork/provider.js";
import { VisualEntityProfile } from "../src/domain/visual-profile.js";

const DUMMY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

class MockImageProvider implements ImageProvider {
  readonly name = "openai";
  readonly version = "mock-v1";
  calls: Array<{ model: string; prompt: string; quality?: string; size?: string }> = [];

  async validateConfiguration() {}
  async generate(request: { model: string; prompt: string; quality?: string; size?: string; outputFormat?: string }) {
    this.calls.push(request);
    return { data: DUMMY_PNG, mimeType: "image/png" as const };
  }
}

describe("Milestone 21: Visual Canon & Scene Identity Hardening", () => {
  let tempDir: string;
  const slug = "test-hardening";
  const story = testStory({ ...testStory().pipeline, artwork: { ...testStory().artwork, stylePrompt: "LEGACY_SHOULD_NOT_BE_USED" } } as any);

  const idSuMing = "ent_111111111111111111111111";
  const idZhangYongxing = "ent_222222222222222222222222";
  const idElderHan = "ent_333333333333333333333333";

  let testBible: StoryBible;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "visual-canon-test-"));
    await mkdir(join(tempDir, "stories", slug), { recursive: true });
    await atomicWriteJson(storyPaths(tempDir, slug, 1).storyConfig, story);

    testBible = {
      ...emptyStoryBible(),
      canonicalEntities: [
        canonicalEntitySchema.parse({
          id: idSuMing,
          type: "character",
          canonicalName: "Su Ming",
          aliases: ["Mo Luo", "Ninth Peak Disciple"],
          originalName: "苏铭",
          description: "Protagonist clad in purple robes.",
          firstAppearance: 1,
          lastKnownAppearance: 10,
        }),
        canonicalEntitySchema.parse({
          id: idZhangYongxing,
          type: "character",
          canonicalName: "Zhang Yongxing",
          aliases: ["Senior Brother Zhang"],
          originalName: "张永兴",
          description: "Burly senior brother wielding an iron staff.",
          firstAppearance: 2,
          lastKnownAppearance: 8,
        }),
        canonicalEntitySchema.parse({
          id: idElderHan,
          type: "character",
          canonicalName: "Elder Han",
          aliases: ["Master Han"],
          description: "Medicine elder with white beard.",
          firstAppearance: 1,
          lastKnownAppearance: 5,
        }),
      ],
    };
    await atomicWriteJson(storyPaths(tempDir, slug, 1).bible, testBible);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // Scenario A: Multi-character identity test
  it("Scenario A: resolves distinct characters to their exact canonical entities regardless of array ordering", () => {
    const profiles: Record<string, VisualEntityProfile> = {
      [idSuMing]: {
        id: "prof_su",
        entityId: idSuMing,
        visualType: "character",
        status: "approved",
        appearance: "Purple robes, dark hair",
        visualPrompt: "Su Ming standing atop Ninth Peak",
        negativePrompt: "",
        notes: "",
        variants: [],
        references: [],
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      [idZhangYongxing]: {
        id: "prof_zhang",
        entityId: idZhangYongxing,
        visualType: "character",
        status: "draft",
        appearance: "Tall muscular warrior with iron staff",
        visualPrompt: "Zhang Yongxing in defensive stance",
        negativePrompt: "",
        notes: "",
        variants: [],
        references: [],
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };

    // Forward order
    const resSu = resolveSceneVisualEntity("Su Ming", testBible.canonicalEntities, profiles);
    const resZhang = resolveSceneVisualEntity("Zhang Yongxing", testBible.canonicalEntities, profiles);

    expect(resSu.resolution).toBe("canonical_name");
    expect(resSu.entityId).toBe(idSuMing);
    expect(resSu.canonicalName).toBe("Su Ming");
    expect(resSu.profileStatus).toBe("approved");

    expect(resZhang.resolution).toBe("canonical_name");
    expect(resZhang.entityId).toBe(idZhangYongxing);
    expect(resZhang.canonicalName).toBe("Zhang Yongxing");
    expect(resZhang.profileStatus).toBe("draft");

    // Reverse order
    const reverseOrder = ["Zhang Yongxing", "Su Ming"];
    const resolvedReverse = reverseOrder.map((name) =>
      resolveSceneVisualEntity(name, testBible.canonicalEntities, profiles)
    );

    expect(resolvedReverse[0]!.name).toBe("Zhang Yongxing");
    expect(resolvedReverse[0]!.entityId).toBe(idZhangYongxing);
    expect(resolvedReverse[0]!.profileStatus).toBe("draft");

    expect(resolvedReverse[1]!.name).toBe("Su Ming");
    expect(resolvedReverse[1]!.entityId).toBe(idSuMing);
    expect(resolvedReverse[1]!.profileStatus).toBe("approved");

    // Proves Zhang Yongxing NEVER adopts Su Ming's ID
    expect(resolvedReverse[0]!.entityId).not.toBe(idSuMing);
  });

  // Scenario B: Unresolved character test
  it("Scenario B: unlinked/unknown character never produces an entity ID", () => {
    const unknownName = "Mysterious Masked Cultivator";
    const res = resolveSceneVisualEntity(unknownName, testBible.canonicalEntities);

    expect(res.resolution).toBe("unresolved");
    expect(res.entityId).toBeUndefined();
    expect(res.canonicalName).toBeUndefined();
    expect(res.profileStatus).toBeUndefined();
    expect(res.name).toBe(unknownName);

    // Ambiguous alias matching two entities must also be unresolved
    const ambiguousBible: StoryBible = {
      ...testBible,
      canonicalEntities: [
        ...testBible.canonicalEntities,
        canonicalEntitySchema.parse({
          id: "ent_444444444444444444444444",
          type: "character",
          canonicalName: "Shadow Assassin",
          aliases: ["Mo Luo"], // shares alias with Su Ming
          firstAppearance: 1,
          lastKnownAppearance: 2,
        }),
      ],
    };
    const ambiguousRes = resolveSceneVisualEntity("Mo Luo", ambiguousBible.canonicalEntities);
    expect(ambiguousRes.resolution).toBe("unresolved");
    expect(ambiguousRes.entityId).toBeUndefined();
  });

  // Scenario C: Resolved entity without profile
  it("Scenario C: resolves entity without profile to 'missing' and enforces canonical ID on creation", async () => {
    const res = resolveSceneVisualEntity("Elder Han", testBible.canonicalEntities);

    expect(res.resolution).toBe("canonical_name");
    expect(res.entityId).toBe(idElderHan);
    expect(res.canonicalName).toBe("Elder Han");
    expect(res.profileStatus).toBe("missing");

    // Creating profile with canonical ID succeeds
    const created = await updateVisualProfile(tempDir, slug, idElderHan, {
      appearance: "White-haired master with jade calabash",
      status: "draft",
    });
    expect(created.entityId).toBe(idElderHan);
    expect(created.appearance).toBe("White-haired master with jade calabash");

    // Attempting to create profile with display name as entity ID throws
    await expect(
      updateVisualProfile(tempDir, slug, "Elder Han", { appearance: "invalid" })
    ).rejects.toThrow();
  });

  // Scenario D: Story Bible rename stability
  it("Scenario D: Story Bible renames leave Visual Profile intact and reachable", async () => {
    // Create profile for Su Ming
    await updateVisualProfile(tempDir, slug, idSuMing, {
      appearance: "Deep purple flowing robes with nine peaks insignia",
      visualPrompt: "Su Ming standing atop Ninth Peak amid purple mist",
      status: "approved",
    });

    // Rename entity in Story Bible
    const updatedEntities = testBible.canonicalEntities.map((e) => {
      if (e.id === idSuMing) {
        return canonicalEntitySchema.parse({
          ...e,
          canonicalName: "Su Ming (Ascended Sovereign)",
          preferredNarrationName: "The Purple Sovereign",
          localizedNaming: {
            locale: "en-US",
            usageMode: "manual",
            fullName: "Su Ming, Lord of the Ninth Mountain",
            shortName: "Lord Su",
          },
          aliases: ["Mo Luo", "Ascended Sovereign"],
        });
      }
      return e;
    });

    // Profile on disk remains unchanged
    const profile = await getVisualProfile(tempDir, slug, idSuMing);
    expect(profile).toBeDefined();
    expect(profile?.appearance).toContain("Deep purple flowing robes");

    // Resolves correctly by all new names and original ID
    const byNewCanonical = resolveSceneVisualEntity("Su Ming (Ascended Sovereign)", updatedEntities, { [idSuMing]: profile! });
    expect(byNewCanonical.entityId).toBe(idSuMing);
    expect(byNewCanonical.profileStatus).toBe("approved");

    const byPreferred = resolveSceneVisualEntity("The Purple Sovereign", updatedEntities, { [idSuMing]: profile! });
    expect(byPreferred.entityId).toBe(idSuMing);
    expect(byPreferred.resolution).toBe("preferred_name");

    const byLocalized = resolveSceneVisualEntity("Lord Su", updatedEntities, { [idSuMing]: profile! });
    expect(byLocalized.entityId).toBe(idSuMing);
    expect(byLocalized.resolution).toBe("localized_name");

    const byAlias = resolveSceneVisualEntity("Ascended Sovereign", updatedEntities, { [idSuMing]: profile! });
    expect(byAlias.entityId).toBe(idSuMing);
    expect(byAlias.resolution).toBe("alias");

    const byId = resolveSceneVisualEntity(idSuMing, updatedEntities, { [idSuMing]: profile! });
    expect(byId.entityId).toBe(idSuMing);
    expect(byId.resolution).toBe("exact_id");
  });

  // Scenario E: Merge with reference image
  it("Scenario E: merges entity profiles, relocates physical reference files, and cleans up source", async () => {
    const idSource = "ent_aaaaaaaaaaaaaaaaaaaaaaaa";
    const idTarget = "ent_bbbbbbbbbbbbbbbbbbbbbbbb";

    // Create source profile and add reference image
    const { reference: srcRef } = await addVisualReferenceImage(tempDir, slug, idSource, {
      data: DUMMY_PNG,
      role: "face_portrait",
      ext: "png",
      prompt: "Source portrait",
    });

    const srcPath = visualProfileRefPath(tempDir, slug, idSource, srcRef.id, "png");
    expect(await exists(srcPath)).toBe(true);

    // Target has no profile initially
    await handleEntityMerge(tempDir, slug, idTarget, [idSource]);

    // Target profile adopted primary source
    const targetProfile = await getVisualProfile(tempDir, slug, idTarget);
    expect(targetProfile).toBeDefined();
    expect(targetProfile?.references.length).toBe(1);

    const migratedRef = targetProfile!.references[0]!;
    expect(migratedRef.entityId).toBe(idTarget);
    expect(migratedRef.provenance?.migratedFromEntityId).toBe(idSource);

    // Physical file relocated to target directory
    const targetPath = visualProfileRefPath(tempDir, slug, idTarget, migratedRef.id, "png");
    expect(await exists(targetPath)).toBe(true);

    // Source file and source directory cleaned up
    expect(await exists(srcPath)).toBe(false);
    expect(await exists(join(storyPaths(tempDir, slug, 1).visualProfilesDirectory, idSource))).toBe(false);

    // Source profile deleted from metadata
    const sourceProfile = await getVisualProfile(tempDir, slug, idSource);
    expect(sourceProfile).toBeUndefined();
  });

  // Scenario F: Merge with colliding profile & references
  it("Scenario F: resolves reference ID collisions, preserves both files and target canon", async () => {
    const idSource = "ent_aaaaaaaaaaaaaaaaaaaaaaaa";
    const idTarget = "ent_bbbbbbbbbbbbbbbbbbbbbbbb";

    // Setup target profile with a reference
    await updateVisualProfile(tempDir, slug, idTarget, {
      appearance: "Target Authoritative Appearance",
      visualPrompt: "Target prompt",
      status: "approved",
      notes: "Target Note",
      negativePrompt: "low quality",
    });
    const { reference: targetRef } = await addVisualReferenceImage(tempDir, slug, idTarget, {
      data: DUMMY_PNG,
      role: "front",
      ext: "png",
      prompt: "Target front view",
    });

    // Setup source profile with a reference that has the exact SAME id
    await updateVisualProfile(tempDir, slug, idSource, {
      appearance: "Source Ignored Appearance",
      notes: "Source Note",
      negativePrompt: "blurry",
    });
    // Manually force a collision on source ref id
    const collidingRefId = targetRef.id;
    const sourceRefPath = visualProfileRefPath(tempDir, slug, idSource, collidingRefId, "png");
    await mkdir(join(storyPaths(tempDir, slug, 1).visualProfilesDirectory, idSource), { recursive: true });
    await atomicWrite(sourceRefPath, DUMMY_PNG);

    const sourceProfiles = await loadVisualProfiles(tempDir, slug);
    sourceProfiles[idSource]!.references.push({
      id: collidingRefId,
      entityId: idSource,
      role: "back",
      imagePath: sourceRefPath,
      createdAt: new Date().toISOString(),
      source: "uploaded",
      approved: false,
    });
    await saveVisualProfiles(tempDir, slug, sourceProfiles);

    // Execute merge
    await handleEntityMerge(tempDir, slug, idTarget, [idSource]);

    const targetProfile = await getVisualProfile(tempDir, slug, idTarget);
    expect(targetProfile).toBeDefined();

    // Target authoritative fields preserved
    expect(targetProfile?.appearance).toBe("Target Authoritative Appearance");
    expect(targetProfile?.status).toBe("approved");

    // Notes and negative prompts merged
    expect(targetProfile?.notes).toContain("Target Note");
    expect(targetProfile?.notes).toContain("Source Note");
    expect(targetProfile?.negativePrompt).toContain("low quality");
    expect(targetProfile?.negativePrompt).toContain("blurry");

    // Both references survive without collision
    expect(targetProfile?.references.length).toBe(2);
    const ids = targetProfile!.references.map((r) => r.id);
    expect(new Set(ids).size).toBe(2); // No duplicate IDs!

    // Verify both files physically exist in target directory
    for (const ref of targetProfile!.references) {
      expect(await exists(ref.imagePath)).toBe(true);
      expect(ref.imagePath).toContain(idTarget);
    }

    // Migrated reference records provenance of collision resolution
    const migratedRef = targetProfile!.references.find((r) => r.provenance?.migratedFromEntityId === idSource);
    expect(migratedRef).toBeDefined();
    expect(migratedRef?.provenance?.originalRefId).toBe(collidingRefId);
    expect(migratedRef?.provenance?.collisionResolvedTo).toBe(migratedRef?.id);
  });

  // Scenario G: Profile deletion
  it("Scenario G: deletes visual profile metadata and directory idempotently", async () => {
    const idToDelete = "ent_444444444444444444444444";
    await addVisualReferenceImage(tempDir, slug, idToDelete, {
      data: DUMMY_PNG,
      role: "front",
      ext: "png",
    });

    const entityDir = join(storyPaths(tempDir, slug, 1).visualProfilesDirectory, idToDelete);
    expect(await exists(entityDir)).toBe(true);

    // First deletion removes metadata and files
    const firstResult = await deleteVisualProfile(tempDir, slug, idToDelete);
    expect(firstResult).toBe(true);
    expect(await getVisualProfile(tempDir, slug, idToDelete)).toBeUndefined();
    expect(await exists(entityDir)).toBe(false);

    // Idempotent repeated deletion returns false safely
    const secondResult = await deleteVisualProfile(tempDir, slug, idToDelete);
    expect(secondResult).toBe(false);
  });

  // Scenario H: Style sheet active Art Direction
  it("Scenario H: style sheet generation uses active M21 preset and bypasses legacy prompt", async () => {
    // Setup active art direction preset
    const customPreset = await createPreset(tempDir, slug, {
      name: "Gothic Manhwa Noir",
      artStyle: "Manhwa",
      customStylePrompt: "Heavy ink line art, monochrome with vivid purple accents, high contrast noir chiaroscuro",
      visualTone: "Ominous and atmospheric xianxia noir",
      colorDirection: "Dark muted grayscale with luminous violet qi glow",
      lightingDirection: "Extreme angular rim lighting, harsh cast shadows",
      globalNegativePrompt: "cartoon, bright sunshine, pastel colors",
    });
    const artDirection = await loadStoryArtDirection(tempDir, slug);
    artDirection.activePresetId = customPreset.id;
    await saveStoryArtDirection(tempDir, slug, artDirection);

    await updateVisualProfile(tempDir, slug, idSuMing, {
      appearance: "Young cultivator in torn purple robes with bone mask",
      character: {
        apparentAge: "20 years old",
        gender: "male",
        build: "lean and athletic",
        hairColor: "raven black",
        hairstyle: "long unbound hair reaching lower back",
        faceShape: "sharp and angular",
        defaultOutfit: "Nine Peaks disciple robe with torn hem",
        weapons: "Bone dagger strapped to right thigh",
      },
      negativePrompt: "western comic style, 3d render",
    });

    const mockProvider = new MockImageProvider();
    const { reference } = await generateStyleSheet(tempDir, slug, idSuMing, mockProvider, story, {
      presetId: customPreset.id,
    });

    expect(mockProvider.calls.length).toBe(1);
    const sentPrompt = mockProvider.calls[0]!.prompt;

    // Layer 1: Art Direction
    expect(sentPrompt).toContain("ART STYLE: Manhwa");
    expect(sentPrompt).toContain("Heavy ink line art, monochrome with vivid purple accents");
    expect(sentPrompt).toContain("Ominous and atmospheric xianxia noir");
    expect(sentPrompt).toContain("Extreme angular rim lighting");

    // Layer 2: Character Details
    expect(sentPrompt).toContain("SUBJECT VISUAL TRAITS: Young cultivator in torn purple robes with bone mask");
    expect(sentPrompt).toContain("HAIR: raven black, long unbound hair reaching lower back");
    expect(sentPrompt).toContain("FACE SHAPE: sharp and angular");
    expect(sentPrompt).toContain("DEFAULT COSTUME / WARDROBE: Nine Peaks disciple robe with torn hem");
    expect(sentPrompt).toContain("SIGNATURE WEAPONS / GEAR: Bone dagger strapped to right thigh");

    // Layer 3: Style Sheet Requirements
    expect(sentPrompt).toContain("CHARACTER MODEL SHEET / CONCEPT ART TURNAROUND");
    expect(sentPrompt).toContain("REQUIRED VIEWS: full-body front view, three-quarter angle");

    // Legacy prompt must NOT override or appear
    expect(sentPrompt).not.toContain("LEGACY_SHOULD_NOT_BE_USED");
  });

  // Scenario I: Style sheet provenance
  it("Scenario I: records rich provenance with fingerprints in generated style sheet reference", async () => {
    await updateVisualProfile(tempDir, slug, idSuMing, {
      appearance: "Su Ming in dark garb",
      negativePrompt: "blurry, low quality",
    });

    const mockProvider = new MockImageProvider();
    const { reference } = await generateStyleSheet(tempDir, slug, idSuMing, mockProvider, story);

    expect(reference.provenance).toBeDefined();
    expect(reference.provenance?.provider).toBe("openai");
    expect(reference.provenance?.presetId).toBeDefined();
    expect(reference.provenance?.presetName).toBeDefined();
    expect(reference.provenance?.artDirectionFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(reference.provenance?.profileRevision).toBeGreaterThanOrEqual(1);
    expect(reference.provenance?.profileFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(reference.provenance?.promptFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(reference.provenance?.negativePrompt).toContain("blurry, low quality");
  });

  // Scenario J: Safe single reference image deletion
  it("Scenario J: deletes a single visual reference image cleanly", async () => {
    const { reference: ref1 } = await addVisualReferenceImage(tempDir, slug, idSuMing, {
      data: DUMMY_PNG,
      role: "front",
      ext: "png",
    });
    const { reference: ref2 } = await addVisualReferenceImage(tempDir, slug, idSuMing, {
      data: DUMMY_PNG,
      role: "side",
      ext: "png",
    });

    let profile = (await getVisualProfile(tempDir, slug, idSuMing))!;
    expect(profile.references.length).toBe(2);

    const result = await deleteVisualReferenceImage(tempDir, slug, idSuMing, ref1.id);
    expect(result.deleted).toBe(true);

    profile = (await getVisualProfile(tempDir, slug, idSuMing))!;
    expect(profile.references.length).toBe(1);
    expect(profile.references[0]!.id).toBe(ref2.id);

    // ref1 file on disk was removed
    expect(await exists(ref1.imagePath)).toBe(false);
    // ref2 file on disk is still there
    expect(await exists(ref2.imagePath)).toBe(true);
  });
});
