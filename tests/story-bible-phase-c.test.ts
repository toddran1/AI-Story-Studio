import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getCanonicalEntityAudit, getCanonicalEntityDetail, getCanonicalEntityUsage, getStoryBibleHealth, getStoryBibleReview } from "../apps/server/catalog.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { qaStateSchema } from "../src/domain/qa.js";
import { canonicalEntitySchema, emptyStoryBible, type CanonicalEntity } from "../src/domain/story-bible.js";
import { visualProfileSchema } from "../src/domain/visual-profile.js";
import { continuityReviewSchema } from "../src/story-bible/continuity.js";
import { appendEntityAudit, readEntityAudit } from "../src/story-bible/entity-audit.js";
import { findNamingCollisions } from "../src/story-bible/naming-collisions.js";
import { sceneManifestSchema } from "../src/scenes/types.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";

const env = loadEnvironment({});
const id = (hex: string) => `ent_${hex.padEnd(24, "0")}`;
const entity = (hex: string, patch: Record<string, unknown> = {}): CanonicalEntity => canonicalEntitySchema.parse({ id: id(hex), type: "character", canonicalName: `Entity ${hex}`, originalName: `原名${hex}`, firstAppearance: 1, lastKnownAppearance: 3, ...patch });

async function storyFixture() {
  const root = await mkdtemp(join(tmpdir(), "story-bible-phase-c-"));
  const story = defaultStory("night-lantern", env);
  const paths = storyPaths(root, story.slug, 1);
  await atomicWriteJson(paths.storyConfig, story);
  await atomicWriteJson(paths.pipelineConfig, story.pipeline);
  return { root, story, paths };
}

async function seedBible(paths: ReturnType<typeof storyPaths>, entities: CanonicalEntity[]) {
  await atomicWriteJson(paths.bible, { ...emptyStoryBible(), canonicalEntities: entities });
}

