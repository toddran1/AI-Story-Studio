import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getChapter, getChapterPage, getStoryBibleView } from "../apps/server/catalog.js";
import { masterStoredChapter } from "../src/audio/chapter-audio.js";
import { AudioMasteringProcessor } from "../src/audio/mastering.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { importSource } from "../src/source/importer.js";
import { sourceManifestSchema } from "../src/source/types.js";
import { TxtSource } from "../src/source/txt-source.js";
import { computeStaleExtractionChapters, rebuildStoryBibleBeforeChapter } from "../src/story-bible/rebuild.js";
import { updateCanonicalEntity } from "../src/story-bible/canonical.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { readJsonIfExists } from "../src/storage/story-files.js";
import { testStory } from "./helpers.js";

const complete = { status: "complete" as const, fingerprint: "input", outputFingerprint: "output" };

async function importChapter(root: string, slug: string, text: string, chapter = 1) {
  const source = join(root, `chapter-${chapter}.txt`); await writeFile(source, text);
  const inspection = await new TxtSource().inspect(source, { chapter });
  await importSource(root, slug, inspection);
  const paths = storyPaths(root, slug, chapter);
  const manifest = sourceManifestSchema.parse(JSON.parse(await readFile(paths.sourceManifest, "utf8")));
  return { paths, manifest };
}

function chapterMetadata(chapter: number, fingerprint: string, stages: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return chapterSchema.parse({
    chapter, source: { type: "text", sourceId: `chapter-${chapter}.txt`, fingerprint, metadata: {} },
    sourceLanguage: "zh-CN", outputLanguage: "en-US", counts: { originalCharacters: 10, englishWords: 4, narrationWords: 4 },
    createdAt: now, updatedAt: now,
    stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, continuity: complete, tts: complete, audioMastering: complete, alignment: complete, subtitles: complete, scenePlanning: complete, artwork: complete, video: complete, ...stages },
  });
}

async function writeArtifacts(paths: ReturnType<typeof storyPaths>) {
  await atomicWriteJson(paths.storyContext, { summary: "The lamp awakens." });
  await atomicWriteJson(paths.alignment, {
    version: 1, chapter: 1, mode: "estimated", engine: "deterministic", engineVersion: "1", createdAt: new Date().toISOString(),
    audioFingerprint: "audio", narrationFingerprint: "narration", inputFingerprint: "input",
    metrics: { matchedWordPercentage: 100, matchedWordCount: 1, unmatchedWordCount: 0, alignmentDurationSeconds: 1, audioDurationSeconds: 1 },
    words: [{ text: "Lamp", start: 0, end: 0.5 }],
  });
  await atomicWriteJson(paths.subtitlesDocument, { version: "subtitles-v1", durationSeconds: 1, timingMode: "estimated", cues: [{ index: 1, startSeconds: 0, endSeconds: 0.8, text: "Lamp" }] });
  await atomicWrite(paths.subtitlesVtt, "WEBVTT\n\n00:00.000 --> 00:00.800\nLamp\n");
  await atomicWrite(paths.video, Buffer.from("video"));
}

async function makeManifestStale(root: string, slug: string) {
  const paths = storyPaths(root, slug, 1);
  const manifest = sourceManifestSchema.parse(JSON.parse(await readFile(paths.sourceManifest, "utf8")));
  manifest.chapters[0]!.contentFingerprint = "f".repeat(64);
  await atomicWriteJson(paths.sourceManifest, manifest);
}

