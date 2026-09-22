import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getAudioDashboard, getChapter, getChapterPage, getQaDashboard, getScenesDashboard, getStoryDashboard, getStoryOverview, getVideoDashboard, listStories, updateStorySettings } from "../apps/server/catalog.js";
import { Job, JobManager } from "../apps/server/job-manager.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { canonicalEntitySchema, emptyStoryBible } from "../src/domain/story-bible.js";
import { qaResultSchema } from "../src/domain/qa.js";
import { LLMRouter } from "../src/llm/router.js";
import { PreviewRunner } from "../src/preview/preview-runner.js";
import { SourceProviderRegistry } from "../src/source/registry.js";
import { importSource, loadImportedChapters } from "../src/source/importer.js";
import { StorySourceProvider, sourceManifestSchema } from "../src/source/types.js";
import { NovelSourceProvider } from "../src/source/novel-provider.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { exists, readJsonIfExists } from "../src/storage/story-files.js";
import { fingerprint } from "../src/utils/hash.js";
import { addVisualReferenceImage, saveVisualProfiles } from "../src/visual-canon/profiles.js";
import { fileFingerprint } from "../src/utils/file-fingerprint.js";
import { MockLLM, MockTTS } from "./helpers.js";
import { AudioMasteringProcessor } from "../src/audio/mastering.js";
import { AudiobookProcessor } from "../src/audio/audiobook.js";
import { VideoProcessor } from "../src/video/renderer.js";
import { VideoExportProcessor } from "../src/video/video-export.js";
import { ImageProvider } from "../src/artwork/provider.js";
import { ImageProviderRouter } from "../src/artwork/router.js";
import { chapterParam, continuityStatusFilter, createApiHandler, entitySortFilter, entityTypeFilter, integerParam, publicJob, statusFor, validateLocalRequest, validationIssues } from "../apps/server/api.js";
import { PassThrough, Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { SourceConflictError, SourceInputError, SourceUpstreamError, SourceValidationError } from "../src/source/errors.js";
import { ConfigurationError, SceneError } from "../src/pipeline/errors.js";
import { SummaryArtifactNotFoundError } from "../src/summaries/visuals.js";
import { QaFindingLifecycleConflictError } from "../src/qa/review.js";

const webAudio: AudioMasteringProcessor = { version: "web-audio-v1", master: async (_inputs, output) => { await atomicWrite(output, Buffer.from("mastered")); return { durationSeconds: 9, codec: "mp3", container: "mp3" }; } };
const webBook: AudiobookProcessor = { version: "web-book-v1", assemble: async (_chapters, output, format) => { await atomicWrite(output, Buffer.from("book")); return { durationSeconds: 9, codec: format === "m4b" ? "aac" : "mp3", container: format === "m4b" ? "mp4" : "mp3" }; } };
const webVideo: VideoProcessor = { version: "web-video-v1", render: async (_input, output, settings) => { await atomicWrite(output, Buffer.from("video")); return { durationSeconds: 12, videoCodec: "h264", audioCodec: "aac", width: settings.width, height: settings.height, container: "mp4" }; } };
const webVideoExport: VideoExportProcessor = { version: "web-video-export-v1", assemble: async (_chapters, output) => { await atomicWrite(output, Buffer.from("video-export")); return { durationSeconds: 12, videoCodec: "h264", audioCodec: "aac", width: 1920, height: 1080, container: "mp4" }; } };
const webImages: ImageProvider = { name: "openai", version: "web-images-v1", validateConfiguration: async () => undefined, generate: async () => ({ data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), mimeType: "image/png" }) };
const webScenePlanner = new MockLLM("openai"); webScenePlanner.generateStructured = async (request: any) => ({ value: request.schema.parse({ scenes: [{ summary: "The lantern wakes.", startSeconds: 0, endSeconds: 9, characters: [], location: "Tower", visualPrompt: "A blue lantern wakes in a dark tower", importance: "major" }] }) });

const env = loadEnvironment({});
const pending = () => ({ status: "pending" as const });

async function storyFixture() {
  const root = await mkdtemp(join(tmpdir(), "story-web-")); const story = defaultStory("night-lantern", env); story.title = "Night Lantern";
  const paths = storyPaths(root, story.slug, 1); await atomicWriteJson(paths.storyConfig, story); await atomicWriteJson(paths.pipelineConfig, story.pipeline);
  return { root, story, paths };
}