describe("naming collision detection", () => {
  it("detects canonical ↔ canonical collisions", () => {
    const collisions = findNamingCollisions([entity("a1", { canonicalName: "Su Ming" }), entity("a2", { canonicalName: "su ming" })]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.type).toBe("canonical-canonical");
    expect(collisions[0]!.entities.map((item) => item.field)).toEqual(["canonical name", "canonical name"]);
  });
  it("detects canonical ↔ alias/original-name collisions", () => {
    const collisions = findNamingCollisions([entity("a3", { canonicalName: "Su Ming" }), entity("a4", { canonicalName: "Ming", aliases: ["Su Ming"] })]);
    expect(collisions.map((item) => item.type)).toEqual(["canonical-alias"]);
    const original = findNamingCollisions([entity("a5", { canonicalName: "苏明" }), entity("a6", { canonicalName: "Ming", originalName: "苏明" })]);
    expect(original.map((item) => item.type)).toEqual(["canonical-alias"]);
  });
  it("detects canonical ↔ preferred narration and alias ↔ preferred narration collisions", () => {
    const narration = findNamingCollisions([entity("a7", { canonicalName: "Sue" }), entity("a8", { canonicalName: "Ming", preferredNarrationName: "Sue" })]);
    expect(narration.map((item) => item.type)).toEqual(["canonical-narration"]);
    const aliasNarration = findNamingCollisions([entity("a9", { canonicalName: "Su Ming", aliases: ["Sue"] }), entity("b1", { canonicalName: "Ming", preferredNarrationName: "Sue" })]);
    expect(aliasNarration.map((item) => item.type)).toEqual(["alias-narration"]);
  });
  it("detects localized naming collisions", () => {
    const collisions = findNamingCollisions([
      entity("b2", { localizedNaming: { locale: "en-US", fullName: "Sue", usageMode: "ai_contextual" } }),
      entity("b3", { canonicalName: "Sue" }),
    ]);
    expect(collisions.map((item) => item.type)).toEqual(["localized"]);
  });
  it("never reports an entity colliding with itself", () => {
    expect(findNamingCollisions([entity("b4", { canonicalName: "Su Ming", aliases: ["Su Ming"], preferredNarrationName: "Su Ming" })])).toEqual([]);
  });
  it("flags collisions between merge-related records instead of surfacing them as open", () => {
    const source = entity("b5", { canonicalName: "Su Ming" });
    const target = entity("b6", { canonicalName: "Su Ming", mergedFromIds: [source.id] });
    const collisions = findNamingCollisions([source, target]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.hasMergeRelationship).toBe(true);
    expect(findNamingCollisions([entity("b7", { canonicalName: "Su Ming" }), entity("b8", { canonicalName: "Ming" })]).every((item) => !item.hasMergeRelationship)).toBe(true);
  });
  it("returns nothing for distinct names and never mutates entities", () => {
    const entities = [entity("b9"), entity("c1")];
    expect(findNamingCollisions(entities)).toEqual([]);
  });

  it("surfaces collisions in health, the review queue, and the entity detail without feeding merge automation", async () => {
    const { root, story, paths } = await storyFixture();
    const a = entity("c2", { canonicalName: "Su Ming" });
    const b = entity("c3", { canonicalName: "Ming", preferredNarrationName: "Su Ming" });
    await seedBible(paths, [a, b]);
    const health = await getStoryBibleHealth(root, story.slug);
    expect(health.issues.namingCollisions).toBe(1);
    const review = await getStoryBibleReview(root, story.slug, { kind: "naming", page: 1, pageSize: 50 });
    expect(review.items).toHaveLength(1);
    expect(review.openTotal).toBe(1);
    expect(review.items[0]!.lifecycle).toBe("derived");
    expect((await getStoryBibleReview(root, story.slug, { status: "resolved", page: 1, pageSize: 50 })).items).toEqual([]);
    expect(review.items[0]!.severity).toBe("warn");
    expect(review.items[0]!.entityIds).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(review.items[0]!.action.href).toBe(`/stories/${story.slug}/bible?entity=${a.id}`);
    // Duplicate suggestions remain the only merge-oriented surface; collisions are review-only.
    const detail = await getCanonicalEntityDetail(root, story.slug, a.id);
    expect(detail.namingCollisions).toHaveLength(1);
    expect(detail.namingCollisions[0]!.entities.find((item: { id: string }) => item.id === b.id)?.field).toContain("preferred narration name");
  });
});

