import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { TTSProvider } from "../../src/tts/provider.js";
import { TTSProviderRouter } from "../../src/tts/router.js";
import { addManualBibleEntry, bibleCategorySchema, chapterTextEditSchema, deleteBibleEntry, saveChapterTextEdit, saveVoicePreview, updateManualBibleEntry, voicePreviewSchema } from "../../src/studio/workflow.js";
import { getStoryBible, invalidateCatalogCache } from "./catalog.js";
import { buildStoryBackup, cleanupKindSchema, cleanupStory, createBlankStory, deleteStory, duplicateStory, getStorageUsage, loadGlobalSettings, readActivity, recordActivity, restoreStoryBackupFile, saveCover, saveGlobalSettings, systemStatus, updateStoryMetadata } from "../../src/studio/projects.js";
import { ProductionQueueService } from "../../src/queue/production-service.js";
import { alignmentConfig, createAlignmentEngine } from "../../src/alignment/config.js";
import { AlignmentEngine } from "../../src/alignment/types.js";
import { alignStoredChapter } from "../../src/alignment/chapter-alignment.js";
import { discardManualSubtitles, saveManualSubtitles } from "../../src/subtitles/chapter-subtitles.js";
import { mergeCanonicalEntities, undoCanonicalMerge, updateCanonicalEntity } from "../../src/story-bible/canonical.js";
import { continuityFindingSchema, resolveContinuityFinding } from "../../src/story-bible/continuity.js";
import { PostgresUsageRepository } from "../../src/cost/repository.js";
import { estimatePlanCost } from "../../src/cost/estimate.js";
import { withUsageScope } from "../../src/cost/context.js";
import { invalidateNarrationNamingChange } from "../../src/story-bible/narration-names.js";

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const batchInputSchema = z.object({ from: z.number().int().positive().optional(), to: z.number().int().positive().optional(), force: z.enum(["translation", "narration", "qa", "story-bible", "continuity", "tts", "audio", "all"]).optional() }).strict();
const previewInputSchema = z.object({ chapter: z.number().int().positive(), audioPreview: z.boolean().default(false), presets: z.object({ a: previewPresetSchema, b: previewPresetSchema }) }).strict();
const audioInputSchema = z.object({ from: z.number().int().positive().optional(), to: z.number().int().positive().optional(), force: z.boolean().default(false) }).strict();
const audiobookInputSchema = z.object({ from: z.number().int().positive(), to: z.number().int().positive(), format: z.enum(["mp3", "m4b"]), force: z.boolean().default(false) }).strict();
const rangeJobSchema = z.object({ from: z.number().int().positive().optional(), to: z.number().int().positive().optional(), force: z.boolean().default(false), forceEstimated: z.boolean().default(false) }).strict();
const alignmentJobSchema = z.object({ chapter: z.number().int().positive(), force: z.boolean().default(false), forceEstimated: z.boolean().default(false), requireAligned: z.boolean().default(false) }).strict();
const videoJobSchema = rangeJobSchema.extend({ subtitleMode: z.enum(["none", "burn", "soft", "both"]).optional() }).strict();
const explicitRangeJobSchema = z.object({ from: z.number().int().positive(), to: z.number().int().positive(), force: z.boolean().default(false) }).strict().refine((value) => value.to >= value.from, { message: "Range end must be at or after range start" });
const artworkJobSchema = z.object({ from: z.number().int().positive(), to: z.number().int().positive(), force: z.boolean().default(false), scene: z.string().regex(/^scene-\d{3}$/).optional(), dryRun: z.boolean().default(false) }).strict().refine((value) => value.to >= value.from, { message: "Range end must be at or after range start" }).refine((value) => !value.scene || value.from === value.to, { message: "A single-scene job must select one chapter" });
const productionInputSchema = z.object({ from: z.number().int().positive(), to: z.number().int().positive(), profile: z.string().optional(), outputs: z.array(productionOutputSchema).min(1).optional(), artwork: z.boolean().optional(), repairQa: z.boolean().optional(), alignment: z.boolean().optional(), refresh: z.boolean().default(false), dryRun: z.boolean().default(false), force: productionForceSchema.optional(), audiobookFormat: z.enum(["mp3", "m4b"]).optional(), maxProviderBudgetUsd: z.number().positive().max(1_000_000).optional() }).strict().refine((value) => value.to >= value.from, { message: "Range end must be at or after range start" });

