import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getCanonicalEntitiesPage, getCanonicalEntityDetail, getStoryBibleHealth, getStoryBibleReview, getStoryBibleReviewSummary, invalidateStoryBibleDerivedReads, invalidateStoryBibleReadCache } from "../apps/server/catalog.js";
import { loadEnvironment } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";
import { canonicalEntitySchema, emptyStoryBible, type CanonicalEntity } from "../src/domain/story-bible.js";
import { normalizeEntitySearch } from "../src/story-bible/search.js";
import { cachedStoryRead, invalidateStoryReadCache, resetStoryReadCaches, storyReadCacheStats } from "../src/story-bible/read-cache.js";
import { bumpStoryBibleReadRevision, getStoryBibleReadRevision } from "../src/story-bible/read-revision.js";
import { computeStaleExtractionChapters } from "../src/story-bible/rebuild.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";

const env = loadEnvironment({});
const id = (hex: string) => `ent_${hex.padEnd(24, "0")}`;
const entity = (hex: string, patch: Record<string, unknown> = {}): CanonicalEntity => canonicalEntitySchema.parse({ id: id(hex), type: "character", canonicalName: `Entity ${hex}`, originalName: `原名${hex}`, firstAppearance: 1, lastKnownAppearance: 3, ...patch });

async function storyFixture() {
  const root = await mkdtemp(join(tmpdir(), "story-bible-read-cache-"));
  const story = defaultStory("read-cache", env);
  const paths = storyPaths(root, story.slug, 1);
  await atomicWriteJson(paths.storyConfig, story);
  await atomicWriteJson(paths.pipelineConfig, story.pipeline);
  resetStoryReadCaches();
  return { root, story, paths };
}

async function seedBible(paths: ReturnType<typeof storyPaths>, entities: CanonicalEntity[]) {
  await atomicWriteJson(paths.bible, { ...emptyStoryBible(), canonicalEntities: entities });
}

const reviewContextBuilds = (root: string, slug: string) => storyReadCacheStats().builds[`story-bible-review-context\0${root}\0${slug}`] ?? 0;
const staleExtractionBuilds = (root: string, slug: string) => storyReadCacheStats().builds[`story-bible-stale-extraction\0${root}\0${slug}`] ?? 0;
const healthBuilds = (root: string, slug: string) => storyReadCacheStats().builds[`story-bible-health\0${root}\0${slug}`] ?? 0;
const reviewDerivedBuilds = (root: string, slug: string) => storyReadCacheStats().builds[`story-bible-review-derived\0${root}\0${slug}`] ?? 0;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((res) => { resolve = res; }); return { promise, resolve } as Deferred<T>; };

describe("read cache generations", () => {
  it("shares one build across concurrent readers with the same fingerprint+generation", async () => {
    resetStoryReadCaches();
    let builds = 0;
    const [a, b] = await Promise.all([
      cachedStoryRead("gen", "/root", "s", async () => "fp", async () => `v${++builds}`),
      cachedStoryRead("gen", "/root", "s", async () => "fp", async () => `v${++builds}`),
    ]);
    expect(builds).toBe(1);
    expect(a.value).toBe(b.value);
    expect((await cachedStoryRead("gen", "/root", "s", async () => "fp", async () => `v${++builds}`)).cacheHit).toBe(true);
    expect(builds).toBe(1);
  });

  it("does not repopulate the cache from a build that was invalidated in flight", async () => {
    resetStoryReadCaches();
    let builds = 0;
    const first = deferred<string>();
    const started = deferred<void>();
    const p1 = cachedStoryRead("gen", "/root", "s", async () => "fp", () => { builds++; started.resolve(); return first.promise; });
    await started.promise;
    invalidateStoryReadCache("/root", "s");
    first.resolve("stale");
    expect((await p1).value).toBe("stale"); // the original caller still gets its value
    const second = await cachedStoryRead("gen", "/root", "s", async () => "fp", async () => `fresh${++builds}`);
    expect(second.value).toBe("fresh2");
    expect(second.cacheHit).toBe(false);
    expect(builds).toBe(2);
  });

  it("starts a new build instead of joining an in-flight build with an old fingerprint", async () => {
    resetStoryReadCaches();
    let stamp = "one";
    let builds = 0;
    const first = deferred<string>();
    const started = deferred<void>();
    const p1 = cachedStoryRead("gen", "/root", "s", async () => stamp, () => { builds++; started.resolve(); return first.promise; });
    await started.promise;
    stamp = "two";
    const p2 = await cachedStoryRead("gen", "/root", "s", async () => stamp, async () => `build${++builds}`);
    expect(p2.value).toBe("build2");
    expect(p2.cacheHit).toBe(false);
    first.resolve("old");
    expect((await p1).value).toBe("old");
    // The newer build won the cache slot: a same-fingerprint read hits it.
    expect((await cachedStoryRead("gen", "/root", "s", async () => "two", async () => `build${++builds}`)).value).toBe("build2");
    expect(builds).toBe(2);
  });

  it("keeps a newer in-flight build when an obsolete build finishes last", async () => {
    resetStoryReadCaches();
    let stamp = "one";
    let builds = 0;
    const first = deferred<string>();
    const startedA = deferred<void>();
    const p1 = cachedStoryRead("gen", "/root", "s", async () => stamp, () => { builds++; startedA.resolve(); return first.promise; });
    await startedA.promise;
    invalidateStoryReadCache("/root", "s");
    const second = deferred<string>();
    const startedB = deferred<void>();
    const p2 = cachedStoryRead("gen", "/root", "s", async () => stamp, () => { builds++; startedB.resolve(); return second.promise; });
    await startedB.promise;
    // A finishes after B started: A's cleanup must not remove B's in-flight entry.
    first.resolve("stale");
    await p1;
    const p3 = cachedStoryRead("gen", "/root", "s", async () => stamp, async () => `build${++builds}`);
    second.resolve("current");
    expect((await p3).value).toBe("current"); // p3 joined B, no third build
    expect((await p2).value).toBe("current");
    expect(builds).toBe(2);
  });
});

