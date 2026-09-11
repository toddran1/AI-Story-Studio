import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getCanonicalEntitiesPage } from "../apps/server/catalog.js";
import { emptyStoryBible, storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { applyCanonicalOverlay, findDuplicateSuggestions, mergeCanonicalEntities, undoCanonicalMerge, updateCanonicalEntity } from "../src/story-bible/canonical.js";
import { analyzeAndPersistContinuity, detectContinuityFindings, resolveContinuityFinding } from "../src/story-bible/continuity.js";
import { retrieveRelevantContext } from "../src/story-bible/retrieval.js";
import { mergeStoryBible } from "../src/story-bible/updater.js";

const named = (name: string, chapter: number, extra: Record<string, unknown> = {}) => ({ canonicalEnglishName: name, originalName: "", description: `${name} at Chapter ${chapter}`, firstSeenChapter: chapter, lastSeenChapter: chapter, ...extra });
const update = (chapter: number, value: Record<string, unknown> = {}) => storyBibleUpdateSchema.parse({ chapterSummary: `Chapter ${chapter}`, ...value });

describe("advanced Story Bible continuity", () => {
  it("keeps stable IDs, resolves aliases, preserves history, and traces provenance", () => {
    let bible = mergeStoryBible(emptyStoryBible(), update(12, { characters: [named("Su Ming", 12, { aliases: ["Xiao Ming"] }), named("Lin Yue", 12)], relationships: [{ subject: "Su Ming", object: "Lin Yue", relationship: "friend", firstSeenChapter: 12, lastSeenChapter: 12 }] }), 12);
    const id = bible.canonicalEntities.find((item) => item.canonicalName === "Su Ming")!.id;
    bible = mergeStoryBible(bible, update(147, { characters: [named("Doctor Su", 147, { aliases: ["Su Ming"], status: "Azure Sect member" })], abilities: [named("Flame Technique", 147)], relationships: [{ subject: "Su Ming", object: "Flame Technique", relationship: "uses", firstSeenChapter: 147, lastSeenChapter: 147 }], timelineEvents: [{ entity: "Su Ming", type: "ability_gained", relatedEntity: "Flame Technique", summary: "Gains Flame Technique", chapter: 147 }] }), 147);
    const su = bible.canonicalEntities.find((item) => item.id === id)!;
    expect(su.aliases).toContain("Doctor Su"); expect(su.firstAppearance).toBe(12); expect(su.lastKnownAppearance).toBe(147); expect(su.provenance.map((item) => item.chapter)).toEqual([12, 147]);
    expect(bible.entityTimeline.filter((item) => item.entityId === id).map((item) => item.type)).toEqual(expect.arrayContaining(["appearance", "status_change", "ability_gained"]));
    expect(bible.canonicalRelationships.some((item) => item.sourceEntityId === id && item.type === "uses")).toBe(true);
  });

  it("protects canonical names and supports reversible, history-preserving merges", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonical-bible-")); let bible = mergeStoryBible(emptyStoryBible(), update(1, { characters: [named("Su Ming", 1), named("Doctor Su", 1)] }), 1); const [su, doctor] = bible.canonicalEntities;
    const edited = await updateCanonicalEntity(root, "demo-story", bible, su!.id, { canonicalName: "Su Ming", aliases: ["Xiao Ming", "Young Master Su"], canonicalNameLocked: true, notes: "Editor-approved spelling" }); bible = edited.bible;
    expect(bible.canonicalEntities.find((item) => item.id === su!.id)).toMatchObject({ canonicalNameLocked: true, origin: "manual", notes: "Editor-approved spelling" });
    const merged = await mergeCanonicalEntities(root, "demo-story", bible, su!.id, [doctor!.id], "Same character"); const target = merged.bible.canonicalEntities.find((item) => item.id === su!.id)!;
    expect(target.aliases).toEqual(expect.arrayContaining(["Doctor Su", "Xiao Ming"])); expect(target.mergedFromIds).toContain(doctor!.id); expect(merged.bible.entityTimeline.every((item) => item.entityId !== doctor!.id)).toBe(true);
    await undoCanonicalMerge(root, "demo-story", bible, merged.merge.id); const restored = await applyCanonicalOverlay(root, "demo-story", bible); expect(restored.bible.canonicalEntities.map((item) => item.id)).toEqual(expect.arrayContaining([su!.id, doctor!.id]));
  });

  it("resolves chained merge references and rejects merge cycles", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonical-chain-")); const base = mergeStoryBible(emptyStoryBible(), update(1, { characters: [named("Alpha", 1), named("Beta", 1), named("Gamma", 1)], relationships: [{ subject: "Alpha", object: "Beta", relationship: "ally", firstSeenChapter: 1, lastSeenChapter: 1 }] }), 1); const [alpha, beta, gamma] = base.canonicalEntities;
    await mergeCanonicalEntities(root, "demo-story", base, beta!.id, [alpha!.id], "First merge"); const chained = await mergeCanonicalEntities(root, "demo-story", base, gamma!.id, [beta!.id], "Second merge");
    expect(chained.bible.canonicalEntities.map((item) => item.id)).toEqual([gamma!.id]); expect(chained.bible.canonicalRelationships[0]).toMatchObject({ sourceEntityId: gamma!.id, targetEntityId: gamma!.id });
    const cycleRoot = await mkdtemp(join(tmpdir(), "canonical-cycle-")); await mergeCanonicalEntities(cycleRoot, "demo-story", base, beta!.id, [alpha!.id], "A to B"); await expect(mergeCanonicalEntities(cycleRoot, "demo-story", base, alpha!.id, [beta!.id], "B to A")).rejects.toThrow(/cycle/);
  });

  it("learns aliases and provenance while canonical records are locked", () => {
    let bible = mergeStoryBible(emptyStoryBible(), update(1, { characters: [named("Su Ming", 1)], relationships: [{ subject: "Su Ming", object: "Lin Yue", relationship: "friend", firstSeenChapter: 1, lastSeenChapter: 1, locked: true }] }), 1); const su = bible.canonicalEntities.find((item) => item.canonicalName === "Su Ming")!; su.canonicalNameLocked = true;
    bible = mergeStoryBible(bible, update(2, { characters: [named("Doctor Su", 2, { aliases: ["Su Ming"] })], relationships: [{ subject: "Su Ming", object: "Lin Yue", relationship: "friend", firstSeenChapter: 2, lastSeenChapter: 2 }] }), 2);
    expect(bible.canonicalEntities.find((item) => item.id === su.id)?.aliases).toContain("Doctor Su"); expect(bible.canonicalRelationships[0]?.provenance.map((item) => item.chapter)).toEqual([1, 2]);
  });

  it("suggests deterministic duplicates but never merges them automatically", () => { const bible = mergeStoryBible(emptyStoryBible(), update(1, { characters: [named("Su Ming", 1), named("Doctor Su", 1)] }), 1); const suggestions = findDuplicateSuggestions(bible.canonicalEntities); expect(suggestions[0]).toMatchObject({ confidence: .82, entities: [{ name: "Su Ming" }, { name: "Doctor Su" }] }); expect(bible.canonicalEntities).toHaveLength(2); });

  it("detects status, location, relationship, identity, and ownership conflicts", () => {
    let bible = mergeStoryBible(emptyStoryBible(), update(12, { characters: [named("Su Ming", 12), named("Lin Yue", 12)], relationships: [{ subject: "Su Ming", object: "Lin Yue", relationship: "friend", firstSeenChapter: 12, lastSeenChapter: 12 }] }), 12);
    bible = mergeStoryBible(bible, update(402, { characters: [named("Elder Han", 402)], timelineEvents: [{ entity: "Elder Han", type: "death", summary: "Elder Han dies", status: "dead", chapter: 402 }] }), 402);
    bible = mergeStoryBible(bible, update(418, { characters: [named("Elder Han", 418)] }), 418);
    bible = mergeStoryBible(bible, update(930, { characters: [named("Doctor Su", 930)] }), 930);
    bible = mergeStoryBible(bible, update(1204, { timelineEvents: [{ entity: "Su Ming", relatedEntity: "Lin Yue", type: "relationship_change", summary: "Su Ming claims he has never met Lin Yue", chapter: 1204 }] }), 1204);
    const types = detectContinuityFindings(bible).map((item) => item.type); expect(types).toEqual(expect.arrayContaining(["status_conflict", "relationship_conflict"]));
    expect(findDuplicateSuggestions(bible.canonicalEntities).some((item) => item.entities.some((entity) => entity.name === "Doctor Su"))).toBe(true);
  });

  it("persists dismissals and keeps them after relevant re-analysis", async () => {
    const root = await mkdtemp(join(tmpdir(), "continuity-review-")); let bible = mergeStoryBible(emptyStoryBible(), update(1, { characters: [named("Elder Han", 1)], timelineEvents: [{ entity: "Elder Han", type: "death", summary: "Dies", status: "dead", chapter: 1 }] }), 1); bible = mergeStoryBible(bible, update(2, { characters: [named("Elder Han", 2)] }), 2);
    const first = await analyzeAndPersistContinuity(root, "demo-story", bible, 2); const finding = first.document.findings[0]!; await resolveContinuityFinding(root, "demo-story", finding.id, "dismissed", "Reported death was a disguise"); const again = await analyzeAndPersistContinuity(root, "demo-story", bible, 2); expect(again.document.findings[0]).toMatchObject({ status: "dismissed", resolutionNote: "Reported death was a disguise" });
  });

  it("paginates and searches large canonical indexes by alias", async () => { const root = await mkdtemp(join(tmpdir(), "bible-page-")); const characters = Array.from({ length: 125 }, (_, index) => named(`Character ${String(index + 1).padStart(3, "0")}`, 1, { aliases: index === 77 ? ["The Archivist"] : [] })); const bible = mergeStoryBible(emptyStoryBible(), update(1, { characters }), 1); await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, bible); const page = await getCanonicalEntitiesPage(root, "demo-story", { page: 2, pageSize: 50, type: "character", sort: "name" }); expect(page).toMatchObject({ page: 2, pages: 3, total: 125 }); expect(page.items).toHaveLength(50); const search = await getCanonicalEntitiesPage(root, "demo-story", { page: 1, pageSize: 10, query: "archivist" }); expect(search.items).toHaveLength(1); expect(search.items[0]?.aliases).toContain("The Archivist"); });

  it("serves the atomic Story Bible snapshot without replaying malformed chapter history", async () => { const root = await mkdtemp(join(tmpdir(), "bible-snapshot-")); const bible = mergeStoryBible(emptyStoryBible(), update(1, { characters: [named("Snapshot Hero", 1)] }), 1); const paths = storyPaths(root, "demo-story", 1); await atomicWriteJson(paths.bible, bible); await atomicWriteJson(paths.bibleUpdate, { malformed: true }); const page = await getCanonicalEntitiesPage(root, "demo-story", { page: 1, pageSize: 10 }); expect(page.items[0]?.canonicalName).toBe("Snapshot Hero"); });

  it("retrieves bounded relevant context from a synthetic 1,600-chapter history", () => {
    let bible = emptyStoryBible();
    for (let chapter = 1; chapter <= 1600; chapter++) bible = mergeStoryBible(bible, update(chapter, { characters: [named(chapter % 2 ? "Su Ming" : "Doctor Su", chapter, { aliases: [chapter % 2 ? "Doctor Su" : "Su Ming"] })], relationships: chapter === 147 ? [{ subject: "Su Ming", object: "Azure Sect", relationship: "member of", firstSeenChapter: chapter, lastSeenChapter: chapter }] : chapter === 612 ? [{ subject: "Su Ming", object: "Azure Sect", relationship: "member of", firstSeenChapter: chapter, lastSeenChapter: chapter, endChapter: chapter, state: "historical" }] : [] }), chapter);
    const context = retrieveRelevantContext(bible, "Doctor Su remembers Azure Sect.", 1601, { maxEntities: 8, maxTimelineEvents: 12, maxCharacters: 7000 }); const su = context.canonicalEntities.find((item) => item.canonicalName === "Su Ming");
    expect(su?.lastKnownAppearance).toBe(1600); expect(context.canonicalEntities.length).toBeLessThanOrEqual(8); expect(context.entityTimeline.length).toBeLessThanOrEqual(12); expect(JSON.stringify(context).length).toBeLessThanOrEqual(7000);
  }, 15_000);

  it("enforces a small context character budget even with oversized entity fields", () => { let bible = mergeStoryBible(emptyStoryBible(), update(1, { characters: [named("Verbose Hero", 1, { aliases: Array.from({ length: 50 }, (_, index) => `Hero Alias ${index}`), description: "x".repeat(9000) })] }), 1); const context = retrieveRelevantContext(bible, "Verbose Hero", 2, { maxCharacters: 1000 }); expect(JSON.stringify(context).length).toBeLessThanOrEqual(1000); });
});
