import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalEntitySchema, emptyStoryBible, storyBibleUpdateSchema, visualEvidenceFieldSchema } from "../src/domain/story-bible.js";
import { visualProfileSchema } from "../src/domain/visual-profile.js";
import { storyPaths } from "../src/storage/paths.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { getCanonicalEntityDetail, getStoryBible, invalidateCatalogCache } from "../apps/server/catalog.js";
import { decideVisualEvidence } from "../src/story-bible/canonical.js";
import { rebuildStoryBibleBeforeChapter } from "../src/story-bible/rebuild.js";
import { mergeStoryBible } from "../src/story-bible/updater.js";
import { resolveEntityVisualEvidence } from "../src/story-bible/visual-evidence.js";
import { inspectVisualProfile } from "../src/visual-canon/completion.js";
import { readVisualField, resolveVisualEntityType, visualFieldsForType, writeVisualField } from "../src/visual-canon/fields.js";
import { extractLocalVisualObservations } from "../src/story-bible/visual-backfill.js";

const slug = "visual-completion";
const id = "ent_111111111111111111111111";
function record(field: (typeof visualEvidenceFieldSchema)["_output"], value: string, chapter: number, index: number) {
  return { id: `ve_${index.toString(16).padStart(24, "0")}`, field, value, normalizedValue: value.toLowerCase(), chapter, lastObservedChapter: chapter, confidence: 0.9, persistence: "persistent" as const, status: "current" as const, source: "source_text" as const, provenance: [{ chapter, excerpt: `Named subject had ${value}.`, confidence: 0.9 }] };
}

