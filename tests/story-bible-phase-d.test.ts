import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createApiHandler } from "../apps/server/api.js";
import { getCanonicalEntityDetail, getCanonicalEntityHistory } from "../apps/server/catalog.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";
import { storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { canonicalOverlaySchema } from "../src/story-bible/canonical.js";
import { rebuildStoryBibleBeforeChapter } from "../src/story-bible/rebuild.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";

const env = loadEnvironment({});

const UPDATES = [
  storyBibleUpdateSchema.parse({
    characters: [{ canonicalEnglishName: "Lin Yao", originalName: "林遥", description: "Carries a lamp", firstSeenChapter: 1, lastSeenChapter: 1 }],
    chapterSummary: "Chapter one",
  }),
  storyBibleUpdateSchema.parse({
    characters: [
      { canonicalEnglishName: "Su Ming", originalName: "苏明", description: "Young wanderer", firstSeenChapter: 2, lastSeenChapter: 2 },
      { canonicalEnglishName: "Ming", originalName: "明", description: "Alias duplicate", firstSeenChapter: 2, lastSeenChapter: 2 },
    ],
    timelineEvents: [{ entity: "Su Ming", type: "appearance", summary: "Enters the city", chapter: 2 }],
    relationships: [{ subject: "Su Ming", object: "Lin Yao", relationship: "ally", firstSeenChapter: 2, lastSeenChapter: 2 }],
    chapterSummary: "Chapter two",
  }),
  storyBibleUpdateSchema.parse({
    characters: [{ canonicalEnglishName: "Su Ming", originalName: "苏明", description: "Becomes a cultivator", firstSeenChapter: 3, lastSeenChapter: 3 }],
    timelineEvents: [{ entity: "Su Ming", type: "rank_change", summary: "Breakthrough", chapter: 3 }],
    relationships: [{ subject: "Su Ming", object: "Lin Yao", relationship: "rival", firstSeenChapter: 3, lastSeenChapter: 3, endChapter: 3, state: "historical" }],
    chapterSummary: "Chapter three",
  }),
];

async function historyFixture(options: { override?: Record<string, unknown>; merge?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "story-bible-phase-d-"));
  const story = defaultStory("night-lantern", env);
  const paths = storyPaths(root, story.slug, 1);
  await atomicWriteJson(paths.storyConfig, story);
  await atomicWriteJson(paths.pipelineConfig, story.pipeline);
  for (const [index, update] of UPDATES.entries()) {
    const chapterPaths = storyPaths(root, story.slug, index + 1);
    await mkdir(dirname(chapterPaths.bibleUpdate), { recursive: true });
    await writeFile(chapterPaths.bibleUpdate, JSON.stringify(update));
    await writeFile(chapterPaths.chapterMeta, JSON.stringify({ stages: { storyBible: { status: "complete" } } }));
  }
  const rebuilt = await rebuildStoryBibleBeforeChapter(root, story.slug, Number.MAX_SAFE_INTEGER, { includeCanonicalOverlay: false });
  const suMing = rebuilt.canonicalEntities.find((item) => item.canonicalName === "Su Ming")!;
  const ming = rebuilt.canonicalEntities.find((item) => item.canonicalName === "Ming")!;
  if (options.override) {
    await atomicWriteJson(paths.bibleCanonicalManual, canonicalOverlaySchema.parse({ version: 1, overrides: { [suMing.id]: { ...options.override, updatedAt: new Date().toISOString() } } }));
  }
  if (options.merge) {
    await atomicWriteJson(paths.bibleCanonicalManual, canonicalOverlaySchema.parse({
      version: 1,
      merges: [{ id: randomUUID(), targetEntityId: suMing.id, sourceEntityIds: [ming.id], reason: "Same identity", createdAt: new Date().toISOString() }],
    }));
  }
  return { root, story, paths, suMing, ming };
}

const OVERRIDE = { canonicalName: "Su Ming the Elder", preferredNarrationName: "Elder Ming", canonicalNameLocked: true, notes: "Protected identity" };

