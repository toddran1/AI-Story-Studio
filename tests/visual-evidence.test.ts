import { describe, expect, it } from "vitest";
import { emptyStoryBible, storyBibleUpdateSchema, visualEvidenceSchema } from "../src/domain/story-bible.js";
import { visualProfileSchema } from "../src/domain/visual-profile.js";
import { createDefaultArtDirection } from "../src/domain/art-direction.js";
import { contextBeforeChapter, mergeStoryBible } from "../src/story-bible/updater.js";
import { resolveEntityVisualEvidence } from "../src/story-bible/visual-evidence.js";
import { extractLocalVisualObservations } from "../src/story-bible/visual-backfill.js";
import { resolveVisualCanonPrompt } from "../src/visual-canon/resolver.js";
import { testStory } from "./helpers.js";

const name = "Li Chen";
const base = storyBibleUpdateSchema.parse({ characters: [{ canonicalEnglishName: name, originalName: "李辰", description: "A student.", firstSeenChapter: 1, lastSeenChapter: 1 }], chapterSummary: "Introduced." });
const observe = (chapter: number, field: "character.hairColor" | "character.hairstyle" | "character.eyeColor" | "character.defaultOutfit", value: string, persistence: "persistent" | "changed" | "temporary" = "persistent") => storyBibleUpdateSchema.parse({ chapterSummary: `Chapter ${chapter}`, visualObservations: [{ entity: name, field, value, chapter, confidence: 0.8, persistence, excerpt: `${name}: ${value}` }] });
const merge = (bible: ReturnType<typeof emptyStoryBible>, update: ReturnType<typeof storyBibleUpdateSchema.parse>, chapter: number) => mergeStoryBible(bible, update, chapter);
const entity = (bible: ReturnType<typeof emptyStoryBible>) => bible.canonicalEntities.find((item) => item.canonicalName === name)!;

