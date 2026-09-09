import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { BatchRunner, ChapterProcessor, ProgressEvent } from "../../src/batch/batch-runner.js";
import { createBatchState } from "../../src/batch/batch-state.js";
import { retryConfigSchema } from "../../src/batch/types.js";
import { selectChapterRange } from "../../src/batch/range.js";
import { Environment } from "../../src/config/env.js";
import { defaultStory, loadStory } from "../../src/config/load-config.js";
import { createPipelineRuntime } from "../../src/pipeline/create-pipeline.js";
import { applyPreviewProfile } from "../../src/preview/profile.js";
import { PreviewRunner } from "../../src/preview/preview-runner.js";
import { previewPresetSchema } from "../../src/preview/types.js";
import { importSource, loadImportedChapters } from "../../src/source/importer.js";
import { validateImportable } from "../../src/source/inspection.js";
import { compareRemoteDirectory } from "../../src/source/refresh.js";
import { SourceProviderRegistry } from "../../src/source/registry.js";
import { applySourceMetadata } from "../../src/source/story-metadata.js";
import { SourceInspection, SourceManifest, SourceType, sourceManifestSchema, sourceTypeSchema } from "../../src/source/types.js";
import { createWebHttpClient } from "../../src/source/web/create-client.js";
import { atomicWriteJson } from "../../src/storage/atomic-write.js";
import { previewPaths, storyPaths } from "../../src/storage/paths.js";
import { exists, readJsonIfExists } from "../../src/storage/story-files.js";
import { withStoryLock } from "../../src/storage/story-lock.js";
import { ShutdownController } from "../../src/batch/shutdown.js";
import { JobManager } from "./job-manager.js";
import { logger } from "../../src/utils/logger.js";
import { AudioMasteringProcessor, FfmpegMasteringProcessor } from "../../src/audio/mastering.js";
import { masterStoredChapter } from "../../src/audio/chapter-audio.js";
import { AudiobookFormat, AudiobookProcessor, FfmpegAudiobookProcessor, assembleAudiobook } from "../../src/audio/audiobook.js";
import { generateStoredSubtitles } from "../../src/subtitles/chapter-subtitles.js";
import { FfmpegVideoProcessor, VideoProcessor } from "../../src/video/renderer.js";
import { renderStoredChapterVideo } from "../../src/video/chapter-video.js";
import { assembleVideoExport, FfmpegVideoExportProcessor, VideoExportProcessor } from "../../src/video/video-export.js";
import { LLMProvider } from "../../src/llm/provider.js";
import { planStoredScenes, updateStoredSceneManifest } from "../../src/scenes/manifest.js";
import { generateStoredArtwork, reviewStoredArtwork } from "../../src/artwork/generator.js";
import { ImageProvider } from "../../src/artwork/provider.js";
import { OpenAIImageProvider } from "../../src/artwork/openai-image.provider.js";
import { planProduction, runProduction } from "../../src/production/orchestrator.js";
import { productionForceSchema, productionOutputSchema } from "../../src/production/types.js";
import { refreshProductionRange } from "../../src/production/refresh.js";

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const batchInputSchema = z.object({ from: z.number().int().positive().optional(), to: z.number().int().positive().optional(), force: z.enum(["translation", "narration", "qa", "story-bible", "tts", "audio", "all"]).optional() }).strict();
const previewInputSchema = z.object({ chapter: z.number().int().positive(), audioPreview: z.boolean().default(false), presets: z.object({ a: previewPresetSchema, b: previewPresetSchema }) }).strict();
const audioInputSchema = z.object({ from: z.number().int().positive().optional(), to: z.number().int().positive().optional(), force: z.boolean().default(false) }).strict();
const audiobookInputSchema = z.object({ from: z.number().int().positive(), to: z.number().int().positive(), format: z.enum(["mp3", "m4b"]), force: z.boolean().default(false) }).strict();
const rangeJobSchema = z.object({ from: z.number().int().positive().optional(), to: z.number().int().positive().optional(), force: z.boolean().default(false) }).strict();
const videoJobSchema = rangeJobSchema.extend({ subtitleMode: z.enum(["none", "burn", "soft", "both"]).optional() }).strict();
const explicitRangeJobSchema = z.object({ from: z.number().int().positive(), to: z.number().int().positive(), force: z.boolean().default(false) }).strict().refine((value) => value.to >= value.from, { message: "Range end must be at or after range start" });
const artworkJobSchema = z.object({ from: z.number().int().positive(), to: z.number().int().positive(), force: z.boolean().default(false), scene: z.string().regex(/^scene-\d{3}$/).optional(), dryRun: z.boolean().default(false) }).strict().refine((value) => value.to >= value.from, { message: "Range end must be at or after range start" }).refine((value) => !value.scene || value.from === value.to, { message: "A single-scene job must select one chapter" });
const productionInputSchema = z.object({ from: z.number().int().positive(), to: z.number().int().positive(), profile: z.string().optional(), outputs: z.array(productionOutputSchema).min(1).optional(), artwork: z.boolean().optional(), repairQa: z.boolean().optional(), refresh: z.boolean().default(false), dryRun: z.boolean().default(false), force: productionForceSchema.optional(), audiobookFormat: z.enum(["mp3", "m4b"]).optional() }).strict().refine((value) => value.to >= value.from, { message: "Range end must be at or after range start" });