describe("story bible read revision", () => {
  it("defaults to 0, advances on bump, and a changed revision forces one rebuild", async () => {
    const { root, story, paths } = await storyFixture();
    await seedBible(paths, [entity("f1")]);
    expect(await getStoryBibleReadRevision(root, story.slug)).toBe(0);
    await getStoryBibleHealth(root, story.slug);
    expect(healthBuilds(root, story.slug)).toBe(1);
    await getStoryBibleHealth(root, story.slug); // unchanged revision: warm hit
    expect(healthBuilds(root, story.slug)).toBe(1);
    expect(await bumpStoryBibleReadRevision(root, story.slug)).toBe(1);
    expect(await getStoryBibleReadRevision(root, story.slug)).toBe(1);
    await getStoryBibleHealth(root, story.slug);
    expect(healthBuilds(root, story.slug)).toBe(2);
    await getStoryBibleHealth(root, story.slug);
    expect(healthBuilds(root, story.slug)).toBe(2);
  });

  it("invalidateStoryBibleDerivedReads bumps the revision and drops memory caches", async () => {
    const { root, story, paths } = await storyFixture();
    await seedBible(paths, [entity("f2")]);
    await getStoryBibleHealth(root, story.slug);
    expect(healthBuilds(root, story.slug)).toBe(1);
    await invalidateStoryBibleDerivedReads(root, story.slug);
    expect(await getStoryBibleReadRevision(root, story.slug)).toBe(1);
    await getStoryBibleHealth(root, story.slug);
    expect(healthBuilds(root, story.slug)).toBe(2);
  });
});

describe("normalizeEntitySearch", () => {
  it("normalizes case, punctuation runs, and spacing", () => {
    expect(normalizeEntitySearch("Qain Yi")).toBe("qain yi");
    expect(normalizeEntitySearch("qain yi")).toBe("qain yi");
    expect(normalizeEntitySearch("QAIN-YI")).toBe("qain yi");
    expect(normalizeEntitySearch("Qain-Yi")).toBe("qain yi");
    expect(normalizeEntitySearch("  Qain —  Yi  ")).toBe("qain yi");
    expect(normalizeEntitySearch("Café")).toBe("cafe");
    expect(normalizeEntitySearch("Sect #7")).toBe("sect 7");
  });
});

describe("canonical entity search", () => {
  it("matches Qain Yi query variants with AND token semantics", async () => {
    const { root, story, paths } = await storyFixture();
    await seedBible(paths, [entity("a1", { canonicalName: "Qain Yi" }), entity("a2", { canonicalName: "Qain Zhao" })]);
    const names = async (query: string) => (await getCanonicalEntitiesPage(root, story.slug, { page: 1, pageSize: 50, query })).items.map((item) => item.canonicalName);
    for (const query of ["Qain Yi", "qain yi", "QAIN-YI", "Qain-Yi", "qain   yi", "yi"]) {
      expect(await names(query), query).toEqual(["Qain Yi"]);
    }
    expect(await names("QAIN")).toEqual(["Qain Yi", "Qain Zhao"]);
    // Every query token must appear: "qain yi" must not match "Qain Zhao".
    expect(await names("qain zhao")).toEqual(["Qain Zhao"]);
    expect(await names("qain yi zhao")).toEqual([]);
  });
});

