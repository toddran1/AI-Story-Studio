import { describe, expect, it } from "vitest";
import { visualProfileSchema } from "../src/domain/visual-profile.js";
import { resolveApprovedAppearanceEra, resolveVisualCanonPrompt } from "../src/visual-canon/resolver.js";
import { createDefaultArtDirection } from "../src/domain/art-direction.js";
import { emptyStoryBible } from "../src/domain/story-bible.js";
import { testStory } from "./helpers.js";
import type { Scene } from "../src/scenes/types.js";

const entityId = `ent_${"1".repeat(24)}`;
const now = new Date().toISOString();
const profile = visualProfileSchema.parse({
  id: "profile-1", entityId, visualType: "character", status: "approved", createdAt: now, updatedAt: now,
  appearance: "short black hair", visualPrompt: "young with short black hair", character: { hairColor: "black", hairstyle: "short" },
  references: [
    { id: "early", entityId, role: "primary_reference", imagePath: "early.png", createdAt: now, source: "uploaded", approved: true },
    { id: "later", entityId, role: "face_portrait", imagePath: "later.png", createdAt: now, source: "uploaded", approved: true },
  ],
  appearanceEras: [
    { id: "grown", name: "After the journey", startChapter: 10, status: "approved", appearance: "long silver hair", visualPrompt: "older with long silver hair", character: { hairColor: "silver", hairstyle: "long" }, referenceIds: ["later"] },
    { id: "draft", name: "Future design", startChapter: 20, status: "draft", appearance: "red hair", visualPrompt: "red hair", referenceIds: [] },
  ],
});
const scene = { id: "scene-1", summary: "A portrait", startSeconds: 0, endSeconds: 4, characters: ["Ari"], entityIds: [entityId], location: "", visualPrompt: "Ari stands still", importance: "major", artwork: { status: "pending", review: "unreviewed", versions: [] } } as Scene;
const bible = { ...emptyStoryBible(), canonicalEntities: [{ id: entityId, canonicalName: "Ari", type: "character", aliases: [], description: "A traveler" }] } as unknown as ReturnType<typeof emptyStoryBible>;
const options = { scene, story: testStory(), bible, artDirection: createDefaultArtDirection("illustration").presets[0], visualProfiles: { [entityId]: profile } };

describe("chapter-scoped appearance eras", () => {
  it("uses the original look before the era and the approved look afterward", () => {
    const early = resolveVisualCanonPrompt({ ...options, chapter: 9 });
    const later = resolveVisualCanonPrompt({ ...options, chapter: 10 });
    const draftChapter = resolveVisualCanonPrompt({ ...options, chapter: 20 });
    expect(early.prompt).toContain("short black hair");
    expect(early.resolvedEntities[0].references?.map((reference) => reference.id)).toEqual(["early"]);
    expect(later.prompt).toContain("long silver hair");
    expect(later.prompt).not.toContain("short black hair");
    expect(later.resolvedEntities[0].references?.map((reference) => reference.id)).toEqual(["later"]);
    expect(later.resolvedEntities[0].appearanceEra?.name).toBe("After the journey");
    expect(draftChapter.prompt).not.toContain("red hair");
    expect(early.entityVisualFingerprints[entityId]).not.toBe(later.entityVisualFingerprints[entityId]);
  });

  it("rejects overlapping approved ranges and ignores draft eras", () => {
    expect(resolveApprovedAppearanceEra(profile, 5)).toBeUndefined();
    expect(resolveApprovedAppearanceEra(profile, 20)?.id).toBe("grown");
    expect(() => visualProfileSchema.parse({ ...profile, appearanceEras: [...profile.appearanceEras!, { id: "other", name: "Overlap", startChapter: 12, status: "approved" }] })).toThrow();
    expect(() => visualProfileSchema.parse({ ...profile, appearanceEras: [{ id: "empty", name: "Empty", startChapter: 2, status: "approved" }] })).toThrow();
  });

  it("lets a flashback scene pin an approved era without changing the profile", () => {
    const flashback = resolveVisualCanonPrompt({ ...options, chapter: 5, scene: { ...scene, overrides: { appearanceEraOverrides: { Ari: "grown" }, wardrobeOverrides: {} } } });
    expect(flashback.resolvedEntities[0].appearanceEra?.id).toBe("grown");
    expect(flashback.resolvedEntities[0].references?.map((reference) => reference.id)).toEqual(["later"]);
  });

  it("can use a historical chapter for a summary scene", () => {
    const historical = resolveVisualCanonPrompt({ ...options, chapter: 30, scene: { ...scene, overrides: { appearanceChapter: 5, wardrobeOverrides: {} } } });
    expect(historical.prompt).toContain("short black hair");
    expect(historical.resolvedEntities[0].appearanceEra).toBeUndefined();
  });

  it("does not invalidate earlier chapters when a later draft is edited", () => {
    const before = resolveVisualCanonPrompt({ ...options, chapter: 4 });
    const edited = { ...profile, revision: profile.revision + 1, appearanceEras: profile.appearanceEras!.map((era) => era.id === "draft" ? { ...era, appearance: "blue hair" } : era) };
    const after = resolveVisualCanonPrompt({ ...options, chapter: 4, visualProfiles: { [entityId]: edited } });
    expect(after.entityVisualFingerprints[entityId]).toBe(before.entityVisualFingerprints[entityId]);
    expect(after.resolvedPromptFingerprint).toBe(before.resolvedPromptFingerprint);
  });

  it("does not repeat old structured traits against an era's replacement description", () => {
    const proseEra = { ...profile, negativePrompt: "silver hair", appearanceEras: [{ id: "silver", name: "Silver hair", startChapter: 10, status: "approved" as const, appearance: "long silver hair", visualPrompt: "", referenceIds: [] }] };
    const result = resolveVisualCanonPrompt({ ...options, chapter: 10, visualProfiles: { [entityId]: proseEra } });
    expect(result.prompt).toContain("long silver hair");
    expect(result.prompt).not.toContain("short black hair");
    expect(result.negativePrompt).not.toContain("silver hair");
  });

  it("uses a creature's evolved anatomy and eyes without its old canonical creature prompt", () => {
    const creatureId = `ent_${"2".repeat(24)}`;
    const creatureProfile = visualProfileSchema.parse({ id: "beast", entityId: creatureId, visualType: "creature", status: "approved", createdAt: now, updatedAt: now, creature: { species: "wolf", coloration: "brown", canonicalCreaturePrompt: "brown wolf with small eyes" }, appearanceEras: [{ id: "awakened", name: "Awakened", startChapter: 15, status: "approved", creature: { coloration: "white", eyes: "glowing blue", scale: "giant" }, referenceIds: [] }] });
    const creatureBible = { ...emptyStoryBible(), canonicalEntities: [{ id: creatureId, canonicalName: "Moon Beast", type: "other", sourceBucket: "creatures", aliases: [], description: "A beast" }] } as unknown as ReturnType<typeof emptyStoryBible>;
    const creatureScene = { ...scene, entityIds: [creatureId], characters: [] };
    const result = resolveVisualCanonPrompt({ ...options, scene: creatureScene, bible: creatureBible, visualProfiles: { [creatureId]: creatureProfile }, chapter: 16 });
    expect(result.prompt).toContain("Coloration: white");
    expect(result.prompt).toContain("Eyes: glowing blue");
    expect(result.prompt).not.toContain("brown wolf with small eyes");
  });
});