describe("stale artifact visibility", () => {
  it("returns stale artifacts with stale flags after the source fingerprint changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "stale-visible-")); const slug = "story";
    const { paths, manifest } = await importChapter(root, slug, "Original");
    await atomicWriteJson(paths.chapterMeta, chapterMetadata(1, manifest.chapters[0]!.contentFingerprint!));
    await writeArtifacts(paths);

    const fresh = await getChapter(root, slug, 1);
    expect(fresh.storyContext).toBeDefined(); expect(fresh.storyContextStale).toBe(false);
    expect(fresh.alignmentStale).toBe(false); expect(fresh.subtitlesStale).toBe(false); expect(fresh.videoStale).toBe(false);

    await makeManifestStale(root, slug);
    const stale = await getChapter(root, slug, 1);
    expect(stale.stale).toBe(true);
    expect(stale.storyContext).toEqual({ summary: "The lamp awakens." }); expect(stale.storyContextStale).toBe(true);
    expect(stale.alignment?.words[0]?.text).toBe("Lamp"); expect(stale.alignmentStale).toBe(true);
    expect(stale.subtitleDocument?.cues).toHaveLength(1);
    expect(stale.subtitles).toContain("WEBVTT"); expect(stale.subtitlesStale).toBe(true);
    expect(stale.subtitlesUrl).toBe(`/api/stories/${slug}/chapters/1/subtitles.vtt`);
    expect(stale.videoUrl).toBe(`/api/stories/${slug}/chapters/1/video`); expect(stale.videoStale).toBe(true);

    const page = await getChapterPage(root, slug, { page: 1, pageSize: 50, filter: "all" });
    expect(page.items[0]).toMatchObject({ chapter: 1, videoAvailable: true, videoStale: true });
  });

  it("keeps truly missing artifacts undefined rather than stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "stale-missing-")); const slug = "story";
    const { paths, manifest } = await importChapter(root, slug, "Original");
    await atomicWriteJson(paths.chapterMeta, chapterMetadata(1, manifest.chapters[0]!.contentFingerprint!));
    const detail = await getChapter(root, slug, 1);
    expect(detail.storyContext).toBeUndefined(); expect(detail.storyContextStale).toBe(false);
    expect(detail.alignment).toBeUndefined(); expect(detail.alignmentStale).toBe(false);
    expect(detail.subtitleDocument).toBeUndefined(); expect(detail.subtitles).toBeUndefined(); expect(detail.subtitlesStale).toBe(false);
    expect(detail.subtitlesUrl).toBeUndefined(); expect(detail.videoUrl).toBeUndefined(); expect(detail.videoStale).toBe(false);
  });

  it("treats artifact files deleted after completion as unavailable, not stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "stale-deleted-")); const slug = "story";
    const { paths, manifest } = await importChapter(root, slug, "Original");
    await atomicWriteJson(paths.chapterMeta, chapterMetadata(1, manifest.chapters[0]!.contentFingerprint!));
    await writeArtifacts(paths); await makeManifestStale(root, slug);
    await rm(paths.subtitlesVtt); await rm(paths.video);
    const detail = await getChapter(root, slug, 1);
    expect(detail.subtitles).toBeUndefined(); expect(detail.subtitlesStale).toBe(false); expect(detail.subtitlesUrl).toBeUndefined();
    expect(detail.videoUrl).toBeUndefined(); expect(detail.videoStale).toBe(false);
    const page = await getChapterPage(root, slug, { page: 1, pageSize: 50, filter: "all" });
    expect(page.items[0]).toMatchObject({ videoAvailable: false, videoStale: false });
  });

  it("serves prior output files with stale flags when regeneration failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "stale-failed-")); const slug = "story";
    const { paths, manifest } = await importChapter(root, slug, "Original");
    const failed = { status: "failed" as const, fingerprint: "input", error: { message: "provider exploded" } };
    await atomicWriteJson(paths.chapterMeta, chapterMetadata(1, manifest.chapters[0]!.contentFingerprint!, { subtitles: failed, video: failed }));
    await writeArtifacts(paths);
    const detail = await getChapter(root, slug, 1);
    expect(detail.metadata?.stages.subtitles.status).toBe("failed");
    expect(detail.subtitles).toContain("WEBVTT"); expect(detail.subtitlesStale).toBe(true); expect(detail.subtitlesUrl).toBeDefined();
    expect(detail.videoUrl).toBe(`/api/stories/${slug}/chapters/1/video`); expect(detail.videoStale).toBe(true);
  });

  it("rebuild keeps canonical entities from stale-but-complete extractions and reports them", async () => {
    const root = await mkdtemp(join(tmpdir(), "stale-bible-")); const slug = "story";
    const { paths, manifest } = await importChapter(root, slug, "Original");
    const update = storyBibleUpdateSchema.parse({
      characters: [{ canonicalEnglishName: "Lin Yao", originalName: "林遥", description: "Carries a lamp", firstSeenChapter: 1, lastSeenChapter: 1 }],
      chapterSummary: "Found a lamp",
    });
    await atomicWriteJson(paths.bibleUpdate, update);
    await atomicWriteJson(paths.chapterMeta, chapterMetadata(1, manifest.chapters[0]!.contentFingerprint!));

    const freshBible = await rebuildStoryBibleBeforeChapter(root, slug, 2);
    expect(freshBible.chapterSummaries).toEqual({ "1": "Found a lamp" });
    expect(freshBible.canonicalEntities.map((entity) => entity.canonicalName)).toContain("Lin Yao");
    const freshIds = freshBible.canonicalEntities.map((entity) => entity.id);

    await makeManifestStale(root, slug);
    const staleBible = await rebuildStoryBibleBeforeChapter(root, slug, 2);
    expect(staleBible.chapterSummaries).toEqual({ "1": "Found a lamp" });
    expect(staleBible.canonicalEntities.map((entity) => entity.id)).toEqual(freshIds);
    expect(await computeStaleExtractionChapters(root, slug)).toEqual([1]);

    const now = new Date().toISOString();
    await atomicWriteJson(storyPaths(root, slug, 1).bibleManual, {
      version: 1, mutations: [{ id: crypto.randomUUID(), category: "characters", key: "manual:Warden", action: "upsert",
        value: { canonicalEnglishName: "Warden", originalName: "守者", description: "Manual entry", firstSeenChapter: 1, lastSeenChapter: 1 }, createdAt: now, updatedAt: now }],
    });
    const view = await getStoryBibleView(root, slug);
    expect(view.bible.characters.map((character) => character.canonicalEnglishName)).toContain("Warden");
    expect(view.staleExtractionChapters).toEqual([1]);
  });

  it("contributes nothing from chapters whose extraction stage is pending or failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "stale-pending-")); const slug = "story";
    const { paths, manifest } = await importChapter(root, slug, "Original");
    await atomicWriteJson(paths.bibleUpdate, storyBibleUpdateSchema.parse({ chapterSummary: "Unfinished" }));
    await atomicWriteJson(paths.chapterMeta, chapterMetadata(1, manifest.chapters[0]!.contentFingerprint!, { storyBible: { status: "failed", error: { message: "boom" } } }));
    expect((await rebuildStoryBibleBeforeChapter(root, slug, 2)).chapterSummaries).toEqual({});
    expect(await computeStaleExtractionChapters(root, slug)).toEqual([]);
  });

  it("still refuses to master audio when the upstream narration/TTS chain is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "stale-guard-")); const story = testStory();
    const { paths, manifest } = await importChapter(root, story.slug, "Original");
    await atomicWriteJson(paths.chapterMeta, chapterMetadata(1, manifest.chapters[0]!.contentFingerprint!, { narration: { status: "pending", staleReason: "naming changed" }, tts: { status: "pending" } }));
    const processor: AudioMasteringProcessor = { version: "guard-v1", master: async () => { throw new Error("must not run"); } };
    await expect(masterStoredChapter({ root, story, chapter: 1, processor })).rejects.toThrow("TTS is not complete");
  });

  it("preserves manual canonical naming and localization settings across a stale regeneration", async () => {
    const root = await mkdtemp(join(tmpdir(), "stale-canonical-")); const slug = "story";
    const { paths, manifest } = await importChapter(root, slug, "Original");
    const firstFingerprint = manifest.chapters[0]!.contentFingerprint!;
    await atomicWriteJson(paths.bibleUpdate, storyBibleUpdateSchema.parse({
      characters: [{ canonicalEnglishName: "Su Ming", originalName: "苏明", aliases: ["Ming"], description: "A quiet apprentice", status: "alive", firstSeenChapter: 1, lastSeenChapter: 1 }],
      chapterSummary: "Su Ming finds the lamp",
    }));
    await atomicWriteJson(paths.chapterMeta, chapterMetadata(1, firstFingerprint));

    const initial = await rebuildStoryBibleBeforeChapter(root, slug, 2);
    const entity = initial.canonicalEntities.find((item) => item.canonicalName === "Su Ming");
    expect(entity).toBeDefined(); const entityId = entity!.id;

    await updateCanonicalEntity(root, slug, initial, entityId, {
      canonicalNameLocked: true, notes: "Manual: protagonist keeps the Su Ming spelling.",
      preferredNarrationName: "Malakai Sterling",
      localizedNaming: { locale: "en-US", fullName: "Malakai Sterling", shortName: "Malakai", usageMode: "ai_contextual", notes: "Short form in dialogue." },
      aliasNarrationRules: [{ alias: "Ming", behavior: "custom", replacement: "Mal" }],
    });

    await makeManifestStale(root, slug);
    expect(await computeStaleExtractionChapters(root, slug)).toEqual([1]);

    await atomicWriteJson(paths.bibleUpdate, storyBibleUpdateSchema.parse({
      characters: [
        { canonicalEnglishName: "Su Ming", originalName: "苏明", aliases: ["Ming", "Lampbearer"], description: "A quiet apprentice who awakened the star lamp", status: "ascended", firstSeenChapter: 1, lastSeenChapter: 1 },
        { canonicalEnglishName: "Veyra", originalName: "薇拉", description: "A rival seeker", status: "alive", firstSeenChapter: 1, lastSeenChapter: 1 },
      ],
      chapterSummary: "Su Ming awakens the star lamp",
    }));
    // Regeneration re-runs against the replaced source, so the refreshed
    // extraction is current again.
    await atomicWriteJson(paths.chapterMeta, chapterMetadata(1, "f".repeat(64)));

    const rebuilt = await rebuildStoryBibleBeforeChapter(root, slug, 2);
    const refreshed = rebuilt.canonicalEntities.find((item) => item.id === entityId);
    expect(refreshed).toBeDefined();
    expect(refreshed!.canonicalName).toBe("Su Ming");
    expect(refreshed!.localizedNaming).toMatchObject({ fullName: "Malakai Sterling", shortName: "Malakai", usageMode: "ai_contextual", notes: "Short form in dialogue." });
    expect(refreshed!.preferredNarrationName).toBe("Malakai Sterling");
    expect(refreshed!.aliasNarrationRules).toEqual([{ alias: "Ming", behavior: "custom", replacement: "Mal" }]);
    expect(refreshed!.canonicalNameLocked).toBe(true);
    expect(refreshed!.notes).toBe("Manual: protagonist keeps the Su Ming spelling.");
    expect(refreshed!.origin).toBe("manual");

    // Newly extracted facts, appearances, status, and provenance still update.
    expect(refreshed!.description).toContain("awakened the star lamp");
    expect(refreshed!.status).toBe("ascended");
    expect(refreshed!.aliases).toContain("Lampbearer");
    expect(refreshed!.provenance.some((item) => item.chapter === 1 && item.kind === "extraction")).toBe(true);
    expect(rebuilt.entityTimeline.some((event) => event.entityId === entityId && event.type === "appearance" && event.chapter === 1)).toBe(true);
    expect(rebuilt.chapterSummaries).toEqual({ "1": "Su Ming awakens the star lamp" });

    // The refreshed extraction is current again, and the manual overlay survives.
    expect(await computeStaleExtractionChapters(root, slug)).toEqual([]);
    const overlay = await readJsonIfExists<{ overrides: Record<string, unknown> }>(storyPaths(root, slug, 1).bibleCanonicalManual);
    expect(Object.keys(overlay?.overrides ?? {})).toEqual([entityId]);

    // Manual settings never leak onto a genuinely different entity.
    const other = rebuilt.canonicalEntities.find((item) => item.canonicalName === "Veyra");
    expect(other).toBeDefined(); expect(other!.id).not.toBe(entityId);
    expect(other!.localizedNaming).toBeUndefined();
    expect(other!.preferredNarrationName).toBeUndefined();
    expect(other!.aliasNarrationRules).toEqual([]);
    expect(other!.canonicalNameLocked).toBe(false);
    expect(other!.notes).toBe("");
    expect(other!.origin).toBe("automatic");
  });
});