async function usageFixture() {
  const { root, story, paths } = await storyFixture();
  const target = entity("d1", {
    canonicalName: "Su Ming",
    provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }, { chapter: 2, kind: "event", origin: "automatic" }],
  });
  const other = entity("d2", { canonicalName: "Ming" });
  await seedBible(paths, [target, other]);
  const now = new Date().toISOString();
  const complete = { status: "complete" as const, fingerprint: "in", outputFingerprint: "out" };
  await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({
    chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
    counts: { originalCharacters: 100, englishWords: 120, narrationWords: 120 }, createdAt: now, updatedAt: now,
    stages: { ingestion: complete, translation: complete, narration: complete, qa: { status: "pending" }, storyBible: { status: "pending" }, tts: { status: "pending" } },
  }));
  await atomicWriteJson(paths.qa, qaStateSchema.parse({
    status: "warn", score: 0.7,
    issues: [{ category: "names", severity: "warn", message: "Name drift", evidence: "Su Ming vs Ming" }],
    checks: { completeness: "pass", names: "warn", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" },
    findings: [
      { id: `qaf_${"f1".padEnd(24, "0")}`, category: "names", severity: "warn", message: "Name drift", evidence: "Su Ming vs Ming", status: "open", fingerprint: "fp1", origin: "llm", provenance: { entityIds: [target.id] } },
      { id: `qaf_${"f2".padEnd(24, "0")}`, category: "numbers", severity: "fail", message: "Wrong count", evidence: "Three, not two", status: "open", fingerprint: "fp2", origin: "llm", provenance: { entityIds: [other.id] } },
    ],
  }));
  await atomicWriteJson(paths.scenesManifest, sceneManifestSchema.parse({
    version: 1, chapter: 1, durationSeconds: 60, planningFingerprint: "x",
    planner: { provider: "test", model: "test", promptVersion: "1" }, createdAt: now, updatedAt: now,
    scenes: [
      { id: "scene-001", summary: "Su Ming fights the keeper", startSeconds: 0, endSeconds: 10, characters: ["Su Ming"], visualPrompt: "a fight", entityIds: [target.id] },
      { id: "scene-002", summary: "A quiet courtyard", startSeconds: 10, endSeconds: 20, characters: [], visualPrompt: "courtyard", entityIds: [] },
    ],
  }));
  await atomicWriteJson(paths.continuityReview, continuityReviewSchema.parse({
    version: 1, analyzedThroughChapter: 3, inputFingerprint: "x", updatedAt: now,
    findings: [{ id: `ctf_${"e1".padEnd(24, "0")}`, type: "status_conflict", severity: "critical", entityIds: [target.id], chapters: [1, 2], explanation: "Appears after death without resurrection.", supportingFacts: [{ entityId: target.id, chapter: 1, summary: "Died.", provenanceKind: "event" }], evidenceFingerprint: "e1", status: "open" }],
  }));
  await atomicWriteJson(paths.visualProfiles, { [target.id]: visualProfileSchema.parse({ id: "vp1", entityId: target.id, createdAt: now, updatedAt: now }) });
  return { root, story, target };
}

describe("entity usage endpoint", () => {
  it("counts open review rows while resolved filtering retains only stateful history", async () => {
    const { root, story, target } = await usageFixture();
    const open = await getStoryBibleReview(root, story.slug, { status: "open", page: 1, pageSize: 1 });
    expect(open.openTotal).toBe(open.total);
    expect(open.items).toHaveLength(1);
    expect(open.pages).toBe(open.total);
    const resolved = await getStoryBibleReview(root, story.slug, { status: "resolved", page: 1, pageSize: 50 });
    expect(resolved.items).toEqual([]);
    const paths = storyPaths(root, story.slug, 1);
    const review = continuityReviewSchema.parse({ version: 1, analyzedThroughChapter: 3, inputFingerprint: "x", updatedAt: new Date().toISOString(), findings: [{ id: `ctf_${"e1".padEnd(24, "0")}`, type: "status_conflict", severity: "critical", entityIds: [target.id], chapters: [1, 2], explanation: "Appears after death without resurrection.", supportingFacts: [{ entityId: target.id, chapter: 1, summary: "Died.", provenanceKind: "event" }], evidenceFingerprint: "e1", status: "intentional" }] });
    await atomicWriteJson(paths.continuityReview, review);
    const after = await getStoryBibleReview(root, story.slug, { status: "resolved", page: 1, pageSize: 50 });
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({ kind: "continuity", lifecycle: "stateful", status: "resolved" });
    expect((await getStoryBibleReview(root, story.slug, { status: "open", page: 1, pageSize: 50 })).items.some((item) => item.id === after.items[0]!.id)).toBe(false);
  });
  it("aggregates provenance, QA, continuity, scene, and visual profile uses with real excerpts and hrefs", async () => {
    const { root, story, target } = await usageFixture();
    const usage = await getCanonicalEntityUsage(root, story.slug, target.id, { page: 1, pageSize: 50 });
    expect(usage.summary.sourceChapters).toEqual([1, 3]);
    expect(usage.summary.translationChapters).toBe(1);
    expect(usage.summary.narrationChapters).toBe(1);
    expect(usage.summary.qaFindings).toBe(1);
    expect(usage.summary.continuityFindings).toBe(1);
    expect(usage.summary.scenes).toBe(1);
    expect(usage.summary.visualProfile).toBe(true);
    const kinds = usage.uses.map((use) => use.kind);
    expect(kinds).toEqual(expect.arrayContaining(["provenance", "qa", "continuity", "scene", "visual-profile"]));
    const qa = usage.uses.find((use) => use.kind === "qa")!;
    expect(qa.href).toBe(`/stories/${story.slug}/chapters/1?tab=quality`);
    expect(qa.excerpt).toBe("Su Ming vs Ming");
    const scene = usage.uses.find((use) => use.kind === "scene")!;
    expect(scene.href).toBe(`/stories/${story.slug}/scenes?chapter=1`);
    expect(scene.sceneId).toBe("scene-001");
    expect(scene.excerpt).toBeUndefined();
    const continuity = usage.uses.find((use) => use.kind === "continuity")!;
    expect(continuity.href).toBe(`/stories/${story.slug}/continuity?entity=${target.id}`);
    expect(continuity.excerpt).toBe("Died.");
    expect(usage.uses.filter((use) => use.kind === "provenance")).toHaveLength(2);
    expect(usage.total).toBe(usage.uses.length);
  });

  it("paginates uses and excludes references to other entities", async () => {
    const { root, story, target } = await usageFixture();
    const page = await getCanonicalEntityUsage(root, story.slug, target.id, { page: 2, pageSize: 2 });
    expect(page.page).toBe(2);
    expect(page.uses.length).toBeLessThanOrEqual(2);
    expect(page.uses.every((use) => !use.label.includes("Wrong count"))).toBe(true);
    expect(page.total).toBe(6);
  });

  it("rejects unknown entities", async () => {
    const { root, story, target } = await usageFixture();
    await expect(getCanonicalEntityUsage(root, story.slug, id("ff"), { page: 1, pageSize: 50 })).rejects.toThrow("not found");
    expect(target.id).toBeTruthy();
  });
});

