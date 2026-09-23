import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createApiHandler } from "../apps/server/api.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { canonicalEntitySchema, emptyStoryBible, type CanonicalEntity } from "../src/domain/story-bible.js";
import { continuityReviewSchema } from "../src/story-bible/continuity.js";
import { visualProfileSchema } from "../src/domain/visual-profile.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { readJsonIfExists } from "../src/storage/story-files.js";

const env = loadEnvironment({});
const id = (hex: string) => `ent_${hex.padEnd(24, "0")}`;
const entity = (hex: string, patch: Record<string, unknown> = {}): CanonicalEntity => canonicalEntitySchema.parse({ id: id(hex), type: "character", canonicalName: `Entity ${hex}`, originalName: `原名${hex}`, firstAppearance: 1, lastKnownAppearance: 3, ...patch });

async function impactFixture() {
  const root = await mkdtemp(join(tmpdir(), "story-bible-impact-"));
  const story = defaultStory("impact-story", env);
  const paths = storyPaths(root, story.slug, 1);
  await atomicWriteJson(paths.storyConfig, story);
  await atomicWriteJson(paths.pipelineConfig, story.pipeline);
  const su = entity("a1", { canonicalName: "Su Ming", provenance: [{ chapter: 1, kind: "extraction" }, { chapter: 2, kind: "extraction" }] });
  const ming = entity("b2", { canonicalName: "Ming", provenance: [{ chapter: 2, kind: "extraction" }] });
  await atomicWriteJson(paths.bible, { ...emptyStoryBible(), canonicalEntities: [su, ming] });
  for (const [number, provider, text] of [[1, "openai", "Su Ming entered."], [2, "manual", "Ming spoke softly."], [3, "openai", "Nobody came."]] as const) {
    const chapterPaths = storyPaths(root, story.slug, number);
    await mkdir(chapterPaths.chapterDir, { recursive: true });
    await writeFile(chapterPaths.original, text);
    await writeFile(chapterPaths.english, text);
    await writeFile(chapterPaths.narration, text);
    await atomicWriteJson(chapterPaths.chapterMeta, chapterSchema.parse({ chapter: number, sourceLanguage: "zh-CN", outputLanguage: "en-US", counts: { originalCharacters: 10, englishWords: 3, narrationWords: 3 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stages: { ingestion: { status: "complete" }, translation: { status: "complete" }, narration: { status: "complete", provider }, qa: { status: "complete" }, storyBible: { status: "complete" }, tts: { status: "complete" }, audioMastering: { status: "complete" }, alignment: { status: "complete" }, subtitles: { status: "complete" }, scenePlanning: { status: "complete" }, artwork: { status: "complete" }, video: { status: "complete" } } }));
  }
  return { root, story, paths, su, ming };
}

const chapterMeta = async (root: string, slug: string, chapter: number) => chapterSchema.parse(JSON.parse(await readFile(storyPaths(root, slug, chapter).chapterMeta, "utf8")));

describe("entity impact preview (dry-run)", () => {
  it("reports affected chapters, stage counts, and manual chapters for a naming change without writing", async () => {
    const { root, story, su } = await impactFixture();
    const operations = new StudioOperations(root, env);
    const impact = await operations.inspectCanonicalEntityImpact(story.slug, su.id, { action: "update", patch: { preferredNarrationName: "Big Ming" } });
    expect(impact.affectedChapters).toEqual([1, 2]);
    expect(impact.narrationAffected).toBe(1);
    expect(impact.manualNarrationChapters).toEqual([2]);
    expect(impact.ttsAffected).toBe(2);
    expect(impact.audioAffected).toBe(2);
    expect(impact.scenePlanningAffected).toBe(2);
    expect(impact.artworkAffected).toBe(2);
    expect(impact.videoAffected).toBe(2);
    expect(impact.warnings.some((warning) => warning.includes("manual narration"))).toBe(true);
    // Dry-run: chapter metadata is untouched.
    expect((await chapterMeta(root, story.slug, 1)).stages.narration.status).toBe("complete");
    expect((await chapterMeta(root, story.slug, 2)).stages.tts.status).toBe("complete");
    await operations.close();
  });

  it("reports zero production impact for a notes-only patch", async () => {
    const { root, story, su } = await impactFixture();
    const operations = new StudioOperations(root, env);
    const impact = await operations.inspectCanonicalEntityImpact(story.slug, su.id, { action: "update", patch: { notes: "A quiet note" } });
    expect(impact).toMatchObject({ affectedChapters: [], narrationAffected: 0, qaAffected: 0, ttsAffected: 0, audioAffected: 0, scenePlanningAffected: 0, artworkAffected: 0, videoAffected: 0, manualNarrationChapters: [], visualProfileAffected: false });
    await operations.close();
  });

  it("reports visual profile review and identity staleness for a type change", async () => {
    const { root, story, paths, su } = await impactFixture();
    await atomicWriteJson(paths.visualProfiles, { [su.id]: visualProfileSchema.parse({ id: "vp1", entityId: su.id, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }) });
    const operations = new StudioOperations(root, env);
    const impact = await operations.inspectCanonicalEntityImpact(story.slug, su.id, { action: "update", patch: { type: "location" } });
    expect(impact.visualProfileAffected).toBe(true);
    expect(impact.affectedChapters).toEqual([1, 2]);
    // Without narration naming configured, the type change flags scene/artwork/video but not QA.
    expect(impact.scenePlanningAffected).toBe(2);
    expect(impact.artworkAffected).toBe(2);
    expect(impact.videoAffected).toBe(2);
    expect(impact.qaAffected).toBe(0);
    expect(impact.narrationAffected).toBe(0);
    expect(impact.warnings.some((warning) => warning.includes("Visual Profile"))).toBe(true);
    await operations.close();
  });

  it("matches the real invalidation when the naming change is applied", async () => {
    const { root, story, su } = await impactFixture();
    const operations = new StudioOperations(root, env);
    const preview = await operations.inspectCanonicalEntityImpact(story.slug, su.id, { action: "update", patch: { preferredNarrationName: "Big Ming" } });
    const applied = await operations.updateCanonicalEntity(story.slug, su.id, { preferredNarrationName: "Big Ming" });
    expect([...applied.invalidation.affectedChapters].sort((a, b) => a - b)).toEqual(preview.affectedChapters);
    expect(applied.invalidation.manualNarrationChapters).toEqual(preview.manualNarrationChapters);
    expect((await chapterMeta(root, story.slug, 1)).stages.narration.status).toBe("pending");
    expect((await chapterMeta(root, story.slug, 2)).stages.narration).toMatchObject({ status: "complete", provider: "manual", manualReviewRequired: true });
    await operations.close();
  });

  it("unions source and target references for a merge and warns on naming conflicts", async () => {
    const { root, story, su, ming } = await impactFixture();
    const operations = new StudioOperations(root, env);
    const impact = await operations.inspectCanonicalEntityImpact(story.slug, su.id, { action: "merge", targetEntityId: ming.id });
    expect(impact.affectedChapters).toEqual([1, 2]);
    expect(impact.qaAffected).toBe(2);
    expect(impact.scenePlanningAffected).toBe(2);
    expect(impact.warnings.some((warning) => warning.includes("Naming conflict"))).toBe(false);
    // Conflicting preferred narration names surface the merge-blocking warning.
    const conflicted = await operations.inspectCanonicalEntityImpact(story.slug, su.id, { action: "update", patch: { preferredNarrationName: "Big Mike" } });
    expect(conflicted.affectedChapters).toEqual([1, 2]);
    await operations.updateCanonicalEntity(story.slug, su.id, { preferredNarrationName: "Big Mike" });
    await operations.updateCanonicalEntity(story.slug, ming.id, { preferredNarrationName: "Minnie" });
    const merge = await operations.inspectCanonicalEntityImpact(story.slug, su.id, { action: "merge", targetEntityId: ming.id });
    expect(merge.warnings.some((warning) => warning.includes("Naming conflict"))).toBe(true);
    await expect(operations.inspectCanonicalEntityImpact(story.slug, su.id, { action: "merge", targetEntityId: id("ff") })).rejects.toThrow("Target canonical entity was not found");
    await operations.close();
  });

  it("reports references and open continuity findings for suppression", async () => {
    const { root, story, paths, su } = await impactFixture();
    await atomicWriteJson(paths.continuityReview, continuityReviewSchema.parse({ version: 1, analyzedThroughChapter: 3, inputFingerprint: "x", updatedAt: new Date(0).toISOString(), findings: [{ id: `ctf_${"c1".padEnd(24, "0")}`, type: "status_conflict", severity: "critical", entityIds: [su.id], chapters: [1, 2], explanation: "Appears after death.", supportingFacts: [{ entityId: su.id, chapter: 1, summary: "Died.", provenanceKind: "event" }], evidenceFingerprint: "c1", status: "open" }] }));
    const operations = new StudioOperations(root, env);
    const impact = await operations.inspectCanonicalEntityImpact(story.slug, su.id, { action: "suppress" });
    expect(impact.affectedChapters).toEqual([1, 2]);
    expect(impact.continuityAffected).toBe(1);
    expect(impact.qaAffected).toBe(2);
    await operations.close();
  });

  it("treats demote as a granularity-only change with reference context", async () => {
    const { root, story, su } = await impactFixture();
    const operations = new StudioOperations(root, env);
    const impact = await operations.inspectCanonicalEntityImpact(story.slug, su.id, { action: "demote" });
    expect(impact.affectedChapters).toEqual([1, 2]);
    expect(impact.narrationAffected).toBe(0);
    expect(impact.ttsAffected).toBe(0);
    expect(impact.qaAffected).toBe(0);
    expect(impact.warnings.some((warning) => warning.includes("minor reference"))).toBe(true);
    await operations.close();
  });
});

describe("bulk entity updates", () => {
  it("previews eligibility with dryRun and mutates nothing", async () => {
    const { root, story, paths, su, ming } = await impactFixture();
    const operations = new StudioOperations(root, env);
    const preview = await operations.bulkUpdateCanonicalEntities(story.slug, { action: "lock", entityIds: [su.id, ming.id], dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.eligible.sort()).toEqual([su.id, ming.id].sort());
    expect(preview.applied).toEqual([]);
    expect(preview.skipped).toEqual([]);
    expect(preview.invalidationSummary.affectedChapters).toBe(0);
    expect(await readJsonIfExists(paths.bibleCanonicalManual)).toBeUndefined();
    await operations.close();
  });

  it("applies lock only to the selected entities and skips no-ops with reasons", async () => {
    const { root, story, su, ming } = await impactFixture();
    const operations = new StudioOperations(root, env);
    const applied = await operations.bulkUpdateCanonicalEntities(story.slug, { action: "lock", entityIds: [su.id] });
    expect(applied.applied).toEqual([su.id]);
    expect(applied.skipped).toEqual([]);
    const again = await operations.bulkUpdateCanonicalEntities(story.slug, { action: "lock", entityIds: [su.id, ming.id, id("ee")] });
    expect(again.applied).toEqual([ming.id]);
    expect(again.skipped).toEqual(expect.arrayContaining([
      { id: su.id, reason: "Canonical name is already locked" },
      { id: id("ee"), reason: "Canonical entity was not found" },
    ]));
    await operations.close();
  });

  it("validates each set-type change and estimates identity impact in dryRun", async () => {
    const { root, story, su, ming } = await impactFixture();
    const operations = new StudioOperations(root, env);
    const preview = await operations.bulkUpdateCanonicalEntities(story.slug, { action: "set-type", value: "character", entityIds: [su.id, ming.id], dryRun: true });
    expect(preview.eligible).toEqual([]);
    expect(preview.skipped).toHaveLength(2);
    const location = await operations.bulkUpdateCanonicalEntities(story.slug, { action: "set-type", value: "location", entityIds: [su.id], dryRun: true });
    expect(location.eligible).toEqual([su.id]);
    expect(location.invalidationSummary.affectedChapters).toBe(2);
    const applied = await operations.bulkUpdateCanonicalEntities(story.slug, { action: "set-type", value: "location", entityIds: [su.id] });
    expect(applied.applied).toEqual([su.id]);
    const meta = await chapterMeta(root, story.slug, 1);
    expect(meta.stages.scenePlanning.staleReason).toContain("type changed");
    await operations.close();
  });

  it("rejects invalid bulk input with 400 over HTTP", async () => {
    const { root, story, su } = await impactFixture();
    const operations = new StudioOperations(root, env);
    const handler = createApiHandler(operations);
    const request = async (path: string, body: unknown) => {
      const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: "POST", url: path, headers: { host: "localhost:3000", "content-type": "application/json" } });
      const headers: Record<string, unknown> = {}; const chunks: Buffer[] = [];
      const res = Object.assign(new PassThrough(), { writeHead: (status: number, values?: Record<string, unknown>) => { headers.status = status; Object.assign(headers, values); } });
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      const done = new Promise<void>((resolve) => res.on("finish", resolve));
      await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse); await done;
      return { status: headers.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") };
    };
    expect((await request(`/api/stories/${story.slug}/story-bible/entities/bulk`, { action: "merge", entityIds: [su.id] })).status).toBe(400);
    expect((await request(`/api/stories/${story.slug}/story-bible/entities/bulk`, { action: "set-type", value: "bogus", entityIds: [su.id] })).status).toBe(400);
    expect((await request(`/api/stories/${story.slug}/story-bible/entities/bulk`, { action: "lock", entityIds: [] })).status).toBe(400);
    expect((await request(`/api/stories/${story.slug}/story-bible/entities/${su.id}/impact`, { action: "obliterate" })).status).toBe(400);
    const ok = await request(`/api/stories/${story.slug}/story-bible/entities/${su.id}/impact`, { action: "update", patch: { notes: "fine" } });
    expect(ok.status).toBe(200);
    expect(ok.body.affectedChapters).toEqual([]);
    await operations.close();
  });
});

