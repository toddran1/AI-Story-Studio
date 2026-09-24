import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getChapterStatusReadModel, getScenesIndexRow, getAudioChapterPage, getAudioSummary, getVideoChapterPage, getVideoSummary, getOutputsSummary, getOutputsPage, getScenesIndex, getScenesChapter, getChapterPage, getQaPage, getQaSummary, getProductionStatus, normalizeChapterSearch, getStoryDashboard, getStoryOverview, invalidateChapterStatusDerivedReads } from "../apps/server/catalog.js";
import { defaultStory } from "../src/config/load-config.js";
import { loadEnvironment } from "../src/config/env.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { sceneImagePath, storyPaths } from "../src/storage/paths.js";
import { sceneManifestSchema } from "../src/scenes/types.js";
import { getArtworkOutputReadRevision, writeArtworkOutputManifest } from "../src/artwork/output-index-revision.js";
import { readJsonIfExists } from "../src/storage/story-files.js";
import { chapterStatusReadRevisionPath, getChapterStatusReadRevision } from "../src/studio/chapter-status-revision.js";
import { resetStoryReadCaches, storyReadCacheStats } from "../src/story-bible/read-cache.js";

async function fixture() {
  resetStoryReadCaches();
  const root = await mkdtemp(join(tmpdir(), "chapter-status-"));
  const slug = "read-model";
  const story = defaultStory(slug, loadEnvironment({}));
  await atomicWriteJson(storyPaths(root, slug, 1).storyConfig, story);
  return { root, slug };
}
const builds = (root: string, slug: string) => storyReadCacheStats().builds[`chapter_status\0${root}\0${slug}`] ?? 0;

