import { describe, it, expect, beforeEach } from "vitest";
import { resolveVisualCanonPrompt } from "../src/visual-canon/resolver.js";
import { createDefaultArtDirection } from "../src/domain/art-direction.js";
import { StoryBible, emptyStoryBible } from "../src/domain/story-bible.js";
import { Scene } from "../src/scenes/types.js";
import { testStory } from "./helpers.js";
import { VisualEntityProfile } from "../src/domain/visual-profile.js";

describe("Visual Canon Prompt Resolver", () => {
  const story = testStory();
  const entityId1 = "ent_111111111111111111111111";
  const entityId2 = "ent_222222222222222222222222";

  let bible: StoryBible;
  const artDirection = createDefaultArtDirection("cinematic manhwa digital art").presets[0];

  beforeEach(() => {
    bible = {
      ...emptyStoryBible(),
      canonicalEntities: [
        {
          id: entityId1,
          canonicalName: "Li Chen",
          type: "character",
          description: "Young swordsman from the Mount Hua sect with a ragged cloak.",
          aliases: ["Junior Brother", "Chen'er"],
        } as any,
        {
          id: entityId2,
          canonicalName: "Azure Dragon Halberd",
          type: "item",
          description: "Ancient polearm with a dragon motif carved into celestial steel.",
          aliases: ["The Dragon Polearm"],
        } as any,
      ],
    };
  });

  const baseScene: Scene = {
    id: "scene-001",
    summary: "Li Chen draws his weapon at the mountain pass.",
    startSeconds: 0,
    endSeconds: 6,
    characters: ["Li Chen"],
    entityIds: [],
    location: "Mount Hua Misty Pass",
    visualPrompt: "Li Chen standing on the cliff edge facing the mist",
    importance: "major",
    artwork: { status: "pending", review: "unreviewed", versions: [] },
  };

  it("falls back to Story Bible description when visual profile is draft or missing", () => {
    // Neither entity has an approved visual profile
    const resolved = resolveVisualCanonPrompt({
      scene: baseScene,
      story,
      bible,
      artDirection,
      visualProfiles: {},
    });

    // Should contain base art direction
    expect(resolved.prompt).toContain("cinematic manhwa digital art");
    // Should contain scene summary & visualPrompt
    expect(resolved.prompt).toContain("Mount Hua Misty Pass");
    expect(resolved.prompt).toContain("Li Chen standing on the cliff edge");
    // Fallback: uses Story Bible description
    expect(resolved.prompt).toContain("Young swordsman from the Mount Hua sect with a ragged cloak");
    // Fingerprint for unapproved profiles should be empty
    expect(resolved.entityVisualFingerprints[entityId1]).toBeUndefined();
  });

  it("injects approved visual profile traits and produces deterministic entity fingerprints", () => {
    const profile: VisualEntityProfile = {
      id: "vp-1",
      entityId: entityId1,
      visualType: "character",
      status: "approved",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      appearance: "Tall and lean, sharp jawline, messy raven hair tied with a red ribbon.",
      visualPrompt: "young swordsman, sharp jaw, raven hair with red ribbon, dark jade eyes, charcoal robe",
      notes: "",
      character: {
        hairColor: "raven",
        eyeColor: "dark jade",
        defaultOutfit: "Charcoal battle robe with reinforced leather vambraces",
        weapons: "Azure Dragon Halberd",
      },
      negativePrompt: "blonde hair, short hair, modern clothes",
      variants: [],
      references: [
        {
          id: "ref-1",
          entityId: entityId1,
          imagePath: "stories/demo/visual-profiles/ent_1/ref-1.png",
          role: "face_portrait",
          source: "uploaded",
          approved: true,
          createdAt: new Date().toISOString(),
        },
      ],
    };

    const resolved = resolveVisualCanonPrompt({
      scene: {
        ...baseScene,
        entityIds: [entityId1],
      },
      story,
      bible,
      artDirection,
      visualProfiles: { [entityId1]: profile },
    });

    // Layer 2: Approved entity appearance is injected
    expect(resolved.prompt).toContain("young swordsman, sharp jaw, raven hair with red ribbon");
    expect(resolved.prompt).toContain("Charcoal battle robe with reinforced leather vambraces");

    // Negative prompt contains profile additions
    expect(resolved.negativePrompt).toContain("blonde hair, short hair, modern clothes");

    // Entity fingerprint is recorded
    expect(resolved.entityVisualFingerprints[entityId1]).toBeDefined();
    expect(typeof resolved.entityVisualFingerprints[entityId1]).toBe("string");

    // References list contains Li Chen
    const resolvedLiChen = resolved.resolvedEntities.find((r) => r.entityId === entityId1);
    expect(resolvedLiChen).toBeDefined();
    expect(resolvedLiChen?.references?.some((r) => r.id === "ref-1")).toBe(true);
  });

  it("injects Scene Direction parameters into the composed prompt", () => {
    const sceneWithDirection: Scene = {
      ...baseScene,
      direction: {
        shotType: "medium_wide",
        cameraAngle: "low_angle",
        composition: "dynamic",
        lighting: "golden sunset backlighting through pine trees",
        timeEnvironment: "sunset",
        characterExpressions: { "Li Chen": "fierce concentration, gritted teeth" },
        useCharacterReferences: true,
        useCreatureReferences: true,
        useLocationReferences: true,
        preserveWardrobeEquipment: true,
        useStoryArtDirection: true,
      },
    };

    const resolved = resolveVisualCanonPrompt({
      scene: sceneWithDirection,
      story,
      bible,
      artDirection,
      visualProfiles: {},
    });

    expect(resolved.prompt).toContain("medium wide");
    expect(resolved.prompt).toContain("low angle");
    expect(resolved.prompt).toContain("dynamic");
    expect(resolved.prompt).toContain("golden sunset backlighting through pine trees");
    expect(resolved.prompt).toContain("sunset");
    expect(resolved.prompt).toContain("fierce concentration, gritted teeth");
    expect(resolved.sceneDirectionFingerprint).toBeDefined();
  });

  it("injects Wardrobe and Visual Prompt overrides into Layer 5", () => {
    const sceneWithOverrides: Scene = {
      ...baseScene,
      overrides: {
        wardrobeOverrides: { "Li Chen": "torn battle robes, bloodstained bandages on left arm" },
        customVisualPrompt: "wind howling around the peak sending leaves swirling",
        customNegativePrompt: "sunny, bright smiles",
      },
    };

    const resolved = resolveVisualCanonPrompt({
      scene: sceneWithOverrides,
      story,
      bible,
      artDirection,
      visualProfiles: {},
    });

    expect(resolved.prompt).toContain("torn battle robes, bloodstained bandages on left arm");
    expect(resolved.prompt).toContain("wind howling around the peak sending leaves swirling");
    expect(resolved.negativePrompt).toContain("sunny, bright smiles");
  });

  it("detects fine-grained fingerprint staleness accurately", () => {
    const profile: VisualEntityProfile = {
      id: "vp-1",
      entityId: entityId1,
      visualType: "character",
      status: "approved",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      appearance: "",
      visualPrompt: "young swordsman",
      negativePrompt: "",
      notes: "",
      variants: [],
      references: [],
    };

    const res1 = resolveVisualCanonPrompt({
      scene: baseScene,
      story,
      bible,
      artDirection,
      visualProfiles: { [entityId1]: profile },
    });

    // Modifying only the scene direction changes sceneDirectionFingerprint and promptFingerprint,
    // but keeps artDirectionFingerprint and entityVisualFingerprints identical
    const scene2: Scene = {
      ...baseScene,
      direction: { shotType: "close_up" } as any,
    };
    const res2 = resolveVisualCanonPrompt({
      scene: scene2,
      story,
      bible,
      artDirection,
      visualProfiles: { [entityId1]: profile },
    });

    expect(res2.artDirectionFingerprint).toBe(res1.artDirectionFingerprint);
    expect(res2.entityVisualFingerprints).toEqual(res1.entityVisualFingerprints);
    expect(res2.sceneDirectionFingerprint).not.toBe(res1.sceneDirectionFingerprint);
    expect(res2.resolvedPromptFingerprint).not.toBe(res1.resolvedPromptFingerprint);
  });
});
