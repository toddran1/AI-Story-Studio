import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAudioDashboard, getChapter, getChapterPage, getQaDashboard, getStoryOverview, getVideoDashboard, listStories, updateStorySettings } from "../apps/server/catalog.js";
import { Job, JobManager } from "../apps/server/job-manager.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { qaResultSchema } from "../src/domain/qa.js";
import { LLMRouter } from "../src/llm/router.js";
import { PreviewRunner } from "../src/preview/preview-runner.js";
import { SourceProviderRegistry } from "../src/source/registry.js";
import { StorySourceProvider, sourceManifestSchema } from "../src/source/types.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { fingerprint } from "../src/utils/hash.js";
import { MockLLM, MockTTS } from "./helpers.js";
import { AudioMasteringProcessor } from "../src/audio/mastering.js";
import { AudiobookProcessor } from "../src/audio/audiobook.js";
import { VideoProcessor } from "../src/video/renderer.js";
import { VideoExportProcessor } from "../src/video/video-export.js";

const webAudio: AudioMasteringProcessor = { version: "web-audio-v1", master: async (_inputs, output) => { await atomicWrite(output, Buffer.from("mastered")); return { durationSeconds: 9, codec: "mp3", container: "mp3" }; } };
const webBook: AudiobookProcessor = { version: "web-book-v1", assemble: async (_chapters, output, format) => { await atomicWrite(output, Buffer.from("book")); return { durationSeconds: 9, codec: format === "m4b" ? "aac" : "mp3", container: format === "m4b" ? "mp4" : "mp3" }; } };
const webVideo: VideoProcessor = { version: "web-video-v1", render: async (_input, output, settings) => { await atomicWrite(output, Buffer.from("video")); return { durationSeconds: 12, videoCodec: "h264", audioCodec: "aac", width: settings.width, height: settings.height, container: "mp4" }; } };
const webVideoExport: VideoExportProcessor = { version: "web-video-export-v1", assemble: async (_chapters, output) => { await atomicWrite(output, Buffer.from("video-export")); return { durationSeconds: 12, videoCodec: "h264", audioCodec: "aac", width: 1920, height: 1080, container: "mp4" }; } };

const env = loadEnvironment({});
const pending = () => ({ status: "pending" as const });

async function storyFixture() {
  const root = await mkdtemp(join(tmpdir(), "story-web-")); const story = defaultStory("night-lantern", env); story.title = "Night Lantern";
  const paths = storyPaths(root, story.slug, 1); await atomicWriteJson(paths.storyConfig, story); await atomicWriteJson(paths.pipelineConfig, story.pipeline);
  return { root, story, paths };
}

