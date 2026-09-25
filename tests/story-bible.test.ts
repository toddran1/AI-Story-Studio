import { describe, expect, it } from "vitest";
import { emptyStoryBible, storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { STORY_BIBLE_PROMPT_VERSION, storyBibleInstructions } from "../src/story-bible/prompts.js";
import { contextBeforeChapter, mergeStoryBible, normalizeStoryBibleUpdate } from "../src/story-bible/updater.js";

describe("Story Bible extraction prompt", () => {
  it("covers every schema bucket, relationships, translation terms, and narration-input caveats", () => {
    expect(STORY_BIBLE_PROMPT_VERSION).toBe("5-visual-evidence");
    expect(storyBibleInstructions).toContain("visualObservations");
    for (const bucket of ["characters", "locations", "factions", "abilities", "items", "classes", "ranks", "creatures", "systemTerms"]) expect(storyBibleInstructions).toContain(bucket);
    expect(storyBibleInstructions).toContain("relationships");
    expect(storyBibleInstructions).toContain("translationTerms");
    expect(storyBibleInstructions).not.toContain("important concepts");
    expect(storyBibleInstructions).toMatch(/POLISHED narration/i);
    expect(storyBibleInstructions).toMatch(/soften strong profanity/i);
    expect(storyBibleInstructions).toMatch(/gender and pronouns unset/i);
  });
});

describe("Story Bible", () => {
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
});
