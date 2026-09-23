import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createApiHandler } from "../apps/server/api.js";
import { getCanonicalEntitiesPage, getCanonicalEntityDetail, getStoryBibleHealth, getStoryBibleReview } from "../apps/server/catalog.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";
import { canonicalEntitySchema, emptyStoryBible, type CanonicalEntity } from "../src/domain/story-bible.js";
import { continuityReviewSchema } from "../src/story-bible/continuity.js";
import { entityReadiness, readinessNeedsAttention } from "../src/story-bible/readiness.js";
import { visualProfileSchema } from "../src/domain/visual-profile.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";

const env = loadEnvironment({});
const id = (hex: string) => `ent_${hex.padEnd(24, "0")}`;
const entity = (hex: string, patch: Record<string, unknown> = {}): CanonicalEntity => canonicalEntitySchema.parse({ id: id(hex), type: "character", canonicalName: `Entity ${hex}`, originalName: `原名${hex}`, firstAppearance: 1, lastKnownAppearance: 3, ...patch });

async function storyFixture() {
  const root = await mkdtemp(join(tmpdir(), "story-bible-review-"));
  const story = defaultStory("night-lantern", env);
  const paths = storyPaths(root, story.slug, 1);
  await atomicWriteJson(paths.storyConfig, story);
  await atomicWriteJson(paths.pipelineConfig, story.pipeline);
  return { root, story, paths };
}

async function seedBible(paths: ReturnType<typeof storyPaths>, entities: CanonicalEntity[]) {
  await atomicWriteJson(paths.bible, { ...emptyStoryBible(), canonicalEntities: entities });
}

const finding = (hex: string, entityIds: string[], status: string) => ({
  id: `ctf_${hex.padEnd(24, "0")}`, type: "status_conflict" as const, severity: "critical" as const,
  entityIds, chapters: [1, 2], explanation: "Appears after death without resurrection.",
  supportingFacts: [{ entityId: entityIds[0]!, chapter: 1, summary: "Died.", provenanceKind: "event" }],
  evidenceFingerprint: hex, status,
});

describe("entity readiness model", () => {
  it("marks a fully configured character complete without attention", () => {
    const rows = entityReadiness(entity("a1", { preferredNarrationName: "Sue", localizedNaming: { locale: "en-US", fullName: "Sue", usageMode: "ai_contextual" }, pronunciation: { mode: "custom", customPronunciation: "soo", source: "manual" } }), { visualProfile: { status: "approved", needsReviewConflicts: 0 } });
    expect(readinessNeedsAttention(rows)).toBe(false);
    expect(rows.find((row) => row.key === "pronunciation")?.state).toBe("complete");
    expect(rows.find((row) => row.key === "localization")?.state).toBe("complete");
  });
  it("flags duplicate candidates and continuity findings as attention", () => {
    const rows = entityReadiness(entity("a2"), { duplicateCandidates: 1, duplicateTypeConflict: true, continuityOpenCount: 2 });
    expect(rows.find((row) => row.key === "duplicates")?.state).toBe("attention");
    expect(rows.find((row) => row.key === "type")?.state).toBe("attention");
    expect(rows.find((row) => row.key === "continuity")?.state).toBe("attention");
    expect(readinessNeedsAttention(rows)).toBe(true);
  });
  it("treats skipped visual policy as na and default pronunciation as not-attention", () => {
    const rows = entityReadiness(entity("a3", { visualProfilePolicy: { mode: "skip" } }));
    expect(rows.find((row) => row.key === "visualProfile")?.state).toBe("na");
    expect(rows.find((row) => row.key === "pronunciation")?.state).toBe("na");
    expect(rows.find((row) => row.key === "localization")?.state).toBe("optional");
    expect(readinessNeedsAttention(rows)).toBe(false);
  });
  it("treats an active pronunciation needing review as attention and a pending suggestion as optional", () => {
    const active = entityReadiness(entity("a4", { pronunciation: { mode: "custom", customPronunciation: "soo", source: "manual", needsReview: true } }));
    expect(active.find((row) => row.key === "pronunciation")?.state).toBe("attention");
    const pending = entityReadiness(entity("a5"), { pronunciationSuggestionPending: true });
    expect(pending.find((row) => row.key === "pronunciation")?.state).toBe("optional");
    expect(readinessNeedsAttention(pending)).toBe(false);
  });
});

