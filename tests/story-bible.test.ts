import { describe, expect, it } from "vitest";
import { emptyStoryBible, storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { STORY_BIBLE_PROMPT_VERSION, storyBibleInstructions } from "../src/story-bible/prompts.js";
import { contextBeforeChapter, mergeStoryBible, normalizeStoryBibleUpdate } from "../src/story-bible/updater.js";

describe("Story Bible extraction prompt", () => {
  it("covers every schema bucket, relationships, translation terms, and narration-input caveats", () => {
    expect(STORY_BIBLE_PROMPT_VERSION).toBe("6-identity-rendering-resolution");
    expect(storyBibleInstructions).toContain("visualObservations");
    for (const bucket of ["characters", "locations", "factions", "abilities", "items", "classes", "ranks", "creatures", "systemTerms"]) expect(storyBibleInstructions).toContain(bucket);
    expect(storyBibleInstructions).toContain("relationships");
    expect(storyBibleInstructions).toContain("translationTerms");
    expect(storyBibleInstructions).not.toContain("important concepts");
    expect(storyBibleInstructions).toMatch(/NARRATION is the POLISHED reader-facing chapter/i);
    expect(storyBibleInstructions).toMatch(/soften strong profanity/i);
    expect(storyBibleInstructions).toMatch(/gender and pronouns unset/i);
  });
});

describe("Story Bible", () => {
  it("keeps one stable ID when a concept is promoted and later extracted as a concept again", () => {
    const entry = (chapter: number) => ({ canonicalEnglishName: "Half-Monster", originalName: "半怪人", description: `Seen in chapter ${chapter}`, firstSeenChapter: chapter, lastSeenChapter: chapter });
    let bible = mergeStoryBible(emptyStoryBible(), storyBibleUpdateSchema.parse({ systemTerms: [entry(1)], chapterSummary: "One" }), 1);
    bible = mergeStoryBible(bible, storyBibleUpdateSchema.parse({ characters: [entry(2)], chapterSummary: "Two" }), 2);
    bible = mergeStoryBible(bible, storyBibleUpdateSchema.parse({ systemTerms: [entry(3)], chapterSummary: "Three" }), 3);
    const matches = bible.canonicalEntities.filter((entity) => entity.canonicalName === "Half-Monster");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.lastKnownAppearance).toBe(3);
    expect(matches[0]?.provenance.map((item) => item.chapter)).toEqual([1, 2, 3]);
  });

  it("validates structured responses", () => {
    expect(() => storyBibleUpdateSchema.parse({ chapterSummary: 42 })).toThrow();
  });

  it("merges facts without replacing canonical translations", () => {
    const first = storyBibleUpdateSchema.parse({
      characters: [{ canonicalEnglishName: "Su Ming", originalName: "苏铭", description: "A traveler", firstSeenChapter: 1, lastSeenChapter: 1 }],
      translationTerms: [{ original: "白骨囚笼", canonicalEnglish: "Bone Prison", firstSeenChapter: 1, lastSeenChapter: 1 }], chapterSummary: "One",
    });
    const second = storyBibleUpdateSchema.parse({
      characters: [{ canonicalEnglishName: "Su Min", originalName: "苏铭", description: "Carries a lamp", firstSeenChapter: 2, lastSeenChapter: 2 }],
      translationTerms: [{ original: "白骨囚笼", canonicalEnglish: "White Bone Cage", firstSeenChapter: 2, lastSeenChapter: 2 }], chapterSummary: "Two",
    });
    const merged = mergeStoryBible(mergeStoryBible(emptyStoryBible(), first, 1), second, 2);
    expect(merged.characters[0]?.canonicalEnglishName).toBe("Su Ming");
    expect(merged.characters[0]?.aliases).toContain("Su Min");
    expect(merged.translationTerms[0]?.canonicalEnglish).toBe("Bone Prison");
  });

  it("bounds historical summaries while retaining canonical entities", () => {
    let bible = emptyStoryBible();
    for (let chapter = 1; chapter <= 8; chapter++) bible = mergeStoryBible(bible, storyBibleUpdateSchema.parse({
      characters: chapter === 1 ? [{ canonicalEnglishName: "Su Ming", originalName: "苏铭", description: "Traveler", firstSeenChapter: 1, lastSeenChapter: 1 }] : [],
      chapterSummary: `Summary ${chapter}`,
    }), chapter);
    const context = contextBeforeChapter(bible, 9, 3);
    expect(Object.keys(context.chapterSummaries)).toEqual(["6", "7", "8"]);
    expect(context.characters[0]?.canonicalEnglishName).toBe("Su Ming");
  });

  it("normalizes model-supplied chronology to the chapter being processed", () => {
    const update = storyBibleUpdateSchema.parse({
      characters: [{ canonicalEnglishName: "Su Ming", originalName: "苏铭", description: "Traveler", firstSeenChapter: 999, lastSeenChapter: 1000 }],
      relationships: [{ subject: "Su Ming", relationship: "knows", object: "Lin Yao", firstSeenChapter: 50, lastSeenChapter: 60 }],
      chapterSummary: "Arrival",
    });
    const normalized = normalizeStoryBibleUpdate(update, 3);
    expect(normalized.characters[0]).toMatchObject({ firstSeenChapter: 3, lastSeenChapter: 3 });
    expect(normalized.relationships[0]).toMatchObject({ firstSeenChapter: 3, lastSeenChapter: 3 });
  });

  it("supports cumulative Story Bible relationships exceeding 2000", () => {
    let bible = emptyStoryBible();

    for (let batch = 0; batch < 11; batch++) {
      const relationships = Array.from(
        { length: 200 },
        (_, index) => ({
          subject: `Entity ${batch}-${index}`,
          object: `Target ${batch}-${index}`,
          relationship: "allies with",
          firstSeenChapter: batch + 1,
          lastSeenChapter: batch + 1,
        })
      );

      const update = storyBibleUpdateSchema.parse({
        relationships,
        chapterSummary: `Chapter ${batch + 1}`,
      });

      bible = mergeStoryBible(bible, update, batch + 1);
    }

    expect(bible.relationships).toHaveLength(2200);
  });

  it("rejects a single Story Bible update with more than 2000 relationships", () => {
    const relationships = Array.from(
      { length: 2001 },
      (_, index) => ({
        subject: `Entity ${index}`,
        object: `Target ${index}`,
        relationship: "allies with",
        firstSeenChapter: 1,
        lastSeenChapter: 1,
      })
    );

    expect(() =>
      storyBibleUpdateSchema.parse({
        relationships,
        chapterSummary: "Oversized update",
      })
    ).toThrow();
  });

  it("supports cumulative Story Bible translationTerms exceeding 2000", () => {
    let bible = emptyStoryBible();

    for (let batch = 0; batch < 11; batch++) {
      const translationTerms = Array.from(
        { length: 200 },
        (_, index) => ({
          original: `term_${batch}_${index}`,
          canonicalEnglish: `Term ${batch} ${index}`,
          firstSeenChapter: batch + 1,
          lastSeenChapter: batch + 1,
        })
      );

      const update = storyBibleUpdateSchema.parse({
        translationTerms,
        chapterSummary: `Chapter ${batch + 1}`,
      });

      bible = mergeStoryBible(bible, update, batch + 1);
    }

    expect(bible.translationTerms).toHaveLength(2200);
  });
});