type InspectionRecord = { inspection: SourceInspection; temporaryDirectory?: string; createdAt: number; bytes: number };
export type OperationsDependencies = { pipeline?: ChapterProcessor; preview?: PreviewRunner; registry?: SourceProviderRegistry; audio?: AudioMasteringProcessor; audiobook?: AudiobookProcessor; video?: VideoProcessor; videoExport?: VideoExportProcessor; scenePlanner?: LLMProvider; image?: ImageProvider };

export class StudioOperations {
  private static readonly maxInspections = 10;
  private static readonly maxInspectionBytes = 100 * 1024 * 1024;
  private readonly inspections = new Map<string, InspectionRecord>();
  private readonly pipeline: ChapterProcessor; private readonly preview: PreviewRunner; private readonly registry: SourceProviderRegistry;
  private readonly audio: AudioMasteringProcessor; private readonly audiobook: AudiobookProcessor;
  private readonly video: VideoProcessor; private readonly videoExport: VideoExportProcessor;
  private readonly scenePlanner?: LLMProvider; private readonly image: ImageProvider; private readonly runtime: ReturnType<typeof createPipelineRuntime>;
  private readonly inspectionTimer: NodeJS.Timeout; private inspectionBytes = 0;
  constructor(public readonly root: string, private readonly env: Environment, public readonly jobs = new JobManager(), dependencies: OperationsDependencies = {}) {
    const runtime = createPipelineRuntime(env); this.runtime = runtime; this.pipeline = dependencies.pipeline ?? runtime.pipeline; this.preview = dependencies.preview ?? new PreviewRunner(runtime.router, runtime.tts);
    this.registry = dependencies.registry ?? new SourceProviderRegistry(undefined, createWebHttpClient(root, env));
    this.audio = dependencies.audio ?? runtime.audio ?? new FfmpegMasteringProcessor(); this.audiobook = dependencies.audiobook ?? new FfmpegAudiobookProcessor();
    this.video = dependencies.video ?? new FfmpegVideoProcessor(); this.videoExport = dependencies.videoExport ?? new FfmpegVideoExportProcessor();
    this.scenePlanner = dependencies.scenePlanner; this.image = dependencies.image ?? new OpenAIImageProvider(env.OPENAI_API_KEY, env.PROVIDER_TIMEOUT_MS);
    this.inspectionTimer = setInterval(() => this.expireInspections(), 60_000); this.inspectionTimer.unref();
  }