describe("story bible health endpoint", () => {
  it("aggregates counts from existing artifacts without provider calls", async () => {
    const { root, story, paths } = await storyFixture();
    const duplicateA = entity("b1", { canonicalName: "Su Ming" });
    const duplicateB = entity("b2", { canonicalName: "Ming", aliases: ["Su Ming"], type: "location" });
    const reviewed = entity("b3", { pronunciation: { mode: "custom", customPronunciation: "soo", source: "manual", needsReview: true } });
    await seedBible(paths, [duplicateA, duplicateB, reviewed]);
    await atomicWriteJson(paths.continuityReview, continuityReviewSchema.parse({ version: 1, analyzedThroughChapter: 3, inputFingerprint: "x", updatedAt: new Date(0).toISOString(), findings: [finding("c1", [duplicateA.id], "open"), finding("c2", [duplicateB.id], "dismissed")] }));
    // Stale extraction: chapter 1 completed extraction is marked stale.
    await atomicWriteJson(storyPaths(root, story.slug, 1).bibleUpdate, { ...emptyStoryBible(), chapterSummary: "One" });
    await atomicWriteJson(storyPaths(root, story.slug, 1).chapterMeta, { stages: { storyBible: { status: "complete", staleReason: "Source changed" } }, source: { fingerprint: "old" } });
    const health = await getStoryBibleHealth(root, story.slug);
    expect(health.totals.canonicalEntities).toBe(3);
    expect(health.issues.duplicateCandidates).toBeGreaterThanOrEqual(1);
    expect(health.issues.continuityOpen).toBe(1);
    expect(health.issues.pronunciationNeedsReview).toBe(1);
    expect(health.issues.staleExtractionChapters).toBe(1);
    expect(health.issues.cleanupRecommendations).toBeGreaterThanOrEqual(0);
    expect(health.totals.needsAttention).toBeGreaterThanOrEqual(1);
  });
});

describe("story bible review queue", () => {
  async function seeded() {
    const { root, story, paths } = await storyFixture();
    const a = entity("d1", { canonicalName: "Su Ming" });
    const b = entity("d2", { canonicalName: "Ming", aliases: ["Su Ming"] });
    await seedBible(paths, [a, b]);
    await atomicWriteJson(paths.continuityReview, continuityReviewSchema.parse({ version: 1, analyzedThroughChapter: 3, inputFingerprint: "x", updatedAt: new Date(0).toISOString(), findings: [finding("e1", [a.id], "open"), finding("e2", [b.id], "dismissed")] }));
    return { root, story, paths, a, b };
  }

  it("aggregates duplicates and open continuity without duplicating resolved findings", async () => {
    const { root, story, a, b } = await seeded();
    const review = await getStoryBibleReview(root, story.slug, { page: 1, pageSize: 50 });
    const kinds = review.items.map((item) => item.kind);
    expect(kinds).toContain("duplicate");
    expect(kinds).toContain("continuity");
    expect(review.items.filter((item) => item.kind === "continuity")).toHaveLength(1);
    const duplicate = review.items.find((item) => item.kind === "duplicate")!;
    expect(duplicate.entityIds).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(duplicate.action.href).toBe(`/stories/${story.slug}/bible?entity=${a.id}`);
    const continuity = review.items.find((item) => item.kind === "continuity")!;
    expect(continuity.action.href).toBe(`/stories/${story.slug}/continuity?entity=${a.id}`);
    expect(continuity.severity).toBe("critical");
    expect(review.counts.continuity).toBe(1);
    expect(new Set(review.items.map((item) => item.id)).size).toBe(review.items.length);
  });

  it("filters by kind, status, and entityId, and paginates", async () => {
    const { root, story, a, b } = await seeded();
    const duplicatesOnly = await getStoryBibleReview(root, story.slug, { kind: "duplicate", page: 1, pageSize: 50 });
    expect(duplicatesOnly.items.every((item) => item.kind === "duplicate")).toBe(true);
    const resolved = await getStoryBibleReview(root, story.slug, { kind: "continuity", status: "resolved", page: 1, pageSize: 50 });
    expect(resolved.items.map((item) => item.id)).toEqual([`continuity:ctf_${"e2".padEnd(24, "0")}`]);
    const forB = await getStoryBibleReview(root, story.slug, { entityId: b.id, page: 1, pageSize: 50 });
    expect(forB.items.length).toBeGreaterThanOrEqual(1);
    expect(forB.items.every((item) => item.entityIds?.includes(b.id))).toBe(true);
    const page = await getStoryBibleReview(root, story.slug, { page: 2, pageSize: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.page).toBe(2);
    expect(page.total).toBeGreaterThanOrEqual(2);
  });

  it("groups stale extraction into one item with chapters", async () => {
    const { root, story, paths, a } = await seeded();
    for (const chapter of [1, 2]) {
      await atomicWriteJson(storyPaths(root, story.slug, chapter).bibleUpdate, { ...emptyStoryBible(), chapterSummary: `Ch ${chapter}` });
      await atomicWriteJson(storyPaths(root, story.slug, chapter).chapterMeta, { stages: { storyBible: { status: "complete", staleReason: "Source changed" } } });
    }
    const review = await getStoryBibleReview(root, story.slug, { kind: "stale-extraction", page: 1, pageSize: 50 });
    expect(review.items).toHaveLength(1);
    expect(review.items[0]!.chapters).toEqual([1, 2]);
    expect(review.items[0]!.action.href).toBe(`/stories/${story.slug}/bible?tab=cleanup`);
  });

  it("surfaces visual profile conflicts and pronunciation suggestions", async () => {
    const { root, story, a } = await seeded();
    await atomicWriteJson(storyPaths(root, story.slug, 1).visualProfiles, {
      [a.id]: visualProfileSchema.parse({ id: "vp1", entityId: a.id, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), conflicts: [{ id: "vc1", field: "character.hairColor", canonicalValue: "black", visualValue: "red", detectedAt: new Date(0).toISOString() }] }),
    });
    await atomicWriteJson(join(storyPaths(root, story.slug, 1).story, "pronunciation-enrichment.json"), { [a.id]: { attempt: "x", suggestion: { mode: "automatic", source: "ai", needsReview: true } } });
    const visual = await getStoryBibleReview(root, story.slug, { kind: "visual-profile", page: 1, pageSize: 50 });
    expect(visual.items).toHaveLength(1);
    expect(visual.items[0]!.severity).toBe("warn");
    const pronunciation = await getStoryBibleReview(root, story.slug, { kind: "pronunciation", page: 1, pageSize: 50 });
    expect(pronunciation.items.some((item) => item.id === `pronunciation-suggestion:${a.id}`)).toBe(true);
  });
});