describe("Story Bible visual evidence", () => {
  it("loads older Bibles, keeps vague observations narrow, and requires provenance", () => {
    const bible = merge(emptyStoryBible(), base, 1);
    expect(entity(bible).visualEvidence ?? []).toEqual([]);
    const updated = merge(bible, observe(2, "character.hairstyle", "long hair"), 2);
    expect(resolveEntityVisualEvidence(entity(updated), 2).values).toHaveProperty("character.hairstyle");
    expect(resolveEntityVisualEvidence(entity(updated), 2).values).not.toHaveProperty("character.hairColor");
    expect(visualEvidenceSchema.safeParse(entity(updated).visualEvidence?.[0]).success).toBe(true);
  });

  it("strengthens repeated compatible color observations without losing chapter sources", () => {
    let bible = merge(emptyStoryBible(), base, 1);
    bible = merge(bible, observe(2, "character.hairColor", "black hair"), 2);
    bible = merge(bible, observe(3, "character.hairColor", "jet-black hair"), 3);
    const records = entity(bible).visualEvidence!;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ normalizedValue: "black", chapter: 2, lastObservedChapter: 3, source: "source_text" });
    expect(records[0]!.confidence).toBeGreaterThan(0.8);
    expect(records[0]!.provenance.map((item) => item.chapter)).toEqual([2, 3]);
  });

  it("holds unexplained contradictions for review and resolves explicit changes by chapter", () => {
    let bible = merge(emptyStoryBible(), base, 1);
    bible = merge(bible, observe(10, "character.eyeColor", "blue"), 10);
    bible = merge(bible, observe(40, "character.eyeColor", "green"), 40);
    expect(resolveEntityVisualEvidence(entity(bible), 20).values["character.eyeColor"]?.normalizedValue).toBe("blue");
    expect(resolveEntityVisualEvidence(entity(bible), 50).values["character.eyeColor"]).toBeUndefined();
    expect(resolveEntityVisualEvidence(entity(bible), 50).conflicts["character.eyeColor"]).toHaveLength(2);
    bible = merge(bible, observe(60, "character.eyeColor", "amber", "changed"), 60);
    expect(resolveEntityVisualEvidence(entity(bible), 50).conflicts["character.eyeColor"]).toHaveLength(2);
    expect(resolveEntityVisualEvidence(entity(bible), 70).values["character.eyeColor"]?.normalizedValue).toBe("amber");
  });

  it("keeps future observations out of historical processing context", () => {
    let bible = merge(emptyStoryBible(), base, 1);
    bible = merge(bible, observe(20, "character.hairstyle", "long hair"), 20);
    bible = merge(bible, observe(310, "character.hairstyle", "short hair", "changed"), 310);
    const beforeChange = entity(contextBeforeChapter(bible, 100));
    expect(beforeChange.visualEvidence).toHaveLength(1);
    expect(resolveEntityVisualEvidence(beforeChange, 99).values["character.hairstyle"]?.value).toBe("long hair");
    expect(JSON.stringify(beforeChange)).not.toContain("short hair");
  });

  it("keeps temporary clothing out of persistent identity", () => {
    let bible = merge(emptyStoryBible(), base, 1);
    bible = merge(bible, observe(5, "character.defaultOutfit", "red robe", "temporary"), 5);
    expect(resolveEntityVisualEvidence(entity(bible), 5).values["character.defaultOutfit"]).toBeUndefined();
    expect(resolveEntityVisualEvidence(entity(bible), 5).temporary[0]?.value).toBe("red robe");
    expect(resolveEntityVisualEvidence(entity(bible), 6).temporary).toEqual([]);
  });

  it("grounds fallback art at its chapter, protects approved profiles, and fingerprints only effective context", () => {
    let bible = merge(emptyStoryBible(), base, 1);
    bible = merge(bible, observe(20, "character.hairstyle", "long hair"), 20);
    bible = merge(bible, observe(310, "character.hairstyle", "short hair", "changed"), 310);
    const scene = { id: "scene-001", summary: "Li Chen stands outside.", startSeconds: 0, endSeconds: 5, characters: [name], entityIds: [], visualPrompt: "Li Chen outside", importance: "major" as const, artwork: { status: "pending" as const, review: "unreviewed" as const, versions: [] } };
    const options = { scene, story: testStory(), bible, artDirection: createDefaultArtDirection().presets[0]!, visualProfiles: {} };
    const past = resolveVisualCanonPrompt({ ...options, chapter: 100 });
    const future = resolveVisualCanonPrompt({ ...options, chapter: 500 });
    expect(past.prompt).toContain("character.hairstyle: long hair");
    expect(past.prompt).not.toContain("character.hairstyle: short hair");
    expect(future.prompt).toContain("character.hairstyle: short hair");
    expect(past.resolvedPromptFingerprint).not.toBe(future.resolvedPromptFingerprint);
    const approved = visualProfileSchema.parse({ id: "vp-li", entityId: entity(bible).id, visualType: "character", status: "approved", appearance: "Curly auburn hair", character: { hairstyle: "Curly auburn hair" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const protectedPrompt = resolveVisualCanonPrompt({ ...options, chapter: 500, visualProfiles: { [entity(bible).id]: approved } });
    expect(protectedPrompt.prompt).toContain("Curly auburn hair");
    expect(protectedPrompt.prompt).not.toContain("character.hairstyle: short hair");
  });

  it("backfills only directly named, literal facts and treats one-time clothing as temporary", () => {
    const bible = merge(emptyStoryBible(), base, 1);
    const observations = extractLocalVisualObservations("Li Chen's long hair fell over his eyes. Li Chen had ink-black hair. Li Chen wore a red robe. His eyes were blue.", bible.canonicalEntities, 2);
    expect(observations.map((item) => [item.field, item.value, item.persistence])).toEqual([
      ["character.hairstyle", "long hair", "persistent"],
      ["character.hairColor", "ink-black", "persistent"],
      ["character.defaultOutfit", "a red robe", "temporary"],
    ]);
  });
});