describe("web service layer", () => {
  it("serves controlled visual references for viewing and original-resolution download", async () => {
    const { root, story, paths } = await storyFixture();
    const entityId = "ent_0123456789abcdef01234567";
    await atomicWriteJson(paths.bible, { ...emptyStoryBible(), canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Su Ming", aliases: [], description: "", firstAppearance: 1, lastKnownAppearance: 1 })] });
    const created = await addVisualReferenceImage(root, story.slug, entityId, { data: Buffer.from("original-reference-image"), ext: "png", source: "style_sheet", approved: false });
    const operations = { root, getVisualProfile: async () => created.profile } as unknown as StudioOperations;
    const handler = createApiHandler(operations);
    const request = async (suffix = "") => {
      const req = Object.assign(Readable.from([]), { method: "GET", url: `/api/stories/${story.slug}/visual-profiles/${entityId}/references/${created.reference.id}${suffix}`, headers: { host: "localhost:3000" } });
      const headers: Record<string, unknown> = {}; const chunks: Buffer[] = [];
      const res = Object.assign(new PassThrough(), { writeHead: (status: number, values?: Record<string, unknown>) => { headers.status = status; Object.assign(headers, values); } });
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      const done = new Promise<void>((resolve) => res.on("finish", resolve));
      await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse); await done;
      return { headers, body: Buffer.concat(chunks) };
    };
    const view = await request();
    expect(view.headers).toMatchObject({ status: 200, "content-type": "image/png" });
    expect(view.body).toEqual(Buffer.from("original-reference-image"));
    const download = await request("?download=1");
    expect(download.headers).toMatchObject({ status: 200, "content-type": "image/png", "content-disposition": 'attachment; filename="su-ming-style-sheet.png"' });
    expect(download.body).toEqual(view.body);
  });
  it("classifies malformed pagination as an HTTP 400 client error", () => { expect(() => integerParam("abc", 1)).toThrow(expect.objectContaining({ status: 400 })); expect(() => integerParam("0", 1)).toThrow(expect.objectContaining({ status: 400 })); expect(integerParam(null, 7)).toBe(7); });
  it("rejects zero chapter routes and unknown Story Bible filters as client errors", () => {
    expect(() => chapterParam("0")).toThrow(expect.objectContaining({ status: 400 })); expect(chapterParam("1501")).toBe(1501);
    expect(() => entityTypeFilter("bogus")).toThrow(z.ZodError); expect(() => entitySortFilter("bogus")).toThrow(z.ZodError); expect(() => continuityStatusFilter("bogus")).toThrow(z.ZodError);
  });
  it("classifies a missing story configuration as HTTP 404 through wrapped causes", () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(statusFor(new ConfigurationError("Unable to load story configuration", { cause: missing }))).toBe(404);
  });
  it("classifies expected source failures as actionable HTTP responses", () => {
    expect(statusFor(new SourceInputError("bad source"))).toBe(400); expect(statusFor(new SourceConflictError("replacement"))).toBe(409);
    expect(statusFor(new SourceValidationError("invalid chapter"))).toBe(422); expect(statusFor(new SourceUpstreamError("provider failed"))).toBe(502);
  });
  it("classifies invalid summary scenes and unavailable summary media as client errors", () => {
    expect(statusFor(new SceneError("scene-001 has an invalid time range"))).toBe(400);
    expect(statusFor(new SummaryArtifactNotFoundError("Summary video is missing or damaged; generate it first"))).toBe(404);
  });
  it("classifies QA lifecycle conflicts as recoverable client conflicts", () => {
    expect(statusFor(new QaFindingLifecycleConflictError("QA_FINDING_ALREADY_RESOLVED", "already resolved"))).toBe(409);
    expect(statusFor(new QaFindingLifecycleConflictError("QA_FINDING_ALREADY_OPEN", "already open"))).toBe(409);
  });
  it("exposes safe field paths for invalid editable input", () => {
    const failure = z.object({ tts: z.object({ model: z.string().min(1) }) }).safeParse({ tts: { model: "" } });
    expect(failure.success).toBe(false);
    if (!failure.success) expect(validationIssues(failure.error)).toEqual([expect.objectContaining({ path: "tts.model", code: "too_small" })]);
  });
  it("rejects cross-site and non-JSON mutation requests at the localhost API boundary", () => {
    expect(() => validateLocalRequest({ method: "POST", headers: { host: "localhost:3000", origin: "https://attacker.example", "content-type": "application/json" } })).toThrow("Cross-origin");
    expect(() => validateLocalRequest({ method: "POST", headers: { host: "attacker.example", "content-type": "application/json" } })).toThrow("localhost");
    expect(() => validateLocalRequest({ method: "POST", headers: { host: "localhost:3000", "content-type": "text/plain" } })).toThrow("require application/json");
    expect(() => validateLocalRequest({ method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json; charset=utf-8" } })).not.toThrow();
  });

  it("removes local filesystem paths from public job payloads", () => {
    const publicValue = publicJob({ status: "completed", result: { output: "/Users/example/story.mp4", url: "/api/stories/example/video" }, progress: { temporary: "/tmp/render.mp4" }, error: "Failed under /Users/example/stories/example" }, "/Users/example");
    expect(publicValue).toEqual({ status: "completed", result: { url: "/api/stories/example/video" }, progress: {}, error: "Failed under [project]/stories/example" });
  });

  it("lists stories without exposing environment credentials", async () => {
    const { root } = await storyFixture(); const cards = await listStories(root);
    expect(cards[0]).toMatchObject({ slug: "night-lantern", title: "Night Lantern" });
    expect(JSON.stringify(cards)).not.toMatch(/API_KEY|secret|credential/i);
  });

  it("restores preserved original metadata when output returns to the source language", async () => {
    const { root, story, paths } = await storyFixture(); story.title = "Night Lantern"; story.author = "Translated Author"; story.description = "Translated description"; story.tags = ["fantasy"];
    story.outputLanguage = "zh-CN"; story.metadataTranslationSource = { title: "夜灯", author: "原作者", description: "原始简介", tags: ["玄幻"], language: "zh-CN" }; story.metadataTranslatedAt = new Date().toISOString(); await atomicWriteJson(paths.storyConfig, story);
    const jobs = new JobManager(); const operations = new StudioOperations(root, env, jobs); const result = await waitForJob(jobs, operations.startMetadataTranslation(story.slug).id);
    expect(result.status).toBe("completed"); expect((await readJsonIfExists<any>(paths.storyConfig))).toMatchObject({ title: "夜灯", author: "原作者", description: "原始简介", tags: ["玄幻"] });
    expect((await readJsonIfExists<any>(paths.storyConfig))).not.toHaveProperty("metadataTranslatedAt"); await operations.close();
  });

  it("keeps healthy library entries when another project is corrupt", async () => {
    const { root } = await storyFixture(); const broken = storyPaths(root, "broken-story", 1); await atomicWriteJson(broken.storyConfig, { title: "missing required fields" });
    const warnings: string[] = []; const cards = await listStories(root, warnings); expect(cards.map((item) => item.slug)).toEqual(["night-lantern"]); expect(warnings[0]).toContain("broken-story");
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

  it("dismisses selected QA findings without deleting their evidence", async () => {
    const { root, story, paths } = await storyFixture(); const now = new Date().toISOString();
    const complete = { status: "complete" as const, fingerprint: "in", outputFingerprint: "out" }; const retainedQa = pending();
    const chapter = chapterSchema.parse({ chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, counts: { originalCharacters: 10, englishWords: 8, narrationWords: 8 }, createdAt: now, updatedAt: now,
      stages: { ingestion: complete, translation: complete, narration: complete, qa: retainedQa, storyBible: pending(), tts: pending() }, quality: { status: "warn", score: .86, issueCategories: ["dialogue"] } });
    const qa = qaResultSchema.parse({ status: "warn", score: .86, issues: [{ category: "dialogue", severity: "warn", message: "A threat is softened", evidence: "The meaning remains clear." }], checks: { completeness: "pass", names: "pass", numbers: "pass", terminology: "pass", dialogue: "warn", storyConsistency: "pass", narrationFidelity: "pass" } });
    await atomicWriteJson(paths.chapterMeta, chapter); await atomicWriteJson(paths.qa, qa);
    const operations = new StudioOperations(root, env);
    const result = await operations.dismissQaFindings(story.slug, 1, { issueIndexes: [0] });
    expect(result.qa.status).toBe("pass"); expect(result.qa.issues[0]).toMatchObject({ message: "A threat is softened", review: { disposition: "dismissed" } });
    const detail = await getChapter(root, story.slug, 1); const dashboard = await getQaDashboard(root, story.slug);
    expect(detail.qa?.issues[0]?.review?.disposition).toBe("dismissed"); expect(detail.qa?.originalScore).toBe(.86); expect(detail.metadata?.quality).toEqual({ status: "pass", score: 1, issueCategories: [] });
    expect(detail.metadata?.stages.qa.status).toBe("pending"); expect(detail.qaStale).toBe(true);
    expect(detail.metadata?.stages.qa.outputFingerprint).toBe(await fileFingerprint(paths.qa));
    expect(dashboard.counts.pass).toBe(1); expect(dashboard.chapters[0]?.issues).toEqual([]);
    await operations.close();
  });

  it("repairs selected QA findings with the configured model and invalidates the old QA result", async () => {
    const { root, story, paths } = await storyFixture(); const now = new Date().toISOString(); const complete = { status: "complete" as const, fingerprint: "in", outputFingerprint: "out" };
    const current = "The lantern keeper crossed the silent courtyard and carefully counted ten blue flames. ".repeat(12);
    const repaired = current.replace("ten blue flames", "the ten canonical azure flames");
    const chapter = chapterSchema.parse({ chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, counts: { originalCharacters: 100, englishWords: 120, narrationWords: 120 }, createdAt: now, updatedAt: now, stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: pending(), tts: pending() } });
    const qa = qaResultSchema.parse({ status: "warn", score: .8, issues: [{ category: "terminology", severity: "warn", message: "Use the canonical ability name", evidence: "Azure Flame is the locked term." }], checks: { completeness: "pass", names: "pass", numbers: "pass", terminology: "warn", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" } });
    await atomicWriteJson(paths.chapterMeta, chapter); await atomicWriteJson(paths.qa, qa); await atomicWrite(paths.original, "守灯人穿过庭院。".repeat(50)); await atomicWrite(paths.english, current); await atomicWrite(paths.narration, current); await atomicWriteJson(paths.storyContext, {});
    const gemini = new MockLLM("gemini", [repaired]); const openai = new MockLLM("openai", [repaired]); const jobs = new JobManager(); const operations = new StudioOperations(root, env, jobs, { llm: new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])) });
    const finished = await waitForJob(jobs, operations.startQaRepair(story.slug, 1, { issueIndexes: [0] }).id);
    expect(finished.status).toBe("completed"); expect(await readFile(paths.english, "utf8")).toBe(repaired.trim());
    const retained = await getChapter(root, story.slug, 1); expect(retained.qa?.status).toBe("warn"); expect(retained.qaStale).toBe(true);
    expect((await readJsonIfExists<any>(paths.chapterMeta))?.stages).toMatchObject({ translation: { provider: "manual", model: "studio-editor" }, qa: { status: "pending" } });
    await operations.close();
  });

  it("rechecks retained artifacts through QA only", async () => {
    const { root, story, paths } = await storyFixture(); const now = new Date().toISOString(); const pendingStage = pending();
    const chapter = chapterSchema.parse({ chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, counts: { originalCharacters: 100, englishWords: 2, narrationWords: 2 }, createdAt: now, updatedAt: now,
      stages: { ingestion: pendingStage, translation: pending(), narration: pending(), qa: pending(), storyBible: pending(), tts: pending() } });
    await atomicWriteJson(paths.chapterMeta, chapter); await atomicWrite(paths.original, "原文".repeat(100)); await atomicWrite(paths.english, "Retained translation."); await atomicWrite(paths.narration, "Retained narration.");
    const openai = new MockLLM("openai"); const gemini = new MockLLM("gemini"); const jobs = new JobManager(); const operations = new StudioOperations(root, env, jobs, { llm: new LLMRouter(new Map([["openai", openai], ["gemini", gemini]])) });
    const finished = await waitForJob(jobs, operations.startQaRecheck(story.slug, 1).id);
    expect(finished.status).toBe("completed"); expect(finished.result).toMatchObject({ chapter: 1, qaOnly: true });
    expect(openai.calls).toHaveLength(1); expect(openai.calls[0]).toMatchObject({ structured: true, schemaName: "chapter_qa" }); expect(gemini.calls).toHaveLength(0);
    expect(await readFile(paths.english, "utf8")).toBe("Retained translation."); expect(await readFile(paths.narration, "utf8")).toBe("Retained narration.");
    const after = chapterSchema.parse(await readJsonIfExists(paths.chapterMeta)); expect(after.stages.qa).toMatchObject({ status: "complete", provider: "openai" }); expect(after.stages.translation.status).toBe("pending"); expect(after.stages.narration.status).toBe("pending");
    await operations.close();
  });

  it("inspects and imports an uploaded TXT through existing source services", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-web-import-")); const operations = new StudioOperations(root, env);
    const inspection = await operations.inspectSource({ filename: "chapter.txt", file: Buffer.from("Chapter 1\n\nA lantern wakes."), chapter: 1 });
    expect(inspection.type).toBe("text"); const result = await operations.importInspection("uploaded-story", inspection.id);
    expect(result.chapters).toBe(1); expect((await getStoryOverview(root, "uploaded-story")).counts.chapters).toBe(1);
  });

  it("inspects an uploaded chapter folder in numeric chapter order", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-web-folder-")); const operations = new StudioOperations(root, env);
    const inspection = await operations.inspectSource({ files: [{ name: "chapter-010.txt", text: "Ten" }, { name: "chapter-002.txt", text: "Two" }] });
    expect(inspection.chapters.map((item) => item.chapter)).toEqual([2, 10]); await operations.close();
  });

  it("previews and applies additive chapter updates without removing earlier chapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-web-update-")); const operations = new StudioOperations(root, env);
    const initial = await operations.inspectSource({ files: [{ name: "chapter-001.txt", text: "One" }, { name: "chapter-002.txt", text: "Two" }], allowGaps: true });
    await operations.importInspection("update-story", initial.id, true);
    const later = await operations.inspectSource({ files: [{ name: "chapter-029.txt", text: "Twenty nine" }, { name: "chapter-030.txt", text: "Thirty" }], allowGaps: true }, { story: "update-story", additive: true });
    expect(later.update).toMatchObject({ existingCount: 2, afterCount: 4, added: [29, 30], replaced: [], preservedCount: 2, missingCount: 26 });
    await operations.importInspection("update-story", later.id, true);
    expect((await loadImportedChapters(root, "update-story")).chapters.map((item) => item.chapter)).toEqual([1, 2, 29, 30]);
    expect((await getChapter(root, "update-story", 29)).navigation).toMatchObject({ previous: { chapter: 2 }, next: { chapter: 30 } });
    expect((await getChapter(root, "update-story", 1)).navigation).toMatchObject({ next: { chapter: 2 } });
    await operations.close();
  });

  it("cleans inspection temp data when validation fails during file setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-web-cleanup-")); const operations = new StudioOperations(root, env); const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("ai-story-studio-")));
    await expect(operations.inspectSource({ files: [{ name: "chapter.txt", text: "one" }, { name: "CHAPTER.TXT", text: "two" }] })).rejects.toThrow("Duplicate chapter filename");
    const leaked = (await readdir(tmpdir())).filter((name) => name.startsWith("ai-story-studio-") && !before.has(name)); expect(leaked).toEqual([]); await operations.close();
  });

  it("rolls back a newly created project when its inspection cannot be imported", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-web-transaction-")); const operations = new StudioOperations(root, env);
    await expect(operations.createStoryWithInspection({ ...metadataFor("atomic-story") }, randomUUID())).rejects.toThrow("Inspection expired"); expect(await exists(storyPaths(root, "atomic-story", 1).story)).toBe(false); await operations.close();
  });

  it("starts a batch job and exposes terminal status", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-web-job-")); const jobs = new JobManager();
    const operations = new StudioOperations(root, env, jobs, { pipeline: { run: async ({ chapter }) => ({ chapter, quality: { status: "pass", score: 1, issueCategories: [] } }) } });
    const inspection = await operations.inspectSource({ filename: "chapter.txt", file: Buffer.from("A chapter."), chapter: 1 }); await operations.importInspection("job-story", inspection.id);
    const started = operations.startBatch("job-story", { from: 1, to: 1, continueOnError: true }); const finished = await waitForJob(jobs, started.id);
    expect(finished.status).toBe("completed"); expect((finished.result as any).summary.complete).toBe(1); expect((finished.result as any).options.continueOnError).toBe(true);
  });

  it("plans and runs a no-cost production job through the web job boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-web-production-")); const jobs = new JobManager(); const operations = new StudioOperations(root, env, jobs, { pipeline: { run: async ({ chapter }) => ({ chapter, quality: { status: "pass", score: 1, issueCategories: [] } }) } });
    const inspection = await operations.inspectSource({ filename: "chapter.txt", file: Buffer.from("A chapter."), chapter: 1 }); await operations.importInspection("production-story", inspection.id);
    const plan = await operations.productionPlan("production-story", { from: 1, to: 1, outputs: ["audio"] }); expect(plan.stages).toContain("audioMastering"); expect(plan.stages).not.toContain("video");
    const finished = await waitForJob(jobs, operations.startProduction("production-story", { from: 1, to: 1, outputs: ["audio"] }).id); expect(finished.status).toBe("completed"); expect((finished.result as any).summary.completed).toBe(1); await operations.close();
  });

  it("runs mastering and audiobook exports through web jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-web-audio-")); const jobs = new JobManager(); const operations = new StudioOperations(root, env, jobs, { audio: webAudio, audiobook: webBook, video: webVideo, videoExport: webVideoExport, scenePlanner: webScenePlanner, image: webImages });
    const inspection = await operations.inspectSource({ filename: "chapter.txt", file: Buffer.from("A chapter."), chapter: 1 }); const imported = await operations.importInspection("audio-story", inspection.id); const paths = storyPaths(root, imported.story.slug, 1); const manifest = sourceManifestSchema.parse(JSON.parse(await readFile(paths.sourceManifest, "utf8"))); const now = new Date().toISOString(); const complete = { status: "complete" as const, fingerprint: "input", outputFingerprint: "output" };
    await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({ chapter: 1, originalTitle: "Opening", source: { type: manifest.chapters[0]!.ref.sourceType, sourceId: manifest.chapters[0]!.ref.sourceId, fingerprint: manifest.chapters[0]!.contentFingerprint!, metadata: manifest.chapters[0]!.ref.metadata }, sourceLanguage: imported.story.sourceLanguage, outputLanguage: imported.story.outputLanguage, counts: { originalCharacters: 10, englishWords: 2, narrationWords: 2 }, createdAt: now, updatedAt: now,
      stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, tts: complete, audioMastering: pending() } })); await atomicWrite(paths.narration, "The chapter opens. The lantern burns brightly."); await atomicWrite(paths.audioRaw, Buffer.from("raw"));
    const mastering = await waitForJob(jobs, operations.startAudio(imported.story.slug, { from: 1, to: 1 }).id); expect(mastering.status).toBe("completed"); expect((await getAudioDashboard(root, imported.story.slug)).counts.mastered).toBe(1);
    const exportJob = await waitForJob(jobs, operations.startAudiobook(imported.story.slug, { from: 1, to: 1, format: "m4b" }).id); expect(exportJob.status).toBe("completed"); const dashboard = await getAudioDashboard(root, imported.story.slug); expect(dashboard.exports[0]).toMatchObject({ format: "m4b", from: 1, to: 1, downloadUrl: "/api/stories/audio-story/exports/1-1.m4b" }); expect(dashboard.exports[0]).not.toHaveProperty("output"); expect(JSON.stringify(dashboard)).not.toContain(root);
    await atomicWrite(join(root, "stories", imported.story.slug, "exports", "interrupted.m4b.json"), Buffer.from("M4A binary data"));
    expect((await getAudioDashboard(root, imported.story.slug)).exports).toHaveLength(1);
    await atomicWrite(join(root, "stories", imported.story.slug, "exports", "._audio-story-001-001.m4b.json"), Buffer.from([0, 5, 22, 7, 0, 2, 0, 0, 77, 97]));
    const warnings: string[] = []; expect(await listStories(root, warnings)).toHaveLength(1); expect(warnings).toEqual([]);
    expect((await getAudioDashboard(root, imported.story.slug)).exports).toHaveLength(1);
    await atomicWrite(join(root, "stories", imported.story.slug, "exports", "audio-story-001-001.m4b.json"), Buffer.from("M4A interrupted manifest"));
    expect((await waitForJob(jobs, operations.startAudiobook(imported.story.slug, { from: 1, to: 1, format: "m4b" }).id)).status).toBe("completed");
    expect((await getAudioDashboard(root, imported.story.slug)).exports).toHaveLength(1);
    expect((await waitForJob(jobs, operations.startSubtitles(imported.story.slug, { from: 1, to: 1 }).id)).status).toBe("completed"); expect((await waitForJob(jobs, operations.startVideo(imported.story.slug, { from: 1, to: 1 }).id)).status).toBe("completed"); expect((await waitForJob(jobs, operations.startVideoExport(imported.story.slug, { from: 1, to: 1 }).id)).status).toBe("completed"); const videoDashboard = await getVideoDashboard(root, imported.story.slug); expect(videoDashboard.counts).toMatchObject({ subtitles: 1, videos: 1 }); expect(videoDashboard.exports[0]?.downloadUrl).toBe("/api/stories/audio-story/video-exports/1-1.mp4");
    expect((await waitForJob(jobs, operations.startScenes(imported.story.slug, { from: 1, to: 1 }).id)).status).toBe("completed"); const estimate = await waitForJob(jobs, operations.startArtwork(imported.story.slug, { from: 1, to: 1, dryRun: true }).id); expect(estimate.result).toMatchObject({ dryRun: true, imageCountEstimate: 1 }); expect((await waitForJob(jobs, operations.startArtwork(imported.story.slug, { from: 1, to: 1 }).id)).status).toBe("completed"); const scenes = await getScenesDashboard(root, imported.story.slug, 1); expect(scenes.manifest?.scenes[0]).toMatchObject({ summary: "The lantern wakes.", imageUrl: "/api/stories/audio-story/chapters/1/scenes/scene-001.png" });
    const staleMetadata = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8")));
    staleMetadata.stages.audioMastering = { status: "pending", staleReason: "Narration settings changed" }; await atomicWriteJson(paths.chapterMeta, staleMetadata);
    const staleDashboard = await getAudioDashboard(root, imported.story.slug);
    expect(staleDashboard.counts).toMatchObject({ mastered: 1, current: 0, stale: 1 }); expect(staleDashboard.exports).toHaveLength(1);
    expect((await waitForJob(jobs, operations.startAudiobook(imported.story.slug, { from: 1, to: 1, format: "m4b" }).id)).status).toBe("completed");
    await operations.close();
  });

  it("routes artwork, style sheets, and the scenes dashboard through the story's image provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-web-image-routing-"));
    const openaiCalls: unknown[] = []; const geminiCalls: unknown[] = [];
    const openaiImages: ImageProvider = { ...webImages, generate: async (request) => { openaiCalls.push(request); return webImages.generate(request); } };
    const geminiImages: ImageProvider = { name: "gemini", version: "web-gemini-images-v1", validateConfiguration: async () => undefined, generate: async (request) => { geminiCalls.push(request); return { data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), mimeType: "image/png" as const }; } };
    const router = new ImageProviderRouter(new Map([["openai", openaiImages], ["gemini", geminiImages]]));
    const jobs = new JobManager(); const operations = new StudioOperations(root, env, jobs, { audio: webAudio, video: webVideo, scenePlanner: webScenePlanner, image: router });
    const inspection = await operations.inspectSource({ filename: "chapter.txt", file: Buffer.from("A chapter."), chapter: 1 }); const imported = await operations.importInspection("image-routing-story", inspection.id);
    const paths = storyPaths(root, imported.story.slug, 1);
    const storyConfig = JSON.parse(await readFile(paths.storyConfig, "utf8"));
    storyConfig.artwork = { ...storyConfig.artwork, provider: "gemini", model: "gemini-3.1-flash-image" };
    await atomicWriteJson(paths.storyConfig, storyConfig);
    const manifest = sourceManifestSchema.parse(JSON.parse(await readFile(paths.sourceManifest, "utf8"))); const now = new Date().toISOString();
    const complete = { status: "complete" as const, fingerprint: "input", outputFingerprint: "output" };
    await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({ chapter: 1, originalTitle: "Opening", source: { type: manifest.chapters[0]!.ref.sourceType, sourceId: manifest.chapters[0]!.ref.sourceId, fingerprint: manifest.chapters[0]!.contentFingerprint!, metadata: manifest.chapters[0]!.ref.metadata }, sourceLanguage: imported.story.sourceLanguage, outputLanguage: imported.story.outputLanguage, counts: { originalCharacters: 10, englishWords: 2, narrationWords: 2 }, createdAt: now, updatedAt: now,
      stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, tts: complete, audioMastering: complete }, audio: { durationSeconds: 9, codec: "mp3", container: "mp3" } }));
    await atomicWrite(paths.narration, "The chapter opens. The lantern burns brightly."); await atomicWrite(paths.audio, Buffer.from("mastered"));
    expect((await waitForJob(jobs, operations.startScenes(imported.story.slug, { from: 1, to: 1 }).id)).status).toBe("completed");
    const artwork = await waitForJob(jobs, operations.startArtwork(imported.story.slug, { from: 1, to: 1 }).id);
    expect(artwork.status).toBe("completed");
    expect(geminiCalls.length).toBeGreaterThan(0); expect(openaiCalls).toHaveLength(0);
    const scenes = await getScenesDashboard(root, imported.story.slug, 1);
    expect(scenes.artworkRouting).toMatchObject({ provider: "gemini", model: "gemini-3.1-flash-image" });
    expect(scenes.artworkRouting?.availableProviders.map((provider) => provider.name).sort()).toEqual(["gemini", "openai"]);
    const entityId = "ent_0123456789abcdef01234567";
    await atomicWriteJson(paths.bible, { ...emptyStoryBible(), canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Li Chen", aliases: [], description: "Young swordsman.", firstAppearance: 1, lastKnownAppearance: 1 })] });
    await saveVisualProfiles(root, imported.story.slug, { [entityId]: { id: "vp-1", entityId, visualType: "character", status: "approved", revision: 1, createdAt: now, updatedAt: now, appearance: "Tall, raven hair.", visualPrompt: "young swordsman, raven hair", notes: "", negativePrompt: "", variants: [], references: [] } });
    const before = geminiCalls.length;
    const sheet = await operations.generateStyleSheet(imported.story.slug, entityId);
    expect(sheet.reference.source).toBe("style_sheet");
    expect(geminiCalls.length).toBe(before + 1); expect(openaiCalls).toHaveLength(0);
    await operations.close();
  });

  it("keeps a failed batch result failed at the job boundary", async () => {
    const jobs = new JobManager(); const started = jobs.create("batch", "failed-story", async () => ({ status: "failed", stopReason: "Chapter 7 failed" }));
    const finished = await waitForJob(jobs, started.id);
    expect(finished).toMatchObject({ status: "failed", error: "Chapter 7 failed", result: { status: "failed" } });
    expect(finished.diagnostic).toMatchObject({ chapter: 7, summary: "Chapter 7 failed", retryable: false });
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
    await operations.importInspection("remote-story", result.id, true);
    expect(await getStoryDashboard(root, "remote-story")).toMatchObject({
      story: { source: { type: "fanqie", url: "https://fanqienovel.com/page/123" } },
      source: { origin: { url: "https://fanqienovel.com/page/123" } },
    });
    await operations.close();
  });

  it("hides stale artifacts and omits chapters removed from the current source", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-web-stale-")); const operations = new StudioOperations(root, env);
    let inspection = await operations.inspectSource({ filename: "chapter.txt", file: Buffer.from("Original"), chapter: 101 });
    await operations.importInspection("stale-story", inspection.id);
    const paths = storyPaths(root, "stale-story", 101); const manifest = sourceManifestSchema.parse(JSON.parse(await readFile(paths.sourceManifest, "utf8")));
    const now = new Date().toISOString(); const complete = { status: "complete" as const, fingerprint: "input", outputFingerprint: "output" };
    const metadata = chapterSchema.parse({ chapter: 101, source: { type: "text", sourceId: "chapter.txt", fingerprint: manifest.chapters[0]!.contentFingerprint!, metadata: {} },
      sourceLanguage: "zh-CN", outputLanguage: "en-US", counts: { originalCharacters: 8, englishWords: 1, narrationWords: 1 }, createdAt: now, updatedAt: now,
      stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, tts: complete, audioMastering: complete } });
    await atomicWriteJson(paths.chapterMeta, metadata); await writeFile(paths.audio, Buffer.from("audio"));
    expect(await getStoryOverview(root, "stale-story")).toMatchObject({ counts: { minChapter: 101, maxChapter: 101, complete: 1 } });
    expect(await getChapter(root, "stale-story", 101)).toMatchObject({ stale: false, audioAvailable: true, audioStale: false });
    expect((await getChapterPage(root, "stale-story", { page: 1, pageSize: 50, filter: "all" })).items[0]).toMatchObject({ translation: "complete", narration: "complete" });
    inspection = await operations.inspectSource({ filename: "chapter.txt", file: Buffer.from("Changed"), chapter: 101 });
    await expect(operations.importInspection("stale-story", inspection.id)).rejects.toThrow(/explicitly confirm replacement/);
    await operations.importInspection("stale-story", inspection.id, false, true);
    const invalidated = JSON.parse(await readFile(paths.chapterMeta, "utf8")); expect(invalidated.stages.ingestion.status).toBe("pending"); expect(invalidated.stages.tts.status).toBe("pending");
    expect(await getChapter(root, "stale-story", 101)).toMatchObject({ stale: true, audioAvailable: true, audioStale: true, audioUrl: "/api/stories/stale-story/chapters/101/audio" });
    expect((await getChapterPage(root, "stale-story", { page: 1, pageSize: 50, filter: "all" })).items[0]).toMatchObject({ chapter: 101, translation: "pending", tts: "pending", audioAvailable: true, audioStale: true, audioMastering: "stale" });
    expect(await getStoryOverview(root, "stale-story")).toMatchObject({ counts: { minChapter: 101, maxChapter: 101, complete: 1 } });
    const audioDashboard = await getAudioDashboard(root, "stale-story");
    expect(audioDashboard.counts).toEqual({ total: 1, mastered: 1, current: 0, stale: 1 });
    expect(audioDashboard.chapters[0]).toMatchObject({ chapter: 101, audioAvailable: true, audioStale: true, status: "stale" });
    const completePage = await getChapterPage(root, "stale-story", { page: 1, pageSize: 50, filter: "complete" });
    expect(completePage.items).toHaveLength(1);
    expect(completePage.items[0]!.chapter).toBe(101);
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
    const { root, story, paths } = await storyFixture(); const now = new Date().toISOString(); const complete = { status: "complete" as const };
    await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({ chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, counts: { originalCharacters: 20, englishWords: 4, narrationWords: 4 }, createdAt: now, updatedAt: now, stages: { ingestion: complete, translation: complete, narration: { ...complete, provider: "openai" }, qa: complete, storyBible: complete, tts: complete, audioMastering: complete } }));
    const valid = { title: "Revised", sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, recentChapterSummaries: story.context.recentChapterSummaries, narrationSettings: { profanityMode: "soften-strong" as const, bleepStrongProfanity: true, includeChapterTitle: false },
      translation: story.pipeline.translation, narration: story.pipeline.narration, qa: story.pipeline.qa, tts: { model: "s2.1-pro-free", referenceId: "voice", secondaryReferenceId: "dialogue-voice", voiceMode: "narrator-dialogue" as const, deliveryIntensity: "restrained" as const, qualityGuard: true, speed: 1.1 } };
    expect((await updateStorySettings(root, story.slug, valid)).title).toBe("Revised");
    expect((await updateStorySettings(root, story.slug, valid)).pipeline.tts.model).toBe("s2.1-pro-free");
    expect((await updateStorySettings(root, story.slug, valid)).pipeline.tts).toMatchObject({ secondaryReferenceId: "dialogue-voice", voiceMode: "narrator-dialogue", deliveryIntensity: "restrained", qualityGuard: true });
    expect((await updateStorySettings(root, story.slug, valid)).narrationSettings.profanityMode).toBe("soften-strong");
    expect((await updateStorySettings(root, story.slug, valid)).narrationSettings.bleepStrongProfanity).toBe(true);
    expect((await updateStorySettings(root, story.slug, valid)).narrationSettings.includeChapterTitle).toBe(false);
    const chapter = chapterSchema.parse(await readJsonIfExists(paths.chapterMeta)); expect(chapter.stages.translation.status).toBe("complete"); expect(chapter.stages.narration.status).toBe("pending"); expect(chapter.stages.qa.status).toBe("pending");
    const persisted = await readFile(storyPaths(root, story.slug, 1).storyConfig, "utf8");
    await expect(updateStorySettings(root, story.slug, { ...valid, tts: { ...valid.tts, model: "" } })).rejects.toThrow();
    expect(await readFile(storyPaths(root, story.slug, 1).storyConfig, "utf8")).toBe(persisted);
    await expect(updateStorySettings(root, story.slug, { ...valid, OPENAI_API_KEY: "must-not-pass" })).rejects.toThrow();
  });

  it("invalidates only TTS and downstream media when strong-word bleeping changes", async () => {
    const { root, story, paths } = await storyFixture(); const now = new Date().toISOString(); const complete = { status: "complete" as const };
    await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({ chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, counts: { originalCharacters: 20, englishWords: 4, narrationWords: 4 }, createdAt: now, updatedAt: now,
      stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, continuity: complete, tts: complete, audioMastering: complete, alignment: complete, subtitles: complete, scenePlanning: complete, artwork: complete, video: complete } }));
    await updateStorySettings(root, story.slug, { title: story.title, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
      recentChapterSummaries: story.context.recentChapterSummaries, narrationSettings: { ...story.narrationSettings, bleepStrongProfanity: true },
      translation: story.pipeline.translation, narration: story.pipeline.narration, qa: story.pipeline.qa, tts: { speed: story.pipeline.tts.speed } });
    const chapter = chapterSchema.parse(await readJsonIfExists(paths.chapterMeta));
    expect(chapter.stages.translation.status).toBe("complete"); expect(chapter.stages.narration.status).toBe("complete"); expect(chapter.stages.qa.status).toBe("complete");
    expect(chapter.stages.storyBible.status).toBe("complete"); expect(chapter.stages.continuity.status).toBe("complete"); expect(chapter.stages.tts.status).toBe("pending"); expect(chapter.stages.video.status).toBe("pending");
  });

  it("refreshes a remote directory with the existing comparison service", async () => {
    const { root, story, paths } = await storyFixture(); story.source = { type: "fanqie", url: "https://fanqienovel.com/page/123", path: "source" }; await atomicWriteJson(paths.storyConfig, story);
    const first = { chapter: 1, sourceId: "one", sourceType: "fanqie" as const, metadata: {} }; const second = { chapter: 2, sourceId: "two", sourceType: "fanqie" as const, metadata: {} };
    const manifest = sourceManifestSchema.parse({ version: 1, adapterVersion: "test", type: "fanqie", origin: { url: story.source.url, bookId: "123" }, fingerprint: "a".repeat(64), importedAt: new Date().toISOString(), remote: { lastInspectedAt: new Date().toISOString(), chapterCountAtInspection: 1, directory: [first] }, warnings: [], unnumberedSections: [], chapters: [] }); await atomicWriteJson(paths.sourceManifest, manifest);
    const provider: StorySourceProvider = { type: "fanqie", inspect: async (sourcePath) => ({ sourcePath, sourceType: "fanqie", fingerprint: fingerprint("remote"), chapters: [], directory: [first, second], warnings: [], unnumberedSections: [], origin: { url: sourcePath }, remote: { lastInspectedAt: new Date().toISOString(), chapterCountAtInspection: 2 } }) };
    const operations = new StudioOperations(root, env, new JobManager(), { registry: new SourceProviderRegistry([provider]) }); const result = await operations.refreshRemote(story.slug, false);
    expect(result.currentCount).toBe(2); expect(result.added.map((item) => item.chapter)).toEqual([2]);
  });

  it("uses a configured complete fallback without replacing an existing valid chapter", async () => {
    const { root, story, paths } = await storyFixture(); const now = new Date().toISOString();
    const fanqieUrl = "https://fanqienovel.com/page/123"; const fallbackUrl = "https://ixdzs8.com/read/456/";
    story.source = { type: "fanqie", url: fanqieUrl, externalId: "123", path: "source" };
    story.sources = [
      { provider: "fanqie", bookId: "123", url: fanqieUrl, addedAt: now, priority: 900, enabled: true },
      { provider: "ixdzs8", bookId: "456", url: fallbackUrl, addedAt: now, priority: 100, enabled: true },
    ];
    await atomicWriteJson(paths.storyConfig, story);
    const primaryRef = { chapter: 1500, sourceId: "locked-1500", sourceType: "fanqie" as const, metadata: { provider: "fanqie" } };
    const fallbackValidation = { status: "COMPLETE" as const, evidence: { extractedCharacters: 600, contentContainerFound: true, indicators: [] as string[], reasons: ["Complete chapter content"] } };
    const fallbackRef = { chapter: 1500, sourceId: "p1500", sourceType: "web" as const, metadata: { provider: "ixdzs8", sourceBookId: "456", sourceChapterId: "p1500", sourceUrl: `${fallbackUrl}p1500.html`, retrievedAt: now, validation: fallbackValidation, characterCount: 600 } };
    let fallbackInspections = 0;
    const primary = {
      type: "fanqie" as const, id: "fanqie" as const, displayName: "Fanqie", capabilities: { search: false, download: true, authentication: "optional" as const }, supportsUrl: (url: string) => url === fanqieUrl,
      search: async () => [], getBook: async () => ({ provider: "fanqie" as const, bookId: "123", url: fanqieUrl, title: "Test" }), getChapterList: async () => [], getChapter: async () => { throw new Error("locked"); }, validateChapter: () => ({ status: "LOCKED" as const, evidence: { extractedCharacters: 200, expectedCharacters: 1800, contentContainerFound: true, indicators: ["lock"], reasons: ["Locked preview"] } }),
      inspect: async () => ({ sourcePath: fanqieUrl, sourceType: "fanqie" as const, fingerprint: "a".repeat(64), chapters: [], directory: [primaryRef], warnings: [{ code: "unavailable_chapter" as const, sourceId: primaryRef.sourceId, message: "Chapter 1500 LOCKED: extracted 200 / ~1800 characters" }], unnumberedSections: [], origin: { url: fanqieUrl, bookId: "123" }, remote: { lastInspectedAt: now, chapterCountAtInspection: 1 }, metadata: { provider: "fanqie", bookId: "123" } }),
    } satisfies StorySourceProvider & NovelSourceProvider;
    const fallback = {
      type: "web" as const, id: "ixdzs8" as const, displayName: "ixdzs8", capabilities: { search: true, download: true, authentication: "none" as const }, supportsUrl: (url: string) => url === fallbackUrl,
      search: async () => [], getBook: async () => ({ provider: "ixdzs8" as const, bookId: "456", url: fallbackUrl, title: "Test" }), getChapterList: async () => [], getChapter: async () => { throw new Error("not used"); }, validateChapter: () => fallbackValidation,
      inspect: async (_source: string, options) => { fallbackInspections += 1; return { sourcePath: fallbackUrl, sourceType: "web" as const, fingerprint: "b".repeat(64), chapters: options?.chapters?.length ? [{ ref: fallbackRef, text: "完整正文。".repeat(100) }] : [], directory: [fallbackRef], warnings: [], unnumberedSections: [], origin: { url: fallbackUrl, bookId: "456" }, remote: { lastInspectedAt: now, chapterCountAtInspection: 1 }, metadata: { provider: "ixdzs8", bookId: "456" }, adapterVersion: "test" }; },
    } satisfies StorySourceProvider & NovelSourceProvider;
    const operations = new StudioOperations(root, env, new JobManager(), { registry: new SourceProviderRegistry([primary, fallback]) });
    const result = await operations.inspectSource({ url: fanqieUrl, from: 1500, to: 1500 }, { story: story.slug, additive: true });
    expect(result.chapters[0]?.metadata).toMatchObject({ provider: "ixdzs8", validation: { status: "COMPLETE" } });
    expect(result.metadata?.fallbackAttempts).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "fanqie", status: "LOCKED" }), expect.objectContaining({ provider: "ixdzs8", status: "COMPLETE" })]));
    await importSource(root, story.slug, { sourcePath: fallbackUrl, sourceType: "web", fingerprint: "b".repeat(64), chapters: [{ ref: fallbackRef, text: "Existing valid text" }], directory: [fallbackRef], warnings: [], unnumberedSections: [], origin: { url: fallbackUrl, bookId: "456" }, remote: { lastInspectedAt: now, chapterCountAtInspection: 1 }, metadata: { provider: "ixdzs8", bookId: "456" }, adapterVersion: "test" });
    const callsBefore = fallbackInspections; const preserved = await operations.inspectSource({ url: fanqieUrl, from: 1500, to: 1500 }, { story: story.slug, additive: true });
    expect(fallbackInspections).toBe(callsBefore); expect(preserved.chapters).toHaveLength(0);
    await operations.close();
  });

  it("validates and persists story-specific provider priority without losing source provenance", async () => {
    const { root, story, paths } = await storyFixture(); const now = new Date().toISOString();
    story.sources = [
      { provider: "fanqie", bookId: "123", url: "https://fanqienovel.com/page/123", addedAt: now, priority: 900, enabled: true },
      { provider: "ixdzs8", bookId: "456", url: "https://ixdzs8.com/read/456/", addedAt: now, priority: 100, enabled: true },
    ];
    await atomicWriteJson(paths.storyConfig, story); const operations = new StudioOperations(root, env);
    const updated = await operations.updateNovelSourcePriorities(story.slug, { sources: [
      { provider: "fanqie", bookId: "123", priority: 950, enabled: false },
      { provider: "ixdzs8", bookId: "456", priority: 10, enabled: true },
    ] });
    expect(updated.sources).toEqual([expect.objectContaining({ provider: "fanqie", url: story.sources[0]!.url, priority: 950, enabled: false }), expect.objectContaining({ provider: "ixdzs8", priority: 10, enabled: true })]);
    await expect(operations.updateNovelSourcePriorities(story.slug, { sources: [{ provider: "unknown-source", bookId: "999", priority: 1, enabled: true }] })).rejects.toThrow(/already attached/);
    await operations.close();
  });

  it("exposes durable Summary Library operations through the server service", async () => {
    const { root, story, paths } = await storyFixture(); await atomicWrite(paths.original, "原始章节"); await atomicWrite(paths.english, "The lantern wakes in the tower.");
    const openai = new MockLLM("openai", ["A lantern wakes.", "The lantern wakes again."]); const gemini = new MockLLM("gemini"); const jobs = new JobManager();
    const operations = new StudioOperations(root, env, jobs, { llm: new LLMRouter(new Map([["openai", openai], ["gemini", gemini]])) });
    const generated = await waitForJob(jobs, operations.startSummary(story.slug, { title: "Opening recap", chapters: [1], contextEligible: true }).id);
    expect(generated.status).toBe("completed"); const id = (generated.result as any).id;
    expect(await operations.listSummaries(story.slug)).toEqual([expect.objectContaining({ id, title: "Opening recap", contextEligible: true })]);
    expect(await operations.getSummary(story.slug, id)).toMatchObject({ text: "A lantern wakes." });
    await operations.updateSummary(story.slug, id, { text: "A manual recap." }); expect((await operations.getSummary(story.slug, id)).manuallyEdited).toBe(true);
    const regenerated = await waitForJob(jobs, operations.regenerateSummary(story.slug, id, {}).id); expect(regenerated.status).toBe("completed");
    await operations.deleteSummary(story.slug, id); expect(await operations.listSummaries(story.slug)).toEqual([]); await operations.close();
  });

  it("discovers active story jobs and exposes them via GET /api/stories/:slug/jobs/active", async () => {
    const { root, story } = await storyFixture();
    const jobs = new JobManager();
    const operations = new StudioOperations(root, env, jobs);
    const handler = createApiHandler(operations);

    const callApi = async (urlPath: string) => {
      const req = Object.assign(Readable.from([]), {
        method: "GET",
        url: urlPath,
        headers: { host: "localhost:3000" },
      });
      const headers: Record<string, unknown> = {};
      let status = 0;
      const chunks: Buffer[] = [];
      const res = Object.assign(new PassThrough(), {
        setHeader: (name: string, value: unknown) => { headers[name] = value; },
        writeHead: (code: number, values?: object) => {
          status = code;
          if (values) Object.assign(headers, values);
        },
      });
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      const done = new Promise<void>((resolve) => res.on("finish", resolve));
      await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      await done;
      return { status, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") };
    };

    // 1. Initial state: no active job for this story
    expect(jobs.getActiveForStory(story.slug)).toBeUndefined();
    const initialRes = await callApi(`/api/stories/${story.slug}/jobs/active`);
    expect(initialRes.status).toBe(200);
    expect(initialRes.body).toEqual({ job: null });

    // 2. Start a running job
    let finishJob!: (result: unknown) => void;
    const runningJob = jobs.create("batch", story.slug, () => new Promise((resolve) => { finishJob = resolve; }));
    expect(jobs.getActiveForStory(story.slug)?.id).toBe(runningJob.id);
    expect(["queued", "running"]).toContain(jobs.getActiveForStory(story.slug)?.status);
    await vi.waitFor(() => expect(jobs.getActiveForStory(story.slug)?.status).toBe("running"));

    // 3. GET /api/stories/:slug/jobs/active returns the active job
    const activeRes = await callApi(`/api/stories/${story.slug}/jobs/active`);
    expect(activeRes.status).toBe(200);
    expect(activeRes.body.job).toMatchObject({ id: runningJob.id, status: "running", story: story.slug });

    // 4. Other story does not see this active job
    expect(jobs.getActiveForStory("other-story")).toBeUndefined();
    const otherRes = await callApi(`/api/stories/other-story/jobs/active`);
    expect(otherRes.status).toBe(200);
    expect(otherRes.body).toEqual({ job: null });

    // 5. Complete the job: it is no longer active
    finishJob({ ok: true });
    await waitForJob(jobs, runningJob.id);
    expect(jobs.getActiveForStory(story.slug)).toBeUndefined();
    const completedRes = await callApi(`/api/stories/${story.slug}/jobs/active`);
    expect(completedRes.status).toBe(200);
    expect(completedRes.body).toEqual({ job: null });

    // 6. Multiple active jobs: newest is returned deterministically
    const jobOld: Job = { id: "11111111-1111-4111-8111-111111111111", type: "batch", story: story.slug, status: "running", createdAt: "2026-09-18T10:00:00.000Z", updatedAt: "2026-09-18T10:00:00.000Z" };
    const jobNew: Job = { id: "22222222-2222-4222-8222-222222222222", type: "production", story: story.slug, status: "running", createdAt: "2026-09-18T11:00:00.000Z", updatedAt: "2026-09-18T11:00:00.000Z" };
    (jobs as any).jobs.set(jobOld.id, jobOld);
    (jobs as any).jobs.set(jobNew.id, jobNew);
    (jobs as any).activeStories.delete(story.slug);
    expect(jobs.getActiveForStory(story.slug)?.id).toBe(jobNew.id);

    await operations.close();
  });
});

function waitForJob(jobs: JobManager, id: string): Promise<Job> {
  return new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("Job timed out")), 3000); const unsubscribe = jobs.subscribe(id, (job) => { if (["completed", "failed", "paused"].includes(job.status)) { clearTimeout(timeout); unsubscribe?.(); resolve(job); } }); });
}

function metadataFor(slug: string) { return { slug, title: "Atomic Story", description: "", tags: [], notes: "", sourceLanguage: "zh-CN", outputLanguage: "en-US" }; }