describe("visual evidence completion", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "visual-completion-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it.each([
    ["character", "character"], ["location", "location"], ["creature", "creature"], ["item", "item"],
  ] as const)("bridges every %s field into an inspection without writing a profile", async (section, type) => {
    const paths = visualFieldsForType(type);
    expect(paths).toEqual(visualEvidenceFieldSchema.options.filter((path) => path.startsWith(`${section}.`)));
    const entity = canonicalEntitySchema.parse({ id, type: section === "creature" ? "concept" : type, sourceBucket: section === "creature" ? "creatures" : undefined, canonicalName: "Named subject", firstAppearance: 1, lastKnownAppearance: 1, visualEvidence: paths.map((path, index) => record(visualEvidenceFieldSchema.parse(path), `value ${index}`, 2, index + 1)) });
    const bible = emptyStoryBible(); bible.canonicalEntities = [entity];
    await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);
    expect(resolveVisualEntityType(entity)).toBe(type);
    const inspection = await inspectVisualProfile(root, slug, bible, id);
    expect(inspection.profile.visualType).toBe(type);
    expect(inspection.protectedFields).toEqual(paths);
    expect(inspection.eligibleFields).toEqual([]);
    expect(inspection.profile[section]).toEqual({});
  });

  it("reads and writes only valid paths for creature and item profiles", () => {
    const now = new Date().toISOString();
    const creature = visualProfileSchema.parse({ id: "vp-creature", entityId: id, visualType: "creature", createdAt: now, updatedAt: now });
    expect(writeVisualField(creature, "creature.anatomy", "six arms")).toBe(true);
    expect(readVisualField(creature, "creature.anatomy")).toBe("six arms");
    expect(writeVisualField(creature, "character.hairColor", "black")).toBe(false);
    const item = visualProfileSchema.parse({ id: "vp-item", entityId: id, visualType: "weapon", createdAt: now, updatedAt: now });
    expect(writeVisualField(item, "item.materials", "iron")).toBe(true);
    expect(readVisualField(item, "item.materials")).toBe("iron");
  });

  it("keeps a creature profile disagreement separate from Story Bible evidence conflicts", async () => {
    const entity = canonicalEntitySchema.parse({ id, type: "concept", sourceBucket: "creatures", canonicalName: "Ash Wolf", firstAppearance: 1, lastKnownAppearance: 1, visualEvidence: [record("creature.anatomy", "six arms", 1, 1)] });
    const bible = emptyStoryBible(); bible.canonicalEntities = [entity];
    await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);
    const now = new Date().toISOString();
    await atomicWriteJson(storyPaths(root, slug, 1).visualProfiles, { [id]: visualProfileSchema.parse({ id: "vp-wolf", entityId: id, visualType: "creature", status: "draft", creature: { anatomy: "two arms" }, fieldProvenance: { "creature.anatomy": { source: "ai_generated", locked: false } }, createdAt: now, updatedAt: now }) });
    const inspection = await inspectVisualProfile(root, slug, bible, id);
    expect(inspection.conflicts).toMatchObject([{ field: "creature.anatomy", canonicalValue: "six arms", visualValue: "two arms" }]);
    expect(resolveEntityVisualEvidence(entity, 1).conflicts).toEqual({});
  });

  it("persists conflict decisions through Bible reload and keeps historical provenance", async () => {
    const entity = canonicalEntitySchema.parse({ id, type: "character", canonicalName: "Named subject", firstAppearance: 1, lastKnownAppearance: 40, visualEvidence: [record("character.eyeColor", "blue", 10, 1), record("character.eyeColor", "green", 40, 2)] });
    const bible = emptyStoryBible(); bible.canonicalEntities = [entity];
    await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);
    const detail = await getCanonicalEntityDetail(root, slug, id);
    expect(detail.visualEvidenceResolution.conflicts["character.eyeColor"]).toHaveLength(2);
    expect(resolveEntityVisualEvidence(entity, 50).conflicts["character.eyeColor"]).toHaveLength(2);
    await decideVisualEvidence(root, slug, id, "character.eyeColor", entity.visualEvidence![1]!.id, "change");
    invalidateCatalogCache(root, slug);
    let loaded = (await getStoryBible(root, slug)).canonicalEntities[0]!;
    expect(resolveEntityVisualEvidence(loaded, 30).values["character.eyeColor"]?.value).toBe("blue");
    expect(resolveEntityVisualEvidence(loaded, 50).values["character.eyeColor"]?.value).toBe("green");
    expect((await getCanonicalEntityDetail(root, slug, id)).visualEvidenceResolution.values["character.eyeColor"]?.value).toBe("green");
    expect(loaded.visualEvidence).toHaveLength(2);
    await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);
    loaded = (await getStoryBible(root, slug)).canonicalEntities[0]!;
    expect(resolveEntityVisualEvidence(loaded, 50).values["character.eyeColor"]?.value).toBe("green");
    await decideVisualEvidence(root, slug, id, "character.eyeColor", entity.visualEvidence![1]!.id, "clear");
    loaded = (await getStoryBible(root, slug)).canonicalEntities[0]!;
    expect(resolveEntityVisualEvidence(loaded, 50).conflicts["character.eyeColor"]).toHaveLength(2);
  });

  it("keeps a manual change decision through chronological rebuild", async () => {
    const first = storyBibleUpdateSchema.parse({ chapterSummary: "Introduced", characters: [{ canonicalEnglishName: "Named subject", originalName: "原名", description: "Person", firstSeenChapter: 1, lastSeenChapter: 1 }] });
    const observation = (chapter: number, value: string) => storyBibleUpdateSchema.parse({ chapterSummary: `Chapter ${chapter}`, visualObservations: [{ entity: "Named subject", field: "character.eyeColor", value, chapter, confidence: 0.9, persistence: "persistent", excerpt: `Named subject had ${value} eyes.` }] });
    const blue = observation(10, "blue"), green = observation(40, "green");
    for (const [chapter, update] of [[1, first], [10, blue], [40, green]] as const) await atomicWriteJson(storyPaths(root, slug, chapter).bibleUpdate, update);
    let bible = mergeStoryBible(emptyStoryBible(), first, 1);
    bible = mergeStoryBible(bible, blue, 10);
    bible = mergeStoryBible(bible, green, 40);
    await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);
    const subject = bible.canonicalEntities.find((item) => item.canonicalName === "Named subject")!;
    await decideVisualEvidence(root, slug, subject.id, "character.eyeColor", subject.visualEvidence!.find((item) => item.value === "green")!.id, "change");
    const rebuilt = await rebuildStoryBibleBeforeChapter(root, slug, 41);
    const resolved = rebuilt.canonicalEntities.find((item) => item.id === subject.id)!;
    expect(resolveEntityVisualEvidence(resolved, 30).values["character.eyeColor"]?.value).toBe("blue");
    expect(resolveEntityVisualEvidence(resolved, 50).values["character.eyeColor"]?.value).toBe("green");
  });

  it("preserves successive editorial appearance changes", () => {
    const entity = canonicalEntitySchema.parse({ id, type: "character", canonicalName: "Named subject", firstAppearance: 1, lastKnownAppearance: 70, visualEvidence: [record("character.eyeColor", "blue", 10, 1), record("character.eyeColor", "green", 40, 2), record("character.eyeColor", "amber", 70, 3)], visualEvidenceDecisions: [{ field: "character.eyeColor", evidenceId: "ve_000000000000000000000002", action: "change", decidedAt: new Date().toISOString() }, { field: "character.eyeColor", evidenceId: "ve_000000000000000000000003", action: "change", decidedAt: new Date().toISOString() }] });
    expect(resolveEntityVisualEvidence(entity, 30).values["character.eyeColor"]?.value).toBe("blue");
    expect(resolveEntityVisualEvidence(entity, 50).values["character.eyeColor"]?.value).toBe("green");
    expect(resolveEntityVisualEvidence(entity, 80).values["character.eyeColor"]?.value).toBe("amber");
  });

  it("extracts only named literal traits and keeps one-time clothing temporary", () => {
    const entity = canonicalEntitySchema.parse({ id, type: "character", canonicalName: "Li Chen", firstAppearance: 1, lastKnownAppearance: 1 });
    const statements = ["Li Chen was tall.", "Li Chen had a lean build.", "Li Chen had pale skin.", "Li Chen wore a short beard.", "Li Chen had a dragon tattoo on his left arm.", "Li Chen had a scar over his left eyebrow.", "Li Chen wore leather boots.", "Li Chen wore a silver necklace.", "Li Chen carried a black sword at his waist.", "Li Chen carried a wooden shield.", "Li Chen wore a red robe.", "Li Chen usually wore a blue coat.", "His eyes were bright."];
    const found = extractLocalVisualObservations(statements.join(" "), [entity], 2);
    for (const field of ["character.height", "character.build", "character.skinTone", "character.facialHair", "character.tattoos", "character.scars", "character.shoes", "character.accessories", "character.weapons", "character.equipment"]) expect(found.some((item) => item.field === field)).toBe(true);
    expect(found.find((item) => item.value === "a red robe")?.persistence).toBe("temporary");
    expect(found.find((item) => item.value === "a blue coat")?.persistence).toBe("persistent");
    expect(found.some((item) => item.field === "character.eyeColor")).toBe(false);
    expect(extractLocalVisualObservations("He was tall. The captain had pale skin while Li Chen watched.", [entity], 2)).toEqual([]);
  });
});