describe("chapter status read model", () => {
  it("shares concurrent and warm reads, including overview and dashboard", async () => {
    const { root, slug } = await fixture();
    const [a, b] = await Promise.all([getChapterStatusReadModel(root, slug), getChapterStatusReadModel(root, slug)]);
    expect(a).toEqual(b);
    expect(builds(root, slug)).toBe(1);
    await getStoryOverview(root, slug);
    await getStoryDashboard(root, slug);
    expect(builds(root, slug)).toBe(1);
    await invalidateChapterStatusDerivedReads(root, slug);
    await getChapterStatusReadModel(root, slug);
    expect(builds(root, slug)).toBe(2);
  });

  it("serves targeted Scenes rows and aggregate counts from one shared status projection", async () => {
    const { root, slug } = await fixture();
    const now = new Date().toISOString();
    for (let chapter = 1; chapter <= 3; chapter++) {
      const paths = storyPaths(root, slug, chapter);
      await atomicWriteJson(paths.chapterMeta, {
        chapter, originalTitle: `Chapter ${chapter}`, sourceLanguage: "zh-CN", outputLanguage: "en-US",
        counts: { originalCharacters: 1, englishWords: 0, narrationWords: 0 }, createdAt: now, updatedAt: now,
        stages: { ingestion: { status: "pending" }, translation: { status: "pending" }, narration: { status: "pending" }, qa: { status: "pending" }, storyBible: { status: "pending" }, tts: { status: "pending" }, scenePlanning: { status: chapter === 1 ? "complete" : "pending" }, artwork: { status: chapter === 1 ? "complete" : "pending" } },
      });
    }
    const index = await getScenesIndex(root, slug);
    const key = `chapter_status\0${root}\0${slug}`;
    const buildsBeforeRowRead = storyReadCacheStats().builds[key];
    const first = await getScenesIndexRow(root, slug, 1);
    expect(first.row).toEqual(index.chapters[0]);
    expect(first.counts).toEqual(index.counts);
    expect(storyReadCacheStats().builds[key]).toBe(buildsBeforeRowRead);

    const paths = storyPaths(root, slug, 2);
    const metadata = await readJsonIfExists<any>(paths.chapterMeta);
    metadata.stages.scenePlanning.status = "complete";
    metadata.stages.artwork.status = "complete";
    await atomicWriteJson(paths.chapterMeta, metadata);
    await invalidateChapterStatusDerivedReads(root, slug);
    const updated = await getScenesIndexRow(root, slug, 2);
    expect(updated.row).toEqual((await getScenesIndex(root, slug)).chapters[1]);
    expect(updated.counts).toEqual({ chapters: 3, planned: 2, artworkReady: 2 });
    expect(storyReadCacheStats().builds[key]).toBe(buildsBeforeRowRead + 1);
  });

  it("loads Scenes chapter detail without rebuilding workspace settings or chapter rows", async () => {
    const { root, slug } = await fixture();
    await atomicWriteJson(storyPaths(root, slug, 1).chapterMeta, { chapter: 1 });
    await getScenesIndex(root, slug);
    const before = builds(root, slug);
    await rm(storyPaths(root, slug, 1).storyConfig);
    expect((await getScenesChapter(root, slug, 1)).selectedChapter).toBe(1);
    expect(builds(root, slug)).toBe(before);
    await expect(getScenesIndex(root, slug)).rejects.toThrow();
  });

  it("paginates cached chapter and QA rows without another chapter build", async () => {
    const { root, slug } = await fixture();
    const now = new Date().toISOString();
    const qa = (status: "pass" | "warn" | "fail") => ({ status, score: status === "pass" ? 1 : 0.6, issues: [], checks: { completeness: "pass", names: "pass", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" } });
    for (let chapter = 1; chapter <= 55; chapter++) {
      const paths = storyPaths(root, slug, chapter);
      await atomicWriteJson(paths.chapterMeta, { chapter, originalTitle: chapter === 25 ? "The Blue Lantern!" : `Chapter ${chapter}`, sourceLanguage: "zh-CN", outputLanguage: "en-US", counts: { originalCharacters: 1, englishWords: 0, narrationWords: 0 }, createdAt: now, updatedAt: now, stages: { ingestion: { status: "pending" }, translation: { status: "pending" }, narration: { status: "pending" }, qa: { status: "pending" }, storyBible: { status: "pending" }, tts: { status: "pending" } } });
      await atomicWriteJson(paths.qa, qa(chapter <= 25 ? "pass" : chapter <= 45 ? "warn" : "fail"));
    }
    const first = await getChapterPage(root, slug, { page: 1, pageSize: 25, filter: "all" });
    expect(first.items).toHaveLength(25); expect(first.total).toBe(55);
    expect((await getChapterPage(root, slug, { page: 1, pageSize: 25, filter: "all", query: " blue,  lantern " })).items.map((item) => item.chapter)).toEqual([25]);
    const summary = await getQaSummary(root, slug);
    expect(summary.counts).toMatchObject({ pass: 25, warn: 20, fail: 10, totalEvaluated: 55 });
    const page = await getQaPage(root, slug, { page: 2, pageSize: 10, status: "warn" });
    expect(page).toMatchObject({ page: 2, pageSize: 10, pages: 2, total: 20 });
    expect(page.items.map((item) => item.chapter)).toEqual(Array.from({ length: 10 }, (_, index) => index + 36));
    expect(builds(root, slug)).toBe(1);
    expect(normalizeChapterSearch("  Ｂｌｕｅ—Lantern!! ")).toBe("blue lantern");
  });

  it("reads production status without building chapter rows", async () => {
    const { root, slug } = await fixture();
    expect(await getProductionStatus(root, slug)).toEqual({ latest: undefined });
    expect(builds(root, slug)).toBe(0);
  });

  it("serves bounded media pages and lazy output groups from one status build", async () => {
    const { root, slug } = await fixture();
    const now = new Date().toISOString();
    for (let chapter = 1; chapter <= 30; chapter++) {
      const paths = storyPaths(root, slug, chapter);
      await atomicWriteJson(paths.chapterMeta, { chapter, originalTitle: `Chapter ${chapter}`, sourceLanguage: "zh-CN", outputLanguage: "en-US", counts: { originalCharacters: 1, englishWords: 0, narrationWords: 0 }, createdAt: now, updatedAt: now, stages: { ingestion: { status: "pending" }, translation: { status: "pending" }, narration: { status: "pending" }, qa: { status: "pending" }, storyBible: { status: "pending" }, tts: { status: "pending" } } });
      if (chapter <= 27) await writeFile(paths.audio, "audio");
      if (chapter <= 5) await writeFile(paths.video, "video");
    }
    const audio = await getAudioChapterPage(root, slug, 1, 25);
    expect(audio.items).toHaveLength(25); expect(audio.total).toBe(30);
    expect((await getAudioChapterPage(root, slug, 2, 25)).items).toHaveLength(5);
    expect((await getAudioSummary(root, slug)).counts).toMatchObject({ total: 30, mastered: 27, stale: 27 });
    expect((await getVideoChapterPage(root, slug, 1, 25)).items).toHaveLength(25);
    expect((await getVideoSummary(root, slug)).counts).toMatchObject({ total: 30, videos: 0 });
    expect((await getOutputsSummary(root, slug)).counts).toMatchObject({ chapterAudio: 27, chapterVideos: 5 });
    const outputs = await getOutputsPage(root, slug, "chapterAudio", 1, 25);
    expect(outputs.items).toHaveLength(25); expect(outputs.total).toBe(27);
    expect((await getOutputsPage(root, slug, "chapterAudio", 2, 25)).items).toHaveLength(2);
    expect(builds(root, slug)).toBe(1);
    const index = await getScenesIndex(root, slug);
    expect(index.chapters).toHaveLength(30); expect(index.manifest).toBeUndefined();
    const detail = await getScenesChapter(root, slug, 2);
    expect(detail.selectedChapter).toBe(2); expect(detail).not.toHaveProperty("chapters");
    expect(builds(root, slug)).toBe(1);
  });

  it("shares one Artwork Output Index across pages and summary, then invalidates on manifest writes", async () => {
    const { root, slug } = await fixture();
    expect((await getOutputsSummary(root, slug)).counts.artwork).toBe(0);
    const now = new Date().toISOString();
    for (let chapter = 1; chapter <= 3; chapter++) {
      const paths = storyPaths(root, slug, chapter);
      await atomicWriteJson(paths.chapterMeta, { chapter, originalTitle: `Chapter ${chapter}`, sourceLanguage: "zh-CN", outputLanguage: "en-US", counts: { originalCharacters: 1, englishWords: 0, narrationWords: 0 }, createdAt: now, updatedAt: now, stages: { ingestion: { status: "pending" }, translation: { status: "pending" }, narration: { status: "pending" }, qa: { status: "pending" }, storyBible: { status: "pending" }, tts: { status: "pending" } } });
      const manifest = sceneManifestSchema.parse({ version: 1, chapter, durationSeconds: 10, planningFingerprint: "test", planner: { provider: "test", model: "test", promptVersion: "1" }, createdAt: now, updatedAt: now, scenes: [{ id: "scene-001", summary: "A visual beat", startSeconds: 0, endSeconds: 10, characters: [], visualPrompt: "A lantern", artwork: { status: "complete", review: "approved", imageFingerprint: "test" } }] });
      await writeArtworkOutputManifest(root, slug, chapter, manifest);
      const imagePath = sceneImagePath(root, slug, chapter, "scene-001");
      await mkdir(dirname(imagePath), { recursive: true });
      await writeFile(imagePath, "image");
    }
    await invalidateChapterStatusDerivedReads(root, slug);
    const key = `artwork-output-index\0${root}\0${slug}`;
    const before = storyReadCacheStats().builds[key] ?? 0;
    const [summary, first] = await Promise.all([getOutputsSummary(root, slug), getOutputsPage(root, slug, "artwork", 1, 2)]);
    expect((storyReadCacheStats().builds[key] ?? 0) - before).toBe(1);
    expect(summary.counts.artwork).toBe(3);
    expect(first).toMatchObject({ total: 3, pages: 2 });
    expect(first.items).toHaveLength(2);
    const second = await getOutputsPage(root, slug, "artwork", 2, 2);
    expect(second.items).toHaveLength(1);
    expect(storyReadCacheStats().builds[key]).toBe(before + 1);
    const path = storyPaths(root, slug, 1);
    const old = sceneManifestSchema.parse(await readJsonIfExists(path.scenesManifest));
    const changed = sceneManifestSchema.parse({ ...old, scenes: [{ id: "scene-001", summary: "A visual beat", startSeconds: 0, endSeconds: 10, characters: [], visualPrompt: "A lantern", artwork: { status: "pending", review: "unreviewed" } }] });
    await writeArtworkOutputManifest(root, slug, 1, changed);
    expect((await getOutputsSummary(root, slug)).counts.artwork).toBe(2);
    expect(storyReadCacheStats().builds[key]).toBe(before + 2);
  });

  it("invalidates the artwork index before a delayed manifest write and observes the committed revision", async () => {
    const { root, slug } = await fixture();
    const now = new Date().toISOString();
    const paths = storyPaths(root, slug, 1);
    await atomicWriteJson(paths.chapterMeta, { chapter: 1, originalTitle: "Chapter 1", sourceLanguage: "zh-CN", outputLanguage: "en-US", counts: { originalCharacters: 1, englishWords: 0, narrationWords: 0 }, createdAt: now, updatedAt: now, stages: { ingestion: { status: "pending" }, translation: { status: "pending" }, narration: { status: "pending" }, qa: { status: "pending" }, storyBible: { status: "pending" }, tts: { status: "pending" } } });
    const complete = sceneManifestSchema.parse({ version: 1, chapter: 1, durationSeconds: 10, planningFingerprint: "test", planner: { provider: "test", model: "test", promptVersion: "1" }, createdAt: now, updatedAt: now, scenes: [{ id: "scene-001", summary: "A visual beat", startSeconds: 0, endSeconds: 10, characters: [], visualPrompt: "A lantern", artwork: { status: "complete", review: "approved", imageFingerprint: "test" } }] });
    await writeArtworkOutputManifest(root, slug, 1, complete);
    expect((await getOutputsSummary(root, slug)).counts.artwork).toBe(1);
    const key = `artwork-output-index\0${root}\0${slug}`;
    const buildsBefore = storyReadCacheStats().builds[key] ?? 0;
    const oldRevision = await getArtworkOutputReadRevision(root, slug);
    let signalStarted!: () => void;
    let releaseWrite!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const pending = sceneManifestSchema.parse({ ...complete, scenes: [{ ...complete.scenes[0], artwork: { status: "pending", review: "unreviewed" } }] });
    const mutation = writeArtworkOutputManifest(root, slug, 1, pending, async (path, value) => {
      signalStarted();
      await blocked;
      await atomicWriteJson(path, value);
    });
    await started;
    await getOutputsSummary(root, slug);
    expect(storyReadCacheStats().builds[key]).toBe(buildsBefore + 1);
    releaseWrite();
    await mutation;
    expect(await getArtworkOutputReadRevision(root, slug)).not.toBe(oldRevision);
    expect((await getOutputsSummary(root, slug)).counts.artwork).toBe(0);
    expect(storyReadCacheStats().builds[key]).toBe(buildsBefore + 2);
  });

  it("keeps artwork memory invalidated after a failed manifest write", async () => {
    const { root, slug } = await fixture();
    const now = new Date().toISOString();
    const paths = storyPaths(root, slug, 1);
    await atomicWriteJson(paths.chapterMeta, { chapter: 1, originalTitle: "Chapter 1", sourceLanguage: "zh-CN", outputLanguage: "en-US", counts: { originalCharacters: 1, englishWords: 0, narrationWords: 0 }, createdAt: now, updatedAt: now, stages: { ingestion: { status: "pending" }, translation: { status: "pending" }, narration: { status: "pending" }, qa: { status: "pending" }, storyBible: { status: "pending" }, tts: { status: "pending" } } });
    const manifest = sceneManifestSchema.parse({ version: 1, chapter: 1, durationSeconds: 10, planningFingerprint: "test", planner: { provider: "test", model: "test", promptVersion: "1" }, createdAt: now, updatedAt: now, scenes: [{ id: "scene-001", summary: "A visual beat", startSeconds: 0, endSeconds: 10, characters: [], visualPrompt: "A lantern", artwork: { status: "complete", review: "approved", imageFingerprint: "test" } }] });
    await writeArtworkOutputManifest(root, slug, 1, manifest);
    expect((await getOutputsSummary(root, slug)).counts.artwork).toBe(1);
    const key = `artwork-output-index\0${root}\0${slug}`;
    const buildsBefore = storyReadCacheStats().builds[key] ?? 0;
    const revisionBefore = await getArtworkOutputReadRevision(root, slug);
    await expect(writeArtworkOutputManifest(root, slug, 1, { ...manifest, scenes: [] }, async () => { throw new Error("write failed"); })).rejects.toThrow("write failed");
    expect(await getArtworkOutputReadRevision(root, slug)).toBe(revisionBefore);
    expect((await getOutputsSummary(root, slug)).counts.artwork).toBe(1);
    expect(storyReadCacheStats().builds[key]).toBe(buildsBefore + 1);
  });

  it("uses a stable missing revision and heals malformed JSON on bump", async () => {
    const { root, slug } = await fixture();
    expect(await getChapterStatusReadRevision(root, slug)).toBe("missing");
    const path = chapterStatusReadRevisionPath(root, slug);
    await writeFile(path, "{broken");
    expect(await getChapterStatusReadRevision(root, slug)).toBe("missing");
    await invalidateChapterStatusDerivedReads(root, slug);
    expect(await getChapterStatusReadRevision(root, slug)).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