  async inspectSource(input: { url?: string; file?: Uint8Array; filename?: string; type?: SourceType; from?: number; to?: number; chapter?: number; splitChapters?: boolean; allowGaps?: boolean }) {
    this.expireInspections(); let source: string; let temporaryDirectory: string | undefined;
    const type = input.type === undefined ? undefined : sourceTypeSchema.parse(input.type);
    if (input.url) { const url = new URL(input.url); if (url.protocol !== "https:") throw new Error("Only HTTPS source URLs are allowed"); source = url.toString(); }
    else {
      if (!input.file?.length || !input.filename) throw new Error("Select a TXT, EPUB, or DOCX file");
      const safeName = basename(input.filename); if (!/\.(txt|epub|docx)$/i.test(safeName)) throw new Error("Only TXT, EPUB, and DOCX files are supported");
      temporaryDirectory = join(tmpdir(), `ai-story-studio-${randomUUID()}`); await mkdir(temporaryDirectory); source = join(temporaryDirectory, safeName); await writeFile(source, input.file);
    }
    try {
      const { provider, semanticType } = await this.registry.resolve(source, type); const remote = semanticType === "fanqie" || semanticType === "web";
      if (remote && ((input.from === undefined) !== (input.to === undefined))) throw new Error("Remote chapter ranges require both from and to");
      const inspection = await provider.inspect(source, { semanticType, from: input.from, to: input.to, chapter: input.chapter, splitChapters: input.splitChapters, allowGaps: input.allowGaps });
      const bytes = inspection.chapters.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
      if (this.inspections.size >= StudioOperations.maxInspections || this.inspectionBytes + bytes > StudioOperations.maxInspectionBytes) {
        throw new Error("Too many pending source inspections; import an existing inspection or wait for it to expire");
      }
      const id = randomUUID(); this.inspections.set(id, { inspection, temporaryDirectory, createdAt: Date.now(), bytes }); this.inspectionBytes += bytes;
      const selected = inspection.chapters.map((item) => item.ref); const available = inspection.directory?.length ?? selected.length;
      return { id, type: inspection.sourceType, title: inspection.title, author: inspection.author, language: inspection.language,
        chapterCount: selected.length, availableChapterCount: available, chapters: selected.slice(0, 200), truncated: selected.length > 200,
        warnings: inspection.warnings, metadata: inspection.metadata };
    } catch (error) { if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }); throw error; }
  }

  async importInspection(slug: string, inspectionId: string, allowGaps = false) {
    slugSchema.parse(slug); const record = this.inspections.get(inspectionId); if (!record) throw new Error("Inspection expired or was not found");
    validateImportable(record.inspection.chapters, record.inspection.warnings, allowGaps);
    const result = await withStoryLock(this.root, slug, "web source import", async () => {
        const paths = storyPaths(this.root, slug, record.inspection.chapters[0]?.ref.chapter ?? 1); const existed = await exists(paths.storyConfig);
        let story = existed ? await loadStory(paths.storyConfig) : defaultStory(slug, this.env); story = applySourceMetadata(story, record.inspection, !existed);
        const result = await importSource(this.root, slug, record.inspection, async () => { await atomicWriteJson(paths.storyConfig, story); await atomicWriteJson(paths.pipelineConfig, story.pipeline); });
        return { status: result.status, story, added: result.added, modified: result.modified, removed: result.removed, chapters: result.manifest.chapters.length };
      });
    try { await this.discardInspection(inspectionId); }
    catch (error) { logger.warn({ event: "web.inspection.cleanup_failed", inspectionId, error: error instanceof Error ? error.message : String(error) }); }
    return result;
  }

  startBatch(slug: string, raw: unknown) {
    slugSchema.parse(slug); const input = batchInputSchema.parse(raw);
    return this.jobs.create("batch", slug, async (control) => withStoryLock(this.root, slug, "web batch", async () => {
      const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const imported = await loadImportedChapters(this.root, slug);
      const selected = selectChapterRange(imported.chapters, input.from, input.to); const state = createBatchState({ root: this.root, story: slug, inputDirectory: imported.directory, chapters: selected, allowGaps: true, continueOnError: false, delayMs: 0, force: input.force });
      const shutdown = new ShutdownController(); control.setPause(() => shutdown.request());
      return new BatchRunner(this.pipeline).run({ root: this.root, story, chapters: selected, state, shutdown, retry: retryConfigSchema.parse({}),
        onProgress: (event: ProgressEvent) => control.update(event) });
    }));
  }

  async productionPlan(slug: string, raw: unknown) { slugSchema.parse(slug); const input = productionInputSchema.parse(raw); const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); return (await planProduction({ root: this.root, story, ...input, dryRun: true }, { loadChapters: async () => (await loadImportedChapters(this.root, slug)).chapters })).plan; }

  startProduction(slug: string, raw: unknown) { slugSchema.parse(slug); const input = productionInputSchema.parse(raw); return this.jobs.create("production", slug, async (control) => withStoryLock(this.root, slug, "end-to-end production", async () => { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); return (await runProduction({ root: this.root, story, ...input, pause: shutdown, onProgress: (event) => control.update(event) }, { pipeline: this.pipeline, loadChapters: async () => (await loadImportedChapters(this.root, slug)).chapters, refresh: (from, to) => refreshProductionRange({ root: this.root, story, from, to, registry: this.registry }), scenePlanner: this.scenePlanner ?? this.runtime.router.forStage(story.pipeline.scenePlanner), image: this.image, video: this.video, videoExport: this.videoExport, audiobook: this.audiobook })).manifest; })); }

  startPreview(slug: string, raw: unknown) {
    slugSchema.parse(slug); const input = previewInputSchema.parse(raw);
    return this.jobs.create("preview", slug, async () => withStoryLock(this.root, slug, "web preview", async () => {
      const story = await loadStory(storyPaths(this.root, slug, input.chapter).storyConfig); const imported = await loadImportedChapters(this.root, slug);
      const chapter = imported.chapters.find((item) => item.chapter === input.chapter); if (!chapter) throw new Error(`Imported source does not contain Chapter ${input.chapter}`);
      return this.preview.run({ root: this.root, story, chapter: input.chapter, inputPath: chapter.path, presets: input.presets, audioPreview: input.audioPreview });
    }));
  }

  startAudio(slug: string, raw: unknown) {
    slugSchema.parse(slug); const input = audioInputSchema.parse(raw);
    return this.jobs.create("audio", slug, async (control) => withStoryLock(this.root, slug, "web audio mastering", async () => {
      const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const imported = await loadImportedChapters(this.root, slug);
      const selected = selectChapterRange(imported.chapters, input.from, input.to); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); let mastered = 0; let reused = 0;
      for (let index = 0; index < selected.length; index++) {
        if (shutdown.isRequested) return { status: "paused", mastered, reused, total: selected.length };
        const chapter = selected[index]!.chapter; control.update({ type: "audio.chapter.started", chapter, index: index + 1, total: selected.length });
        const result = await masterStoredChapter({ root: this.root, story, chapter, processor: this.audio, force: input.force }); result.reused ? reused++ : mastered++;
        control.update({ type: "audio.chapter.completed", chapter, index: index + 1, total: selected.length, reused: result.reused, durationSeconds: result.probe.durationSeconds });
      }
      return { status: "completed", mastered, reused, total: selected.length };
    }));
  }

  startAudiobook(slug: string, raw: unknown) {
    slugSchema.parse(slug); const input = audiobookInputSchema.parse(raw);
    return this.jobs.create("audiobook", slug, async (control) => withStoryLock(this.root, slug, "web audiobook assembly", async () => {
      const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const imported = await loadImportedChapters(this.root, slug);
      const selected = selectChapterRange(imported.chapters, input.from, input.to); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request());
      for (let index = 0; index < selected.length; index++) {
        if (shutdown.isRequested) return { status: "paused", total: selected.length };
        const chapter = selected[index]!.chapter; control.update({ type: "audio.chapter.started", chapter, index: index + 1, total: selected.length });
        const result = await masterStoredChapter({ root: this.root, story, chapter, processor: this.audio });
        control.update({ type: "audio.chapter.completed", chapter, index: index + 1, total: selected.length, reused: result.reused });
      }
      return assembleAudiobook({ root: this.root, story, from: selected[0]!.chapter, to: selected.at(-1)!.chapter, format: input.format as AudiobookFormat,
        processor: this.audiobook, force: input.force, onProgress: (event) => control.update(event) });
    }));
  }

  startSubtitles(slug: string, raw: unknown) { slugSchema.parse(slug); const input = rangeJobSchema.parse(raw); return this.jobs.create("subtitles", slug, async (control) => withStoryLock(this.root, slug, "web subtitle generation", async () => { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const selected = selectChapterRange((await loadImportedChapters(this.root, slug)).chapters, input.from, input.to); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); let generated = 0; let reused = 0; for (let index = 0; index < selected.length; index++) { if (shutdown.isRequested) return { status: "paused", generated, reused }; const chapter = selected[index]!.chapter; control.update({ type: "subtitles.chapter.started", chapter, index: index + 1, total: selected.length }); const result = await generateStoredSubtitles({ root: this.root, story, chapter, force: input.force }); result.reused ? reused++ : generated++; control.update({ type: "subtitles.chapter.completed", chapter, index: index + 1, total: selected.length, reused: result.reused }); } return { generated, reused, total: selected.length }; })); }

  startVideo(slug: string, raw: unknown) { slugSchema.parse(slug); const input = videoJobSchema.parse(raw); return this.jobs.create("video", slug, async (control) => withStoryLock(this.root, slug, "web chapter video rendering", async () => { let story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); if (input.subtitleMode) story = { ...story, video: { ...story.video, subtitleMode: input.subtitleMode } }; const selected = selectChapterRange((await loadImportedChapters(this.root, slug)).chapters, input.from, input.to); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); let rendered = 0; let reused = 0; for (let index = 0; index < selected.length; index++) { if (shutdown.isRequested) return { status: "paused", rendered, reused }; const chapter = selected[index]!.chapter; if (story.video.subtitleMode !== "none") await generateStoredSubtitles({ root: this.root, story, chapter }); control.update({ type: "video.chapter.started", chapter, index: index + 1, total: selected.length }); const result = await renderStoredChapterVideo({ root: this.root, story, chapter, processor: this.video, force: input.force }); result.reused ? reused++ : rendered++; control.update({ type: "video.chapter.completed", chapter, index: index + 1, total: selected.length, reused: result.reused }); } return { rendered, reused, total: selected.length }; })); }

  startVideoExport(slug: string, raw: unknown) { slugSchema.parse(slug); const input = rangeJobSchema.parse(raw); return this.jobs.create("videoExport", slug, async (control) => withStoryLock(this.root, slug, "web combined video export", async () => { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const selected = selectChapterRange((await loadImportedChapters(this.root, slug)).chapters, input.from, input.to); for (let index = 0; index < selected.length; index++) { const chapter = selected[index]!.chapter; if (story.video.subtitleMode !== "none") await generateStoredSubtitles({ root: this.root, story, chapter }); const rendered = await renderStoredChapterVideo({ root: this.root, story, chapter, processor: this.video }); control.update({ type: "video.chapter.completed", chapter, index: index + 1, total: selected.length, reused: rendered.reused }); } return assembleVideoExport({ root: this.root, story, from: selected[0]!.chapter, to: selected.at(-1)!.chapter, processor: this.videoExport, force: input.force, onProgress: (event) => control.update(event) }); })); }

  startScenes(slug: string, raw: unknown) { slugSchema.parse(slug); const input = explicitRangeJobSchema.parse(raw); return this.jobs.create("scenes", slug, async (control) => withStoryLock(this.root, slug, "web scene planning", async () => { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const selected = selectChapterRange((await loadImportedChapters(this.root, slug)).chapters, input.from, input.to); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); let planned = 0; let reused = 0; for (let index = 0; index < selected.length; index++) { if (shutdown.isRequested) return { status: "paused", planned, reused }; const chapter = selected[index]!.chapter; control.update({ type: "scenes.chapter.started", chapter, index: index + 1, total: selected.length }); const provider = this.scenePlanner ?? this.runtime.router.forStage(story.pipeline.scenePlanner); const result = await planStoredScenes({ root: this.root, story, chapter, provider, force: input.force }); result.reused ? reused++ : planned++; control.update({ type: "scenes.chapter.completed", chapter, index: index + 1, total: selected.length, scenes: result.manifest.scenes.length, reused: result.reused }); } return { planned, reused, total: selected.length }; })); }

  startArtwork(slug: string, raw: unknown) { slugSchema.parse(slug); const input = artworkJobSchema.parse(raw); return this.jobs.create("artwork", slug, async (control) => withStoryLock(this.root, slug, "web artwork generation", async () => { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const selected = selectChapterRange((await loadImportedChapters(this.root, slug)).chapters, input.from, input.to); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); let generated = 0; let estimate = 0; for (let index = 0; index < selected.length; index++) { if (shutdown.isRequested) return { status: "paused", generated, estimate }; const chapter = selected[index]!.chapter; const result = await generateStoredArtwork({ root: this.root, story, chapter, provider: this.image, sceneId: input.scene, force: input.force, dryRun: input.dryRun, onProgress: (event) => control.update({ ...event, chapterIndex: index + 1, chapterTotal: selected.length }) }); generated += "generated" in result ? result.generated ?? 0 : 0; estimate += result.imagesToGenerate; } return { dryRun: input.dryRun, generated, imageCountEstimate: estimate, chapters: selected.length }; })); }

  async updateScenes(slug: string, chapter: number, scenes: unknown) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "manual scene edit", async () => { const story = await loadStory(storyPaths(this.root, slug, chapter).storyConfig); return updateStoredSceneManifest({ root: this.root, story, chapter, scenes }); }); }
  async reviewArtwork(slug: string, chapter: number, sceneId: string, review: unknown) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "artwork review", async () => { const story = await loadStory(storyPaths(this.root, slug, chapter).storyConfig); return reviewStoredArtwork({ root: this.root, story, chapter, sceneId, review }); }); }

  async getPreview(slug: string, id: string) {
    slugSchema.parse(slug); if (!/^[A-Za-z0-9T_-]+$/.test(id)) throw new Error("Invalid preview id"); const paths = previewPaths(this.root, slug, id);
    const manifest = await readJsonIfExists(paths.manifest); if (!manifest) throw new Error(`Preview '${id}' was not found`);
    return { manifest, translationA: await readFileSafe(paths.translationA), translationB: await readFileSafe(paths.translationB), narrationA: await readFileSafe(paths.narrationA), narrationB: await readFileSafe(paths.narrationB), qaA: await readJsonIfExists(paths.qaA), qaB: await readJsonIfExists(paths.qaB), audioA: await exists(paths.audioA), audioB: await exists(paths.audioB) };
  }

  async selectPreview(slug: string, previewId: string, choice: "a" | "b") {
    slugSchema.parse(slug); return withStoryLock(this.root, slug, "web preview selection", async () => {
      const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); return applyPreviewProfile(this.root, story, previewId, choice);
    });
  }

  async refreshRemote(slug: string, importNew: boolean) {
    slugSchema.parse(slug); return withStoryLock(this.root, slug, "web remote refresh", async () => {
      const paths = storyPaths(this.root, slug, 1); const raw = await readJsonIfExists<SourceManifest>(paths.sourceManifest); if (!raw) throw new Error(`Story '${slug}' has no source manifest`);
      const manifest = sourceManifestSchema.parse(raw); if (!("url" in manifest.origin) || !manifest.remote) throw new Error(`Story '${slug}' does not use a remote source`);
      const { provider } = await this.registry.resolve(manifest.origin.url, manifest.type); const directory = await provider.inspect(manifest.origin.url, { refresh: true }); const comparison = compareRemoteDirectory(manifest, directory);
      let imported: number[] = [];
      if (importNew && comparison.added.length) {
        if (comparison.removed.length || comparison.reordered.length) throw new Error("Cannot import automatically because existing chapters were removed or reordered");
        const inspection = await provider.inspect(manifest.origin.url, { chapters: comparison.added.map((item) => item.chapter) }); const result = await importSource(this.root, slug, inspection); imported = result.added;
      }
      return { ...comparison, previousImportedCount: manifest.chapters.length, imported };
    });
  }

  async close() { clearInterval(this.inspectionTimer); await Promise.all([...this.inspections.keys()].map((id) => this.discardInspection(id))); }
  private expireInspections() { const cutoff = Date.now() - 30 * 60_000; for (const [id, record] of this.inspections) if (record.createdAt < cutoff) void this.discardInspection(id).catch((error) => logger.warn({ event: "web.inspection.cleanup_failed", inspectionId: id, error: error instanceof Error ? error.message : String(error) })); }
  private async discardInspection(id: string) {
    const record = this.inspections.get(id); if (!record) return;
    this.inspections.delete(id); this.inspectionBytes = Math.max(0, this.inspectionBytes - record.bytes);
    if (record.temporaryDirectory) await rm(record.temporaryDirectory, { recursive: true, force: true });
  }
}

async function readFileSafe(path: string) { try { return await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
