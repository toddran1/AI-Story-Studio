import { describe, expect, it } from "vitest";
import { emptyStoryBible, storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { EntityIdentityIndex } from "../src/story-bible/entity-identity.js";
import { mergeStoryBible } from "../src/story-bible/updater.js";
import { findDuplicateSuggestions } from "../src/story-bible/duplicate-detection.js";
import { extractStoryBible, storyBibleExtractionFingerprint } from "../src/story-bible/extractor.js";
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
});