describe("review context cache", () => {
  it("shares one build across concurrent readers and reuses it afterwards", async () => {
    const { root, story, paths } = await storyFixture();
    const a = entity("b1", { canonicalName: "Su Ming" });
    await seedBible(paths, [a]);
    await Promise.all([
      getCanonicalEntitiesPage(root, story.slug, { page: 1, pageSize: 50 }),
      getStoryBibleHealth(root, story.slug),
      getCanonicalEntityDetail(root, story.slug, a.id),
    ]);
    expect(reviewContextBuilds(root, story.slug)).toBe(1);
    await getCanonicalEntitiesPage(root, story.slug, { page: 1, pageSize: 50 });
    await getCanonicalEntityDetail(root, story.slug, a.id);
    expect(reviewContextBuilds(root, story.slug)).toBe(1);
  });

  it("rebuilds after explicit invalidation and after bible content changes", async () => {
    const { root, story, paths } = await storyFixture();
    await seedBible(paths, [entity("c1")]);
    await getCanonicalEntitiesPage(root, story.slug, { page: 1, pageSize: 50 });
    expect(reviewContextBuilds(root, story.slug)).toBe(1);
    invalidateStoryBibleReadCache(root, story.slug);
    await getCanonicalEntitiesPage(root, story.slug, { page: 1, pageSize: 50 });
    expect(reviewContextBuilds(root, story.slug)).toBe(2);
    // Fingerprint validation: a mutation without explicit invalidation still rebuilds.
    await seedBible(paths, [entity("c1"), entity("c2")]);
    const page = await getCanonicalEntitiesPage(root, story.slug, { page: 1, pageSize: 50 });
    expect(reviewContextBuilds(root, story.slug)).toBe(3);
    expect(page.total).toBe(2);
  });
});

describe("health cache", () => {
  async function seedStaleChapter(root: string, slug: string) {
    await atomicWriteJson(storyPaths(root, slug, 1).bibleUpdate, { ...emptyStoryBible(), chapterSummary: "One" });
    await atomicWriteJson(storyPaths(root, slug, 1).chapterMeta, { stages: { storyBible: { status: "complete", staleReason: "Source changed" } } });
  }

  it("reuses the health summary and stale walk until invalidated", async () => {
    const { root, story, paths } = await storyFixture();
    await seedBible(paths, [entity("d1")]);
    await seedStaleChapter(root, story.slug);
    const first = await getStoryBibleHealth(root, story.slug);
    expect(first.issues.staleExtractionChapters).toBe(1);
    expect(staleExtractionBuilds(root, story.slug)).toBe(1);
    expect(healthBuilds(root, story.slug)).toBe(1);
    const second = await getStoryBibleHealth(root, story.slug);
    expect(second).toEqual(first);
    expect(staleExtractionBuilds(root, story.slug)).toBe(1);
    expect(healthBuilds(root, story.slug)).toBe(1);
    invalidateStoryBibleReadCache(root, story.slug);
    await getStoryBibleHealth(root, story.slug);
    expect(healthBuilds(root, story.slug)).toBe(2);
  });

  it("does not re-walk chapter files on a warm read; a revision bump forces one rescan", async () => {
    const { root, story, paths } = await storyFixture();
    await seedBible(paths, [entity("e1")]);
    await seedStaleChapter(root, story.slug);
    const first = await getStoryBibleHealth(root, story.slug);
    expect(first.issues.staleExtractionChapters).toBe(1);
    expect(staleExtractionBuilds(root, story.slug)).toBe(1);
    // Direct artifact writes without an app mutation: the warm health request
    // is O(1) and does not walk chapter files, so nothing rebuilds.
    await atomicWriteJson(storyPaths(root, story.slug, 2).bibleUpdate, { ...emptyStoryBible(), chapterSummary: "Two" });
    await atomicWriteJson(storyPaths(root, story.slug, 2).chapterMeta, { stages: { storyBible: { status: "complete", staleReason: "Source changed" } } });
    const warm = await getStoryBibleHealth(root, story.slug);
    expect(staleExtractionBuilds(root, story.slug)).toBe(1);
    expect(healthBuilds(root, story.slug)).toBe(1);
    expect(warm).toEqual(first);
    // The mutation boundary bumps the revision: exactly one rescan, new result.
    await invalidateStoryBibleDerivedReads(root, story.slug);
    const health = await getStoryBibleHealth(root, story.slug);
    expect(staleExtractionBuilds(root, story.slug)).toBe(2);
    expect(health.issues.staleExtractionChapters).toBe(2);
    await getStoryBibleHealth(root, story.slug);
    expect(staleExtractionBuilds(root, story.slug)).toBe(2);
  });
});