describe("entity as-of-chapter history (Phase D)", () => {
  it("reports exists:false before the first appearance with the earliest known chapter", async () => {
    const { root, story, suMing } = await historyFixture();
    const view = await getCanonicalEntityHistory(root, story.slug, suMing.id, 1);
    expect(view.exists).toBe(false);
    expect(view.entity).toBeUndefined();
    expect(view.timeline).toEqual([]);
    expect(view.relationships).toEqual([]);
    expect(view.provenance).toEqual([]);
    expect(view.firstAppearanceKnown).toBe(true);
    expect(view.earliestKnownChapter).toBe(2);
  });

  it("reconstructs the extracted state at the first appearance, with overlay fields surfaced as currentOverrides only", async () => {
    const { root, story, suMing } = await historyFixture({ override: OVERRIDE });
    const view = await getCanonicalEntityHistory(root, story.slug, suMing.id, 2);
    expect(view.exists).toBe(true);
    // Historical identity is the extracted record, not the manual override.
    expect(view.entity!.canonicalName).toBe("Su Ming");
    expect(view.entity!.description).toBe("Young wanderer");
    expect(view.entity!.canonicalNameLocked).toBe(false);
    expect(view.entity!.preferredNarrationName).toBeUndefined();
    expect(view.entity!.notes).toBe("");
    // Manual overlay fields are labeled as current editorial state, not history.
    expect(view.currentOverrides).toEqual(expect.arrayContaining(["canonicalName", "preferredNarrationName", "canonicalNameLocked", "notes"]));
    expect(view.overrideUpdatedAt).toBeDefined();
    // Timeline and relationships are filtered to chapter ≤ 2 (the updater also
    // records an appearance event per chapter, so assert filtering + content).
    expect(view.timeline.length).toBeGreaterThan(0);
    expect(view.timeline.every((item) => item.chapter <= 2)).toBe(true);
    expect(view.timeline.map((item) => item.summary)).toContain("Enters the city");
    expect(view.relationships.map((item) => item.type)).toEqual(["ally"]);
    expect(Object.values(view.relatedNames)).toContain("Lin Yao");
    // Provenance carries no future chapters.
    expect(view.provenance.length).toBeGreaterThan(0);
    expect(view.provenance.every((item) => item.chapter <= 2)).toBe(true);
    expect(view.entity!.provenance).toEqual(view.provenance);
  });

  it("includes later timeline events and ended relationships at a later chapter", async () => {
    const { root, story, suMing } = await historyFixture();
    const view = await getCanonicalEntityHistory(root, story.slug, suMing.id, 3);
    expect(view.timeline.every((item) => item.chapter <= 3)).toBe(true);
    expect(view.timeline.map((item) => item.summary)).toEqual(expect.arrayContaining(["Enters the city", "Breakthrough"]));
    expect(view.relationships.map((item) => item.type).sort()).toEqual(["ally", "rival"]);
    expect(view.entity!.description).toContain("Becomes a cultivator");
  });

  it("clamps chapters beyond the imported range and reports the requested value", async () => {
    const { root, story, suMing } = await historyFixture();
    const view = await getCanonicalEntityHistory(root, story.slug, suMing.id, 99);
    expect(view.chapter).toBe(3);
    expect(view.requestedChapter).toBe(99);
    expect(view.exists).toBe(true);
  });

  it("rejects invalid chapters and unknown entities", async () => {
    const { root, story, suMing } = await historyFixture();
    await expect(getCanonicalEntityHistory(root, story.slug, suMing.id, 0)).rejects.toThrow(/positive integer/);
    await expect(getCanonicalEntityHistory(root, story.slug, suMing.id, 1.5)).rejects.toThrow(/positive integer/);
    await expect(getCanonicalEntityHistory(root, story.slug, "ent_ffffffffffffffffffffffff", 1)).rejects.toThrow(/not found/);
  });

  it("warns that manual merges have no chapter semantics instead of guessing", async () => {
    const { root, story, suMing } = await historyFixture({ merge: true });
    const view = await getCanonicalEntityHistory(root, story.slug, suMing.id, 3);
    expect(view.exists).toBe(true);
    expect(view.warnings.some((warning) => warning.includes("Manual merges"))).toBe(true);
    // The historical view keeps the pre-merge extracted records (Ming stays separate).
    expect(view.entity!.mergedFromIds).toEqual([]);
  });

  it("is read-only: artifacts and overlays are byte-identical after history reads", async () => {
    const { root, story, paths, suMing } = await historyFixture({ override: OVERRIDE });
    const before = await readFile(paths.bibleCanonicalManual, "utf8");
    const updateBefore = await readFile(storyPaths(root, story.slug, 2).bibleUpdate, "utf8");
    await getCanonicalEntityHistory(root, story.slug, suMing.id, 2);
    await getCanonicalEntityHistory(root, story.slug, suMing.id, 1);
    expect(await readFile(paths.bibleCanonicalManual, "utf8")).toBe(before);
    expect(await readFile(storyPaths(root, story.slug, 2).bibleUpdate, "utf8")).toBe(updateBefore);
  });

  it("exposes manualFields on the current entity detail for MANUAL badges", async () => {
    const { root, story, suMing } = await historyFixture({ override: OVERRIDE });
    const detail = await getCanonicalEntityDetail(root, story.slug, suMing.id);
    expect(detail.manualFields).toEqual(expect.arrayContaining(["canonicalName", "preferredNarrationName", "canonicalNameLocked", "notes"]));
    expect(detail.entity.canonicalName).toBe("Su Ming the Elder");
  });

  it("serves the history over HTTP and rejects missing/invalid chapter params with 400", async () => {
    const { root, story, suMing } = await historyFixture({ override: OVERRIDE });
    const operations = new StudioOperations(root, env);
    const handler = createApiHandler(operations);
    const request = async (path: string, method = "GET") => {
      const req = Object.assign(Readable.from([]), { method, url: path, headers: { host: "localhost:3000", ...(method === "GET" ? {} : { "content-type": "application/json" }) } });
      const headers: Record<string, unknown> = {}; const chunks: Buffer[] = [];
      const res = Object.assign(new PassThrough(), { writeHead: (status: number, values?: Record<string, unknown>) => { headers.status = status; Object.assign(headers, values); } });
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      const done = new Promise<void>((resolve) => res.on("finish", resolve));
      await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse); await done;
      return { status: headers.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    };
    const ok = await request(`/api/stories/${story.slug}/story-bible/entities/${suMing.id}/history?chapter=2`);
    expect(ok.status).toBe(200);
    expect(ok.body.exists).toBe(true);
    expect(ok.body.currentOverrides).toContain("canonicalName");
    const missing = await request(`/api/stories/${story.slug}/story-bible/entities/${suMing.id}/history`);
    expect(missing.status).toBe(400);
    const bogus = await request(`/api/stories/${story.slug}/story-bible/entities/${suMing.id}/history?chapter=abc`);
    expect(bogus.status).toBe(400);
    // Read-only: no mutation verb is routed for the history path.
    const post = await request(`/api/stories/${story.slug}/story-bible/entities/${suMing.id}/history`, "POST");
    expect(post.status).toBe(404);
    await operations.close();
  });
});
