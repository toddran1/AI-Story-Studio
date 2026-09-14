import { describe, expect, it } from "vitest";
import { localizedNamingSchema } from "../src/domain/story-bible.js";
import { LLMProvider } from "../src/llm/provider.js";
import { generateLocalizedNameSuggestions, localizationSuggestionRequestSchema } from "../src/story-bible/localization.js";
import { mergeStoryBible } from "../src/story-bible/updater.js";
import { emptyStoryBible, storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { retrieveRelevantContext } from "../src/story-bible/retrieval.js";

function entity() {
  const update = storyBibleUpdateSchema.parse({ chapterSummary: "Su Ming joins the academy.", characters: [{ canonicalEnglishName: "Su Ming", originalName: "苏铭", aliases: ["Student Su"], description: "An ambitious necromancer", status: "student", notes: "Male protagonist", firstSeenChapter: 1, lastSeenChapter: 12 }], relationships: [{ subject: "Su Ming", object: "Jiangbei Academy", relationship: "student of", firstSeenChapter: 10, lastSeenChapter: 12 }] });
  return mergeStoryBible(emptyStoryBible(), update, 12).canonicalEntities[0]!;
}

describe("entity localization", () => {
  it("validates contextual, full, short, and manual naming modes", () => {
    expect(localizedNamingSchema.parse({ locale: "en-US", fullName: "Simon Su", shortName: "Simon", usageMode: "ai_contextual" })).toMatchObject({ locale: "en-US" });
    expect(localizedNamingSchema.safeParse({ locale: "en-US", shortName: "Simon", usageMode: "always_full" }).success).toBe(false);
    expect(localizedNamingSchema.safeParse({ locale: "en-US", fullName: "Simon Su", usageMode: "always_short" }).success).toBe(false);
    expect(localizedNamingSchema.safeParse({ locale: "not a locale", fullName: "Simon Su", usageMode: "manual" }).success).toBe(false);
    expect(localizationSuggestionRequestSchema.parse({})).toEqual({ count: 5 });
  });

  it("asks the configured provider for distinct locale-aware full and short forms", async () => {
    let request: any;
    const provider: LLMProvider = {
      name: "openai",
      validateConfiguration: async () => undefined,
      generateText: async () => { throw new Error("unused"); },
      generateStructured: async (value) => { request = value; return { value: { suggestions: [{ fullName: "Simon Su", shortName: "Simon", rationale: "Natural in contemporary US English." }, { fullName: "Silas Su", shortName: "Silas", rationale: "Keeps the original surname and darker genre tone." }] } as any }; },
    };
    const result = await generateLocalizedNameSuggestions(provider, { provider: "openai", model: "test-model" }, { entity: entity(), sourceLanguage: "zh-CN", targetLanguage: "en-US", locale: "en-US", count: 2, relationships: [{ relation: "student of", otherEntity: "Jiangbei Academy" }] });
    expect(result.suggestions).toHaveLength(2); expect(request.schemaName).toBe("entity_name_localization"); expect(request.instructions).toMatch(/target locale is en-US/); expect(request.instructions).toMatch(/locations, organizations, abilities, items, and concepts/); expect(request.input).toContain('"otherEntity": "Jiangbei Academy"');
  });

  it("keeps localized naming inside bounded narration context", () => {
    const localized = { ...entity(), localizedNaming: { locale: "en-US", fullName: "Simon Su", shortName: "Simon", usageMode: "ai_contextual" as const, notes: "Use full name for introductions." } };
    const context = retrieveRelevantContext(emptyStoryBible(), "Su Ming entered the academy.", 13, { narrationNamingEntities: [localized], maxCharacters: 1800 });
    expect(context.canonicalEntities[0]).toMatchObject({ canonicalName: "Su Ming", originalName: "苏铭", localizedNaming: { fullName: "Simon Su", shortName: "Simon", usageMode: "ai_contextual" } });
  });
});