describe("entities endpoint readiness", () => {
  it("exposes readiness rows per entity and filters by readiness", async () => {
    const { root, story, paths } = await storyFixture();
    const clean = entity("f1", { canonicalName: "Clean" });
    const conflicted = entity("f2", { canonicalName: "Conflicted" });
    await seedBible(paths, [clean, conflicted]);
    await atomicWriteJson(paths.continuityReview, continuityReviewSchema.parse({ version: 1, analyzedThroughChapter: 3, inputFingerprint: "x", updatedAt: new Date(0).toISOString(), findings: [finding("01", [conflicted.id], "open")] }));
    const page = await getCanonicalEntitiesPage(root, story.slug, { page: 1, pageSize: 50 });
    const conflictedRow = page.items.find((item) => item.id === conflicted.id)!;
    expect(conflictedRow.readiness.find((row: { key: string }) => row.key === "continuity")?.state).toBe("attention");
    const filtered = await getCanonicalEntitiesPage(root, story.slug, { page: 1, pageSize: 50, readiness: "continuity-issues" });
    expect(filtered.items.map((item) => item.id)).toEqual([conflicted.id]);
    const attention = await getCanonicalEntitiesPage(root, story.slug, { page: 1, pageSize: 50, readiness: "needs-attention" });
    expect(attention.items.map((item) => item.id)).toEqual([conflicted.id]);
  });

  it("includes full readiness in the entity detail", async () => {
    const { root, story, paths } = await storyFixture();
    const target = entity("f9", { visualProfilePolicy: { mode: "skip" } });
    await seedBible(paths, [target]);
    const detail = await getCanonicalEntityDetail(root, story.slug, target.id);
    expect(detail.readiness.find((row: { key: string }) => row.key === "visualProfile")?.state).toBe("na");
  });
});

describe("story bible review API routes", () => {
  it("serves health and review over HTTP and validates query params", async () => {
    const { root, story, paths } = await storyFixture();
    await seedBible(paths, [entity("aa", { canonicalName: "Su Ming" }), entity("ab", { canonicalName: "Ming", aliases: ["Su Ming"] })]);
    const operations = new StudioOperations(root, env);
    const handler = createApiHandler(operations);
    const request = async (path: string) => {
      const req = Object.assign(Readable.from([]), { method: "GET", url: path, headers: { host: "localhost:3000" } });
      const headers: Record<string, unknown> = {}; const chunks: Buffer[] = [];
      const res = Object.assign(new PassThrough(), { writeHead: (status: number, values?: Record<string, unknown>) => { headers.status = status; Object.assign(headers, values); } });
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      const done = new Promise<void>((resolve) => res.on("finish", resolve));
      await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse); await done;
      return { status: headers.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    };
    const health = await request(`/api/stories/${story.slug}/story-bible/health`);
    expect(health.status).toBe(200);
    expect(health.body.totals.canonicalEntities).toBe(2);
    const review = await request(`/api/stories/${story.slug}/story-bible/review?type=duplicate&page=1&pageSize=10`);
    expect(review.status).toBe(200);
    expect(review.body.items.every((item: { kind: string }) => item.kind === "duplicate")).toBe(true);
    const invalid = await request(`/api/stories/${story.slug}/story-bible/review?type=bogus`);
    expect(invalid.status).toBe(400);
    await operations.close();
  });
});