describe("review summary and shared derivation", () => {
  async function seedContinuityFindings(root: string, slug: string, entityId: string) {
    const finding = (hex: string, status: string) => ({
      id: `ctf_${hex.padEnd(24, "0")}`, type: "status_conflict", severity: "warning", entityIds: [entityId], chapters: [1],
      explanation: `Finding ${hex}`, supportingFacts: [{ entityId, chapter: 1, summary: "fact", provenanceKind: "extraction" }],
      evidenceFingerprint: hex.repeat(4), status,
    });
    await atomicWriteJson(storyPaths(root, slug, 1).continuityReview, {
      version: 1, analyzedThroughChapter: 1, inputFingerprint: "seed", updatedAt: new Date(0).toISOString(),
      findings: [finding("aa", "open"), finding("bb", "dismissed")],
    });
  }

  it("returns openTotal/counts that agree with the paginated review, built once per revision", async () => {
    const { root, story, paths } = await storyFixture();
    const subject = entity("a1");
    await seedBible(paths, [subject]);
    await seedContinuityFindings(root, story.slug, subject.id);
    const summary = await getStoryBibleReviewSummary(root, story.slug);
    expect(reviewDerivedBuilds(root, story.slug)).toBe(1);
    expect(summary.counts.continuity).toBe(1); // the dismissed finding is not open
    const review = await getStoryBibleReview(root, story.slug, { page: 1, pageSize: 1, status: "open" });
    expect(review.openTotal).toBe(summary.openTotal);
    expect(review.counts).toEqual(summary.counts);
    const all = await getStoryBibleReview(root, story.slug, { page: 1, pageSize: 100, status: "all" });
    expect(all.total).toBeGreaterThan(summary.openTotal); // resolved findings appear under status=all
    // Summary, list, and health share the same derived build for one revision.
    await getStoryBibleHealth(root, story.slug);
    expect(reviewDerivedBuilds(root, story.slug)).toBe(1);
    // A mutation forces exactly one derived rebuild.
    await invalidateStoryBibleDerivedReads(root, story.slug);
    await getStoryBibleReviewSummary(root, story.slug);
    expect(reviewDerivedBuilds(root, story.slug)).toBe(2);
  });
});

describe("computeStaleExtractionChapters", () => {
  it("preserves stale semantics with bounded concurrency", async () => {
    const { root, story } = await storyFixture();
    const write = async (chapter: number, meta: unknown, withUpdate = true) => {
      if (withUpdate) await atomicWriteJson(storyPaths(root, story.slug, chapter).bibleUpdate, { ...emptyStoryBible(), chapterSummary: `Ch ${chapter}` });
      await atomicWriteJson(storyPaths(root, story.slug, chapter).chapterMeta, meta);
    };
    await write(1, { stages: { storyBible: { status: "complete", staleReason: "Source changed" } } }); // stale: explicit reason
    await write(2, { stages: { storyBible: { status: "complete" } } }); // current: no manifest to drift from
    await write(3, { stages: { storyBible: { status: "pending" } } }); // stale: not complete
    await write(4, { stages: { storyBible: { status: "failed" } } }); // skipped: failed without output
    await write(5, { stages: { storyBible: { status: "complete" } } }, false); // skipped: no update artifact
    const stale = await computeStaleExtractionChapters(root, story.slug);
    expect(stale).toEqual([1, 3]);
  });

  it("flags chapters whose source fingerprint drifted from the manifest", async () => {
    const { root, story, paths } = await storyFixture();
    const hash = (char: string) => char.repeat(64);
    await atomicWriteJson(paths.sourceManifest, {
      version: 1, adapterVersion: "1.0.0", type: "text", origin: { path: "/dummy/novel.txt", name: "novel.txt" }, importedAt: new Date(0).toISOString(),
      fingerprint: hash("a"), warnings: [], unnumberedSections: [],
      chapters: [{ chapter: 1, file: "chapters/0001.txt", fingerprint: hash("b"), contentFingerprint: hash("c"), ref: { chapter: 1, sourceId: "sec_1", sourceType: "text", metadata: {} } }],
    });
    await atomicWriteJson(storyPaths(root, story.slug, 1).bibleUpdate, { ...emptyStoryBible(), chapterSummary: "One" });
    await atomicWriteJson(storyPaths(root, story.slug, 1).chapterMeta, { stages: { storyBible: { status: "complete" } }, source: { fingerprint: hash("d") } });
    expect(await computeStaleExtractionChapters(root, story.slug)).toEqual([1]);
  });
});