describe("entity audit log", () => {
  it("records rename, type, narration mapping, lock, and notes deltas with before/after", async () => {
    const { root, story, paths } = await storyFixture();
    const target = entity("e1", { canonicalName: "Su Ming" });
    await seedBible(paths, [target]);
    const operations = new StudioOperations(root, env);
    await operations.updateCanonicalEntity(story.slug, target.id, { canonicalName: "Su Ming the Elder" });
    await operations.updateCanonicalEntity(story.slug, target.id, { notes: "Watch this character" });
    await operations.updateCanonicalEntity(story.slug, target.id, { canonicalNameLocked: true });
    await operations.updateCanonicalEntity(story.slug, target.id, { preferredNarrationName: "Sue" });
    await operations.updateCanonicalEntity(story.slug, target.id, { type: "organization" });
    const entries = await readEntityAudit(root, story.slug, target.id);
    expect(entries.map((entry) => entry.action)).toEqual(["type_changed", "narration_mapping_changed", "locked", "updated", "renamed"]);
    const renamed = entries.find((entry) => entry.action === "renamed")!;
    expect(renamed.before).toMatchObject({ canonicalName: "Su Ming" });
    expect(renamed.after).toMatchObject({ canonicalName: "Su Ming the Elder" });
    const notes = entries.find((entry) => entry.action === "updated")!;
    expect(Object.keys(notes.before!)).toEqual(["notes"]);
    expect(notes.after).toMatchObject({ notes: "Watch this character" });
    const locked = entries.find((entry) => entry.action === "locked")!;
    expect(locked.before).toMatchObject({ canonicalNameLocked: false });
    const mapping = entries.find((entry) => entry.action === "narration_mapping_changed")!;
    expect(mapping.after).toMatchObject({ preferredNarrationName: "Sue" });
    await operations.close();
  });

  it("records merge, merge undo, suppress, restore, demote, promote, and bulk edits", async () => {
    const { root, story, paths } = await storyFixture();
    const target = entity("e2", { canonicalName: "Su Ming" });
    const source = entity("e3", { canonicalName: "Ming" });
    const demotable = entity("e4", { canonicalName: "Fleeting Sect" });
    await seedBible(paths, [target, source, demotable]);
    const operations = new StudioOperations(root, env);
    const merged = await operations.mergeCanonicalEntities(story.slug, { targetEntityId: target.id, sourceEntityIds: [source.id], reason: "Same person" });
    await operations.undoCanonicalMerge(story.slug, merged.merge.id);
    await operations.suppressCanonicalEntity(story.slug, source.id, { reason: "Noise" });
    await operations.restoreCanonicalEntity(story.slug, source.id);
    await operations.demoteCanonicalEntity(story.slug, demotable.id, { reason: "Minor" });
    await operations.promoteMinorReference(story.slug, `ref_${demotable.id.slice(4)}`, { reason: "Actually important" });
    await operations.bulkUpdateCanonicalEntities(story.slug, { action: "lock", entityIds: [target.id] });
    const targetEntries = await readEntityAudit(root, story.slug, target.id);
    expect(targetEntries.map((entry) => entry.action)).toEqual(expect.arrayContaining(["merged", "merge_undone", "locked"]));
    const sourceEntries = await readEntityAudit(root, story.slug, source.id);
    expect(sourceEntries.map((entry) => entry.action)).toEqual(expect.arrayContaining(["merged", "merge_undone", "suppressed", "restored"]));
    const suppression = sourceEntries.find((entry) => entry.action === "suppressed")!;
    expect(suppression.reason).toBe("Noise");
    const demotedEntries = await readEntityAudit(root, story.slug, demotable.id);
    expect(demotedEntries.map((entry) => entry.action)).toEqual(expect.arrayContaining(["demoted", "promoted"]));
    await operations.close();
  });

  it("serves paginated entries newest-first plus the pre-existing historical record", async () => {
    const { root, story, paths } = await storyFixture();
    const target = entity("e5", { canonicalName: "Su Ming", provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }] });
    const source = entity("e6", { canonicalName: "Ming" });
    await seedBible(paths, [target, source]);
    const operations = new StudioOperations(root, env);
    const merged = await operations.mergeCanonicalEntities(story.slug, { targetEntityId: target.id, sourceEntityIds: [source.id], reason: "Same person" });
    await operations.updateCanonicalEntity(story.slug, target.id, { notes: "one" });
    await operations.updateCanonicalEntity(story.slug, target.id, { notes: "two" });
    const audit = await getCanonicalEntityAudit(root, story.slug, target.id, { page: 1, pageSize: 1 });
    expect(audit.total).toBe(3);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]!.after).toMatchObject({ notes: "two" });
    expect(audit.historical.some((item) => item.kind === "merge" && item.label.includes("Merged"))).toBe(true);
    expect(audit.historical.some((item) => item.kind === "provenance" && item.label.includes("extracted as"))).toBe(true);
    expect(merged.merge.id).toBeTruthy();
    const second = await getCanonicalEntityAudit(root, story.slug, target.id, { page: 3, pageSize: 1 });
    expect(second.entries[0]!.action).toBe("merged");
    await operations.close();
  });

  it("trims the log oldest-first at the retention cap", async () => {
    const { root, story, paths } = await storyFixture();
    const target = entity("e7");
    await seedBible(paths, [target]);
    const entry = (index: number) => ({ entityId: target.id, action: "updated" as const, after: { notes: `n${index}` }, source: "manual" as const });
    await appendEntityAudit(root, story.slug, Array.from({ length: 4995 }, (_, index) => entry(index)));
    await appendEntityAudit(root, story.slug, Array.from({ length: 10 }, (_, index) => entry(4995 + index)));
    const entries = await readEntityAudit(root, story.slug, target.id);
    expect(entries).toHaveLength(5000);
    expect(entries[0]!.after).toMatchObject({ notes: "n5004" });
    expect(entries.at(-1)!.after).toMatchObject({ notes: "n5" });
  });
});
