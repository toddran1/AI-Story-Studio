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

  it("keeps permanent identity while current continuity and scene overrides win over profile defaults", () => {
    const profile: VisualEntityProfile = {
      id: "vp-state", entityId: entityId1, visualType: "character", status: "approved", revision: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), appearance: "", visualPrompt: "", notes: "", negativePrompt: "", variants: [], references: [],
      character: {
        apparentAge: "nineteen", build: "lean", hairColor: "black", hairstyle: "long tied hair", eyeColor: "amber",
        distinguishingFeatures: "a crescent scar under his left eye",
        defaultOutfit: "black academy jacket and white shirt", shoes: "black boots", accessories: "silver pendant",
        weapons: "signature sword", equipment: "leather satchel",
      },
    };
    const resolved = resolveVisualCanonPrompt({
      scene: {
        ...baseScene,
        entityIds: [entityId1],
        visualPrompt: "Li Chen lies unconscious on the ground, shirtless and bleeding from a chest wound.",
        direction: { characterExpressions: { "Li Chen": "screaming in rage" } } as any,
        overrides: { wardrobeOverrides: { "Li Chen": "ceremonial white robe" }, customVisualPrompt: "His signature sword has been lost." },
      },
      story,
      bible,
      artDirection,
      visualProfiles: { [entityId1]: profile },
      visualContinuity: "Li Chen remains bloodied with torn-away clothing from the previous scene.",
    });

    expect(resolved.prompt).toContain("Age: nineteen");
    expect(resolved.prompt).toContain("Hair: black, long tied hair");
    expect(resolved.prompt).toContain("Default weapons (overridable by current scene): signature sword");
    expect(resolved.prompt).toContain("Scene override attire: ceremonial white robe");
    expect(resolved.prompt).toContain("shirtless and bleeding from a chest wound");
    expect(resolved.prompt).toContain("remains bloodied with torn-away clothing");
    expect(resolved.prompt).toContain("His signature sword has been lost");
    expect(resolved.prompt.match(/SCENE-STATE PRIORITY/g)).toHaveLength(1);
    expect(resolved.prompt).toContain("Do not infer a change from an omitted detail.");
    // Resolving a temporary state is read-only: the stored profile remains a default.
    expect(profile.character?.defaultOutfit).toBe("black academy jacket and white shirt");
  });

  it("keeps profile defaults available when the current scene does not contradict them", () => {
    const profile: VisualEntityProfile = {
      id: "vp-default", entityId: entityId1, visualType: "character", status: "approved", revision: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), appearance: "", visualPrompt: "", notes: "", negativePrompt: "", variants: [],
      references: [], character: { defaultOutfit: "black academy jacket and white shirt" },
    };
    const resolved = resolveVisualCanonPrompt({
      scene: { ...baseScene, entityIds: [entityId1], visualPrompt: "Li Chen walks into a room." },
      story, bible, artDirection, visualProfiles: { [entityId1]: profile },
    });
    expect(resolved.prompt).toContain("Default attire (overridable by current scene): black academy jacket and white shirt");
  });

  it("uses structured physical identity without mixed free-text defaults when wardrobe/equipment preservation is off", () => {
    const profile: VisualEntityProfile = {
      id: "vp-no-defaults", entityId: entityId1, visualType: "character", status: "approved", revision: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      appearance: "A young man with black hair in an academy jacket, carrying an ebony staff.",
      visualPrompt: "Young man, black hair, gray eyes, academy jacket, ebony staff",
      notes: "", negativePrompt: "", variants: [], references: [{
        id: "identity-ref", entityId: entityId1, role: "face_portrait", source: "uploaded", approved: true,
        imagePath: "stories/demo/visual-profiles/identity-ref.png", createdAt: new Date().toISOString(),
      }],
      character: {
        apparentAge: "young adult", gender: "man", height: "tall", build: "lean", skinTone: "warm tan",
        faceShape: "angular", hairColor: "black", hairstyle: "long and tied back", eyeColor: "gray",
        facialHair: "clean-shaven", distinguishingFeatures: "a small mole by the left eye",
        additionalAppearanceNotes: "A calm, youthful face.",
        defaultOutfit: "black academy jacket", shoes: "leather boots", accessories: "silver clasp",
        weapons: "ebony staff", equipment: "travel pack",
      },
    };
    const resolved = resolveVisualCanonPrompt({
      scene: { ...baseScene, entityIds: [entityId1], direction: { preserveWardrobeEquipment: false } as any },
      story, bible, artDirection, visualProfiles: { [entityId1]: profile },
    });

    expect(resolved.prompt).toContain("Gender: man");
    expect(resolved.prompt).toContain("Height: tall");
    expect(resolved.prompt).toContain("Skin tone: warm tan");
    expect(resolved.prompt).toContain("Face shape: angular");
    expect(resolved.prompt).toContain("Eyes: gray");
    expect(resolved.prompt).toContain("Facial hair: clean-shaven");
    expect(resolved.prompt).toContain("Persistent appearance notes: A calm, youthful face.");
    expect(resolved.prompt).not.toContain("academy jacket");
    expect(resolved.prompt).not.toContain("ebony staff");
    expect(resolved.prompt).not.toContain("leather boots");
    expect(resolved.prompt).not.toContain("silver clasp");
    expect(resolved.prompt).not.toContain("travel pack");
    // Disabling profile wardrobe defaults does not discard approved identity references.
    expect(resolved.resolvedEntities.find((entity) => entity.entityId === entityId1)?.references)
      .toEqual(profile.references);
    expect(resolved.resolvedEntities.find((entity) => entity.entityId === entityId1)?.weapons).toBeUndefined();
    expect(resolved.resolvedEntities.find((entity) => entity.entityId === entityId1)?.visualPrompt).toBeUndefined();
  });

  it("keeps explicit scene attire and current continuity when profile defaults are disabled", () => {
    const profile: VisualEntityProfile = {
      id: "vp-scene-override", entityId: entityId1, visualType: "character", status: "approved", revision: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), appearance: "", visualPrompt: "", notes: "", negativePrompt: "", variants: [], references: [],
      character: { hairColor: "black", defaultOutfit: "black academy jacket", weapons: "ebony staff" },
    };
    const resolved = resolveVisualCanonPrompt({
      scene: {
        ...baseScene, entityIds: [entityId1], direction: { preserveWardrobeEquipment: false } as any,
        overrides: { wardrobeOverrides: { [entityId1]: "ceremony robe" } },
      },
      story, bible, artDirection, visualProfiles: { [entityId1]: profile },
      visualContinuity: "A fresh bandage wraps his right forearm.",
    });

    expect(resolved.prompt).toContain("Scene override attire: ceremony robe");
    expect(resolved.prompt).toContain("A fresh bandage wraps his right forearm.");
    expect(resolved.prompt).not.toContain("black academy jacket");
    expect(resolved.prompt).not.toContain("ebony staff");
  });

  it("omits mixed legacy character text when sparse structured identity cannot separate its wardrobe/gear", () => {
    const profile: VisualEntityProfile = {
      id: "vp-legacy-sparse", entityId: entityId1, visualType: "character", status: "approved", revision: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), appearance: "A scarred veteran with a red coat and a long rifle.",
      visualPrompt: "", notes: "", negativePrompt: "", variants: [], references: [], character: {},
    };
    const resolved = resolveVisualCanonPrompt({
      scene: { ...baseScene, entityIds: [entityId1], direction: { preserveWardrobeEquipment: false } as any },
      story, bible, artDirection, visualProfiles: { [entityId1]: profile },
    });

    expect(resolved.prompt).not.toContain("LEGACY VISUAL PROFILE");
    expect(resolved.prompt).not.toContain("red coat");
    expect(resolved.prompt).not.toContain("long rifle");
  });

  it("uses identity-only legacy text as a fallback when structured character identity is sparse", () => {
    const profile: VisualEntityProfile = {
      id: "vp-legacy-identity", entityId: entityId1, visualType: "character", status: "approved", revision: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      appearance: "A scarred veteran with silver eyes and a weathered face.",
      visualPrompt: "", notes: "", negativePrompt: "", variants: [], references: [], character: {},
    };
    const resolved = resolveVisualCanonPrompt({
      scene: { ...baseScene, entityIds: [entityId1], direction: { preserveWardrobeEquipment: false } as any },
      story, bible, artDirection, visualProfiles: { [entityId1]: profile },
    });

    expect(resolved.prompt).toContain("LEGACY VISUAL PROFILE (sparse structured identity");
    expect(resolved.prompt).toContain("A scarred veteran with silver eyes and a weathered face.");
  });

  it("leaves non-character visual profile prompts unchanged when wardrobe defaults are disabled", () => {
    const itemProfile: VisualEntityProfile = {
      id: "vp-item", entityId: entityId2, visualType: "item", status: "approved", revision: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      appearance: "Ancient polearm with a carved dragon motif.",
      visualPrompt: "Ancient polearm, celestial steel, glowing runes", notes: "", negativePrompt: "", variants: [], references: [],
      item: { shape: "long polearm", materials: "celestial steel", magicalEffects: "glowing runes" },
    };
    const resolved = resolveVisualCanonPrompt({
      scene: {
        ...baseScene, characters: [], entityIds: [entityId2],
        direction: { preserveWardrobeEquipment: false } as any,
      },
      story, bible, artDirection, visualProfiles: { [entityId2]: itemProfile },
    });

    expect(resolved.prompt).toContain("Ancient polearm, celestial steel, glowing runes");
    expect(resolved.prompt).toContain("Shape: long polearm");
    expect(resolved.prompt).toContain("Materials: celestial steel");
  });

  it("honors scene Visual Canon toggles without removing Story Bible fallback", () => {
    const profile: VisualEntityProfile = {
      id: "vp-toggle", entityId: entityId1, visualType: "character", status: "approved", revision: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), appearance: "profile appearance", visualPrompt: "profile identity", notes: "", negativePrompt: "profile-negative", variants: [], references: [],
      character: { defaultOutfit: "academy uniform", weapons: "signature sword" },
    };
    const resolved = resolveVisualCanonPrompt({
      scene: { ...baseScene, entityIds: [entityId1], direction: { useCharacterReferences: false, preserveWardrobeEquipment: false, useStoryArtDirection: false } as any },
      story, bible, artDirection, visualProfiles: { [entityId1]: profile },
    });
    expect(resolved.prompt).toContain("Young swordsman from the Mount Hua sect");
    expect(resolved.prompt).not.toContain("profile identity");
    expect(resolved.prompt).not.toContain("academy uniform");
    expect(resolved.prompt).not.toContain("STORY ART DIRECTION:");
    expect(resolved.negativePrompt).not.toContain("profile-negative");
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