describe("web service layer", () => {
  it("lists stories without exposing environment credentials", async () => {
    const { root } = await storyFixture(); const cards = await listStories(root);
    expect(cards[0]).toMatchObject({ slug: "night-lantern", title: "Night Lantern" });
    expect(JSON.stringify(cards)).not.toMatch(/API_KEY|secret|credential/i);
  });

  it("loads chapter stages and structured QA", async () => {
    const { root, story, paths } = await storyFixture(); const now = new Date().toISOString();
    const complete = { status: "complete" as const, fingerprint: "in", outputFingerprint: "out" };
    const chapter = chapterSchema.parse({ chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, counts: { originalCharacters: 10, englishWords: 8, narrationWords: 8 }, createdAt: now, updatedAt: now,
      stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: pending(), tts: pending() } });
    const qa = qaResultSchema.parse({ status: "warn", score: .76, issues: [{ category: "terminology", severity: "warn", message: "Term drift", evidence: "Bone Cage differs from the canonical term." }], checks: { completeness: "pass", names: "pass", numbers: "pass", terminology: "warn", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" } });
    await atomicWriteJson(paths.chapterMeta, chapter); await atomicWriteJson(paths.qa, qa);
    const detail = await getChapter(root, story.slug, 1); const dashboard = await getQaDashboard(root, story.slug);
    expect(detail.qa?.status).toBe("warn"); expect(dashboard.counts.warn).toBe(1); expect(dashboard.categories.terminology).toBe(1);
  });

  it("inspects and imports an uploaded TXT through existing source services", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-web-import-")); const operations = new StudioOperations(root, env);
    const inspection = await operations.inspectSource({ filename: "chapter.txt", file: Buffer.from("Chapter 1\n\nA lantern wakes."), chapter: 1 });
    expect(inspection.type).toBe("text"); const result = await operations.importInspection("uploaded-story", inspection.id);
    expect(result.chapters).toBe(1); expect((await getStoryOverview(root, "uploaded-story")).counts.chapters).toBe(1);
  });

  it("starts a batch job and exposes terminal status", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-web-job-")); const jobs = new JobManager();
    const operations = new StudioOperations(root, env, jobs, { pipeline: { run: async ({ chapter }) => ({ chapter, quality: { status: "pass", score: 1, issueCategories: [] } }) } });
    const inspection = await operations.inspectSource({ filename: "chapter.txt", file: Buffer.from("A chapter."), chapter: 1 }); await operations.importInspection("job-story", inspection.id);
    const started = operations.startBatch("job-story", { from: 1, to: 1 }); const finished = await waitForJob(jobs, started.id);
    expect(finished.status).toBe("completed"); expect((finished.result as any).summary.complete).toBe(1);
  });

  it("runs mastering and audiobook exports through web jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-web-audio-")); const jobs = new JobManager(); const operations = new StudioOperations(root, env, jobs, { audio: webAudio, audiobook: webBook, video: webVideo, videoExport: webVideoExport });
    const inspection = await operations.inspectSource({ filename: "chapter.txt", file: Buffer.from("A chapter."), chapter: 1 }); const imported = await operations.importInspection("audio-story", inspection.id); const paths = storyPaths(root, imported.story.slug, 1); const manifest = sourceManifestSchema.parse(JSON.parse(await readFile(paths.sourceManifest, "utf8"))); const now = new Date().toISOString(); const complete = { status: "complete" as const, fingerprint: "input", outputFingerprint: "output" };
    await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({ chapter: 1, originalTitle: "Opening", source: { type: manifest.chapters[0]!.ref.sourceType, sourceId: manifest.chapters[0]!.ref.sourceId, fingerprint: manifest.chapters[0]!.fingerprint, metadata: manifest.chapters[0]!.ref.metadata }, sourceLanguage: imported.story.sourceLanguage, outputLanguage: imported.story.outputLanguage, counts: { originalCharacters: 10, englishWords: 2, narrationWords: 2 }, createdAt: now, updatedAt: now,
      stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, tts: complete, audioMastering: pending() } })); await atomicWrite(paths.narration, "The chapter opens. The lantern burns brightly."); await atomicWrite(paths.audioRaw, Buffer.from("raw"));
    const mastering = await waitForJob(jobs, operations.startAudio(imported.story.slug, { from: 1, to: 1 }).id); expect(mastering.status).toBe("completed"); expect((await getAudioDashboard(root, imported.story.slug)).counts.mastered).toBe(1);
    const exportJob = await waitForJob(jobs, operations.startAudiobook(imported.story.slug, { from: 1, to: 1, format: "m4b" }).id); expect(exportJob.status).toBe("completed"); const dashboard = await getAudioDashboard(root, imported.story.slug); expect(dashboard.exports[0]).toMatchObject({ format: "m4b", from: 1, to: 1, downloadUrl: "/api/stories/audio-story/exports/1-1.m4b" });
    expect((await waitForJob(jobs, operations.startSubtitles(imported.story.slug, { from: 1, to: 1 }).id)).status).toBe("completed"); expect((await waitForJob(jobs, operations.startVideo(imported.story.slug, { from: 1, to: 1 }).id)).status).toBe("completed"); expect((await waitForJob(jobs, operations.startVideoExport(imported.story.slug, { from: 1, to: 1 }).id)).status).toBe("completed"); const videoDashboard = await getVideoDashboard(root, imported.story.slug); expect(videoDashboard.counts).toMatchObject({ subtitles: 1, videos: 1 }); expect(videoDashboard.exports[0]?.downloadUrl).toBe("/api/stories/audio-story/video-exports/1-1.mp4");
    await operations.close();
  });

  it("keeps a failed batch result failed at the job boundary", async () => {
    const jobs = new JobManager(); const started = jobs.create("batch", "failed-story", async () => ({ status: "failed", stopReason: "Chapter 7 failed" }));
    const finished = await waitForJob(jobs, started.id);
    expect(finished).toMatchObject({ status: "failed", error: "Chapter 7 failed", result: { status: "failed" } });
  });

  it("reports the selected remote range separately from the available directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-web-range-"));
    const directory = Array.from({ length: 10 }, (_, index) => ({ chapter: index + 1, sourceId: String(index + 1), sourceType: "fanqie" as const, metadata: {} }));
    const provider: StorySourceProvider = { type: "fanqie", inspect: async (sourcePath) => ({ sourcePath, sourceType: "fanqie", fingerprint: fingerprint("range"),
      chapters: directory.slice(4, 6).map((ref) => ({ ref, text: `Chapter ${ref.chapter}` })), directory, warnings: [], unnumberedSections: [], origin: { url: sourcePath },
      remote: { lastInspectedAt: new Date().toISOString(), chapterCountAtInspection: directory.length } }) };
    const operations = new StudioOperations(root, env, new JobManager(), { registry: new SourceProviderRegistry([provider]) });
    const result = await operations.inspectSource({ url: "https://fanqienovel.com/page/123", from: 5, to: 6 });
    expect(result).toMatchObject({ chapterCount: 2, availableChapterCount: 10, chapters: [{ chapter: 5 }, { chapter: 6 }] });
    await operations.close();
  });

  it("hides stale artifacts and omits chapters removed from the current source", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-web-stale-")); const operations = new StudioOperations(root, env);
    let inspection = await operations.inspectSource({ filename: "chapter.txt", file: Buffer.from("Original"), chapter: 101 });
    await operations.importInspection("stale-story", inspection.id);
    const paths = storyPaths(root, "stale-story", 101); const manifest = sourceManifestSchema.parse(JSON.parse(await readFile(paths.sourceManifest, "utf8")));
    const now = new Date().toISOString(); const complete = { status: "complete" as const, fingerprint: "input", outputFingerprint: "output" };
    const metadata = chapterSchema.parse({ chapter: 101, source: { type: "text", sourceId: "chapter.txt", fingerprint: manifest.chapters[0]!.fingerprint, metadata: {} },
      sourceLanguage: "zh-CN", outputLanguage: "en-US", counts: { originalCharacters: 8, englishWords: 1, narrationWords: 1 }, createdAt: now, updatedAt: now,
      stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, tts: complete, audioMastering: complete } });
    await atomicWriteJson(paths.chapterMeta, metadata); await writeFile(paths.audio, Buffer.from("audio"));
    expect(await getStoryOverview(root, "stale-story")).toMatchObject({ counts: { minChapter: 101, maxChapter: 101, complete: 1 } });
    inspection = await operations.inspectSource({ filename: "chapter.txt", file: Buffer.from("Changed"), chapter: 101 }); await operations.importInspection("stale-story", inspection.id);
    const invalidated = JSON.parse(await readFile(paths.chapterMeta, "utf8")); expect(invalidated.stages.ingestion.status).toBe("pending"); expect(invalidated.stages.tts.status).toBe("pending");
    expect(await getChapter(root, "stale-story", 101)).toMatchObject({ stale: true, audioAvailable: false, audioUrl: undefined });
    expect((await getChapterPage(root, "stale-story", { page: 1, pageSize: 50, filter: "all" })).items[0]).toMatchObject({ chapter: 101, translation: "pending", tts: "pending", audioAvailable: false });
    inspection = await operations.inspectSource({ filename: "chapter.txt", file: Buffer.from("Replacement"), chapter: 102 }); await operations.importInspection("stale-story", inspection.id);
    const page = await getChapterPage(root, "stale-story", { page: 1, pageSize: 50, filter: "all" }); expect(page.items.map((item) => item.chapter)).toEqual([102]);
    await operations.close();
  });

  it("runs isolated previews and applies the selected profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-web-preview-")); const jobs = new JobManager();
    const gemini = new MockLLM("gemini", ["Translation A"]); const openai = new MockLLM("openai", ["Narration A", "Translation B", "Narration B"]);
    const preview = new PreviewRunner(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), new MockTTS());
    const operations = new StudioOperations(root, env, jobs, { preview }); const inspection = await operations.inspectSource({ filename: "chapter.txt", file: Buffer.from("A chapter."), chapter: 1 }); const imported = await operations.importInspection("preview-story", inspection.id); const story = imported.story;
    const a = { translation: story.pipeline.translation, narration: story.pipeline.narration, qa: story.pipeline.qa, tts: story.pipeline.tts };
    const b = { ...a, translation: { provider: "openai" as const, model: "translation-b" } };
    const started = operations.startPreview(story.slug, { chapter: 1, audioPreview: true, presets: { a, b } }); const finished = await waitForJob(jobs, started.id);
    expect(finished.status).toBe("completed"); const id = (finished.result as any).id; const result = await operations.getPreview(story.slug, id);
    expect(result.translationA).toBe("Translation A"); const selected = await operations.selectPreview(story.slug, id, "b"); expect(selected.pipeline.translation).toEqual(b.translation);
  });

  it("validates settings and rejects credential-shaped fields", async () => {
    const { root, story } = await storyFixture(); const valid = { title: "Revised", sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, recentChapterSummaries: 4,
      translation: story.pipeline.translation, narration: story.pipeline.narration, qa: story.pipeline.qa, tts: { referenceId: "voice", speed: 1.1 } };
    expect((await updateStorySettings(root, story.slug, valid)).title).toBe("Revised");
    await expect(updateStorySettings(root, story.slug, { ...valid, OPENAI_API_KEY: "must-not-pass" })).rejects.toThrow();
  });

  it("refreshes a remote directory with the existing comparison service", async () => {
    const { root, story, paths } = await storyFixture(); story.source = { type: "fanqie", url: "https://fanqienovel.com/page/123", path: "source" }; await atomicWriteJson(paths.storyConfig, story);
    const first = { chapter: 1, sourceId: "one", sourceType: "fanqie" as const, metadata: {} }; const second = { chapter: 2, sourceId: "two", sourceType: "fanqie" as const, metadata: {} };
    const manifest = sourceManifestSchema.parse({ version: 1, adapterVersion: "test", type: "fanqie", origin: { url: story.source.url, bookId: "123" }, fingerprint: "a".repeat(64), importedAt: new Date().toISOString(), remote: { lastInspectedAt: new Date().toISOString(), chapterCountAtInspection: 1, directory: [first] }, warnings: [], unnumberedSections: [], chapters: [] }); await atomicWriteJson(paths.sourceManifest, manifest);
    const provider: StorySourceProvider = { type: "fanqie", inspect: async (sourcePath) => ({ sourcePath, sourceType: "fanqie", fingerprint: fingerprint("remote"), chapters: [], directory: [first, second], warnings: [], unnumberedSections: [], origin: { url: sourcePath }, remote: { lastInspectedAt: new Date().toISOString(), chapterCountAtInspection: 2 } }) };
    const operations = new StudioOperations(root, env, new JobManager(), { registry: new SourceProviderRegistry([provider]) }); const result = await operations.refreshRemote(story.slug, false);
    expect(result.currentCount).toBe(2); expect(result.added.map((item) => item.chapter)).toEqual([2]);
  });
});

function waitForJob(jobs: JobManager, id: string): Promise<Job> {
  return new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("Job timed out")), 3000); const unsubscribe = jobs.subscribe(id, (job) => { if (["completed", "failed", "paused"].includes(job.status)) { clearTimeout(timeout); unsubscribe?.(); resolve(job); } }); });
}