type InspectionRecord = { inspection: SourceInspection; temporaryDirectory?: string; createdAt: number; bytes: number };
export type OperationsDependencies = { pipeline?: ChapterProcessor; preview?: PreviewRunner; registry?: SourceProviderRegistry; audio?: AudioMasteringProcessor; audiobook?: AudiobookProcessor; video?: VideoProcessor; videoExport?: VideoExportProcessor; scenePlanner?: LLMProvider; image?: ImageProvider; tts?: TTSProvider | TTSProviderRouter; alignment?: AlignmentEngine; queue?: ProductionQueueService; usage?: PostgresUsageRepository };

export class StudioOperations {
  private static readonly maxInspections = 10;
  private static readonly maxInspectionBytes = 100 * 1024 * 1024;
  private readonly inspections = new Map<string, InspectionRecord>();
  private readonly pipeline: ChapterProcessor; private readonly preview: PreviewRunner; private readonly registry: SourceProviderRegistry;
  private readonly audio: AudioMasteringProcessor; private readonly audiobook: AudiobookProcessor;
  private readonly video: VideoProcessor; private readonly videoExport: VideoExportProcessor;
  private readonly scenePlanner?: LLMProvider; private readonly image: ImageProvider; private readonly tts: TTSProviderRouter; private readonly runtime: ReturnType<typeof createPipelineRuntime>;
  private readonly alignConfig; private readonly aligner?: AlignmentEngine;
  private readonly inspectionTimer: NodeJS.Timeout; private inspectionBytes = 0;
  readonly queue?: ProductionQueueService; readonly usage?: PostgresUsageRepository;
  constructor(public readonly root: string, private readonly env: Environment, public readonly jobs = new JobManager(), dependencies: OperationsDependencies = {}) {
    this.usage = dependencies.usage; const runtime = createPipelineRuntime(env, this.usage); this.runtime = runtime; this.pipeline = dependencies.pipeline ?? runtime.pipeline; this.preview = dependencies.preview ?? new PreviewRunner(runtime.router, runtime.tts);
    this.registry = dependencies.registry ?? new SourceProviderRegistry(undefined, createWebHttpClient(root, env));
    this.audio = dependencies.audio ?? runtime.audio ?? new FfmpegMasteringProcessor(); this.audiobook = dependencies.audiobook ?? new FfmpegAudiobookProcessor();
    this.video = dependencies.video ?? new FfmpegVideoProcessor(); this.videoExport = dependencies.videoExport ?? new FfmpegVideoExportProcessor();
    this.scenePlanner = dependencies.scenePlanner; this.image = dependencies.image ?? runtime.images.forName("openai"); this.tts = dependencies.tts instanceof TTSProviderRouter ? dependencies.tts : dependencies.tts ? new TTSProviderRouter(dependencies.tts) : runtime.tts;
    this.queue = dependencies.queue; this.alignConfig = alignmentConfig(env, root); this.aligner = dependencies.alignment ?? createAlignmentEngine(this.alignConfig);
    this.inspectionTimer = setInterval(() => this.expireInspections(), 60_000); this.inspectionTimer.unref();
  }