describe("cleanup plan apply by recommendation ids", () => {
  it("applies only the checked recommendations and keeps type-conflict merges unchecked-safe", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-bible-cleanup-plan-"));
    const story = defaultStory("cleanup-story", env);
    const paths = storyPaths(root, story.slug, 1);
    await atomicWriteJson(paths.storyConfig, story);
    await atomicWriteJson(paths.pipelineConfig, story.pipeline);
    const first = entity("f1", { canonicalName: "Su Ming" });
    const second = entity("f2", { canonicalName: "Ming", aliases: ["Su Ming"] });
    const conflictTarget = entity("f3", { canonicalName: "Red Keeper", type: "location" });
    const conflictSource = entity("f4", { canonicalName: "Keeper", aliases: ["Red Keeper"] });
    const bystander = entity("f5", { canonicalName: "Quiet Pond", type: "location" });
    await atomicWriteJson(paths.bible, { ...emptyStoryBible(), canonicalEntities: [first, second, conflictTarget, conflictSource, bystander] });
    const operations = new StudioOperations(root, env);
    const analysis = await operations.analyzeStoryBible(story.slug);
    const mergeRec = analysis.recommendations.find((rec) => rec.recommendation === "merge" && rec.entityId === second.id);
    expect(mergeRec).toBeDefined();
    expect(mergeRec!.safeToAutoApply).toBe(true);
    expect(mergeRec!.source).toBe("deterministic");
    const conflictRec = analysis.recommendations.find((rec) => rec.entityId === conflictSource.id && rec.targetEntityId === conflictTarget.id);
    expect(conflictRec).toBeDefined();
    expect(conflictRec!.recommendation).toBe("merge");
    expect(conflictRec!.safeToAutoApply).toBe(false);
    // Apply only the checked recommendation; the unchecked conflict merge must not run.
    const result = await operations.applyCleanupRecommendations(story.slug, { recommendationIds: [mergeRec!.id] });
    expect(result.appliedMergesCount).toBe(1);
    expect(result.appliedDemotionsCount).toBe(0);
    expect(result.failedCount).toBe(0);
    const overlay = await readJsonIfExists(paths.bibleCanonicalManual) as { merges?: Array<{ targetEntityId: string; sourceEntityIds: string[] }> } | undefined;
    expect(overlay?.merges).toHaveLength(1);
    expect(overlay!.merges![0]).toMatchObject({ targetEntityId: first.id, sourceEntityIds: [second.id] });
    // The unchecked type-conflict recommendation was not applied.
    expect(JSON.stringify(overlay)).not.toContain(conflictSource.id);
    await operations.close();
  });
});
