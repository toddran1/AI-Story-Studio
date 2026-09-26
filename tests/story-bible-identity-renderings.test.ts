import { describe, expect, it } from "vitest";
import { emptyStoryBible, storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import {
  EntityIdentityIndex,
  buildEffectiveIdentityIndex,
  effectiveEntityIdentity,
  containsIdentityRendering,
  normalizeEntityName,
} from "../src/story-bible/entity-identity.js";
import { mergeStoryBible } from "../src/story-bible/updater.js";
import { findDuplicateSuggestions } from "../src/story-bible/duplicate-detection.js";
import {
  extractChapterVisualObservations,
  extractStoryBible,
  storyBibleExtractionFingerprint,
} from "../src/story-bible/extractor.js";
import { MockLLM } from "./helpers.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCanonicalOverlay, canonicalOverlaySchema, updateCanonicalEntity } from "../src/story-bible/canonical.js";
import { readJsonIfExists } from "../src/storage/story-files.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { analyzeStoryBible } from "../src/story-bible/granularity.js";

const update = (chapter: number, names: string[], extra: Record<string, unknown> = {}) => storyBibleUpdateSchema.parse({
  chapterSummary: `Chapter ${chapter}`,
  characters: names.map((canonicalEnglishName) => ({ canonicalEnglishName, originalName: "", firstSeenChapter: chapter, lastSeenChapter: chapter })),
  ...extra,
});

function established() {
  const bible = mergeStoryBible(emptyStoryBible(), update(1, ["Luo Xiaoxue", "Asher"]), 1);
  const luo = bible.canonicalEntities.find((entity) => entity.canonicalName === "Luo Xiaoxue")!;
  luo.originalName = "罗小雪";
  luo.preferredNarrationName = "Lucine Luo";
  luo.localizedNaming = { locale: "en-US", fullName: "Lucine Luo", shortName: "Lucine", usageMode: "ai_contextual" };
  luo.aliasNarrationRules = [{ alias: "Snow", behavior: "custom", replacement: "Brother Ash" }];
  return bible;
}

describe("Story Bible narration rendering identity", () => {
  it("indexes only effective manual names and type, matching the applied overlay", async () => {
    const bible = established();
    const entity = bible.canonicalEntities[0]!;
    entity.aliases = ["Snow", "Brother Su"];
    const root = await mkdtemp(join(tmpdir(), "identity-effective-"));
    const override = { aliases: [], preferredNarrationName: null, localizedNaming: { locale: "en-US" as const, fullName: "Lucina Luo", shortName: "Lucina", usageMode: "ai_contextual" as const }, aliasNarrationRules: [], type: "item" as const, updatedAt: new Date().toISOString() };
    const overlay = canonicalOverlaySchema.parse({ version: 1, overrides: { [entity.id]: override } });
    const before = JSON.stringify(entity);
    const index = buildEffectiveIdentityIndex(bible.canonicalEntities, overlay);
    for (const oldName of ["Snow", "Brother Su", "Lucine Luo", "Lucine", "Brother Ash"]) expect(index.resolve([oldName], { expectedType: "item" }).status).toBe("none");
    for (const currentName of ["Luo Xiaoxue", "Lucina Luo", "Lucina"]) expect(index.resolve([currentName], { expectedType: "item" }).status).toBe("matched");
    expect(index.resolve(["Lucina"], { expectedType: "character" }).status).toBe("none");
    expect(JSON.stringify(entity)).toBe(before);
    await atomicWriteJson(storyPaths(root, "demo-story", 1).bibleCanonicalManual, overlay);
    const applied = (await applyCanonicalOverlay(root, "demo-story", bible)).bible.canonicalEntities.find((item) => item.id === entity.id)!;
    const view = effectiveEntityIdentity(entity, override);
    for (const field of ["type", "canonicalName", "aliases", "preferredNarrationName", "localizedNaming", "aliasNarrationRules"] as const) expect(view[field]).toEqual(applied[field]);
    expect(buildEffectiveIdentityIndex(bible.canonicalEntities, { suppressions: [{ entityId: entity.id }] }).resolve(["Lucine Luo"]).status).toBe("none");
  });

  it("keeps relationship and timeline names reference-only", () => {
    const bible = established();
    const next = mergeStoryBible(bible, update(2, [], {
      relationships: [{ subject: "Mystery Person", object: "Asher", relationship: "ally", firstSeenChapter: 2, lastSeenChapter: 2 }],
      timelineEvents: [
        { entity: "Mystery Person", type: "appearance", summary: "Unknown appears", chapter: 2 },
        { entity: "Asher", relatedEntity: "Mystery Person", type: "revelation", summary: "Asher learns", chapter: 2 },
      ],
    }), 2);
    expect(next.canonicalEntities).toHaveLength(2);
    expect(next.canonicalRelationships).toHaveLength(0);
    expect(next.entityTimeline.some((item) => item.summary === "Unknown appears")).toBe(false);
    expect(next.entityTimeline.find((item) => item.summary === "Asher learns")?.relatedEntityId).toBeUndefined();
    const withTyped = mergeStoryBible(bible, update(2, ["Jane"], { relationships: [{ subject: "Jane", object: "Asher", relationship: "ally", firstSeenChapter: 2, lastSeenChapter: 2 }] }), 2);
    expect(withTyped.canonicalEntities.some((item) => item.canonicalName === "Jane")).toBe(true);
    expect(withTyped.canonicalRelationships).toHaveLength(1);
  });

  it("does not revive a cleared preferred name through a relationship", () => {
    const bible = established();
    const id = bible.canonicalEntities[0]!.id;
    bible.canonicalEntities[0]!.localizedNaming = undefined;
    const overlay = canonicalOverlaySchema.parse({ version: 1, overrides: { [id]: { preferredNarrationName: null, updatedAt: new Date().toISOString() } } });
    const next = mergeStoryBible(bible, update(2, [], { relationships: [{ subject: "Lucine Luo", object: "Asher", relationship: "ally", firstSeenChapter: 2, lastSeenChapter: 2 }] }), 2, { overlay });
    expect(next.canonicalEntities).toHaveLength(2);
    expect(next.canonicalRelationships).toHaveLength(0);
    expect(buildEffectiveIdentityIndex(next.canonicalEntities, overlay).resolve(["Lucine Luo"]).status).toBe("none");
  });

  it("does not promote same-chapter minor or ambiguous names through references", () => {
    const bible = established();
    bible.canonicalEntities[0]!.preferredNarrationName = "Shadow";
    bible.canonicalEntities[1]!.preferredNarrationName = "Shadow";
    const next = mergeStoryBible(bible, update(2, ["Mystery Guard"], {
      characters: [{ canonicalEnglishName: "Mystery Guard", originalName: "", firstSeenChapter: 2, lastSeenChapter: 2, identityEvidence: { seenInSource: false, seenInTranslation: false, seenInNarration: true } }],
      relationships: [
        { subject: "Mystery Guard", object: "Asher", relationship: "protects", firstSeenChapter: 2, lastSeenChapter: 2 },
        { subject: "Shadow", object: "Asher", relationship: "ally", firstSeenChapter: 2, lastSeenChapter: 2 },
      ],
      timelineEvents: [{ entity: "Shadow", type: "appearance", summary: "Shadow appears", chapter: 2 }],
    }), 2);
    expect(next.canonicalEntities).toHaveLength(2);
    expect(next.minorReferences.some((item) => item.name === "Mystery Guard")).toBe(true);
    expect(next.canonicalRelationships).toHaveLength(0);
    expect(next.entityTimeline.some((item) => item.summary === "Shadow appears")).toBe(false);
  });
  it("indexes canonical and narration names separately and reports ambiguity", () => {
    const bible = established();
    const index = new EntityIdentityIndex(bible.canonicalEntities);
    expect(index.resolve(["Lucine Luo"])).toMatchObject({ status: "matched", matchKind: "preferred_narration" });
    expect(index.resolve(["Lucine"])).toMatchObject({ status: "matched", matchKind: "localized_short" });
    expect(index.resolve(["Brother Ash"])).toMatchObject({ status: "matched", matchKind: "custom_narration_replacement" });
    bible.canonicalEntities.find((entity) => entity.canonicalName === "Asher")!.preferredNarrationName = "Lucine";
    expect(new EntityIdentityIndex(bible.canonicalEntities).resolve(["Lucine"]).status).toBe("ambiguous");
  });

  it.each(["Lucine Luo", "Lucine", "Brother Ash"])("binds %s to the established entity without renaming or alias pollution", (rendering) => {
    const bible = established();
    const luoId = bible.canonicalEntities[0]!.id;
    const merged = mergeStoryBible(bible, update(2, [rendering], {
      relationships: [{ subject: rendering, object: "Asher", relationship: "ally", firstSeenChapter: 2, lastSeenChapter: 2 }],
      timelineEvents: [{ entity: rendering, type: "appearance", summary: `${rendering} arrives`, chapter: 2 }],
      visualObservations: [{ entity: rendering, field: "character.hairColor", value: "black", chapter: 2, confidence: 0.9, persistence: "persistent", excerpt: "black hair" }],
    }), 2);
    const luo = merged.canonicalEntities.find((entity) => entity.id === luoId)!;
    expect(merged.canonicalEntities).toHaveLength(2);
    expect(merged.characters).toHaveLength(2);
    expect(luo.canonicalName).toBe("Luo Xiaoxue");
    expect(luo.preferredNarrationName).toBe("Lucine Luo");
    expect(luo.aliases).not.toContain(rendering);
    expect(luo.provenance.some((item) => item.chapter === 2)).toBe(true);
    expect(merged.canonicalRelationships.some((relation) => relation.sourceEntityId === luoId)).toBe(true);
    expect(merged.entityTimeline.some((event) => event.entityId === luoId && event.summary.includes("arrives"))).toBe(true);
    expect(luo.visualEvidence?.some((item) => item.field === "character.hairColor")).toBe(true);
  });

  it("defers ambiguous and unknown narration-only identities to minor review", () => {
    const bible = established();
    bible.canonicalEntities[0]!.preferredNarrationName = "Shadow";
    bible.canonicalEntities[1]!.preferredNarrationName = "Shadow";
    const ambiguous = mergeStoryBible(bible, update(2, ["Shadow"]), 2);
    expect(ambiguous.canonicalEntities).toHaveLength(2);
    expect(ambiguous.minorReferences.some((ref) => ref.name === "Shadow" && ref.disposition === "needs_review")).toBe(true);
    const unknown = mergeStoryBible(bible, update(2, ["Mystery Name"], {
      characters: [{ canonicalEnglishName: "Mystery Name", originalName: "", firstSeenChapter: 2, lastSeenChapter: 2, identityEvidence: { seenInSource: false, seenInTranslation: false, seenInNarration: true } }],
    }), 2);
    expect(unknown.canonicalEntities).toHaveLength(2);
    expect(unknown.minorReferences.some((ref) => ref.name === "Mystery Name" && ref.disposition === "needs_review")).toBe(true);
  });

  it("surfaces an existing narration rendering duplicate with a targeted repair direction", () => {
    const bible = established();
    const duplicate = { ...structuredClone(bible.canonicalEntities[1]!), id: "ent_aaaaaaaaaaaaaaaaaaaaaaaa", canonicalName: "Lucine Luo", originalName: "", aliases: [] };
    const suggestions = findDuplicateSuggestions([...bible.canonicalEntities, duplicate]);
    expect(suggestions.find((item) => item.entityIds.includes(duplicate.id))).toMatchObject({
      recommendedTargetEntityId: bible.canonicalEntities[0]!.id,
      kind: "narration_rendering_duplicate",
      recommendation: "needs_review",
    });
  });

  it("keeps the established owner as the analyzer target even if the duplicate appeared first", async () => {
    const root = await mkdtemp(join(tmpdir(), "identity-analyzer-"));
    const bible = established();
    const owner = bible.canonicalEntities[0]!;
    owner.firstAppearance = 2;
    const duplicate = { ...structuredClone(bible.canonicalEntities[1]!), id: "ent_aaaaaaaaaaaaaaaaaaaaaaaa", canonicalName: "Lucine Luo", originalName: "", aliases: [] };
    bible.canonicalEntities.push(duplicate);
    await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, bible);
    const report = await analyzeStoryBible(root, "demo-story");
    expect(report.recommendations.find((item) => item.entityId === duplicate.id)).toMatchObject({
      targetEntityId: owner.id,
      kind: "narration_rendering_duplicate",
      recommendation: "needs_review",
      safeToAutoApply: false,
    });
  });

  it("sends distinct source, translation, narration, and established context to extraction", async () => {
    const llm = new MockLLM();
    await extractStoryBible(llm, { provider: "gemini", model: "test" }, { chapter: 2, source: "罗小雪", translation: "Luo Xiaoxue", narration: "Lucine Luo", bible: established() });
    const input = llm.calls[0]!.input;
    expect(input).toContain("SOURCE CHAPTER:\n罗小雪");
    expect(input).toContain("TRANSLATION:\nLuo Xiaoxue");
    expect(input).toContain("NARRATION:\nLucine Luo");
    expect(input).toContain("ESTABLISHED STORY BIBLE:");
  });

  it("changes extraction fingerprint for every evidence input and prompt version", () => {
    const base = { source: "罗小雪", translation: "Luo Xiaoxue", narration: "Lucine Luo", config: { provider: "gemini" as const, model: "test" }, bible: established() };
    const current = storyBibleExtractionFingerprint(base);
    expect(storyBibleExtractionFingerprint({ ...base, source: "罗小雪来了" })).not.toBe(current);
    expect(storyBibleExtractionFingerprint({ ...base, translation: "Lucine Luo" })).not.toBe(current);
    expect(storyBibleExtractionFingerprint({ ...base, narration: "Luo Xiaoxue" })).not.toBe(current);
    expect(storyBibleExtractionFingerprint({ ...base, promptVersion: "next-version" })).not.toBe(current);
  });

  it("honors a manual preferred name during chronological rebuild and keeps the overlay authoritative", async () => {
    const root = await mkdtemp(join(tmpdir(), "identity-overlay-rebuild-"));
    const base = mergeStoryBible(emptyStoryBible(), update(1, ["Luo Xiaoxue"]), 1);
    const id = base.canonicalEntities[0]!.id;
    await updateCanonicalEntity(root, "demo-story", base, id, { preferredNarrationName: "Lucine Luo" });
    const overlay = canonicalOverlaySchema.parse(await readJsonIfExists(storyPaths(root, "demo-story", 1).bibleCanonicalManual));
    const rebuilt = mergeStoryBible(base, update(2, ["Lucine Luo"]), 2, { overlay });
    expect(rebuilt.canonicalEntities).toHaveLength(1);
    expect(rebuilt.canonicalEntities[0]?.canonicalName).toBe("Luo Xiaoxue");
    const effective = await applyCanonicalOverlay(root, "demo-story", rebuilt);
    expect(effective.bible.canonicalEntities[0]?.preferredNarrationName).toBe("Lucine Luo");
    expect(effective.bible.canonicalEntities[0]?.aliases).not.toContain("Lucine Luo");
  });

  it("normalizes names neutrally without stripping semantic title or honorific words", () => {
    expect(normalizeEntityName("Master Sword")).not.toBe(normalizeEntityName("Sword"));
    expect(normalizeEntityName("Lord Hall")).not.toBe(normalizeEntityName("Hall"));
    expect(normalizeEntityName("Dr. Strange")).toBe(normalizeEntityName("Dr Strange"));
    expect(normalizeEntityName("Sword")).toBe(normalizeEntityName("sword"));
    expect(normalizeEntityName("X-Ray")).toBe(normalizeEntityName("X Ray"));
  });

  it("resolves character honorific secondary match for characters only", () => {
    const zhang = {
      ...structuredClone(established().canonicalEntities[0]!),
      id: "ent_111111111111111111111111",
      canonicalName: "Zhang",
      originalName: "张",
      aliases: [],
      type: "character" as const,
    };
    const index = new EntityIdentityIndex([zhang]);
    expect(index.resolve(["Elder Zhang"], { expectedType: "character" })).toMatchObject({
      status: "matched",
      entity: { id: "ent_111111111111111111111111" },
      matchKind: "honorific_variant",
    });

    const sword = {
      ...structuredClone(established().canonicalEntities[0]!),
      id: "ent_222222222222222222222222",
      canonicalName: "Sword",
      originalName: "",
      aliases: [],
      type: "item" as const,
    };
    const itemIndex = new EntityIdentityIndex([sword]);
    expect(itemIndex.resolve(["Master Sword"], { expectedType: "item" }).status).toBe("none");
  });

  it("disambiguates same-text entities of different types when expectedType is provided", () => {
    const charPhoenix = {
      ...structuredClone(established().canonicalEntities[0]!),
      id: "ent_333333333333333333333333",
      canonicalName: "Phoenix",
      originalName: "",
      aliases: [],
      type: "character" as const,
    };
    const locPhoenix = {
      ...structuredClone(established().canonicalEntities[0]!),
      id: "ent_444444444444444444444444",
      canonicalName: "Phoenix",
      originalName: "",
      aliases: [],
      type: "location" as const,
    };
    const index = new EntityIdentityIndex([charPhoenix, locPhoenix]);

    const resolvedChar = index.resolve(["Phoenix"], { expectedType: "character" });
    expect(resolvedChar).toMatchObject({ status: "matched", entity: { id: "ent_333333333333333333333333", type: "character" } });

    const resolvedLoc = index.resolve(["Phoenix"], { expectedType: "location" });
    expect(resolvedLoc).toMatchObject({ status: "matched", entity: { id: "ent_444444444444444444444444", type: "location" } });

    const resolvedUnspecified = index.resolve(["Phoenix"]);
    expect(resolvedUnspecified.status).toBe("ambiguous");
  });

  it("prevents cross-type collision between narration rendering and entity name", () => {
    const luo = {
      ...structuredClone(established().canonicalEntities[0]!),
      id: "ent_555555555555555555555555",
      canonicalName: "Luo Xiaoxue",
      preferredNarrationName: "Lucine",
      originalName: "罗小雪",
      aliases: [],
      type: "character" as const,
    };
    const locLucine = {
      ...structuredClone(established().canonicalEntities[0]!),
      id: "ent_666666666666666666666666",
      canonicalName: "Lucine",
      originalName: "",
      aliases: [],
      type: "location" as const,
    };
    const index = new EntityIdentityIndex([luo, locLucine]);

    expect(index.resolve(["Lucine"], { expectedType: "character" })).toMatchObject({
      status: "matched",
      entity: { id: "ent_555555555555555555555555" },
      matchKind: "preferred_narration",
    });
    expect(index.resolve(["Lucine"], { expectedType: "location" })).toMatchObject({
      status: "matched",
      entity: { id: "ent_666666666666666666666666" },
      matchKind: "canonical",
    });
  });

  it("does not bind incompatible entity types solely from name equality", () => {
    const oracleChar = {
      ...structuredClone(established().canonicalEntities[0]!),
      id: "ent_777777777777777777777777",
      canonicalName: "Oracle",
      originalName: "",
      aliases: [],
      type: "character" as const,
    };
    const index = new EntityIdentityIndex([oracleChar]);

    expect(index.resolve(["Oracle"], { expectedType: "item" }).status).toBe("none");

    const baseBible = { ...emptyStoryBible(), canonicalEntities: [oracleChar] };
    const merged = mergeStoryBible(baseBible, storyBibleUpdateSchema.parse({
      chapterSummary: "Chapter 2",
      items: [{ canonicalEnglishName: "Oracle", originalName: "", firstSeenChapter: 2, lastSeenChapter: 2, description: "A mystical orb" }],
    }), 2);

    const char = merged.canonicalEntities.find((e) => e.id === "ent_777777777777777777777777")!;
    expect(char.type).toBe("character");
    expect(
      merged.canonicalEntities.filter((e) => e.type === "item").length +
      (merged.minorReferences?.filter((r) => r.type === "item").length ?? 0)
    ).toBeGreaterThan(0);
  });

  it("preserves ambiguity when multiple same-type entities share a narration rendering", () => {
    const charA = {
      ...structuredClone(established().canonicalEntities[0]!),
      id: "ent_888888888888888888888888",
      canonicalName: "Entity A",
      preferredNarrationName: "Shadow",
      originalName: "",
      aliases: [],
      type: "character" as const,
    };
    const charB = {
      ...structuredClone(established().canonicalEntities[0]!),
      id: "ent_999999999999999999999999",
      canonicalName: "Entity B",
      localizedNaming: { locale: "en-US", shortName: "Shadow", usageMode: "always_short" as const },
      originalName: "",
      aliases: [],
      type: "character" as const,
    };
    const index = new EntityIdentityIndex([charA, charB]);

    expect(index.resolve(["Shadow"], { expectedType: "character" }).status).toBe("ambiguous");
  });

  it("performs boundary-aware Latin matching and CJK matching correctly", () => {
    expect(containsIdentityRendering("Ash entered the room.", "Ash")).toBe(true);
    expect(containsIdentityRendering("Ashen smoke filled the room.", "Ash")).toBe(false);
    expect(containsIdentityRendering("Nash spoke.", "Ash")).toBe(false);
    expect(containsIdentityRendering('"Ash!"', "Ash")).toBe(true);
    expect(containsIdentityRendering("Ash's blade", "Ash")).toBe(true);

    expect(containsIdentityRendering("Li attacked.", "Li")).toBe(true);
    expect(containsIdentityRendering("Alice attacked.", "Li")).toBe(false);
    expect(containsIdentityRendering("Climb higher.", "Li")).toBe(false);

    expect(containsIdentityRendering("罗小雪缓缓走了进来。", "罗小雪")).toBe(true);

    expect(containsIdentityRendering("Lucine Luo stepped forward.", "Lucine Luo")).toBe(true);
    expect(containsIdentityRendering("The Lucine Luoxin district...", "Lucine Luo")).toBe(false);
  });

  it("protects narration-only entities with false positive boundary checks from bypassing review", async () => {
    const llm = new MockLLM();
    llm.generateStructured = (async (request: any) => ({
      value: request.schema.parse({
        chapterSummary: "Chapter 2",
        characters: [{
          canonicalEnglishName: "Ash",
          originalName: "",
          firstSeenChapter: 2,
          lastSeenChapter: 2,
        }],
      }),
      raw: "",
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    })) as any;

    const extraction = await extractStoryBible(llm, { provider: "gemini", model: "test" }, {
      chapter: 2,
      source: "The ashes drifted across the battlefield.",
      translation: "The ashes drifted across the battlefield.",
      narration: "Ash raised his sword.",
      bible: established(),
    });

    const ash = extraction.value.characters.find((c) => c.canonicalEnglishName === "Ash")!;
    expect(ash.identityEvidence).toEqual({
      seenInSource: false,
      seenInTranslation: false,
      seenInNarration: true,
    });

    const merged = mergeStoryBible(established(), extraction.value, 2);
    expect(merged.canonicalEntities.some((e) => e.canonicalName === "Ash")).toBe(false);
    expect(merged.minorReferences.some((r) => r.name === "Ash" && r.disposition === "needs_review")).toBe(true);
  });

  it("includes preferred narration names and custom replacements in visual backfill and writes evidence to canonical entity", async () => {
    const bible = established();
    const luoId = bible.canonicalEntities[0]!.id;
    const llm = new MockLLM();

    llm.generateStructured = (async (args: any) => {
      const input = JSON.parse(args.input as string);
      expect(input.canonicalEntities.some((e: any) => e.name === "Luo Xiaoxue")).toBe(true);
      return {
        value: args.schema.parse({
          visualObservations: [{
            entity: "Luo Xiaoxue",
            field: "character.hairColor",
            value: "raven black",
            chapter: 2,
            confidence: 0.95,
            persistence: "persistent",
            excerpt: "Lucine Luo's black hair fell across her shoulders.",
          }],
        }),
        raw: "",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      };
    }) as any;

    const observations = await extractChapterVisualObservations(
      llm,
      { provider: "gemini", model: "test" },
      2,
      "Lucine Luo's black hair fell across her shoulders. Brother Ash stood nearby.",
      bible,
    );

    expect(observations).toHaveLength(1);
    expect(observations[0]?.entity).toBe("Luo Xiaoxue");

    const merged = mergeStoryBible(bible, storyBibleUpdateSchema.parse({
      chapterSummary: "Chapter 2",
      visualObservations: observations,
    }), 2);

    const luo = merged.canonicalEntities.find((e) => e.id === luoId)!;
    expect(luo.canonicalName).toBe("Luo Xiaoxue");
    expect(luo.visualEvidence?.some((v) => v.field === "character.hairColor" && v.value === "raven black")).toBe(true);
    expect(merged.canonicalEntities.some((e) => e.canonicalName === "Lucine Luo")).toBe(false);
    expect(luo.aliases).not.toContain("Lucine Luo");
  });

  it("resolves visual observations type-aware using field prefixes", () => {
    const bible = emptyStoryBible();
    const charPhoenix = {
      ...structuredClone(established().canonicalEntities[0]!),
      id: "ent_baaaaaaaaaaaaaaaaaaaaaaa",
      canonicalName: "Phoenix",
      originalName: "",
      aliases: [],
      type: "character" as const,
      visualEvidence: [],
    };
    const itemPhoenix = {
      ...structuredClone(established().canonicalEntities[0]!),
      id: "ent_caaaaaaaaaaaaaaaaaaaaaaa",
      canonicalName: "Phoenix",
      originalName: "",
      aliases: [],
      type: "item" as const,
      visualEvidence: [],
    };
    bible.canonicalEntities = [charPhoenix, itemPhoenix];

    const update = storyBibleUpdateSchema.parse({
      chapterSummary: "Chapter 2",
      visualObservations: [
        {
          entity: "Phoenix",
          field: "character.hairColor",
          value: "crimson red",
          chapter: 2,
          confidence: 0.9,
          persistence: "persistent",
          excerpt: "crimson red hair",
        },
        {
          entity: "Phoenix",
          field: "item.materials",
          value: "star metal",
          chapter: 2,
          confidence: 0.85,
          persistence: "persistent",
          excerpt: "forged from star metal",
        },
      ],
    });

    const merged = mergeStoryBible(bible, update, 2);
    const updatedChar = merged.canonicalEntities.find((e) => e.id === "ent_baaaaaaaaaaaaaaaaaaaaaaa")!;
    const updatedItem = merged.canonicalEntities.find((e) => e.id === "ent_caaaaaaaaaaaaaaaaaaaaaaa")!;

    expect(updatedChar.visualEvidence?.some((v) => v.field === "character.hairColor")).toBe(true);
    expect(updatedChar.visualEvidence?.some((v) => v.field === "item.materials")).toBe(false);

    expect(updatedItem.visualEvidence?.some((v) => v.field === "item.materials")).toBe(true);
    expect(updatedItem.visualEvidence?.some((v) => v.field === "character.hairColor")).toBe(false);
  });

  it("preserves character-specific honorific duplicate detection behavior", () => {
    const zhang = {
      ...structuredClone(established().canonicalEntities[0]!),
      id: "ent_daaaaaaaaaaaaaaaaaaaaaaa",
      canonicalName: "Zhang",
      originalName: "张",
      aliases: [],
      type: "character" as const,
    };
    const elderZhang = {
      ...structuredClone(established().canonicalEntities[0]!),
      id: "ent_eaaaaaaaaaaaaaaaaaaaaaaa",
      canonicalName: "Elder Zhang",
      originalName: "张",
      aliases: [],
      type: "character" as const,
    };
    const suggestions = findDuplicateSuggestions([zhang, elderZhang]);
    expect(suggestions.some((s) => s.entityIds.includes("ent_daaaaaaaaaaaaaaaaaaaaaaa") && s.entityIds.includes("ent_eaaaaaaaaaaaaaaaaaaaaaaa"))).toBe(true);
  });
});