  async inspectSource(input: { url?: string; file?: Uint8Array; filename?: string; files?: Array<{ name: string; text: string }>; type?: SourceType; from?: number; to?: number; chapter?: number; splitChapters?: boolean; allowGaps?: boolean }) {
    this.expireInspections(); let source: string; let temporaryDirectory: string | undefined;
    const type = input.type === undefined ? undefined : sourceTypeSchema.parse(input.type);
    try {
      if (input.url) { const url = new URL(input.url); if (url.protocol !== "https:") throw new Error("Only HTTPS source URLs are allowed"); source = url.toString(); }
      else if (input.files) {
        if (!input.files.length || input.files.length > 2_000) throw new Error("Select between 1 and 2,000 TXT chapter files");
        temporaryDirectory = join(this.root, ".ai-story-studio", "tmp", `source-${randomUUID()}`); await mkdir(temporaryDirectory, { recursive: true }); let total = 0; const names = new Set<string>();
        for (const file of input.files) { const safeName = basename(file.name); if (safeName !== file.name || !safeName.toLowerCase().endsWith(".txt")) throw new Error("Chapter folders may contain only top-level TXT files"); if (names.has(safeName.toLowerCase())) throw new Error(`Duplicate chapter filename: ${safeName}`); names.add(safeName.toLowerCase()); total += Buffer.byteLength(file.text); if (total > 50 * 1024 * 1024) throw new Error("Chapter folder exceeds the 50 MB inspection limit"); await writeFile(join(temporaryDirectory, safeName), file.text, "utf8"); }
        source = temporaryDirectory;
      } else {
        if (!input.file?.length || !input.filename) throw new Error("Select a TXT, EPUB, or DOCX file");
        const safeName = basename(input.filename); if (safeName !== input.filename || !/\.(txt|epub|docx)$/i.test(safeName)) throw new Error("Only top-level TXT, EPUB, and DOCX files are supported");
        temporaryDirectory = join(this.root, ".ai-story-studio", "tmp", `source-${randomUUID()}`); await mkdir(temporaryDirectory, { recursive: true }); source = join(temporaryDirectory, safeName); await writeFile(source, input.file);
      }
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
    await recordActivity(this.root, slug, "source.imported", `Imported ${result.added.length} new and updated ${result.modified.length} chapters`); invalidateCatalogCache(this.root, slug); return result;
  }

  getGlobalSettings() { return loadGlobalSettings(this.root, this.env); }
  updateGlobalSettings(raw: unknown) { return saveGlobalSettings(this.root, raw); }
  getSystemStatus() { return systemStatus(this.env, this.root); }
  async createStory(raw: unknown) { const story = await createBlankStory(this.root, this.env, raw); invalidateCatalogCache(this.root, story.slug); return story; }
  async createStoryWithInspection(raw: unknown, inspectionId: string) {
    const created = await createBlankStory(this.root, this.env, raw);
    try { const story = (await this.importInspection(created.slug, inspectionId)).story; invalidateCatalogCache(this.root, created.slug); return story; }
    catch (error) { await rm(storyPaths(this.root, created.slug, 1).story, { recursive: true, force: true }); invalidateCatalogCache(this.root, created.slug); throw error; }
  }
  async updateMetadata(slug: string, raw: unknown) { const story = await updateStoryMetadata(this.root, slug, raw); invalidateCatalogCache(this.root, slug); return story; }
  async updateCover(slug: string, filename: string, bytes: Uint8Array) { const result = await saveCover(this.root, slug, filename, bytes); invalidateCatalogCache(this.root, slug); return result; }
  async duplicateProject(slug: string, raw: unknown) { const input = z.object({ slug: slugSchema, mode: z.enum(["settings", "full"]) }).strict().parse(raw); const result = await duplicateStory(this.root, slug, input.slug, input.mode); invalidateCatalogCache(this.root, result.slug); return result; }
  async deleteProject(slug: string, raw: unknown) { const input = z.object({ confirmation: z.string() }).strict().parse(raw); const result = await deleteStory(this.root, slug, input.confirmation); invalidateCatalogCache(this.root, slug); return result; }
  createBackup(slug: string, raw: unknown) { const input = z.object({ includeMedia: z.boolean().default(false) }).strict().parse(raw); return buildStoryBackup(this.root, slug, input.includeMedia); }
  restoreBackup(path: string) { return restoreStoryBackupFile(this.root, path); }
  storageUsage(slug: string) { return getStorageUsage(this.root, slug); }
  recentActivity(slug: string, limit?: number) { return readActivity(this.root, slug, limit); }
  async cleanup(slug: string, raw: unknown) { const input = z.object({ kind: cleanupKindSchema }).strict().parse(raw); const result = await cleanupStory(this.root, slug, input.kind); invalidateCatalogCache(this.root, slug); return result; }

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

  async productionPlan(slug: string, raw: unknown) { slugSchema.parse(slug); const input = productionInputSchema.parse(raw); const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const plan=(await planProduction({ root: this.root, story, ...input, dryRun: true }, { loadChapters: async () => (await loadImportedChapters(this.root, slug)).chapters })).plan;const analytics=this.usage?await this.usage.summary({story:slug}):{dimensions:[]};return{...plan,costEstimate:estimatePlanCost(plan,analytics as any)}; }
  async costAnalytics(slug: string, filters: Parameters<PostgresUsageRepository["summary"]>[0]) { slugSchema.parse(slug); if (!this.usage) throw new Error("Cost analytics requires DATABASE_URL"); return this.usage.summary({ ...filters, story: slug }); }
  async costRecords(slug: string, filters: Parameters<PostgresUsageRepository["list"]>[0]) { slugSchema.parse(slug); if (!this.usage) throw new Error("Cost analytics requires DATABASE_URL"); return this.usage.list({ ...filters, story: slug }); }
  async appCostAnalytics(filters: Parameters<PostgresUsageRepository["summary"]>[0]) { if (!this.usage) throw new Error("Cost analytics requires DATABASE_URL"); return this.usage.summary(filters); }

  async editChapterText(slug: string, chapter: number, raw: unknown) { slugSchema.parse(slug); const input = chapterTextEditSchema.parse(raw); return withStoryLock(this.root, slug, "manual chapter text edit", async () => { const result = await saveChapterTextEdit(this.root, slug, chapter, input); await recordActivity(this.root, slug, "chapter.edited", `Edited Chapter ${chapter} ${input.field}`); return result; }); }
  async addBibleEntry(slug: string, raw: unknown) { slugSchema.parse(slug); const input = z.object({ category: bibleCategorySchema, value: z.record(z.string(), z.unknown()), replacementKey: z.string().optional() }).strict().parse(raw); return withStoryLock(this.root, slug, "manual Story Bible add", async () => { const base = await getStoryBible(this.root, slug); const id = await addManualBibleEntry(this.root, slug, base, input.category, input.value, input.replacementKey); await recordActivity(this.root, slug, "bible.edited", `Added or corrected ${input.category} entry`); return { id }; }); }
  async updateBibleEntry(slug: string, id: string, raw: unknown) { slugSchema.parse(slug); const input = z.object({ value: z.record(z.string(), z.unknown()) }).strict().parse(raw); return withStoryLock(this.root, slug, "manual Story Bible edit", async () => { const base = await getStoryBible(this.root, slug); await updateManualBibleEntry(this.root, slug, base, id, input.value); await recordActivity(this.root, slug, "bible.edited", "Updated a Story Bible entry"); return { status: "updated" }; }); }
  async deleteBibleEntry(slug: string, id: string) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "manual Story Bible delete", async () => { const base = await getStoryBible(this.root, slug); await deleteBibleEntry(this.root, slug, base, id); await recordActivity(this.root, slug, "bible.edited", "Deleted a manual Story Bible entry"); return { status: "deleted" }; }); }
  async updateCanonicalEntity(slug: string, id: string, raw: unknown) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "canonical entity edit", async () => { const current = await getStoryBible(this.root, slug); const before = current.canonicalEntities.find((item) => item.id === id); if (!before) throw new Error("Canonical entity was not found"); const base = await getStoryBible(this.root, slug, { includeCanonicalOverlay: false }); const result = await updateCanonicalEntity(this.root, slug, base, id, raw); const entity = result.bible.canonicalEntities.find((item) => item.id === id); if (!entity) throw new Error("Canonical entity was not found after update"); const invalidation = await invalidateNarrationNamingChange(this.root, slug, before, entity); invalidateCatalogCache(this.root, slug); await recordActivity(this.root, slug, "bible.entity.edited", invalidation.affectedChapters.length ? `Updated canonical entity ${id}; marked ${invalidation.affectedChapters.length} chapter(s) affected by narration naming` : `Updated canonical entity ${id}`); return { entity, invalidation }; }); }
  async mergeCanonicalEntities(slug: string, raw: unknown) { slugSchema.parse(slug); const input = z.object({ targetEntityId: z.string(), sourceEntityIds: z.array(z.string()).min(1).max(50), reason: z.string().trim().min(1).max(1000) }).strict().parse(raw); return withStoryLock(this.root, slug, "canonical entity merge", async () => { const base = await getStoryBible(this.root, slug, { includeCanonicalOverlay: false }); const result = await mergeCanonicalEntities(this.root, slug, base, input.targetEntityId, input.sourceEntityIds, input.reason); await recordActivity(this.root, slug, "bible.entities.merged", `Merged ${input.sourceEntityIds.length} duplicate entity record(s)`); return { merge: result.merge, entity: result.bible.canonicalEntities.find((item) => item.id === input.targetEntityId) }; }); }
  async undoCanonicalMerge(slug: string, mergeId: string) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "undo canonical entity merge", async () => { const base = await getStoryBible(this.root, slug, { includeCanonicalOverlay: false }); await undoCanonicalMerge(this.root, slug, base, mergeId); await recordActivity(this.root, slug, "bible.merge.undone", "Undid a canonical entity merge"); return { status: "undone" }; }); }
  async resolveContinuity(slug: string, id: string, raw: unknown) {
    slugSchema.parse(slug); const input = z.object({ resolution: z.enum(["accepted_new", "kept_existing", "intentional", "corrected", "merged", "dismissed"]), note: z.string().trim().max(2000).optional() }).strict().parse(raw);
    return withStoryLock(this.root, slug, "continuity resolution", async () => {
      const reviewRaw = await readJsonIfExists(storyPaths(this.root, slug, 1).continuityReview); const review = z.object({ findings: z.array(continuityFindingSchema) }).passthrough().parse(reviewRaw); const current = review.findings.find((item) => item.id === id);
      if (!current) throw new Error("Continuity finding was not found");
      const base = await getStoryBible(this.root, slug, { includeCanonicalOverlay: false });
      if (input.resolution === "merged") {
        if (current.type !== "identity_alias_ambiguity" || current.entityIds.length < 2) throw new Error("Only identity or alias findings can be resolved by merging entities");
        await mergeCanonicalEntities(this.root, slug, base, current.entityIds[0]!, current.entityIds.slice(1), input.note || `Resolved continuity finding ${id}`);
      } else if (input.resolution === "accepted_new") {
        if (current.type !== "status_conflict" || current.entityIds.length !== 1) throw new Error("This finding requires a manual Story Bible correction before it can be accepted");
        const chapter = Math.max(...current.chapters); const latest = base.entityTimeline.filter((event) => event.entityId === current.entityIds[0] && event.chapter === chapter).at(-1); const status = latest?.status ?? (latest?.type === "appearance" ? "alive" : undefined);
        if (!status) throw new Error("The newest finding does not contain a canonical status; edit the Story Bible instead");
        await updateCanonicalEntity(this.root, slug, base, current.entityIds[0]!, { status });
      }
      const finding = await resolveContinuityFinding(this.root, slug, id, input.resolution, input.note); invalidateCatalogCache(this.root, slug); await recordActivity(this.root, slug, "continuity.resolved", `Resolved ${finding.type} finding`); return { finding };
    });
  }

  startVoicePreview(slug: string, raw: unknown) { slugSchema.parse(slug); const input = voicePreviewSchema.parse(raw); return this.jobs.create("voicePreview", slug, async () => { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const config = story.pipeline.tts; const request = { ...input, provider: input.provider ?? config.provider, model: input.model ?? config.model, referenceId: input.referenceId ?? config.referenceId, speed: input.speed ?? config.speed }; const result = await withUsageScope({story:slug,stage:"voicePreview"},()=>this.tts.forName(request.provider).synthesize({ text: request.text, model: request.model, referenceId: request.referenceId, speed: request.speed, format: config.format, sampleRate: config.sampleRate, bitrate: config.bitrate, normalize: config.normalize, maxCharsPerRequest: config.maxCharsPerRequest })); const saved = await saveVoicePreview(this.root, slug, result.audio, request); await recordActivity(this.root, slug, "voice.preview", "Generated a voice preview"); return saved; }); }

  startProduction(slug: string, raw: unknown) { slugSchema.parse(slug); const input = productionInputSchema.parse(raw); return this.jobs.create("production", slug, async (control) => withStoryLock(this.root, slug, "end-to-end production", async () => { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); await recordActivity(this.root, slug, "production.started", `Started production for Chapters ${input.from}–${input.to}`); const manifest = (await runProduction({ root: this.root, story, ...input, pause: shutdown, recordedCost: this.usage ? () => this.usage!.recordedCost({ story: slug }) : undefined, onProgress: (event) => control.update(event) }, { pipeline: this.pipeline, loadChapters: async () => (await loadImportedChapters(this.root, slug)).chapters, refresh: (from, to) => refreshProductionRange({ root: this.root, story, from, to, registry: this.registry }), scenePlanner: this.scenePlanner ?? this.runtime.router.forStage(story.pipeline.scenePlanner), image: this.image, video: this.video, videoExport: this.videoExport, audiobook: this.audiobook, alignmentConfig: this.alignConfig, alignmentEngine: this.aligner })).manifest; await recordActivity(this.root, slug, `production.${manifest.status}`, `${manifest.status === "completed" ? "Completed" : "Stopped"} production for Chapters ${input.from}–${input.to}`); return manifest; })); }
  async submitProduction(slug:string,raw:unknown){if(this.queue)return this.queue.submit(slug,raw);return this.startProduction(slug,raw);}

  startPreview(slug: string, raw: unknown) {
    slugSchema.parse(slug); const input = previewInputSchema.parse(raw);
    return this.jobs.create("preview", slug, async () => withStoryLock(this.root, slug, "web preview", async () => {
      const story = await loadStory(storyPaths(this.root, slug, input.chapter).storyConfig); const imported = await loadImportedChapters(this.root, slug);
      const chapter = imported.chapters.find((item) => item.chapter === input.chapter); if (!chapter) throw new Error(`Imported source does not contain Chapter ${input.chapter}`);
      return withUsageScope({story:slug,chapter:input.chapter,stage:"preview"},()=>this.preview.run({ root: this.root, story, chapter: input.chapter, inputPath: chapter.path, presets: input.presets, audioPreview: input.audioPreview }));
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

  startAlignment(slug: string, raw: unknown) { slugSchema.parse(slug); const input = alignmentJobSchema.parse(raw); return this.jobs.create("alignment", slug, async (control) => withStoryLock(this.root, slug, "web chapter alignment", async () => { const story = await loadStory(storyPaths(this.root, slug, input.chapter).storyConfig); control.update({ type: "alignment.chapter.started", chapter: input.chapter }); return alignStoredChapter({ root: this.root, storySlug: slug, chapter: input.chapter, language: story.outputLanguage, config: this.alignConfig, engine: this.aligner, force: input.force, forceEstimated: input.forceEstimated, requireAligned: input.requireAligned, onEvent: (event) => control.update({ type: `alignment.${event.status}`, chapter: input.chapter, mode: event.mode }) }); })); }

  startSubtitles(slug: string, raw: unknown) { slugSchema.parse(slug); const input = rangeJobSchema.parse(raw); return this.jobs.create("subtitles", slug, async (control) => withStoryLock(this.root, slug, "web subtitle generation", async () => { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const selected = selectChapterRange((await loadImportedChapters(this.root, slug)).chapters, input.from, input.to); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); let generated = 0; let reused = 0; for (let index = 0; index < selected.length; index++) { if (shutdown.isRequested) return { status: "paused", generated, reused }; const chapter = selected[index]!.chapter; control.update({ type: "subtitles.chapter.started", chapter, index: index + 1, total: selected.length }); if (!input.forceEstimated) await alignStoredChapter({ root: this.root, storySlug: slug, chapter, language: story.outputLanguage, config: this.alignConfig, engine: this.aligner }); const result = await generateStoredSubtitles({ root: this.root, story, chapter, force: input.force, forceEstimated: input.forceEstimated }); result.reused ? reused++ : generated++; control.update({ type: "subtitles.chapter.completed", chapter, index: index + 1, total: selected.length, reused: result.reused }); } return { generated, reused, total: selected.length }; })); }

  async editSubtitles(slug: string, chapter: number, raw: unknown) { slugSchema.parse(slug); const input = z.object({ cues: z.array(z.unknown()).min(1).max(10_000) }).strict().parse(raw); return withStoryLock(this.root, slug, "manual subtitle edit", () => saveManualSubtitles(this.root, slug, chapter, input.cues)); }
  async resetSubtitles(slug: string, chapter: number) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "discard manual subtitles", async () => { await discardManualSubtitles(this.root, slug, chapter); const story = await loadStory(storyPaths(this.root, slug, chapter).storyConfig); return generateStoredSubtitles({ root: this.root, story, chapter, force: true }); }); }

  startVideo(slug: string, raw: unknown) { slugSchema.parse(slug); const input = videoJobSchema.parse(raw); return this.jobs.create("video", slug, async (control) => withStoryLock(this.root, slug, "web chapter video rendering", async () => { let story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); if (input.subtitleMode) story = { ...story, video: { ...story.video, subtitleMode: input.subtitleMode } }; const selected = selectChapterRange((await loadImportedChapters(this.root, slug)).chapters, input.from, input.to); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); let rendered = 0; let reused = 0; for (let index = 0; index < selected.length; index++) { if (shutdown.isRequested) return { status: "paused", rendered, reused }; const chapter = selected[index]!.chapter; if (story.video.subtitleMode !== "none") { await alignStoredChapter({ root: this.root, storySlug: slug, chapter, language: story.outputLanguage, config: this.alignConfig, engine: this.aligner }); await generateStoredSubtitles({ root: this.root, story, chapter }); } control.update({ type: "video.chapter.started", chapter, index: index + 1, total: selected.length }); const result = await renderStoredChapterVideo({ root: this.root, story, chapter, processor: this.video, force: input.force }); result.reused ? reused++ : rendered++; control.update({ type: "video.chapter.completed", chapter, index: index + 1, total: selected.length, reused: result.reused }); } return { rendered, reused, total: selected.length }; })); }

  startVideoExport(slug: string, raw: unknown) { slugSchema.parse(slug); const input = rangeJobSchema.parse(raw); return this.jobs.create("videoExport", slug, async (control) => withStoryLock(this.root, slug, "web combined video export", async () => { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const selected = selectChapterRange((await loadImportedChapters(this.root, slug)).chapters, input.from, input.to); for (let index = 0; index < selected.length; index++) { const chapter = selected[index]!.chapter; if (story.video.subtitleMode !== "none") { await alignStoredChapter({ root: this.root, storySlug: slug, chapter, language: story.outputLanguage, config: this.alignConfig, engine: this.aligner }); await generateStoredSubtitles({ root: this.root, story, chapter }); } const rendered = await renderStoredChapterVideo({ root: this.root, story, chapter, processor: this.video }); control.update({ type: "video.chapter.completed", chapter, index: index + 1, total: selected.length, reused: rendered.reused }); } return assembleVideoExport({ root: this.root, story, from: selected[0]!.chapter, to: selected.at(-1)!.chapter, processor: this.videoExport, force: input.force, onProgress: (event) => control.update(event) }); })); }

  startScenes(slug: string, raw: unknown) { slugSchema.parse(slug); const input = explicitRangeJobSchema.parse(raw); return this.jobs.create("scenes", slug, async (control) => withStoryLock(this.root, slug, "web scene planning", async () => { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const selected = selectChapterRange((await loadImportedChapters(this.root, slug)).chapters, input.from, input.to); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); let planned = 0; let reused = 0; for (let index = 0; index < selected.length; index++) { if (shutdown.isRequested) return { status: "paused", planned, reused }; const chapter = selected[index]!.chapter; control.update({ type: "scenes.chapter.started", chapter, index: index + 1, total: selected.length }); const provider = this.scenePlanner ?? this.runtime.router.forStage(story.pipeline.scenePlanner); const result = await withUsageScope({story:slug,chapter,stage:"scenePlanning"},()=>planStoredScenes({ root: this.root, story, chapter, provider, force: input.force })); result.reused ? reused++ : planned++; control.update({ type: "scenes.chapter.completed", chapter, index: index + 1, total: selected.length, scenes: result.manifest.scenes.length, reused: result.reused }); } return { planned, reused, total: selected.length }; })); }

  startArtwork(slug: string, raw: unknown) { slugSchema.parse(slug); const input = artworkJobSchema.parse(raw); return this.jobs.create("artwork", slug, async (control) => withStoryLock(this.root, slug, "web artwork generation", async () => { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const selected = selectChapterRange((await loadImportedChapters(this.root, slug)).chapters, input.from, input.to); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); let generated = 0; let estimate = 0; for (let index = 0; index < selected.length; index++) { if (shutdown.isRequested) return { status: "paused", generated, estimate }; const chapter = selected[index]!.chapter; const result = await withUsageScope({story:slug,chapter,stage:"artwork"},()=>generateStoredArtwork({ root: this.root, story, chapter, provider: this.image, sceneId: input.scene, force: input.force, dryRun: input.dryRun, onProgress: (event) => control.update({ ...event, chapterIndex: index + 1, chapterTotal: selected.length }) })); generated += "generated" in result ? result.generated ?? 0 : 0; estimate += result.imagesToGenerate; } return { dryRun: input.dryRun, generated, imageCountEstimate: estimate, chapters: selected.length }; })); }

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
