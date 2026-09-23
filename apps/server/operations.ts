import { loadPronunciationEntities, enrichStoryPronunciations, clearPronunciationAttempt, dismissPronunciationSuggestion, inspectPronunciationImpact, invalidatePronunciationChange, loadPronunciationSuggestions } from "../../src/story-bible/pronunciation.js";
import { pronunciationProvider, pronunciationFingerprint, resolvePronunciations } from "../../src/tts/pronunciation.js";
import { randomUUID } from "node:crypto";
import { censorToneConfig } from "../../src/tts/censor-audio.js";
import { normalizeSpeechForProvider } from "../../src/tts/speech-normalization.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { BatchRunner, ChapterProcessor, ProgressEvent } from "../../src/batch/batch-runner.js";
import { createBatchState } from "../../src/batch/batch-state.js";
import { retryConfigSchema } from "../../src/batch/types.js";
import { selectChapterNumbers, selectChapterRange } from "../../src/batch/range.js";
import { Environment } from "../../src/config/env.js";
import { defaultStory, loadStory } from "../../src/config/load-config.js";
import { Story, storySchema } from "../../src/domain/story.js";
import { createPipelineRuntime } from "../../src/pipeline/create-pipeline.js";
import { ConfigurationError, ReconciliationError, RollbackFailure } from "../../src/pipeline/errors.js";
import { applyPreviewProfile } from "../../src/preview/profile.js";
import { PreviewRunner } from "../../src/preview/preview-runner.js";
import { previewPresetSchema } from "../../src/preview/types.js";
import { importedChapterContentFingerprint, importSource, loadImportedChapters } from "../../src/source/importer.js";
import { validateImportable } from "../../src/source/inspection.js";
import { compareRemoteDirectory } from "../../src/source/refresh.js";
import { SourceProviderRegistry } from "../../src/source/registry.js";
import { applySourceMetadata } from "../../src/source/story-metadata.js";
import { translateStoryMetadata } from "../../src/translation/story-metadata.js";
import { SourceInspection, SourceManifest, SourceType, StorySourceProvider, sourceManifestSchema, sourceTypeSchema } from "../../src/source/types.js";
import { createWebHttpClient } from "../../src/source/web/create-client.js";
import { SourceConflictError, SourceInputError, SourceOperationError, SourceValidationError } from "../../src/source/errors.js";
import { atomicWrite, atomicWriteJson } from "../../src/storage/atomic-write.js";
import { previewPaths, storyPaths } from "../../src/storage/paths.js";
import { exists, readJsonIfExists } from "../../src/storage/story-files.js";
import { withStoryLock } from "../../src/storage/story-lock.js";
import { ShutdownController } from "../../src/batch/shutdown.js";
import { JobManager } from "./job-manager.js";
import { logger } from "../../src/utils/logger.js";
import { inspectStageArtifact, stalePrerequisiteWarning } from "../../src/studio/artifact-state.js";
import { AudioMasteringProcessor, FfmpegMasteringProcessor } from "../../src/audio/mastering.js";
import { masterStoredChapter } from "../../src/audio/chapter-audio.js";
import { AudiobookFormat, AudiobookProcessor, FfmpegAudiobookProcessor, assembleAudiobook } from "../../src/audio/audiobook.js";
import { generateStoredSubtitles } from "../../src/subtitles/chapter-subtitles.js";
import { FfmpegVideoProcessor, VideoProcessor } from "../../src/video/renderer.js";
import { renderStoredChapterVideo } from "../../src/video/chapter-video.js";
import { assembleVideoExport, FfmpegVideoExportProcessor, VideoExportProcessor } from "../../src/video/video-export.js";
import { LLMProvider } from "../../src/llm/provider.js";
import { applyStoredSceneRegeneration, planStoredScenes, previewStoredSceneRegeneration, updateStoredScene, updateStoredSceneManifest } from "../../src/scenes/manifest.js";
import { SceneManifest, sceneManifestSchema } from "../../src/scenes/types.js";
import { persistChapterVisualContinuity, removeVisualContinuityOverride, upsertVisualContinuityOverride, visualContinuityOverrideEntrySchema } from "../../src/visual-canon/continuity.js";
import { generateStoredArtwork, reviewStoredArtwork, reviewStoredArtworkVersion, reupscaleStoredArtwork } from "../../src/artwork/generator.js";
import { ImageProvider } from "../../src/artwork/provider.js";
import { ImageProviderSource, resolveImageProvider } from "../../src/artwork/providers.js";
import {
  loadVisualProfiles,
  getVisualProfile as loadVisualProfileEntity,
  updateVisualProfile,
  deleteVisualProfile,
  deleteVisualReferenceImage,
  addVisualReferenceImage,
  generateStyleSheet,
  approveVisualReference,
  handleEntityMerge,
  handleEntityDemote,
  prepareVisualCanonMerge,
  commitVisualCanonMerge,
  finalizeVisualCanonMerge,
  rollbackPreparedVisualCanonMerge,
  prepareVisualCanonDemote,
  commitVisualCanonDemote,
  rollbackPreparedVisualCanonDemote,
} from "../../src/visual-canon/profiles.js";
import { applyVisualProfileProposal, proposeMissingVisualDetails, resolveVisualProfileConflict, synchronizeVisualProfileConflicts, visualProfileProposalSchema } from "../../src/visual-canon/completion.js";
import { loadStoryArtDirection, saveStoryArtDirection, createPreset, updatePreset, deletePreset, duplicatePreset, setDefaultPreset } from "../../src/visual-canon/art-direction.js";
import { visualProfileSchema } from "../../src/domain/visual-profile.js";
import { storyArtDirectionSchema, artDirectionPresetEditSchema, createArtDirectionPresetSchema } from "../../src/domain/art-direction.js";
import { artworkReviewSchema } from "../../src/scenes/types.js";
import { planProduction, runProduction } from "../../src/production/orchestrator.js";
import { productionForceSchema, productionOutputSchema } from "../../src/production/types.js";
import { refreshProductionRange } from "../../src/production/refresh.js";
import { TTSProvider } from "../../src/tts/provider.js";
import { TTSProviderRouter } from "../../src/tts/router.js";
import { CensorAudioService, FfmpegCensorAudioService } from "../../src/tts/censor-audio.js";
import { addManualBibleEntry, bibleCategorySchema, chapterTextEditSchema, deleteBibleEntry, saveChapterTextEdit, saveVoicePreview, updateManualBibleEntry, voicePreviewSchema } from "../../src/studio/workflow.js";
import { getContinuityReview, getStoryBible, invalidateCatalogCache, loadChapterSummaries, mapLimit } from "./catalog.js";
import { buildStoryBackup, cleanupKindSchema, cleanupStory, createBlankStory, deleteStory, duplicateStory, getStorageUsage, invalidateStoryForConfigChange, loadGlobalSettings, readActivity, recordActivity, restoreStoryBackupFile, saveCover, saveGlobalSettings, systemStatus, updateStoryMetadata } from "../../src/studio/projects.js";
import { ProductionQueueService } from "../../src/queue/production-service.js";
import { alignmentConfig, createAlignmentEngine } from "../../src/alignment/config.js";
import { AlignmentEngine } from "../../src/alignment/types.js";
import { alignStoredChapter } from "../../src/alignment/chapter-alignment.js";
import { discardManualSubtitles, saveManualSubtitles } from "../../src/subtitles/chapter-subtitles.js";
import { backfillCanonicalSnapshots, mergeCanonicalEntities, namingMappingConflict, previewCanonicalEntityUpdate, restoreCanonicalEntity, suppressCanonicalEntity, undoCanonicalMerge, updateCanonicalEntity } from "../../src/story-bible/canonical.js";
import { analyzeStoryBible, applyCleanupRecommendations, demoteCanonicalEntity, promoteMinorReference, restorePreDemoteStoryBible, snapshotPreDemoteStoryBible, updateMinorReference } from "../../src/story-bible/granularity.js";
import { continuityFindingSchema, resolveContinuityFinding } from "../../src/story-bible/continuity.js";
import { appendEntityAudit, type EntityAuditInput } from "../../src/story-bible/entity-audit.js";
import { PostgresUsageRepository } from "../../src/cost/repository.js";
import { estimatePlanCost } from "../../src/cost/estimate.js";
import { withUsageScope } from "../../src/cost/context.js";
import { inspectEntityReferenceChapters, inspectNarrationNamingImpact, invalidateCanonicalIdentityChange, invalidateNarrationNamingChange, narrationNamingChanged } from "../../src/story-bible/narration-names.js";
import { findChapterGaps } from "../../src/batch/gaps.js";
import { Chapter, chapterSchema, StageName } from "../../src/domain/chapter.js";
import { fingerprint } from "../../src/utils/hash.js";
import { fileFingerprint } from "../../src/utils/file-fingerprint.js";
import { NovelProviderId, novelProviderIdSchema, storyNovelSourceSchema } from "../../src/source/novel-provider.js";
import { activeQaIssues, qaExceptionSchema, qaResultSchema, type QaFinding } from "../../src/domain/qa.js";
import { migrateQaState, openFindings, qaCounts, qaFindingStats } from "../../src/qa/findings.js";
import { deriveChapterQaFreshness } from "../../src/qa/freshness.js";
import { resolveQaFindingsByIndex, recheckChapterQa, transitionQaFinding, type QaFindingTransition } from "../../src/qa/review.js";
import { addQaException, listQaExceptions, prepareQaException, removeQaException } from "../../src/qa/exceptions.js";
import { resetChapterQa, resetChapterQaBatch, qaResetScopeSchema } from "../../src/qa/reset.js";
import { applyNarrationNamingPreferences } from "../../src/narration/naming-preferences.js";
import { loadNarrationNamingEntities } from "../../src/story-bible/narration-names.js";
import { inferQaRepairTargets, repairQaText, type QaRepairTarget } from "../../src/qa/repair.js";
import { QaRepairTargetAmbiguousError } from "../../src/qa/errors.js";
import { persistQaStateWithMetadata } from "../../src/qa/persistence.js";
import { LLMRouter } from "../../src/llm/router.js";
import { validateChapterQuality } from "../../src/qa/validator.js";
import { canonicalEntitySchema, emptyStoryBible, entityTypeSchema, storyBibleSchema, type CanonicalEntity } from "../../src/domain/story-bible.js";
import { SummaryService } from "../../src/summaries/service.js";
import { SummaryMediaService, summaryMediaInputSchema, summaryNarrationEditSchema, summaryScenesInputSchema } from "../../src/summaries/media.js";
import { SummaryVisualService, summaryVisualInputSchema, summaryProduceInputSchema } from "../../src/summaries/visuals.js";
import type { SummaryArtDirectionOverride } from "../../src/summaries/types.js";
import { generateLocalizedNameSuggestions, localizationSuggestionRequestSchema } from "../../src/story-bible/localization.js";
import { inspectStagesForCurrent, markCurrentInputSchema, markStagesCurrent } from "../../src/studio/stage-acceptance.js";
import { executeStagePlan, planStageExecution, planStageExecutionBatch, stageExecutionInputSchema, stageExecutionModeSchema } from "../../src/studio/stage-execution.js";
import { batchStageSchema } from "../../src/studio/stage-selection.js";
import { WhisperCppSpeechTranscriber } from "../../src/alignment/transcription.js";
import { QualityGuardTTSProvider, SpeechTranscriber } from "../../src/tts/quality-guard.js";
import { acceptStoredChapterTtsSegment, loadChapterTtsQuality, regenerateStoredChapterTtsSegment, verifyStoredChapterTts } from "../../src/tts/chapter-quality.js";

const chapterParamSchema = z.number().int().positive();
const segmentParamSchema = z.number().int().min(1).max(99_999);

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
function summaryArtDirectionIdentity(value: SummaryArtDirectionOverride | undefined) {
  return value?.mode === "preset" ? { mode: value.mode, presetId: value.presetId } : value?.mode === "disabled" ? { mode: value.mode } : { mode: "story-default" };
}
const batchInputSchema = z.object({ from: z.number().int().positive().optional(), to: z.number().int().positive().optional(), force: z.enum(["translation", "narration", "qa", "story-bible", "continuity", "tts", "audio", "all"]).optional(), stage: batchStageSchema.optional(), mode: stageExecutionModeSchema.default("selected"), continueOnError: z.boolean().default(false) }).strict().refine((value) => !(value.stage && value.force), { message: "Choose either a manual stage or the legacy force stage, not both" });
const qaRepairInputSchema = z.object({ issueIndexes: z.array(z.number().int().nonnegative()).min(1).max(100), targetOverrides: z.record(z.string(), z.enum(["translation", "narration", "both"])).optional() }).strict();
const qaDismissInputSchema = z.object({ issueIndexes: z.array(z.number().int().nonnegative()).min(1).max(100), disposition: z.enum(["dismissed", "manually_fixed"]).default("dismissed") }).strict();
const qaFindingIdSchema = z.string().regex(/^qaf_[a-f0-9]{24}$/);
const qaExceptionIdSchema = z.string().regex(/^qax_[a-f0-9]{24}$/);
const qaRecheckInputSchema = z.object({ mode: z.enum(["changed", "full"]).default("full") }).strict();
const qaResolveManualInputSchema = z.object({ finalText: z.string().max(500_000).optional() }).strict();
const qaFindingDismissInputSchema = z.object({
  reason: z.string().max(1_000).optional(),
  remember: z.object({ matchKind: qaExceptionSchema.shape.matchKind, value: z.string().trim().min(1).max(300) }).strict().optional(),
}).strict();
const qaFindingFixInputSchema = z.object({ target: z.enum(["translation", "narration", "both"]).optional() }).strict();
const qaExceptionInputSchema = z.object({
  category: qaExceptionSchema.shape.category, matchKind: qaExceptionSchema.shape.matchKind,
  value: z.string().trim().min(1).max(300), reason: z.string().max(1_000).optional(),
}).strict();

async function recordQaActivityBestEffort(root: string, slug: string, type: string, summary: string): Promise<void> {
  try { await recordActivity(root, slug, type, summary); }
  catch (error) { logger.warn({ event: "qa.activity_log_failed", story: slug, type, error: error instanceof Error ? error.message : String(error) }); }
}
const previewInputSchema = z.object({ chapter: z.number().int().positive(), audioPreview: z.boolean().default(false), presets: z.object({ a: previewPresetSchema, b: previewPresetSchema }) }).strict();
const audioInputSchema = z.object({ from: z.number().int().positive().optional(), to: z.number().int().positive().optional(), force: z.boolean().default(false) }).strict();
const audiobookInputSchema = z.object({ from: z.number().int().positive(), to: z.number().int().positive(), format: z.enum(["mp3", "m4b"]), force: z.boolean().default(false) }).strict();
const rangeJobSchema = z.object({ from: z.number().int().positive().optional(), to: z.number().int().positive().optional(), force: z.boolean().default(false), forceEstimated: z.boolean().default(false) }).strict();
const alignmentJobSchema = z.object({ chapter: z.number().int().positive(), force: z.boolean().default(false), forceEstimated: z.boolean().default(false), requireAligned: z.boolean().default(false) }).strict();
const videoJobSchema = rangeJobSchema.extend({ subtitleMode: z.enum(["none", "burn", "soft", "both"]).optional() }).strict();
const explicitRangeJobSchema = z.object({ from: z.number().int().positive(), to: z.number().int().positive(), force: z.boolean().default(false) }).strict().refine((value) => value.to >= value.from, { message: "Range end must be at or after range start" });
const artworkJobSchema = z.object({ from: z.number().int().positive(), to: z.number().int().positive(), force: z.boolean().default(false), scene: z.string().regex(/^scene-\d{3}$/).optional(), scenes: z.array(z.string().regex(/^scene-\d{3}$/)).min(1).max(100).refine((ids) => new Set(ids).size === ids.length, "Selected scene IDs must be unique").optional(), dryRun: z.boolean().default(false), allowUnprofiledEntityIds: z.array(canonicalEntitySchema.shape.id).max(100).default([]) }).strict().refine((value) => value.to >= value.from, { message: "Range end must be at or after range start" }).refine((value) => !value.scenes || !value.scene, { message: "Choose either one scene or a scene selection" }).refine((value) => !(value.scene || value.scenes) || value.from === value.to, { message: "Selected scenes must belong to one chapter" });
const productionInputSchema = z.object({ from: z.number().int().positive(), to: z.number().int().positive(), profile: z.string().optional(), outputs: z.array(productionOutputSchema).min(1).optional(), artwork: z.boolean().optional(), repairQa: z.boolean().optional(), alignment: z.boolean().optional(), refresh: z.boolean().default(false), dryRun: z.boolean().default(false), force: productionForceSchema.optional(), audiobookFormat: z.enum(["mp3", "m4b"]).optional(), maxProviderBudgetUsd: z.number().positive().max(1_000_000).optional() }).strict().refine((value) => value.to >= value.from, { message: "Range end must be at or after range start" });

type InspectionRecord = { inspection: SourceInspection; temporaryDirectory?: string; createdAt: number; bytes: number };
export type OperationsDependencies = { pipeline?: ChapterProcessor; preview?: PreviewRunner; registry?: SourceProviderRegistry; llm?: LLMRouter; audio?: AudioMasteringProcessor; audiobook?: AudiobookProcessor; video?: VideoProcessor; videoExport?: VideoExportProcessor; scenePlanner?: LLMProvider; image?: ImageProviderSource; tts?: TTSProvider | TTSProviderRouter; censor?: CensorAudioService; alignment?: AlignmentEngine; speechTranscriber?: SpeechTranscriber; queue?: ProductionQueueService; usage?: PostgresUsageRepository };

async function attemptRollback(
  phase: string,
  operation: () => Promise<unknown>,
  failures: RollbackFailure[],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push({ phase, error });
  }
}

/** Fields tracked by the entity audit trail; only changed fields are recorded. */
const ENTITY_AUDIT_FIELDS = ["canonicalName", "type", "aliases", "canonicalNameLocked", "notes", "status", "preferredNarrationName", "aliasNarrationRules", "localizedNaming", "pronunciation", "visualProfilePolicy"] as const;

function entityPatchAuditEntries(before: CanonicalEntity, after: CanonicalEntity): EntityAuditInput[] {
  const deltaBefore: Record<string, unknown> = {};
  const deltaAfter: Record<string, unknown> = {};
  for (const field of ENTITY_AUDIT_FIELDS) {
    const previous = before[field] ?? null;
    const next = after[field] ?? null;
    if (JSON.stringify(previous) !== JSON.stringify(next)) { deltaBefore[field] = previous; deltaAfter[field] = next; }
  }
  const keys = Object.keys(deltaAfter);
  if (!keys.length) return [];
  let action: EntityAuditInput["action"] = "updated";
  if (keys.includes("canonicalName")) action = "renamed";
  else if (keys.includes("type")) action = "type_changed";
  else if (keys.some((key) => key === "preferredNarrationName" || key === "aliasNarrationRules")) action = "narration_mapping_changed";
  else if (keys.includes("localizedNaming")) action = "localized_naming_changed";
  else if (keys.includes("visualProfilePolicy")) action = "visual_profile_policy_changed";
  else if (keys.length === 1 && keys[0] === "canonicalNameLocked") action = after.canonicalNameLocked ? "locked" : "unlocked";
  return [{ entityId: after.id, action, before: deltaBefore, after: deltaAfter, source: "manual" }];
}

export class StudioOperations {
  private static readonly maxInspections = 10;
  private static readonly maxInspectionBytes = 100 * 1024 * 1024;
  private readonly inspections = new Map<string, InspectionRecord>();
  private readonly pipeline: ChapterProcessor; private readonly preview: PreviewRunner; private readonly registry: SourceProviderRegistry;
  private readonly audio: AudioMasteringProcessor; private readonly audiobook: AudiobookProcessor;
  private readonly video: VideoProcessor; private readonly videoExport: VideoExportProcessor;
  private readonly llm: LLMRouter;
  private readonly scenePlanner?: LLMProvider; private readonly image: ImageProviderSource; private readonly tts: TTSProviderRouter; private readonly censor: CensorAudioService; private readonly runtime: ReturnType<typeof createPipelineRuntime>;
  private readonly alignConfig; private readonly aligner?: AlignmentEngine; private readonly transcriber?: SpeechTranscriber;
  private readonly summaryImages: ReturnType<typeof createPipelineRuntime>["images"] | ImageProvider;
  private readonly inspectionTimer: NodeJS.Timeout; private inspectionBytes = 0;
  readonly queue?: ProductionQueueService; readonly usage?: PostgresUsageRepository;
  constructor(public readonly root: string, private readonly env: Environment, public readonly jobs = new JobManager(), dependencies: OperationsDependencies = {}) {
    this.usage = dependencies.usage; const runtime = createPipelineRuntime(env, this.usage); this.runtime = runtime; this.llm = dependencies.llm ?? runtime.router; this.pipeline = dependencies.pipeline ?? runtime.pipeline; this.censor = dependencies.censor ?? runtime.censor ?? new FfmpegCensorAudioService(); this.preview = dependencies.preview ?? new PreviewRunner(this.llm, runtime.tts, this.censor);
    this.registry = dependencies.registry ?? new SourceProviderRegistry(undefined, createWebHttpClient(root, env));
    this.audio = dependencies.audio ?? runtime.audio ?? new FfmpegMasteringProcessor(); this.audiobook = dependencies.audiobook ?? new FfmpegAudiobookProcessor();
    this.video = dependencies.video ?? new FfmpegVideoProcessor(); this.videoExport = dependencies.videoExport ?? new FfmpegVideoExportProcessor();
    this.scenePlanner = dependencies.scenePlanner; this.image = dependencies.image ?? runtime.images; this.summaryImages = dependencies.image && typeof dependencies.image !== "function" ? dependencies.image : runtime.images; this.tts = dependencies.tts instanceof TTSProviderRouter ? dependencies.tts : dependencies.tts ? new TTSProviderRouter(dependencies.tts) : runtime.tts;
    this.queue = dependencies.queue; this.transcriber = dependencies.speechTranscriber; this.alignConfig = alignmentConfig(env, root); this.aligner = dependencies.alignment ?? createAlignmentEngine(this.alignConfig);
    this.inspectionTimer = setInterval(() => this.expireInspections(), 60_000); this.inspectionTimer.unref();
  }
  async previewMarkStagesCurrent(slug: string, raw: unknown) {
    const input = z.object({ chapters: z.array(z.number().int().positive()).min(1).max(2_000) }).strict().parse(raw);
    return inspectStagesForCurrent(this.root, slug, input.chapters);
  }
  async markStagesCurrent(slug: string, raw: unknown) {
    const result = await markStagesCurrent(this.root, slug, markCurrentInputSchema.parse(raw));
    invalidateCatalogCache(this.root, slug);
    return result;
  }
  async planStageExecution(slug: string, raw: unknown) {
    slugSchema.parse(slug); const input = stageExecutionInputSchema.parse(raw);
    const imported = await loadImportedChapters(this.root, slug); const selected = selectChapterNumbers(imported.chapters, input.chapters);
    return planStageExecutionBatch({ root: this.root, story: slug, chapters: selected.map((chapter) => chapter.chapter), selectedStages: input.stages, mode: input.mode, force: input.force });
  }
  startStageExecution(slug: string, raw: unknown) {
    slugSchema.parse(slug); const input = stageExecutionInputSchema.parse(raw);
    if (input.dryRun) return this.planStageExecution(slug, input);
    return this.jobs.create("stageExecution", slug, async (control) => withStoryLock(this.root, slug, "manual stage processing", async () => {
      const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const imported = await loadImportedChapters(this.root, slug);
      const selected = selectChapterNumbers(imported.chapters, input.chapters); const batchPlan = await planStageExecutionBatch({ root: this.root, story: slug, chapters: selected.map((chapter) => chapter.chapter), selectedStages: input.stages, mode: input.mode, force: input.force });
      if (input.expectedPlanFingerprint && input.expectedPlanFingerprint !== batchPlan.fingerprint) throw new ConfigurationError("The execution plan changed after preview. Preview the current plan before running it.");
      if (batchPlan.summary.blockedOperations) throw new ConfigurationError(`${batchPlan.summary.blockedOperations} stage operation${batchPlan.summary.blockedOperations === 1 ? " is" : "s are"} blocked by unavailable prerequisites. Select prerequisite mode and preview again.`);
      const sources = new Map(selected.map((item) => [item.chapter, item])); const results: Array<{ chapter: number; status: "completed" | "reused" | "blocked" | "failed"; plan: (typeof batchPlan.chapters)[number]; error?: string }> = [];
      for (const plan of batchPlan.chapters) {
        const chapter = plan.chapter; const source = sources.get(chapter)!;
        control.update({ type: "stage-execution.chapter.planned", chapter, plan });
        if (plan.blockedStages.length) { results.push({ chapter, status: "blocked", plan }); continue; }
        if (!plan.runStages.length) { results.push({ chapter, status: "reused", plan }); continue; }
        try {
          await executeStagePlan({ root: this.root, story, chapter, inputPath: source.path, source: source.source, plan,
            runtime: { pipeline: this.pipeline, alignment: { config: this.alignConfig, engine: this.aligner }, scenePlanner: this.scenePlanner ?? this.runtime.router.forStage(story.pipeline.scenePlanner), image: this.image, video: this.video },
            onStageEvent: (event) => control.update({ type: "stage", chapter, event }) });
          results.push({ chapter, status: "completed", plan });
        } catch (error) {
          if (!input.continueOnError) throw error;
          results.push({ chapter, status: "failed", plan, error: error instanceof Error ? error.message : String(error) });
        }
      }
      invalidateCatalogCache(this.root, slug); return { fingerprint: batchPlan.fingerprint, results, summary: { ...batchPlan.summary, completedOperations: results.filter((item) => item.status === "completed").reduce((count, item) => count + item.plan.runStages.length, 0), completedChapters: results.filter((item) => item.status === "completed").length, reusedChapters: results.filter((item) => item.status === "reused").length, blockedChapters: results.filter((item) => item.status === "blocked").length, failedChapters: results.filter((item) => item.status === "failed").length } };
    }), { chapters: input.chapters, stages: input.stages, mode: input.mode, force: input.force });
  }

  novelProviders() { return this.registry.listNovelProviders(); }
  diagnoseNovelProvider(id: string) { return this.registry.diagnoseNovelProvider(novelProviderIdSchema.parse(id)); }
  setNovelProviderEnabled(id: string, raw: unknown) { const provider = novelProviderIdSchema.parse(id); const input = z.object({ enabled: z.boolean() }).strict().parse(raw); input.enabled ? this.registry.enableNovelProvider(provider) : this.registry.disableNovelProvider(provider); return this.registry.listNovelProviders().find((item) => item.id === provider)!; }
  async searchNovelSources(raw: unknown) {
    const input = z.object({ query: z.string().trim().min(1).max(200), providers: z.array(novelProviderIdSchema).max(20).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict().parse(raw);
    return this.registry.searchNovels(input.query, input.providers, input.limit);
  }

  async updateNovelSourcePriorities(slug: string, raw: unknown) {
    slugSchema.parse(slug);
    const input = z.object({ sources: z.array(z.object({ provider: novelProviderIdSchema, bookId: z.string().min(1), priority: z.number().int().min(0).max(10_000), enabled: z.boolean() }).strict()).max(100) }).strict().parse(raw);
    const keys = new Set(input.sources.map((source) => `${source.provider}\0${source.bookId}`));
    if (keys.size !== input.sources.length) throw new ConfigurationError("Each configured novel source may appear only once");
    return withStoryLock(this.root, slug, "novel source priority update", async () => {
      const paths = storyPaths(this.root, slug, 1); const current = await loadStory(paths.storyConfig);
      const currentKeys = new Set(current.sources.map((source) => `${source.provider}\0${source.bookId}`));
      for (const key of keys) if (!currentKeys.has(key)) throw new ConfigurationError("Source priority updates may only reference sources already attached to this story");
      const changes = new Map(input.sources.map((source) => [`${source.provider}\0${source.bookId}`, source]));
      const sources = current.sources.map((source) => storyNovelSourceSchema.parse({ ...source, ...(changes.get(`${source.provider}\0${source.bookId}`) ?? {}) }));
      const story = storySchema.parse({ ...current, sources }); await atomicWriteJson(paths.storyConfig, story);
      await recordActivity(this.root, slug, "source.priority", "Updated novel source priority and availability"); invalidateCatalogCache(this.root, slug); return story;
    });
  }

  async inspectSource(input: { url?: string; file?: Uint8Array; filename?: string; files?: Array<{ name: string; text: string }>; type?: SourceType; from?: number; to?: number; chapter?: number; splitChapters?: boolean; allowGaps?: boolean; acquisition?: "html" | "bulk-download" }, context?: { story: string; additive: boolean }) {
    this.expireInspections(); let source: string; let temporaryDirectory: string | undefined;
    const type = input.type === undefined ? undefined : sourceTypeSchema.parse(input.type);
    try {
      if (input.url) { let url: URL; try { url = new URL(input.url); } catch (error) { throw new SourceInputError("Source URL is invalid", { cause: error }); } if (url.protocol !== "https:") throw new SourceInputError("Only HTTPS source URLs are allowed"); source = url.toString(); }
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
      if (remote && ((input.from === undefined) !== (input.to === undefined))) throw new SourceInputError("Remote chapter ranges require both from and to");
      if (input.acquisition === "bulk-download" && (!remote || !supportsBulk(provider))) throw new SourceValidationError("The selected source does not support full-manuscript downloads");
      let inspection = await this.registry.inspect(provider, source, { semanticType, from: input.from, to: input.to, chapter: input.chapter, splitChapters: input.splitChapters, allowGaps: input.allowGaps, acquisition: input.acquisition });
      if (remote && context?.story && inspection.warnings.some((warning) => warning.code === "unavailable_chapter")) inspection = await this.applyConfiguredFallbacks(context.story, inspection, input.from, input.to);
      const previousRaw = context ? await readJsonIfExists<SourceManifest>(storyPaths(this.root, context.story, 1).sourceManifest) : undefined;
      const previous = previousRaw ? sourceManifestSchema.safeParse(previousRaw) : undefined;
      if (context?.additive && previousRaw && !previous?.success) throw new SourceConflictError(`Cannot safely update '${context.story}' because its source manifest is invalid`);
      const storedInspection = { ...inspection, additive: Boolean(context?.additive && previous?.success) };
      const bytes = storedInspection.chapters.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
      if (this.inspections.size >= StudioOperations.maxInspections || this.inspectionBytes + bytes > StudioOperations.maxInspectionBytes) {
        throw new SourceConflictError("Too many pending source inspections; import an existing inspection or wait for it to expire");
      }
      const id = randomUUID(); this.inspections.set(id, { inspection: storedInspection, temporaryDirectory, createdAt: Date.now(), bytes }); this.inspectionBytes += bytes;
      const selected = storedInspection.chapters.map((item) => item.ref); const available = storedInspection.directory?.length ?? selected.length;
      const update = previous?.success ? await sourceUpdatePreview(storyPaths(this.root, context!.story, 1).source, previous.data, storedInspection) : undefined;
      return { id, type: storedInspection.sourceType, title: storedInspection.title, author: storedInspection.author, language: storedInspection.language,
        chapterCount: selected.length, availableChapterCount: available, chapters: selected.slice(0, 200), truncated: selected.length > 200,
        warnings: storedInspection.warnings, metadata: storedInspection.metadata, update };
    } catch (error) { if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }); throw error; }
  }

  async importInspection(slug: string, inspectionId: string, allowGaps = false, overwriteExisting = false) {
    slugSchema.parse(slug); const record = this.inspections.get(inspectionId); if (!record) throw new Error("Inspection expired or was not found");
    try { validateImportable(record.inspection.chapters, record.inspection.warnings, allowGaps); }
    catch (error) { if (error instanceof SourceOperationError) throw error; throw new SourceValidationError(error instanceof Error ? error.message : String(error), { cause: error }); }
    const result = await withStoryLock(this.root, slug, "web source import", async () => {
        const paths = storyPaths(this.root, slug, record.inspection.chapters[0]?.ref.chapter ?? 1); const existed = await exists(paths.storyConfig);
        let story = existed ? await loadStory(paths.storyConfig) : defaultStory(slug, this.env); story = applySourceMetadata(story, record.inspection, !existed);
        const result = await importSource(this.root, slug, record.inspection, async () => { await atomicWriteJson(paths.storyConfig, story); await atomicWriteJson(paths.pipelineConfig, story.pipeline); }, { overwriteExisting });
        return { status: result.status, story, added: result.added, modified: result.modified, removed: result.removed, chapters: result.manifest.chapters.length };
      });
    try { await this.discardInspection(inspectionId); }
    catch (error) { logger.warn({ event: "web.inspection.cleanup_failed", inspectionId, error: error instanceof Error ? error.message : String(error) }); }
    await recordActivity(this.root, slug, "source.imported", `Imported ${result.added.length} new and updated ${result.modified.length} chapters`); invalidateCatalogCache(this.root, slug); return result;
  }

  private async applyConfiguredFallbacks(slug: string, primary: SourceInspection, from?: number, to?: number): Promise<SourceInspection> {
    const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig);
    const inferred = story.source.url ? this.registry.novelProviderIdForUrl(story.source.url) : undefined;
    const configured: Array<{ provider: NovelProviderId; bookId: string; url: string }> = story.sources.length
      ? [...story.sources].filter((item) => item.enabled).sort((left, right) => left.priority - right.priority)
      : inferred && story.source.url ? [{ provider: inferred, bookId: story.source.externalId ?? "unknown", url: story.source.url }] : [];
    const candidates = configured.filter((item) => item.url !== primary.origin?.url);
    if (!candidates.length) return primary;
    const requested = new Set<number>(); const start = from ?? primary.directory?.[0]?.chapter; const end = to ?? primary.directory?.at(-1)?.chapter;
    if (start !== undefined && end !== undefined) for (let chapter = start; chapter <= end; chapter++) requested.add(chapter);
    for (const item of primary.chapters) requested.delete(item.ref.chapter);
    const attempts: Array<{ provider: string; chapter: number; status: string; reason: string; extractedCharacters?: number; expectedCharacters?: number }> = [];
    for (const warning of primary.warnings.filter((item) => item.code === "unavailable_chapter")) {
      const chapter = primary.directory?.find((item) => item.sourceId === warning.sourceId)?.chapter ?? numberFromMessage(warning.message);
      if (chapter) attempts.push({ provider: String(primary.metadata?.provider ?? primary.sourceType), chapter, status: validationStatusFromMessage(warning.message), reason: warning.message });
    }
    const previousRaw = await readJsonIfExists<SourceManifest>(storyPaths(this.root, slug, 1).sourceManifest); const previous = previousRaw ? sourceManifestSchema.safeParse(previousRaw) : undefined;
    if (previous?.success) for (const item of previous.data.chapters) requested.delete(item.chapter);
    const chapters = [...primary.chapters]; const directory = new Map((primary.directory ?? []).map((item) => [item.chapter, item]));
    for (const candidate of candidates) {
      if (!requested.size) break;
      try {
        const { provider } = await this.registry.resolve(candidate.url); const catalog = await this.registry.inspect(provider, candidate.url);
        const available = (catalog.directory ?? []).filter((item) => requested.has(item.chapter)).map((item) => item.chapter);
        if (!available.length) { for (const chapter of requested) attempts.push({ provider: candidate.provider, chapter, status: "INVALID", reason: "Chapter is absent from this provider's catalog" }); continue; }
        const fallback = await this.registry.inspect(provider, candidate.url, { chapters: available });
        for (const warning of fallback.warnings.filter((item) => item.code === "unavailable_chapter")) {
          const chapter = fallback.directory?.find((item) => item.sourceId === warning.sourceId)?.chapter;
          if (chapter) attempts.push({ provider: candidate.provider, chapter, status: validationStatusFromMessage(warning.message), reason: warning.message });
        }
        for (const item of fallback.chapters) {
          if (!requested.has(item.ref.chapter)) continue;
          chapters.push(item); directory.set(item.ref.chapter, item.ref); requested.delete(item.ref.chapter);
          const validation = item.ref.metadata.validation as { status?: string; evidence?: { extractedCharacters?: number; expectedCharacters?: number } } | undefined;
          attempts.push({ provider: candidate.provider, chapter: item.ref.chapter, status: validation?.status ?? "COMPLETE", reason: "Accepted as the first complete configured fallback", extractedCharacters: validation?.evidence?.extractedCharacters, expectedCharacters: validation?.evidence?.expectedCharacters });
        }
      } catch (error) {
        for (const chapter of requested) attempts.push({ provider: candidate.provider, chapter, status: /challenge|captcha|interstitial|browser-verification/i.test(String(error)) ? "CHALLENGE_REQUIRED" : /blocked|access denied/i.test(String(error)) ? "BLOCKED" : "INVALID", reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const unresolved = primary.warnings.filter((warning) => warning.code !== "unavailable_chapter");
    for (const chapter of requested) unresolved.push({ code: "unavailable_chapter", message: `Chapter ${chapter} is unavailable from every configured source`, sourceId: String(chapter) });
    chapters.sort((a, b) => a.ref.chapter - b.ref.chapter);
    return { ...primary, sourceType: chapters.some((item) => item.ref.sourceType === "web") ? "web" : primary.sourceType, chapters,
      directory: [...directory.values()].sort((a, b) => a.chapter - b.chapter), warnings: unresolved,
      fingerprint: fingerprint({ primary: primary.fingerprint, fallbackChapters: chapters.map((item) => ({ chapter: item.ref.chapter, provider: item.ref.metadata.provider, sourceId: item.ref.sourceId })) }),
      metadata: { ...primary.metadata, fallbackAttempts: attempts } };
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

  startMetadataTranslation(slug: string) {
    slugSchema.parse(slug);
    return this.jobs.create("metadataTranslation", slug, async () => withStoryLock(this.root, slug, "story metadata translation", async () => {
      const paths = storyPaths(this.root, slug, 1); const current = await loadStory(paths.storyConfig);
      const source = current.metadataTranslationSource;
      if (sameLanguage(source?.language ?? current.sourceLanguage, current.outputLanguage)) {
        if (!source) return { story: current, reused: true };
        const story = storySchema.parse({ ...current, title: source.title, author: source.author, description: source.description, tags: source.tags,
          originalTitle: current.originalTitle ?? source.title, metadataTranslatedAt: undefined });
        const reused = story.title === current.title && story.author === current.author && story.description === current.description
          && JSON.stringify(story.tags) === JSON.stringify(current.tags) && current.metadataTranslatedAt === undefined;
        if (!reused) {
          await invalidateStoryForConfigChange(this.root, slug, current, story); await atomicWriteJson(paths.storyConfig, story);
          await recordActivity(this.root, slug, "story.metadata_restored", `Restored original story metadata for ${story.outputLanguage}`); invalidateCatalogCache(this.root, slug);
        }
        return { story, reused, restored: true };
      }
      const provider = this.runtime.router.forStage(current.pipeline.translation);
      const result = await withUsageScope({ story: slug, stage: "metadataTranslation" }, () => translateStoryMetadata(provider, current.pipeline.translation, current));
      const story = storySchema.parse({ ...current, title: result.translated.title, author: result.translated.author ?? result.source.author, description: result.translated.description, tags: result.translated.tags,
        originalTitle: current.originalTitle ?? result.source.title, metadataTranslationSource: result.source, metadataTranslatedAt: new Date().toISOString() });
      await invalidateStoryForConfigChange(this.root, slug, current, story); await atomicWriteJson(paths.storyConfig, story);
      await recordActivity(this.root, slug, "story.metadata_translated", `Translated story metadata to ${story.outputLanguage}`); invalidateCatalogCache(this.root, slug);
      return { story, reused: false };
    }));
  }
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
      const selected = selectChapterRange(imported.chapters, input.from, input.to); const state = createBatchState({ root: this.root, story: slug, inputDirectory: imported.directory, chapters: selected, allowGaps: true, continueOnError: input.continueOnError, delayMs: 0, force: input.force, stopAfter: batchStopAfter(input.force), stage: input.stage, mode: input.mode });
      const shutdown = new ShutdownController(); control.setPause(() => shutdown.request());
      const processor: ChapterProcessor = input.stage ? { run: async (request) => {
        // Legacy /batch callers selected one stage as an explicit rerun action. Preserve that
        // long-standing force behavior here; the new /stages/plan + /stages/run dispatcher
        // passes its own `force` flag unchanged and never inherits this legacy default.
        const plan = await planStageExecution({ root: this.root, story: slug, chapter: request.chapter, selectedStages: [input.stage!], mode: input.mode, force: true });
        await executeStagePlan({ root: this.root, story, chapter: request.chapter, inputPath: request.inputPath, source: request.source, plan,
          runtime: { pipeline: this.pipeline, alignment: { config: this.alignConfig, engine: this.aligner }, scenePlanner: this.scenePlanner ?? this.runtime.router.forStage(story.pipeline.scenePlanner), image: this.image, video: this.video }, onStageEvent: request.onStageEvent });
      } } : this.pipeline;
      return new BatchRunner(processor).run({ root: this.root, story, chapters: selected, state, shutdown, retry: retryConfigSchema.parse({}),
        onProgress: (event: ProgressEvent) => control.update(event) });
    }));
  }

  async productionPlan(slug: string, raw: unknown) { slugSchema.parse(slug); const input = productionInputSchema.parse(raw); const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const plan=(await planProduction({ root: this.root, story, ...input, dryRun: true }, { loadChapters: async () => (await loadImportedChapters(this.root, slug)).chapters })).plan;const analytics=this.usage?await this.usage.summary({story:slug}):{dimensions:[]};return{...plan,costEstimate:estimatePlanCost(plan,analytics as any)}; }
  async costAnalytics(slug: string, filters: Parameters<PostgresUsageRepository["summary"]>[0]) { slugSchema.parse(slug); if (!this.usage) throw new Error("Cost analytics requires DATABASE_URL"); return this.usage.summary({ ...filters, story: slug }); }
  async costRecords(slug: string, filters: Parameters<PostgresUsageRepository["list"]>[0]) { slugSchema.parse(slug); if (!this.usage) throw new Error("Cost analytics requires DATABASE_URL"); return this.usage.list({ ...filters, story: slug }); }
  async appCostAnalytics(filters: Parameters<PostgresUsageRepository["summary"]>[0]) { if (!this.usage) throw new Error("Cost analytics requires DATABASE_URL"); return this.usage.summary(filters); }

  listSummaries(slug: string, options?: Parameters<SummaryService["list"]>[1]) { slugSchema.parse(slug); return new SummaryService(this.root, this.llm).list(slug, options); }
  summaryMedia() { return new SummaryMediaService(this.root, this.llm, this.tts, this.censor, this.audio); }
  summaryJobsDirectory() { return join(this.root, ".data", "summary-jobs"); }
  summaryVisuals() { return new SummaryVisualService(this.root, this.summaryMedia(), this.summaryImages, this.video, this.alignConfig, this.aligner); }
  getSummary(slug: string, id: string) { slugSchema.parse(slug); return this.summaryVisuals().get(slug, id); }
  summarySpeech(slug: string, id: string) { slugSchema.parse(slug); return this.summaryMedia().speech(slug, id); }
  startSummaryMedia(slug: string, id: string, stage: "narration" | "audio" | "scenes" | "artwork" | "video" | "produce", raw: unknown) {
    slugSchema.parse(slug); const input = stage === "produce" ? summaryProduceInputSchema.parse(raw) : stage === "scenes" ? summaryScenesInputSchema.parse(raw) : ["artwork", "video"].includes(stage) ? summaryVisualInputSchema.parse(raw) : summaryMediaInputSchema.parse(raw);
    return this.jobs.createDurable(this.summaryJobsDirectory(), slug, async (control) => withStoryLock(this.root, slug, `summary ${stage}`, async () => {
      const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); const progress = (event: unknown) => control.update(event);
      const result: unknown = await withUsageScope<unknown>({ story: slug, stage: stage === "audio" ? "tts" : stage === "scenes" ? "scenePlanning" : stage === "artwork" ? "artwork" : stage === "video" ? "video" : "narration" }, () => stage === "narration" ? this.summaryMedia().narration(slug, id, input) : stage === "audio" ? this.summaryMedia().audio(slug, id, input, progress) : stage === "produce" ? this.summaryVisuals().produce(slug, id, input, progress, () => shutdown.isRequested) : stage === "artwork" ? this.summaryVisuals().artwork(slug, id, input, progress, () => shutdown.isRequested) : this.summaryVisuals()[stage](slug, id, input, progress));
      return shutdown.isRequested ? { status: "paused", summary: result } : result;
    }));
  }
  editSummaryScenes(slug: string, id: string, raw: unknown) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "summary scene edits", () => this.summaryVisuals().editScenes(slug, id, raw)); }
  updateSummaryScene(slug: string, id: string, scene: string, raw: unknown) { slugSchema.parse(slug); z.string().regex(/^scene-\d{3}$/).parse(scene); return withStoryLock(this.root, slug, "summary single scene edit", () => this.summaryVisuals().updateScene(slug, id, scene, raw)); }
  previewSummarySceneRegeneration(slug: string, id: string, scene: string, raw: unknown) { slugSchema.parse(slug); z.string().regex(/^scene-\d{3}$/).parse(scene); return withUsageScope({ story: slug, stage: "scenePlanning" }, () => this.summaryMedia().previewSceneRegeneration(slug, id, scene, raw)); }
  applySummarySceneRegeneration(slug: string, id: string, scene: string, raw: unknown) { slugSchema.parse(slug); z.string().regex(/^scene-\d{3}$/).parse(scene); return withStoryLock(this.root, slug, "summary scene regeneration apply", () => this.summaryVisuals().applySceneRegeneration(slug, id, scene, raw)); }
  summarySceneArtworkGrounding(slug: string, id: string) { slugSchema.parse(slug); return this.summaryVisuals().sceneArtworkGrounding(slug, id); }
  summarySceneContinuity(slug: string, id: string) { slugSchema.parse(slug); return this.summaryVisuals().sceneContinuityDetail(slug, id); }
  updateSummarySceneContinuity(slug: string, id: string, scene: string, raw: unknown) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "summary visual continuity override", () => this.summaryVisuals().updateSceneContinuity(slug, id, scene, raw)); }
  resetSummarySceneContinuity(slug: string, id: string, scene: string) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "summary visual continuity reset", () => this.summaryVisuals().resetSceneContinuity(slug, id, scene)); }
  async inspectSummaryArtworkVisualPreflight(slug: string, id: string, raw: unknown) {
    slugSchema.parse(slug);
    const input = summaryVisualInputSchema.parse(raw);
    const report = await this.summaryVisuals().artwork(slug, id, { ...input, dryRun: true });
    if (!("preflight" in report)) throw new Error("Summary artwork inspection did not produce a Visual Profile report");
    return { ...report.preflight, imageCountEstimate: report.imagesToGenerate, sceneIds: report.sceneIds };
  }
  reviewSummaryArtwork(slug: string, id: string, scene: string, review: unknown) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "summary artwork review", () => this.summaryVisuals().reviewArtwork(slug, id, scene, review)); }
  reviewSummaryArtworkVersion(slug: string, id: string, scene: string, version: string) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "summary artwork version review", () => this.summaryVisuals().reviewArtworkVersion(slug, id, scene, version)); }
  async estimateSummaryArtwork(slug: string, id: string, raw: unknown) {
    slugSchema.parse(slug);
    const input = summaryVisualInputSchema.parse(raw);
    const result = await this.summaryVisuals().artwork(slug, id, { ...input, dryRun: true });
    if (!("dryRun" in result)) throw new Error("Artwork estimate did not return a dry-run plan");
    const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig);
    const grounding = await this.summaryVisuals().sceneArtworkGrounding(slug, id);
    const selected = new Set(result.sceneIds);
    return { imagesToGenerate: result.imagesToGenerate, reusable: result.reusable, derivativesToBuild: result.derivativesToBuild, sceneIds: result.sceneIds,
      missing: grounding.filter((scene) => selected.has(scene.sceneId) && scene.status === "missing").length,
      stale: grounding.filter((scene) => selected.has(scene.sceneId) && scene.status === "stale").length,
      blockedByVisualProfiles: result.preflight.requiresDecision.length, provider: story.artwork.provider, model: story.artwork.model };
  }
  reupscaleSummaryArtwork(slug: string, id: string, raw: unknown) {
    slugSchema.parse(slug);
    return withStoryLock(this.root, slug, "summary artwork re-upscale", () => this.summaryVisuals().reupscale(slug, id, raw));
  }
  editSummaryNarration(slug: string, id: string, raw: unknown) {
    slugSchema.parse(slug); summaryNarrationEditSchema.parse(raw);
    return withStoryLock(this.root, slug, "summary narration edit", () => this.summaryMedia().editNarration(slug, id, raw));
  }
  startSummary(slug: string, raw: unknown) {
    slugSchema.parse(slug);
    return this.jobs.create("summary", slug, async (control) => withStoryLock(this.root, slug, "summary generation", async () => {
      const result = await withUsageScope({ story: slug, stage: "summary" }, () => new SummaryService(this.root, this.llm).generate(slug, raw, (event) => control.update(event)));
      await recordActivity(this.root, slug, "summary.generated", `Generated summary '${result.title}' for ${result.chapters.length} chapter(s)`); return result;
    }));
  }
  updateSummary(slug: string, id: string, raw: unknown) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "summary edit", async () => {
    const service = new SummaryService(this.root, this.llm);
    const before = await service.get(slug, id);
    let result = await service.update(slug, id, raw);
    if (fingerprint(summaryArtDirectionIdentity(before.artDirectionOverride)) !== fingerprint(summaryArtDirectionIdentity(result.artDirectionOverride))) {
      result = await this.summaryVisuals().reconcileSummaryVisualFreshness(slug, result, true);
    }
    await recordActivity(this.root, slug, "summary.edited", `Edited summary '${result.title}'`);
    return result;
  }); }
  regenerateSummary(slug: string, id: string, raw: unknown) {
    slugSchema.parse(slug);
    return this.jobs.create("summary", slug, async (control) => withStoryLock(this.root, slug, "summary regeneration", async () => {
      const result = await withUsageScope({ story: slug, stage: "summary" }, () => new SummaryService(this.root, this.llm).regenerate(slug, id, raw, (event) => control.update(event)));
      await recordActivity(this.root, slug, "summary.regenerated", `Regenerated summary '${result.title}'`); return result;
    }));
  }
  deleteSummary(slug: string, id: string) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "summary deletion", async () => { const result = await new SummaryService(this.root, this.llm).delete(slug, id); await recordActivity(this.root, slug, "summary.deleted", `Deleted summary ${id}`); return result; }); }

  async editChapterText(slug: string, chapter: number, raw: unknown) { slugSchema.parse(slug); const input = chapterTextEditSchema.parse(raw); return withStoryLock(this.root, slug, "manual chapter text edit", async () => { const result = await saveChapterTextEdit(this.root, slug, chapter, input); await recordActivity(this.root, slug, "chapter.edited", `Edited Chapter ${chapter} ${input.field}`); return result; }); }
  async dismissQaFindings(slug: string, chapter: number, raw: unknown) {
    slugSchema.parse(slug); if (!Number.isSafeInteger(chapter) || chapter < 1) throw new ConfigurationError("Chapter must be a positive integer");
    const input = qaDismissInputSchema.parse(raw);
    return withStoryLock(this.root, slug, "QA finding dismissal", async () => {
      const paths = storyPaths(this.root, slug, chapter);
      const [qaRaw, chapterRaw] = await Promise.all([readJsonIfExists(paths.qa), readJsonIfExists<Chapter>(paths.chapterMeta)]);
      if (!qaRaw || !chapterRaw) throw new Error(`Chapter ${chapter} does not have a QA result`);
      const metadata = chapterSchema.parse(chapterRaw);
      const uniqueIndexes = [...new Set(input.issueIndexes)];
      const qa = resolveQaFindingsByIndex(qaRaw, uniqueIndexes, input.disposition, undefined, chapter);
      const activeIssues = activeQaIssues(qa);
      await persistQaStateWithMetadata(paths, qa, metadata, (outputFingerprint, prior) => ({
        ...prior,
        quality: { status: qa.status, score: qa.score, issueCategories: [...new Set(activeIssues.map((issue) => issue.category))] },
        stages: { ...prior.stages, qa: { ...prior.stages.qa, outputFingerprint } },
        updatedAt: new Date().toISOString(),
      }));
      invalidateCatalogCache(this.root, slug);
      const action = input.disposition === "manually_fixed" ? "Marked manually fixed" : "Dismissed";
      await recordQaActivityBestEffort(this.root, slug, input.disposition === "manually_fixed" ? "chapter.qa_manually_fixed" : "chapter.qa_dismissed", `${action} ${uniqueIndexes.length} QA finding(s) for Chapter ${chapter}`);
      return { chapter, resolved: uniqueIndexes.length, disposition: input.disposition, qa };
    });
  }
  async startQaRepair(slug: string, chapter: number, raw: unknown) {
    slugSchema.parse(slug); const input = qaRepairInputSchema.parse(raw);
    const preflightPaths = storyPaths(this.root, slug, chapter);
    const [preflightQaRaw, preflightTranslation, preflightNarration] = await Promise.all([
      readJsonIfExists(preflightPaths.qa), readFile(preflightPaths.english, "utf8"), readFile(preflightPaths.narration, "utf8"),
    ]);
    const preflightQa = qaResultSchema.parse(preflightQaRaw); const preflightIndexes = [...new Set(input.issueIndexes)];
    if (preflightIndexes.some((index) => !preflightQa.issues[index])) throw new Error("One or more selected QA findings no longer exist. Reload the chapter and select them again.");
    const preflightState = migrateQaState(preflightQaRaw, { chapter });
    for (const index of preflightIndexes) {
      const issue = preflightQa.issues[index]!;
      const finding = preflightState.findings.find((candidate) => candidate.message === issue.message && candidate.evidence === issue.evidence);
      const inference = inferQaRepairTargets({ ...issue, provenance: finding?.provenance, origin: finding?.origin ?? "llm" }, { translation: preflightTranslation, narration: preflightNarration });
      if (inference.confidence === "ambiguous" && !input.targetOverrides?.[String(index)]) throw new QaRepairTargetAmbiguousError(["translation", "narration", "both"]);
    }
    return this.jobs.create("qaRepair", slug, async (control) => withStoryLock(this.root, slug, "selected QA repair", async () => {
      const story = await loadStory(storyPaths(this.root, slug, chapter).storyConfig); const paths = storyPaths(this.root, slug, chapter);
      const [qaRaw, source, translation, narration, context] = await Promise.all([readJsonIfExists(paths.qa), readFile(paths.original, "utf8"), readFile(paths.english, "utf8"), readFile(paths.narration, "utf8"), readJsonIfExists(paths.storyContext)]);
      const qa = qaResultSchema.parse(qaRaw); const uniqueIndexes = [...new Set(input.issueIndexes)];
      const issues = uniqueIndexes.map((index) => qa.issues[index]).filter((issue): issue is NonNullable<typeof issue> => Boolean(issue));
      if (issues.length !== uniqueIndexes.length) throw new Error("One or more selected QA findings no longer exist. Reload the chapter and select them again.");
      const state = migrateQaState(qaRaw, { chapter });
      const inferred = issues.map((issue, position) => {
        const index = uniqueIndexes[position]!;
        const finding = state.findings.find((candidate) => candidate.message === issue.message && candidate.evidence === issue.evidence);
        const result = inferQaRepairTargets({ ...issue, provenance: finding?.provenance, origin: finding?.origin ?? "llm" }, { translation, narration });
        const override = input.targetOverrides?.[String(index)];
        if (override) return { targets: override === "both" ? ["translation", "narration"] as QaRepairTarget[] : [override], confidence: "high" as const };
        if (result.confidence === "ambiguous") throw new QaRepairTargetAmbiguousError(["translation", "narration", "both"]);
        return result;
      });
      const targets = [...new Set(inferred.flatMap((item) => item.targets))].sort((a, b) => a === "translation" ? -1 : b === "translation" ? 1 : 0); const repaired: string[] = []; let currentTranslation = translation; let currentNarration = narration;
      for (const target of targets) {
        control.update({ type: "qa.repair.started", chapter, target, selectedIssues: issues.length });
        const config = story.pipeline[target]; const provider = this.llm.forStage(config);
        const targetIssues = issues.filter((_, index) => inferred[index]!.targets.includes(target));
        const result = await withUsageScope({ story: slug, chapter, stage: `qaRepair.${target}` }, async () => repairQaText(provider, config, { target, chapter, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, source, translation: currentTranslation, narration: currentNarration, issues: targetIssues, context, authorizedNarrationEntities: await loadNarrationNamingEntities(this.root, slug), profanityMode: story.narrationSettings.profanityMode, includeChapterTitle: story.narrationSettings.includeChapterTitle !== false }));
        await saveChapterTextEdit(this.root, slug, chapter, { field: target, text: result.text });
        if (target === "translation") currentTranslation = result.text; else currentNarration = result.text; repaired.push(target);
        control.update({ type: "qa.repair.completed", chapter, target, completed: repaired.length, total: targets.length });
      }
      invalidateCatalogCache(this.root, slug); await recordQaActivityBestEffort(this.root, slug, "chapter.qa_repaired", `AI repaired Chapter ${chapter} ${repaired.join(" and ")} for ${issues.length} selected QA finding(s)`);
      return { chapter, repaired, issueIndexes: uniqueIndexes, requiresQaRecheck: true };
    }));
  }
  startQaRecheck(slug: string, chapter: number, raw?: unknown) {
    slugSchema.parse(slug); if (!Number.isSafeInteger(chapter) || chapter < 1) throw new ConfigurationError("Chapter must be a positive integer");
    const input = qaRecheckInputSchema.parse(raw ?? {});
    return this.jobs.create("qaRecheck", slug, async (control) => withStoryLock(this.root, slug, "QA-only recheck", async () => {
      const paths = storyPaths(this.root, slug, chapter); const story = await loadStory(paths.storyConfig);
      control.update({ type: "qa.recheck.started", chapter, stage: "qa", mode: input.mode });
      const result = await withUsageScope({ story: slug, chapter, stage: "qa" }, () => recheckChapterQa({ root: this.root, story, chapter, provider: this.llm.forStage(story.pipeline.qa), mode: input.mode }));
      control.update({ type: "qa.recheck.completed", chapter, stage: "qa", status: result.state.status });
      invalidateCatalogCache(this.root, slug); await recordQaActivityBestEffort(this.root, slug, "chapter.qa_rechecked", `Rechecked Chapter ${chapter} using its retained translation and narration`);
      return { chapter, qa: result.state.status, qaOnly: true, summary: result.summary };
    }));
  }

  async getChapterQa(slug: string, chapter: number) {
    slugSchema.parse(slug); if (!Number.isSafeInteger(chapter) || chapter < 1) throw new ConfigurationError("Chapter must be a positive integer");
    const paths = storyPaths(this.root, slug, chapter);
    const [qaRaw, chapterRaw, story] = await Promise.all([readJsonIfExists(paths.qa), readJsonIfExists<Chapter>(paths.chapterMeta), loadStory(paths.storyConfig)]);
    if (!qaRaw) throw new Error(`Chapter ${chapter} does not have a QA result`);
    const state = migrateQaState(qaRaw, { chapter });
    const metadata = chapterRaw ? chapterSchema.parse(chapterRaw) : undefined;
    const [translation, narration] = await Promise.all([readFile(paths.english, "utf8").catch(() => ""), readFile(paths.narration, "utf8").catch(() => "")]);
    const counts = qaCounts(state);
    counts.safeFixesAvailable = openFindings(state).filter((finding) => finding.safeToFix === true && inferQaRepairTargets(finding, { translation, narration }).confidence === "high").length;
    // Authoritative freshness: compares the recorded dependency fingerprint
    // against the current effective one, not just the stage status.
    const qaFreshness = await deriveChapterQaFreshness(this.root, story, chapter, metadata?.stages.qa);
    return {
      chapter, state, counts, stats: qaFindingStats(state, qaFreshness.currentFingerprint),
      freshness: qaFreshness.freshness, qaStale: qaFreshness.freshness !== "current", currentFingerprint: qaFreshness.currentFingerprint,
    };
  }

  async resetChapterQa(slug: string, chapter: number) {
    slugSchema.parse(slug);
    if (!Number.isSafeInteger(chapter) || chapter < 1) throw new ConfigurationError("Chapter must be a positive integer");
    const result = await resetChapterQa(this.root, slug, chapter);
    if (result.reset) {
      invalidateCatalogCache(this.root, slug);
      await recordQaActivityBestEffort(this.root, slug, "chapter.qa_reset", `Reset QA evaluation data for Chapter ${chapter}`);
    }
    return result;
  }

  async resetQaBatch(slug: string, raw: unknown) {
    slugSchema.parse(slug);
    const scope = qaResetScopeSchema.parse(raw);
    const result = await resetChapterQaBatch(this.root, slug, scope);
    if (result.reset > 0) {
      invalidateCatalogCache(this.root, slug);
      await recordQaActivityBestEffort(this.root, slug, "qa.batch_reset", `Reset QA evaluation data for ${result.reset} chapter(s)`);
    }
    return result;
  }

  /** Persist a single-finding transition and only the QA artifacts it affects. Caller holds the story lock. */
  private async mutateQaFindingState(slug: string, chapter: number, id: string, action: QaFindingTransition, options: { reason?: string; finalTextFingerprint?: string } = {}) {
    const paths = storyPaths(this.root, slug, chapter);
    const [qaRaw, chapterRaw] = await Promise.all([readJsonIfExists(paths.qa), readJsonIfExists<Chapter>(paths.chapterMeta)]);
    if (!qaRaw || !chapterRaw) throw new Error(`Chapter ${chapter} does not have a QA result`);
    const metadata = chapterSchema.parse(chapterRaw);
    const state = transitionQaFinding(migrateQaState(qaRaw, { chapter }), id, action, options);
    // QA-state-only mutation: input fingerprints and downstream stages stay untouched.
    await persistQaStateWithMetadata(paths, state, metadata, (outputFingerprint, prior) => ({
      ...prior,
      quality: { status: state.status, score: state.score, issueCategories: [...new Set(openFindings(state).map((finding) => finding.category))] },
      stages: { ...prior.stages, qa: { ...prior.stages.qa, outputFingerprint } },
      updatedAt: new Date().toISOString(),
    }));
    invalidateCatalogCache(this.root, slug);
    return { state, finding: state.findings.find((finding) => finding.id === id)! };
  }

  async resolveQaFindingManually(slug: string, chapter: number, id: string, raw: unknown) {
    slugSchema.parse(slug); if (!Number.isSafeInteger(chapter) || chapter < 1) throw new ConfigurationError("Chapter must be a positive integer");
    qaFindingIdSchema.parse(id); const input = qaResolveManualInputSchema.parse(raw);
    return withStoryLock(this.root, slug, "QA finding manual resolution", async () => {
      const finalTextFingerprint = input.finalText?.trim() ? fingerprint(input.finalText) : undefined;
      const { finding, state } = await this.mutateQaFindingState(slug, chapter, id, "manual_fix", { finalTextFingerprint });
      await recordQaActivityBestEffort(this.root, slug, "chapter.qa_manually_fixed", `Marked QA finding ${id} for Chapter ${chapter} manually fixed`);
      return { chapter, finding, qa: state, presentation: await this.getChapterQa(slug, chapter) };
    });
  }

  async dismissQaFinding(slug: string, chapter: number, id: string, raw: unknown) {
    slugSchema.parse(slug); if (!Number.isSafeInteger(chapter) || chapter < 1) throw new ConfigurationError("Chapter must be a positive integer");
    qaFindingIdSchema.parse(id); const input = qaFindingDismissInputSchema.parse(raw);
    return withStoryLock(this.root, slug, "QA finding dismissal", async () => {
      const paths = storyPaths(this.root, slug, chapter);
      const [qaRaw, chapterRaw] = await Promise.all([readJsonIfExists(paths.qa), readJsonIfExists<Chapter>(paths.chapterMeta)]);
      if (!qaRaw || !chapterRaw) throw new Error(`Chapter ${chapter} does not have a QA result`);
      const metadata = chapterSchema.parse(chapterRaw);
      const state = transitionQaFinding(migrateQaState(qaRaw, { chapter }), id, "dismiss", { reason: input.reason });
      const finding = state.findings.find((candidate) => candidate.id === id)!;
      let exception: Awaited<ReturnType<typeof prepareQaException>>["exception"] | undefined;
      let oldExceptionFile: Buffer | undefined;
      if (input.remember) {
        const exceptionPath = storyPaths(this.root, slug, 1).qaExceptions;
        oldExceptionFile = await readFile(exceptionPath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
        const existing = await listQaExceptions(this.root, slug);
        const prepared = prepareQaException(existing, { category: finding.category, matchKind: input.remember.matchKind, value: input.remember.value, reason: input.reason });
        exception = prepared.exception;
        if (prepared.created) await atomicWriteJson(exceptionPath, { version: 1, exceptions: prepared.exceptions });
      }
      try {
        await persistQaStateWithMetadata(paths, state, metadata, (outputFingerprint, prior) => ({
          ...prior,
          quality: { status: state.status, score: state.score, issueCategories: [...new Set(openFindings(state).map((item) => item.category))] },
          stages: { ...prior.stages, qa: { ...prior.stages.qa, outputFingerprint } }, updatedAt: new Date().toISOString(),
        }));
      } catch (error) {
        if (input.remember && exception) {
          const exceptionPath = storyPaths(this.root, slug, 1).qaExceptions;
          try { if (oldExceptionFile) await atomicWrite(exceptionPath, oldExceptionFile); else await rm(exceptionPath, { force: true }); }
          catch (rollbackError) { throw new AggregateError([error, rollbackError], "QA dismissal failed and the remembered exception could not be rolled back"); }
        }
        throw error;
      }
      if (input.remember) invalidateCatalogCache(this.root, slug);
      await recordQaActivityBestEffort(this.root, slug, "chapter.qa_dismissed", `Dismissed QA finding ${id} for Chapter ${chapter}${exception ? " and remembered the decision" : ""}`);
      return { chapter, finding, qa: state, exception, presentation: await this.getChapterQa(slug, chapter) };
    });
  }

  async reopenQaFinding(slug: string, chapter: number, id: string) {
    slugSchema.parse(slug); if (!Number.isSafeInteger(chapter) || chapter < 1) throw new ConfigurationError("Chapter must be a positive integer");
    qaFindingIdSchema.parse(id);
    return withStoryLock(this.root, slug, "QA finding reopen", async () => {
      const { finding, state } = await this.mutateQaFindingState(slug, chapter, id, "reopen");
      await recordQaActivityBestEffort(this.root, slug, "chapter.qa_reopened", `Reopened QA finding ${id} for Chapter ${chapter}`);
      return { chapter, finding, qa: state, presentation: await this.getChapterQa(slug, chapter) };
    });
  }

  /** Repair one finding's target text(s). Caller holds the story lock. Returns the repaired targets. */
  private async repairFindingTargets(slug: string, story: Story, chapter: number, finding: QaFinding, texts: { source: string; translation: string; narration: string; context: unknown }, control?: { update: (event: unknown) => void }, targetOverride?: "translation" | "narration" | "both") {
    const issue = { category: finding.category, severity: finding.severity, message: finding.message, evidence: finding.evidence };
    const repaired: string[] = [];
    let currentTranslation = texts.translation; let currentNarration = texts.narration;
    const inference = inferQaRepairTargets(finding, { translation: texts.translation, narration: texts.narration });
    if (inference.confidence === "ambiguous" && !targetOverride) throw new QaRepairTargetAmbiguousError(["translation", "narration", "both"]);
    const targets = targetOverride === "both" ? ["translation", "narration"] as QaRepairTarget[] : targetOverride ? [targetOverride] : inference.targets;
    for (const target of targets) {
      control?.update({ type: "qa.repair.started", chapter, target, findingId: finding.id });
      const config = story.pipeline[target]; const provider = this.llm.forStage(config);
      const result = await withUsageScope({ story: slug, chapter, stage: `qaRepair.${target}` }, async () => repairQaText(provider, config, {
        target, chapter, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, source: texts.source,
        translation: currentTranslation, narration: currentNarration, issues: [issue], context: texts.context, authorizedNarrationEntities: await loadNarrationNamingEntities(this.root, slug),
        profanityMode: story.narrationSettings.profanityMode, includeChapterTitle: story.narrationSettings.includeChapterTitle !== false,
      }));
      await saveChapterTextEdit(this.root, slug, chapter, { field: target, text: result.text });
      if (target === "translation") currentTranslation = result.text; else currentNarration = result.text;
      repaired.push(target);
      control?.update({ type: "qa.repair.completed", chapter, target, findingId: finding.id });
    }
    return { repaired, translation: currentTranslation, narration: currentNarration };
  }

  async startQaFindingFix(slug: string, chapter: number, id: string, raw?: unknown) {
    slugSchema.parse(slug); if (!Number.isSafeInteger(chapter) || chapter < 1) throw new ConfigurationError("Chapter must be a positive integer");
    qaFindingIdSchema.parse(id);
    const input = qaFindingFixInputSchema.parse(raw ?? {});
    const preflightPaths = storyPaths(this.root, slug, chapter);
    const [preflightQa, preflightTranslation, preflightNarration] = await Promise.all([
      readJsonIfExists(preflightPaths.qa), readFile(preflightPaths.english, "utf8"), readFile(preflightPaths.narration, "utf8"),
    ]);
    if (!preflightQa) throw new Error(`Chapter ${chapter} does not have a QA result`);
    const preflightState = migrateQaState(preflightQa, { chapter });
    const preflightFinding = preflightState.findings.find((candidate) => candidate.id === id);
    if (!preflightFinding) throw new Error("QA finding was not found. Reload the chapter and try again.");
    if (preflightFinding.status !== "open") throw new Error("QA finding is not open. Reload the chapter and select an open finding.");
    const preflightInference = inferQaRepairTargets(preflightFinding, { translation: preflightTranslation, narration: preflightNarration });
    if (preflightInference.confidence === "ambiguous" && !input.target) throw new QaRepairTargetAmbiguousError(["translation", "narration", "both"]);
    return this.jobs.create("qaRepair", slug, async (control) => withStoryLock(this.root, slug, "QA finding AI fix", async () => {
      const paths = storyPaths(this.root, slug, chapter); const story = await loadStory(paths.storyConfig);
      const [qaRaw, source, translation, narration, context] = await Promise.all([
        readJsonIfExists(paths.qa), readFile(paths.original, "utf8"), readFile(paths.english, "utf8"), readFile(paths.narration, "utf8"), readJsonIfExists(paths.storyContext),
      ]);
      if (!qaRaw) throw new Error(`Chapter ${chapter} does not have a QA result`);
      const state = migrateQaState(qaRaw, { chapter });
      const finding = state.findings.find((candidate) => candidate.id === id);
      if (!finding) throw new Error("QA finding was not found. Reload the chapter and try again.");
      if (finding.status !== "open") throw new Error("QA finding is not open. Reload the chapter and select an open finding.");
      const { repaired, translation: repairedTranslation, narration: repairedNarration } = await this.repairFindingTargets(slug, story, chapter, finding, { source, translation, narration, context }, control, input.target);
      // Mark fixed before the verification recheck: reconciliation reopens the
      // finding (history preserved) only if the problem genuinely persists.
      await this.mutateQaFindingState(slug, chapter, id, "ai_fix", { finalTextFingerprint: fingerprint({ translation: repairedTranslation, narration: repairedNarration }) });
      const recheck = await withUsageScope({ story: slug, chapter, stage: "qa" }, () => recheckChapterQa({ root: this.root, story, chapter, provider: this.llm.forStage(story.pipeline.qa), mode: "full" }));
      const finalFinding = recheck.state.findings.find((candidate) => candidate.id === id);
      invalidateCatalogCache(this.root, slug); await recordQaActivityBestEffort(this.root, slug, "chapter.qa_repaired", `AI repaired Chapter ${chapter} ${repaired.join(" and ")} for QA finding ${id}`);
      return { chapter, findingId: id, repaired, fixed: finalFinding?.status === "fixed_ai", finding: finalFinding, summary: recheck.summary, presentation: await this.getChapterQa(slug, chapter) };
    }));
  }

  /** Core of the safe-fixes flow, shared by the web job and the CLI. Caller holds the story lock. */
  async applyQaSafeFixes(slug: string, chapter: number, control?: { update: (event: unknown) => void }) {
    slugSchema.parse(slug); if (!Number.isSafeInteger(chapter) || chapter < 1) throw new ConfigurationError("Chapter must be a positive integer");
    const paths = storyPaths(this.root, slug, chapter); const story = await loadStory(paths.storyConfig);
    const [qaRaw, source, translation, narration, context] = await Promise.all([
      readJsonIfExists(paths.qa), readFile(paths.original, "utf8"), readFile(paths.english, "utf8"), readFile(paths.narration, "utf8"), readJsonIfExists(paths.storyContext),
    ]);
    if (!qaRaw) throw new Error(`Chapter ${chapter} does not have a QA result`);
    const state = migrateQaState(qaRaw, { chapter });
    // The backend alone decides what is safe: open + explicitly marked safeToFix.
    const safe = state.findings.filter((finding) => finding.status === "open" && finding.safeToFix === true
      && inferQaRepairTargets(finding, { translation, narration }).confidence === "high");
    const fixed: string[] = []; const failed: { id: string; message: string }[] = [];
    let summary;
    if (safe.length) {
      const namingEntities = await loadNarrationNamingEntities(this.root, slug);
      let currentTranslation = translation; let currentNarration = narration;
      for (const finding of safe) {
        try {
          control?.update({ type: "qa.safefix.started", chapter, findingId: finding.id });
          const namingEntity = finding.origin === "deterministic" && finding.category === "names"
            ? namingEntities.find((entity) => finding.provenance?.entityIds?.includes(entity.id) && entity.preferredNarrationName)
            : undefined;
          if (namingEntity) {
            const rewritten = applyNarrationNamingPreferences(currentNarration, { canonicalEntities: [namingEntity] });
            if (rewritten === currentNarration) throw new Error("Mechanical name substitution produced no change");
            await saveChapterTextEdit(this.root, slug, chapter, { field: "narration", text: rewritten });
            currentNarration = rewritten;
          } else {
            const repaired = await this.repairFindingTargets(slug, story, chapter, finding, { source, translation: currentTranslation, narration: currentNarration, context }, control);
            currentTranslation = repaired.translation; currentNarration = repaired.narration;
          }
          await this.mutateQaFindingState(slug, chapter, finding.id, "ai_fix", {});
          fixed.push(finding.id);
        } catch (error) {
          failed.push({ id: finding.id, message: error instanceof Error ? error.message : String(error) });
        }
      }
      if (fixed.length) {
        try {
          const recheck = await withUsageScope({ story: slug, chapter, stage: "qa" }, () => recheckChapterQa({ root: this.root, story, chapter, provider: this.llm.forStage(story.pipeline.qa), mode: "full" }));
          summary = recheck.summary;
        } catch (error) {
          invalidateCatalogCache(this.root, slug);
          await recordQaActivityBestEffort(this.root, slug, "chapter.qa_repaired", `Saved ${fixed.length} safe QA fix(es) for Chapter ${chapter}; final QA verification failed`);
          return { chapter, status: "repairs_applied_recheck_failed" as const, code: "QA_SAFE_FIX_RECHECK_FAILED" as const, fixed, failed, summary: undefined,
            recheck: { attempted: true as const, success: false as const, error: error instanceof Error ? error.message : String(error) }, requiresQaRecheck: true as const };
        }
      }
    }
    invalidateCatalogCache(this.root, slug); await recordQaActivityBestEffort(this.root, slug, "chapter.qa_repaired", `Applied ${fixed.length} safe QA fix(es) for Chapter ${chapter}${failed.length ? `; ${failed.length} failed` : ""}`);
    return { chapter, status: "completed" as const, fixed, failed, summary, recheck: { attempted: fixed.length > 0, success: fixed.length > 0 }, requiresQaRecheck: false };
  }

  startQaSafeFixes(slug: string, chapter: number) {
    slugSchema.parse(slug); if (!Number.isSafeInteger(chapter) || chapter < 1) throw new ConfigurationError("Chapter must be a positive integer");
    return this.jobs.create("qaRepair", slug, async (control) => withStoryLock(this.root, slug, "QA safe fixes", () => this.applyQaSafeFixes(slug, chapter, control)));
  }

  async listQaExceptions(slug: string) { slugSchema.parse(slug); return { exceptions: await listQaExceptions(this.root, slug) }; }
  async addQaException(slug: string, raw: unknown) {
    slugSchema.parse(slug); const input = qaExceptionInputSchema.parse(raw);
    return withStoryLock(this.root, slug, "QA exception add", async () => {
      const result = await addQaException(this.root, slug, input);
      invalidateCatalogCache(this.root, slug); await recordQaActivityBestEffort(this.root, slug, "chapter.qa_dismissed", `${result.created ? "Added" : "Kept"} QA exception "${input.value}"`);
      return result;
    });
  }
  async removeQaException(slug: string, id: string) {
    slugSchema.parse(slug); qaExceptionIdSchema.parse(id);
    return withStoryLock(this.root, slug, "QA exception remove", async () => {
      const result = await removeQaException(this.root, slug, id);
      if (!result.removed) throw new Error("QA exception was not found");
      invalidateCatalogCache(this.root, slug); await recordQaActivityBestEffort(this.root, slug, "chapter.qa_dismissed", `Removed QA exception ${id}`);
      return result;
    });
  }
  async addBibleEntry(slug: string, raw: unknown) { slugSchema.parse(slug); const input = z.object({ category: bibleCategorySchema, value: z.record(z.string(), z.unknown()), replacementKey: z.string().optional() }).strict().parse(raw); return withStoryLock(this.root, slug, "manual Story Bible add", async () => { const base = await getStoryBible(this.root, slug); const id = await addManualBibleEntry(this.root, slug, base, input.category, input.value, input.replacementKey); await recordActivity(this.root, slug, "bible.edited", `Added or corrected ${input.category} entry`); return { id }; }); }
  async updateBibleEntry(slug: string, id: string, raw: unknown) { slugSchema.parse(slug); const input = z.object({ value: z.record(z.string(), z.unknown()) }).strict().parse(raw); return withStoryLock(this.root, slug, "manual Story Bible edit", async () => { const base = await getStoryBible(this.root, slug); await updateManualBibleEntry(this.root, slug, base, id, input.value); await recordActivity(this.root, slug, "bible.edited", "Updated a Story Bible entry"); return { status: "updated" }; }); }
  async deleteBibleEntry(slug: string, id: string) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "manual Story Bible delete", async () => { const base = await getStoryBible(this.root, slug); await deleteBibleEntry(this.root, slug, base, id); await recordActivity(this.root, slug, "bible.edited", "Deleted a manual Story Bible entry"); return { status: "deleted" }; }); }
  async updateCanonicalEntity(slug: string, id: string, raw: unknown) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "canonical entity edit", () => this.applyCanonicalEntityPatch(slug, id, raw)); }

  /** Core of a canonical entity edit: overlay update plus invalidations. Caller holds the story lock. */
  private async applyCanonicalEntityPatch(slug: string, id: string, raw: unknown) {
    const current = await getStoryBible(this.root, slug); const before = current.canonicalEntities.find((item) => item.id === id); if (!before) throw new Error("Canonical entity was not found");
    await backfillCanonicalSnapshots(this.root, slug, current);
    const base = await getStoryBible(this.root, slug, { includeCanonicalOverlay: false }); const overlayPath = storyPaths(this.root, slug, 1).bibleCanonicalManual;
    const priorOverlay = await readFile(overlayPath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    const result = await updateCanonicalEntity(this.root, slug, base, id, raw); let entity; let invalidation; let visualProfileReviewRequired = false;
    try { entity = result.bible.canonicalEntities.find((item) => item.id === id); if (!entity) throw new Error("Canonical entity was not found after update"); visualProfileReviewRequired = before.type !== entity.type && Boolean((await loadVisualProfiles(this.root, slug))[id]); invalidation = await invalidateNarrationNamingChange(this.root, slug, before, entity); const soundAffected = await invalidatePronunciationChange(this.root, slug, before, entity); invalidation.affectedChapters = [...new Set([...invalidation.affectedChapters, ...soundAffected])]; if ((raw as { pronunciation?: unknown }).pronunciation === null) await clearPronunciationAttempt(this.root, slug, id); if (before.type !== entity.type) await invalidateCanonicalIdentityChange(this.root, slug, [before, entity], `Canonical entity type changed for ${entity.canonicalName}`, Boolean(entity.preferredNarrationName || entity.localizedNaming || entity.aliasNarrationRules.length)); if (visualProfileReviewRequired) await updateVisualProfile(this.root, slug, id, { status: "draft" }); }
    catch (error) {
      try { if (priorOverlay) await atomicWrite(overlayPath, priorOverlay); else await rm(overlayPath, { force: true }); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Canonical entity update failed and its overlay could not be restored"); }
      throw error;
    }
    if (invalidation.exportCleanupWarnings.length) logger.warn({ event: "bible.entity.export_cleanup_incomplete", story: slug, entityId: id, manifests: invalidation.exportCleanupWarnings });
    await appendEntityAudit(this.root, slug, entityPatchAuditEntries(before, entity));
    invalidateCatalogCache(this.root, slug); await recordActivity(this.root, slug, "bible.entity.edited", invalidation.affectedChapters.length ? `Updated canonical entity ${id}; marked ${invalidation.affectedChapters.length} chapter(s) affected by narration naming` : `Updated canonical entity ${id}`); return { entity, invalidation, visualProfileReviewRequired };
  }

  /**
   * Dry-run impact preview for entity actions. Read-only and provider-free: it
   * reuses the same scan/detection helpers the real invalidations consume, so
   * the estimate matches apply semantics wherever the architecture can know it.
   */
  async inspectCanonicalEntityImpact(slug: string, id: string, raw: unknown) {
    slugSchema.parse(slug);
    const input = z.object({
      action: z.enum(["update", "merge", "suppress", "demote", "promote"]),
      patch: z.unknown().optional(),
      targetEntityId: z.string().regex(/^ent_[a-f0-9]{24}$/).optional(),
    }).strict().parse(raw ?? {});
    const bible = await getStoryBible(this.root, slug);
    const entity = bible.canonicalEntities.find((item) => item.id === id);
    if (!entity) throw new Error("Canonical entity was not found");
    const summaries = await loadChapterSummaries(this.root, slug);
    const byChapter = new Map(summaries.map((item) => [item.chapter, item]));
    const profiles = await loadVisualProfiles(this.root, slug);
    const openFindings = (await getContinuityReview(this.root, slug)).findings.filter((finding) => finding.status === "open");
    const continuityFor = (ids: string[]) => openFindings.filter((finding) => finding.entityIds.some((entityId) => ids.includes(entityId))).length;
    const complete = (chapter: number, key: "tts" | "scenePlanning" | "artwork" | "video") => byChapter.get(chapter)?.[key] === "complete";
    const qaComplete = (chapter: number) => byChapter.get(chapter)?.qaStage === "complete";
    const audioComplete = (chapter: number) => byChapter.get(chapter)?.audioMastering === "complete";
    const manualNarrationAmong = async (chapters: number[]) => (await mapLimit(chapters, 16, async (chapter) => {
      const rawMeta = await readJsonIfExists<Chapter>(storyPaths(this.root, slug, chapter).chapterMeta);
      const parsed = rawMeta ? chapterSchema.safeParse(rawMeta) : undefined;
      return parsed?.success && parsed.data.stages.narration.provider === "manual" && parsed.data.stages.narration.status === "complete" ? chapter : undefined;
    })).filter((chapter): chapter is number => chapter !== undefined).sort((a, b) => a - b);
    const identityCounts = (chapters: number[], into: { qa: Set<number>; scene: Set<number>; artwork: Set<number>; video: Set<number> }, includeQa = true) => {
      for (const chapter of chapters) {
        if (includeQa && qaComplete(chapter)) into.qa.add(chapter);
        if (complete(chapter, "scenePlanning")) into.scene.add(chapter);
        if (complete(chapter, "artwork")) into.artwork.add(chapter);
        if (complete(chapter, "video")) into.video.add(chapter);
      }
    };
    const touched = new Set<number>();
    const sets = { qa: new Set<number>(), tts: new Set<number>(), audio: new Set<number>(), scene: new Set<number>(), artwork: new Set<number>(), video: new Set<number>() };
    let narrationAffected = 0;
    let manualNarrationChapters: number[] = [];
    let visualProfileAffected = false;
    let continuityIds = [id];
    const warnings: string[] = [];

    if (input.action === "update") {
      const after = previewCanonicalEntityUpdate(entity, input.patch ?? {});
      if (narrationNamingChanged(entity, after)) {
        const naming = await inspectNarrationNamingImpact(this.root, slug, entity, after);
        for (const chapter of naming.affectedChapters) touched.add(chapter);
        manualNarrationChapters = await manualNarrationAmong(naming.affectedChapters);
        const manual = new Set(manualNarrationChapters);
        narrationAffected = naming.affectedChapters.filter((chapter) => {
          const summary = byChapter.get(chapter);
          return (summary?.narration === "complete" || summary?.narration === "stale") && !manual.has(chapter);
        }).length;
        for (const chapter of naming.affectedChapters) {
          const summary = byChapter.get(chapter);
          if (summary && (summary.qa || summary.qaStale)) sets.qa.add(chapter);
          if (complete(chapter, "tts")) sets.tts.add(chapter);
          if (audioComplete(chapter)) sets.audio.add(chapter);
        }
        identityCounts(naming.affectedChapters, sets, false);
        if (manualNarrationChapters.length) warnings.push(`${manualNarrationChapters.length} manual narration chapter${manualNarrationChapters.length === 1 ? "" : "s"} will be preserved for review`);
      }
      if (JSON.stringify(entity.pronunciation ?? null) !== JSON.stringify(after.pronunciation ?? null)) {
        const sound = await inspectPronunciationImpact(this.root, slug, entity, after);
        for (const chapter of sound) {
          touched.add(chapter);
          if (complete(chapter, "tts")) sets.tts.add(chapter);
          if (audioComplete(chapter)) sets.audio.add(chapter);
          if (complete(chapter, "video")) sets.video.add(chapter);
        }
      }
      if (entity.type !== after.type) {
        const chapters = await inspectEntityReferenceChapters(this.root, slug, [entity, after]);
        for (const chapter of chapters) touched.add(chapter);
        identityCounts(chapters, sets, Boolean(after.preferredNarrationName || after.localizedNaming || after.aliasNarrationRules.length));
        visualProfileAffected = Boolean(profiles[id]);
        if (visualProfileAffected) warnings.push("The existing Visual Profile will be moved to draft and must be reviewed before regenerating visual canon");
      } else if (entity.canonicalName !== after.canonicalName) {
        const chapters = await inspectEntityReferenceChapters(this.root, slug, [entity, after]);
        for (const chapter of chapters) touched.add(chapter);
        warnings.push("Renaming steers future extraction and narration; existing chapter artifacts are not automatically marked stale");
      }
    } else if (input.action === "merge") {
      const target = bible.canonicalEntities.find((item) => item.id === input.targetEntityId);
      if (!target) throw new Error("Target canonical entity was not found");
      continuityIds = [...new Set([id, target.id])];
      const chapters = await inspectEntityReferenceChapters(this.root, slug, [entity, target]);
      for (const chapter of chapters) touched.add(chapter);
      identityCounts(chapters, sets);
      visualProfileAffected = Boolean(profiles[id] || profiles[target.id]);
      if (namingMappingConflict(target, entity)) warnings.push("Naming conflict: resolve the preferred/localized naming of one entity before merging; the server will reject an unresolved conflict");
      if (entity.canonicalNameLocked || target.canonicalNameLocked) warnings.push("One of the entities has a locked canonical name");
    } else if (input.action === "suppress") {
      const chapters = await inspectEntityReferenceChapters(this.root, slug, [entity]);
      for (const chapter of chapters) touched.add(chapter);
      identityCounts(chapters, sets);
      visualProfileAffected = Boolean(profiles[id]);
      if (bible.merges.some((merge) => !merge.undoneAt && merge.targetEntityId === id)) warnings.push("This entity is the target of an active merge; undo the merge before suppressing it");
    } else {
      // demote / promote change granularity only: chapter artifacts are kept as-is.
      const chapters = await inspectEntityReferenceChapters(this.root, slug, [entity]);
      for (const chapter of chapters) touched.add(chapter);
      visualProfileAffected = input.action === "demote" && Boolean(profiles[id]);
      warnings.push(input.action === "demote" ? "The entity becomes a minor reference; chapter artifacts are kept and are not marked stale" : "Promotion changes granularity only; no chapter artifacts are regenerated");
      if (input.action === "demote" && entity.canonicalNameLocked) warnings.push("Locked entities cannot be demoted without force");
    }

    return {
      affectedChapters: [...touched].sort((a, b) => a - b),
      narrationAffected,
      qaAffected: sets.qa.size,
      ttsAffected: sets.tts.size,
      audioAffected: sets.audio.size,
      scenePlanningAffected: sets.scene.size,
      artworkAffected: sets.artwork.size,
      videoAffected: sets.video.size,
      manualNarrationChapters,
      visualProfileAffected,
      continuityAffected: continuityFor(continuityIds),
      warnings,
    };
  }

  /**
   * Bounded bulk edits that need no per-entity review. Eligibility and the
   * estimated impact are computed with the same patch semantics as the single
   * edit; `dryRun: true` returns that preview without writing anything.
   */
  async bulkUpdateCanonicalEntities(slug: string, raw: unknown) {
    slugSchema.parse(slug);
    const input = z.object({
      action: z.enum(["lock", "unlock", "set-type", "set-visual-policy"]),
      entityIds: z.array(z.string().regex(/^ent_[a-f0-9]{24}$/)).min(1).max(200),
      value: z.string().optional(),
      dryRun: z.boolean().default(false),
    }).strict().parse(raw);
    let patch: { canonicalNameLocked?: boolean; type?: z.infer<typeof entityTypeSchema>; visualProfilePolicy?: { mode: "prompt" | "skip" } };
    if (input.action === "lock") patch = { canonicalNameLocked: true };
    else if (input.action === "unlock") patch = { canonicalNameLocked: false };
    else if (input.action === "set-type") patch = { type: entityTypeSchema.parse(input.value) };
    else patch = { visualProfilePolicy: { mode: z.enum(["prompt", "skip"]).parse(input.value) } };
    const bible = await getStoryBible(this.root, slug);
    const eligible: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of [...new Set(input.entityIds)]) {
      const entity = bible.canonicalEntities.find((item) => item.id === id);
      if (!entity) { skipped.push({ id, reason: "Canonical entity was not found" }); continue; }
      if (input.action === "lock" && entity.canonicalNameLocked) { skipped.push({ id, reason: "Canonical name is already locked" }); continue; }
      if (input.action === "unlock" && !entity.canonicalNameLocked) { skipped.push({ id, reason: "Canonical name is already unlocked" }); continue; }
      if (input.action === "set-type" && entity.type === input.value) { skipped.push({ id, reason: `Entity is already a ${input.value}` }); continue; }
      if (input.action === "set-visual-policy" && entity.visualProfilePolicy?.mode === input.value) { skipped.push({ id, reason: `Visual Profile policy is already ${input.value}` }); continue; }
      try { previewCanonicalEntityUpdate(entity, patch); eligible.push(id); }
      catch (error) { skipped.push({ id, reason: error instanceof Error ? error.message : String(error) }); }
    }
    if (input.dryRun) {
      // Only a type change touches production freshness; lock/unlock/policy are inert overlays.
      const affectedChapters = input.action === "set-type" && eligible.length
        ? (await inspectEntityReferenceChapters(this.root, slug, bible.canonicalEntities.filter((entity) => eligible.includes(entity.id)))).length
        : 0;
      return { dryRun: true as const, applied: [] as string[], eligible, skipped, invalidationSummary: { affectedChapters, manualNarrationChapters: 0, visualProfileReviews: 0 } };
    }
    return withStoryLock(this.root, slug, "canonical entity bulk edit", async () => {
      const applied: string[] = [];
      const affected = new Set<number>();
      let manualNarrationChapters = 0;
      let visualProfileReviews = 0;
      for (const id of eligible) {
        try {
          const result = await this.applyCanonicalEntityPatch(slug, id, patch);
          applied.push(id);
          for (const chapter of result.invalidation.affectedChapters) affected.add(chapter);
          manualNarrationChapters += result.invalidation.manualNarrationChapters.length;
          if (result.visualProfileReviewRequired) visualProfileReviews++;
        } catch (error) {
          skipped.push({ id, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      if (applied.length) await recordActivity(this.root, slug, "bible.entity.bulk_edited", `Bulk ${input.action} applied to ${applied.length} canonical entit${applied.length === 1 ? "y" : "ies"}`);
      return { dryRun: false as const, applied, eligible, skipped, invalidationSummary: { affectedChapters: affected.size, manualNarrationChapters, visualProfileReviews } };
    });
  }
  async listPronunciationDesk(slug: string) {
    slugSchema.parse(slug);
    const [bible, suggestions] = await Promise.all([getStoryBible(this.root, slug), loadPronunciationSuggestions(this.root, slug)]);
    return { entities: bible.canonicalEntities, suggestions };
  }
  /** Accepting a suggestion is the explicit user action that activates pronunciation. */
  async acceptPronunciationSuggestion(slug: string, id: string) {
    slugSchema.parse(slug); z.string().regex(/^ent_[a-f0-9]{24}$/).parse(id);
    const suggestions = await loadPronunciationSuggestions(this.root, slug);
    const suggestion = suggestions[id];
    if (!suggestion) throw new Error("No pronunciation suggestion exists for this entity");
    return this.updateCanonicalEntity(slug, id, { pronunciation: { ...suggestion, source: "manual", locked: false, needsReview: false, updatedAt: new Date().toISOString() } });
  }
  async dismissPronunciationSuggestion(slug: string, id: string) {
    slugSchema.parse(slug); z.string().regex(/^ent_[a-f0-9]{24}$/).parse(id);
    return withStoryLock(this.root, slug, "pronunciation suggestion dismiss", async () => {
      await dismissPronunciationSuggestion(this.root, slug, id);
      invalidateCatalogCache(this.root, slug);
      return { status: "dismissed" };
    });
  }
  startPronunciationEnrichment(slug: string, raw: unknown) {
    slugSchema.parse(slug);
    const input = z.object({ entityId: z.string().regex(/^ent_[a-f0-9]{24}$/).optional(), force: z.boolean().default(false), dryRun: z.boolean().default(false) }).strict().parse(raw);
    return this.jobs.create("pronunciation", slug, async () => withStoryLock(this.root, slug, "pronunciation enrichment", async () => {
      const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig);
      const base = await getStoryBible(this.root, slug);
      if (input.entityId && !base.canonicalEntities.some(entity => entity.id === input.entityId)) throw new Error("Canonical entity was not found");
      const result = await withUsageScope({ story: slug, stage: "pronunciation" }, () => enrichStoryPronunciations(this.root, slug, base, this.llm.forStage(story.pipeline.storyBible), story.pipeline.storyBible, story.sourceLanguage, input.entityId ? [input.entityId] : undefined, input.force || Boolean(input.entityId), input.dryRun));
      invalidateCatalogCache(this.root, slug);
      return result;
    }));
  }
  startPronunciationTest(slug: string, id: string) {
    slugSchema.parse(slug); z.string().regex(/^ent_[a-f0-9]{24}$/).parse(id);
    return this.jobs.create("pronunciation", slug, async () => {
      const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig);
      const entities = await loadPronunciationEntities(this.root, slug);
      const entity = entities.find(item => item.id === id); if (!entity) throw new Error("Canonical entity was not found");
      const name = entity.localizedNaming?.fullName ?? entity.preferredNarrationName ?? entity.canonicalName;
      const text = entity.type === "location" ? `They finally arrived in ${name}.` : `${name} followed them through the gate.`;
      const config = story.pipeline.tts; const provider = pronunciationProvider(this.tts.forName(config.provider), entities); const speech = normalizeSpeechForProvider(text, story.outputLanguage, story.narrationSettings, provider, config.model);
      const key = fingerprint({ text, speech: speech.fingerprint, config, reference: provider.resolveReferenceId?.(config.referenceId), pronunciation: pronunciationFingerprint(resolvePronunciations(speech.normalized.text, entities)), normalization: provider.inputNormalizationVersion, censor: { version: this.censor.version, config: censorToneConfig }, bleep: story.narrationSettings.bleepStrongProfanity });
      const cachePath = join(storyPaths(this.root, slug, 1).story, "pronunciation-previews", `${key}.json`);
      const cachedRaw = await readJsonIfExists(cachePath);
      const cacheResult = z.object({ id: z.string().uuid(), audioUrl: z.string(), bytes: z.number().positive() }).safeParse(cachedRaw);
      const cached = cacheResult.success ? cacheResult.data : undefined;
      if (cached && (await readFile(join(storyPaths(this.root, slug, 1).story, "voice-previews", `${cached.id}.mp3`)).catch(() => undefined))) return { ...cached, cached: true };
      const result = await withUsageScope({ story: slug, stage: "pronunciationPreview" }, () => this.censor.synthesize(provider, { ...config, text: speech.normalized.text, bleepStrongProfanity: story.narrationSettings.bleepStrongProfanity }));
      const saved = await saveVoicePreview(this.root, slug, result.audio, { text });
      await atomicWriteJson(cachePath, saved); return saved;
    });
  }
  startLocalizationSuggestions(slug: string, id: string, raw: unknown) {
    slugSchema.parse(slug); const input = localizationSuggestionRequestSchema.parse(raw);
    return this.jobs.create("entityLocalizationSuggestions", slug, async () => {
      const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig);
      const bible = await getStoryBible(this.root, slug); const entity = bible.canonicalEntities.find((item) => item.id === id);
      if (!entity) throw new Error("Canonical entity was not found");
      const names = new Map(bible.canonicalEntities.map((item) => [item.id, item.canonicalName]));
      const relationships = bible.canonicalRelationships.filter((item) => item.sourceEntityId === id || item.targetEntityId === id).slice(0, 30).map((item) => ({
        relation: item.type,
        otherEntity: names.get(item.sourceEntityId === id ? item.targetEntityId : item.sourceEntityId) ?? "Unknown entity",
      }));
      const config = story.pipeline.narration;
      const result = await withUsageScope({ story: slug, stage: "entityLocalization" }, () => generateLocalizedNameSuggestions(this.llm.forStage(config), config, {
        entity, sourceLanguage: story.sourceLanguage, targetLanguage: story.outputLanguage, locale: input.locale ?? defaultLocale(story.outputLanguage), count: input.count, relationships,
      }));
      await recordActivity(this.root, slug, "bible.localization.suggested", `Generated localized name suggestions for ${entity.canonicalName}`);
      return { entityId: id, locale: input.locale ?? defaultLocale(story.outputLanguage), model: config, suggestions: result.suggestions };
    });
  }
  private async executeCanonicalEntityMerge(
    slug: string,
    targetEntityId: string,
    sourceEntityIds: string[],
    reason: string,
  ) {
    const before = await getStoryBible(this.root, slug);
    const changedEntities = before.canonicalEntities.filter((entity) => entity.id === targetEntityId || sourceEntityIds.includes(entity.id));
    const prepared = await prepareVisualCanonMerge(this.root, slug, targetEntityId, sourceEntityIds);
    const base = await getStoryBible(this.root, slug, { includeCanonicalOverlay: false });
    const result = await mergeCanonicalEntities(this.root, slug, base, targetEntityId, sourceEntityIds, reason);
    const mergeId = result.merge.id;

    try {
      await commitVisualCanonMerge(this.root, slug, prepared);
    } catch (commitErr) {
      const rollbackFailures: RollbackFailure[] = [];

      await attemptRollback(
        "visual_canon_prepared_assets",
        () => rollbackPreparedVisualCanonMerge(prepared),
        rollbackFailures,
      );

      await attemptRollback(
        "story_bible_merge",
        () => undoCanonicalMerge(this.root, slug, base, mergeId),
        rollbackFailures,
      );

      if (rollbackFailures.length > 0) {
        throw new ReconciliationError(
          `Entity merge failed and automatic rollback could not fully restore the previous state. The story requires reconciliation before retrying this merge.`,
          {
            cause: commitErr,
            rollbackFailures,
            storySlug: slug,
            targetEntityId,
            sourceEntityIds,
            mergeId,
            failedPhase: "visual_canon_commit_rollback",
          },
        );
      }

      throw commitErr;
    }

    const cleanup = await finalizeVisualCanonMerge(prepared);
    try { await invalidateCanonicalIdentityChange(this.root, slug, changedEntities, "Canonical entities were merged"); }
    catch (error) { cleanup.errors.push(`Could not mark affected chapter reviews stale after merge: ${error instanceof Error ? error.message : String(error)}`); }
    await appendEntityAudit(this.root, slug, [
      { entityId: targetEntityId, action: "merged", after: { mergeId, mergedSourceIds: sourceEntityIds, reason }, reason, source: "manual" },
      ...sourceEntityIds.map((sourceEntityId): EntityAuditInput => ({ entityId: sourceEntityId, action: "merged", after: { mergeId, mergedInto: targetEntityId, reason }, reason, source: "manual" })),
    ]);
    return {
      ...result,
      cleanupWarnings: cleanup.errors.length > 0 ? cleanup.errors : undefined,
    };
  }

  async mergeCanonicalEntities(slug: string, raw: unknown) {
    slugSchema.parse(slug);
    const input = z.object({
      targetEntityId: z.string(),
      sourceEntityIds: z.array(z.string()).min(1).max(50),
      reason: z.string().trim().min(1).max(1000),
    }).strict().parse(raw);
    return withStoryLock(this.root, slug, "canonical entity merge", async () => {
      const result = await this.executeCanonicalEntityMerge(slug, input.targetEntityId, input.sourceEntityIds, input.reason);
      await recordActivity(this.root, slug, "bible.entities.merged", `Merged ${input.sourceEntityIds.length} duplicate entity record(s)`);
      return {
        merge: result.merge,
        entity: result.bible.canonicalEntities.find((item) => item.id === input.targetEntityId),
        ...(result.cleanupWarnings ? { cleanupWarnings: result.cleanupWarnings } : {}),
      };
    });
  }
  async undoCanonicalMerge(slug: string, mergeId: string) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "undo canonical entity merge", async () => { const base = await getStoryBible(this.root, slug, { includeCanonicalOverlay: false }); const result = await undoCanonicalMerge(this.root, slug, base, mergeId); const merge = result.overlay.merges.find((item) => item.id === mergeId); if (merge) { const entries: EntityAuditInput[] = [{ entityId: merge.targetEntityId, action: "merge_undone", after: { mergeId, mergedSourceIds: merge.sourceEntityIds }, source: "manual" }, ...merge.sourceEntityIds.map((id): EntityAuditInput => ({ entityId: id, action: "merge_undone", after: { mergeId, unmergedFrom: merge.targetEntityId }, source: "manual" }))]; await appendEntityAudit(this.root, slug, entries.filter((entry) => canonicalEntitySchema.shape.id.safeParse(entry.entityId).success)); } await recordActivity(this.root, slug, "bible.merge.undone", "Undid a canonical entity merge"); return { status: "undone" }; }); }
  async suppressCanonicalEntity(slug: string, entityId: string, raw: unknown) {
    slugSchema.parse(slug);
    const { reason } = z.object({ reason: z.string().trim().min(1).max(1000) }).strict().parse(raw);
    return withStoryLock(this.root, slug, "canonical entity suppression", async () => {
      const base = await getStoryBible(this.root, slug, { includeCanonicalOverlay: false });
      const before = (await getStoryBible(this.root, slug)).canonicalEntities.find((item) => item.id === entityId);
      if (!before) throw new Error("Canonical entity was not found");
      const overlayPath = storyPaths(this.root, slug, 1).bibleCanonicalManual;
      const priorOverlay = await readFile(overlayPath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      const result = await suppressCanonicalEntity(this.root, slug, base, entityId, reason);
      try { await invalidateCanonicalIdentityChange(this.root, slug, [before], `Canonical entity ${before.canonicalName} was suppressed`); }
      catch (error) { if (priorOverlay) await atomicWrite(overlayPath, priorOverlay); else await rm(overlayPath, { force: true }); throw error; }
      invalidateCatalogCache(this.root, slug);
      await appendEntityAudit(this.root, slug, [{ entityId, action: "suppressed", before: { canonicalName: before.canonicalName, type: before.type }, reason, source: "manual" }]);
      await recordActivity(this.root, slug, "bible.entity.suppressed", `Suppressed canonical entity ${entityId}: ${reason}`);
      return { status: "suppressed", suppression: result.overlay.suppressions.find((item) => item.entityId === entityId) };
    });
  }
  async restoreCanonicalEntity(slug: string, entityId: string) {
    slugSchema.parse(slug);
    return withStoryLock(this.root, slug, "canonical entity restoration", async () => {
      const base = await getStoryBible(this.root, slug, { includeCanonicalOverlay: false });
      const overlayPath = storyPaths(this.root, slug, 1).bibleCanonicalManual;
      const priorOverlay = await readFile(overlayPath);
      const result = await restoreCanonicalEntity(this.root, slug, base, entityId);
      const entity = result.bible.canonicalEntities.find((item) => item.id === entityId);
      try { if (entity) await invalidateCanonicalIdentityChange(this.root, slug, [entity], `Canonical entity ${entity.canonicalName} was restored`); }
      catch (error) { await atomicWrite(overlayPath, priorOverlay); throw error; }
      invalidateCatalogCache(this.root, slug);
      await appendEntityAudit(this.root, slug, [{ entityId, action: "restored", after: entity ? { canonicalName: entity.canonicalName, type: entity.type } : undefined, source: "manual" }]);
      await recordActivity(this.root, slug, "bible.entity.restored", `Restored canonical entity ${entityId}`);
      return { status: "restored", entity: result.bible.canonicalEntities.find((item) => item.id === entityId) };
    });
  }
  async resolveContinuity(slug: string, id: string, raw: unknown) {
    slugSchema.parse(slug); const input = z.object({ resolution: z.enum(["accepted_new", "kept_existing", "intentional", "corrected", "merged", "dismissed"]), note: z.string().trim().max(2000).optional() }).strict().parse(raw);
    return withStoryLock(this.root, slug, "continuity resolution", async () => {
      const reviewRaw = await readJsonIfExists(storyPaths(this.root, slug, 1).continuityReview); const review = z.object({ findings: z.array(continuityFindingSchema) }).passthrough().parse(reviewRaw); const current = review.findings.find((item) => item.id === id);
      if (!current) throw new Error("Continuity finding was not found");
      const base = await getStoryBible(this.root, slug, { includeCanonicalOverlay: false });
      if (input.resolution === "merged") {
        if (current.type !== "identity_alias_ambiguity" || current.entityIds.length < 2) throw new Error("Only identity or alias findings can be resolved by merging entities");
        await this.executeCanonicalEntityMerge(slug, current.entityIds[0]!, current.entityIds.slice(1), input.note || `Resolved continuity finding ${id}`);
      } else if (input.resolution === "accepted_new") {
        if (current.type !== "status_conflict" || current.entityIds.length !== 1) throw new Error("This finding requires a manual Story Bible correction before it can be accepted");
        const chapter = Math.max(...current.chapters); const latest = base.entityTimeline.filter((event) => event.entityId === current.entityIds[0] && event.chapter === chapter).at(-1); const status = latest?.status ?? (latest?.type === "appearance" ? "alive" : undefined);
        if (!status) throw new Error("The newest finding does not contain a canonical status; edit the Story Bible instead");
        await updateCanonicalEntity(this.root, slug, base, current.entityIds[0]!, { status });
        if (canonicalEntitySchema.shape.id.safeParse(current.entityIds[0]!).success) await appendEntityAudit(this.root, slug, [{ entityId: current.entityIds[0]!, action: "updated", after: { status }, reason: input.note || `Resolved continuity finding ${id}`, source: "manual" }]);
      }
      const finding = await resolveContinuityFinding(this.root, slug, id, input.resolution, input.note); invalidateCatalogCache(this.root, slug); await recordActivity(this.root, slug, "continuity.resolved", `Resolved ${finding.type} finding`); return { finding };
    });
  }

  async analyzeStoryBible(slug: string) {
    slugSchema.parse(slug);
    return analyzeStoryBible(this.root, slug);
  }

  async applyCleanupRecommendations(slug: string, raw: unknown) {
    slugSchema.parse(slug);
    const input = z.object({
      recommendationIds: z.array(z.string()).default([]),
      highConfidenceOnly: z.boolean().default(false),
    }).passthrough().parse(raw ?? {});
    const result = await applyCleanupRecommendations(this.root, slug, input.recommendationIds, {
      highConfidenceOnly: input.highConfidenceOnly,
    });
    invalidateCatalogCache(this.root, slug);
    await appendEntityAudit(this.root, slug, result.auditTrail.filter((entry) => canonicalEntitySchema.shape.id.safeParse(entry.entityId).success));
    await recordActivity(this.root, slug, "bible.cleanup.applied", `Applied Story Bible cleanup: demoted ${result.appliedDemotionsCount}, merged ${result.appliedMergesCount}`);
    return result;
  }

  async demoteCanonicalEntity(slug: string, id: string, raw: unknown) {
    slugSchema.parse(slug);
    canonicalEntitySchema.shape.id.parse(id);
    const input = z.object({
      parentEntityId: z.string().optional(),
      reason: z.string().optional(),
      force: z.boolean().optional(),
    }).passthrough().parse(raw ?? {});

    const preparedVisual = await prepareVisualCanonDemote(this.root, slug, id);
    const snapshot = await snapshotPreDemoteStoryBible(this.root, slug);

    const result = await demoteCanonicalEntity(this.root, slug, id, input);

    try {
      await commitVisualCanonDemote(this.root, slug, preparedVisual);
    } catch (visualErr) {
      const rollbackFailures: RollbackFailure[] = [];

      await attemptRollback(
        "story_bible_demote",
        async () => {
          await restorePreDemoteStoryBible(this.root, slug, snapshot);
          invalidateCatalogCache(this.root, slug);
        },
        rollbackFailures,
      );

      await attemptRollback(
        "visual_canon_demote",
        () => rollbackPreparedVisualCanonDemote(this.root, slug, preparedVisual),
        rollbackFailures,
      );

      if (rollbackFailures.length > 0) {
        throw new ReconciliationError(
          `Canonical entity demotion failed and automatic rollback could not fully restore the previous Story Bible state. The story requires reconciliation before retrying.`,
          {
            cause: visualErr,
            rollbackFailures,
            storySlug: slug,
            targetEntityId: id,
            failedPhase: "visual_canon_demote_rollback",
          },
        );
      }

      throw visualErr;
    }

    invalidateCatalogCache(this.root, slug);
    if (result.status === "demoted") await appendEntityAudit(this.root, slug, [{ entityId: id, action: "demoted", after: { referenceId: result.referenceId, parentEntityId: input.parentEntityId ?? null }, reason: input.reason, source: "manual" }]);
    await recordActivity(this.root, slug, "bible.entity.demoted", `Demoted canonical entity ${id} to minor reference`);
    return result;
  }

  async promoteMinorReference(slug: string, id: string, raw: unknown) {
    slugSchema.parse(slug);
    const input = z.object({
      reason: z.string().optional(),
    }).passthrough().parse(raw ?? {});
    const result = await promoteMinorReference(this.root, slug, id, input);
    invalidateCatalogCache(this.root, slug);
    if (result.status === "promoted") await appendEntityAudit(this.root, slug, [{ entityId: result.entity.id, action: "promoted", after: { referenceId: id, canonicalName: result.entity.canonicalName }, reason: input.reason, source: "manual" }]);
    await recordActivity(this.root, slug, "bible.reference.promoted", `Promoted minor reference ${id} to canonical entity`);
    return result;
  }

  async updateMinorReference(slug: string, id: string, raw: unknown) {
    slugSchema.parse(slug);
    const input = z.object({
      name: z.string().optional(),
      parentEntityId: z.string().nullable().optional(),
      status: z.enum(["minor", "promotion_candidate"]).optional(),
      aliases: z.array(z.string()).optional(),
      contextNotes: z.string().nullable().optional(),
    }).passthrough().parse(raw ?? {});
    const result = await updateMinorReference(this.root, slug, id, input);
    invalidateCatalogCache(this.root, slug);
    return result;
  }

  startVoicePreview(slug: string, raw: unknown) { slugSchema.parse(slug); const input = voicePreviewSchema.parse(raw); return this.jobs.create("voicePreview", slug, async () => { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const config = story.pipeline.tts; const request = { ...input, provider: input.provider ?? config.provider, model: input.model ?? config.model, referenceId: input.referenceId ?? config.referenceId, speed: input.speed ?? config.speed }; const provider = pronunciationProvider(this.tts.forName(request.provider), await loadPronunciationEntities(this.root, slug)); const speech = normalizeSpeechForProvider(request.text, story.outputLanguage, story.narrationSettings, provider, request.model); const result = await withUsageScope({story:slug,stage:"voicePreview"},async ()=>this.censor.synthesize(provider, { text: speech.normalized.text, model: request.model, referenceId: request.referenceId,
    secondaryReferenceId: config.secondaryReferenceId, voiceMode: config.voiceMode, deliveryIntensity: config.deliveryIntensity, qualityGuard: config.qualityGuard, providerQualityGuard: config.providerQualityGuard,
    bleepStrongProfanity: story.narrationSettings.bleepStrongProfanity,
    speed: request.speed, format: config.format, sampleRate: 44100, bitrate: 192, normalize: true, maxCharsPerRequest: config.maxCharsPerRequest })); const saved = await saveVoicePreview(this.root, slug, result.audio, request); await recordActivity(this.root, slug, "voice.preview", "Generated a voice preview"); return saved; }); }

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
      const selected = selectChapterRange(imported.chapters, input.from, input.to); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); let mastered = 0; let reused = 0; const warnings: string[] = [];
      for (let index = 0; index < selected.length; index++) {
        if (shutdown.isRequested) return { status: "paused", mastered, reused, total: selected.length, warnings: [...new Set(warnings)] };
        const chapter = selected[index]!.chapter; control.update({ type: "audio.chapter.started", chapter, index: index + 1, total: selected.length });
        const retainedAudio = await exists(storyPaths(this.root, slug, chapter).audio);
        if (!input.force && retainedAudio) {
          reused++;
          const audioArtifact = await inspectStageArtifact(this.root, slug, chapter, "audioMastering");
          const chapterWarnings: string[] = [];
          if (audioArtifact.freshness === "stale") chapterWarnings.push(stalePrerequisiteWarning("audioMastering"));
          warnings.push(...chapterWarnings);
          control.update({ type: "audio.chapter.completed", chapter, index: index + 1, total: selected.length, reused: true, retained: true, warnings: chapterWarnings });
          continue;
        }
        const result = await masterStoredChapter({ root: this.root, story, chapter, processor: this.audio, force: input.force }); result.reused ? reused++ : mastered++;
        warnings.push(...(result.warnings ?? []));
        control.update({ type: "audio.chapter.completed", chapter, index: index + 1, total: selected.length, reused: result.reused, durationSeconds: result.probe.durationSeconds, warnings: result.warnings });
      }
      return { status: "completed", mastered, reused, total: selected.length, warnings: [...new Set(warnings)] };
    }));
  }

  private speechTranscriber() {
    if (this.transcriber) return this.transcriber;
    if (this.alignConfig.engine === "disabled") throw new ConfigurationError("TTS quality verification requires whisper.cpp (ALIGNMENT_ENGINE is disabled)");
    return new WhisperCppSpeechTranscriber(this.alignConfig.executable, this.alignConfig.model, this.alignConfig.timeoutMs, undefined, this.alignConfig.device);
  }

  async getChapterTtsQuality(slug: string, chapter: number) {
    slugSchema.parse(slug); chapterParamSchema.parse(chapter);
    return { quality: (await loadChapterTtsQuality(this.root, slug, chapter)) ?? null };
  }

  startVerifyChapterTts(slug: string, raw: unknown) {
    slugSchema.parse(slug); const input = z.object({ chapter: z.number().int().positive() }).strict().parse(raw);
    return this.jobs.create("ttsQualityVerify", slug, async () => withStoryLock(this.root, slug, "TTS quality re-verification", async () => {
      const story = await loadStory(storyPaths(this.root, slug, input.chapter).storyConfig);
      const quality = await verifyStoredChapterTts({ root: this.root, story, chapter: input.chapter, transcriber: this.speechTranscriber() });
      await recordActivity(this.root, slug, "tts.quality.verified", `Re-verified TTS quality for Chapter ${input.chapter}`);
      return { quality };
    }));
  }

  startRegenerateChapterTtsSegment(slug: string, chapter: number, segment: number) {
    slugSchema.parse(slug); chapterParamSchema.parse(chapter); segmentParamSchema.parse(segment);
    return this.jobs.create("ttsSegmentRegenerate", slug, async () => withStoryLock(this.root, slug, "TTS segment regeneration", async () => {
      const story = await loadStory(storyPaths(this.root, slug, chapter).storyConfig);
      const config = story.pipeline.tts;
      const base = pronunciationProvider(this.tts.forName(config.provider), await loadPronunciationEntities(this.root, slug));
      const provider = new QualityGuardTTSProvider(base, this.speechTranscriber(), { maxRetries: config.maxQualityRetries, language: story.outputLanguage });
      const quality = await withUsageScope({ story: slug, chapter, stage: "tts" }, () => regenerateStoredChapterTtsSegment({ root: this.root, story, chapter, segment: segment - 1, provider, maxRetries: config.maxQualityRetries }));
      await recordActivity(this.root, slug, "tts.quality.segment_regenerated", `Regenerated TTS segment ${segment} for Chapter ${chapter}`);
      return { quality };
    }));
  }

  async acceptChapterTtsSegment(slug: string, chapter: number, segment: number, raw: unknown) {
    slugSchema.parse(slug); chapterParamSchema.parse(chapter); segmentParamSchema.parse(segment);
    const input = z.object({ reason: z.string().max(500).optional() }).strict().parse(raw);
    return withStoryLock(this.root, slug, "TTS segment acceptance", async () => {
      const quality = await acceptStoredChapterTtsSegment({ root: this.root, slug, chapter, segment: segment - 1, reason: input.reason });
      await recordActivity(this.root, slug, "tts.quality.segment_accepted", `Manually accepted TTS segment ${segment} for Chapter ${chapter}`);
      return { quality };
    });
  }

  startAudiobook(slug: string, raw: unknown) {
    slugSchema.parse(slug); const input = audiobookInputSchema.parse(raw);
    return this.jobs.create("audiobook", slug, async (control) => withStoryLock(this.root, slug, "web audiobook assembly", async () => {
      const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const imported = await loadImportedChapters(this.root, slug);
      const selected = selectChapterRange(imported.chapters, input.from, input.to); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request());
      const warnings: string[] = [];
      for (let index = 0; index < selected.length; index++) {
        if (shutdown.isRequested) return { status: "paused", total: selected.length, warnings: [...new Set(warnings)] };
        const chapter = selected[index]!.chapter; control.update({ type: "audio.chapter.started", chapter, index: index + 1, total: selected.length });
        const retainedAudio = await exists(storyPaths(this.root, slug, chapter).audio);
        if (retainedAudio) {
          const audioArtifact = await inspectStageArtifact(this.root, slug, chapter, "audioMastering");
          const chapterWarnings: string[] = [];
          if (audioArtifact.freshness === "stale") chapterWarnings.push(stalePrerequisiteWarning("audioMastering"));
          warnings.push(...chapterWarnings);
          control.update({ type: "audio.chapter.completed", chapter, index: index + 1, total: selected.length, reused: true, retained: true, warnings: chapterWarnings });
          continue;
        }
        const result = await masterStoredChapter({ root: this.root, story, chapter, processor: this.audio });
        warnings.push(...(result.warnings ?? []));
        control.update({ type: "audio.chapter.completed", chapter, index: index + 1, total: selected.length, reused: result.reused, warnings: result.warnings });
      }
      const assembled = await assembleAudiobook({ root: this.root, story, from: selected[0]!.chapter, to: selected.at(-1)!.chapter, format: input.format as AudiobookFormat,
        processor: this.audiobook, force: input.force, onProgress: (event) => control.update(event) });
      return { ...assembled, warnings: [...new Set(warnings)] };
    }));
  }

  startAlignment(slug: string, raw: unknown) { slugSchema.parse(slug); const input = alignmentJobSchema.parse(raw); return this.jobs.create("alignment", slug, async (control) => withStoryLock(this.root, slug, "web chapter alignment", async () => { const story = await loadStory(storyPaths(this.root, slug, input.chapter).storyConfig); control.update({ type: "alignment.chapter.started", chapter: input.chapter }); return alignStoredChapter({ root: this.root, storySlug: slug, chapter: input.chapter, language: story.outputLanguage, config: this.alignConfig, engine: this.aligner, force: input.force, forceEstimated: input.forceEstimated, requireAligned: input.requireAligned, onEvent: (event) => control.update({ type: `alignment.${event.status}`, chapter: input.chapter, mode: event.mode }) }); })); }

  startSubtitles(slug: string, raw: unknown) { slugSchema.parse(slug); const input = rangeJobSchema.parse(raw); return this.jobs.create("subtitles", slug, async (control) => withStoryLock(this.root, slug, "web subtitle generation", async () => { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const selected = selectChapterRange((await loadImportedChapters(this.root, slug)).chapters, input.from, input.to); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); let generated = 0; let reused = 0; const warnings: string[] = []; for (let index = 0; index < selected.length; index++) { if (shutdown.isRequested) return { status: "paused", generated, reused, warnings: [...new Set(warnings)] }; const chapter = selected[index]!.chapter; control.update({ type: "subtitles.chapter.started", chapter, index: index + 1, total: selected.length }); if (!input.forceEstimated) { const alignment = await alignStoredChapter({ root: this.root, storySlug: slug, chapter, language: story.outputLanguage, config: this.alignConfig, engine: this.aligner }); warnings.push(...(alignment.warnings ?? [])); } const result = await generateStoredSubtitles({ root: this.root, story, chapter, force: input.force, forceEstimated: input.forceEstimated }); result.reused ? reused++ : generated++; warnings.push(...(result.warnings ?? [])); control.update({ type: "subtitles.chapter.completed", chapter, index: index + 1, total: selected.length, reused: result.reused, warnings: result.warnings }); } return { generated, reused, total: selected.length, warnings: [...new Set(warnings)] }; })); }

  async editSubtitles(slug: string, chapter: number, raw: unknown) { slugSchema.parse(slug); const input = z.object({ cues: z.array(z.unknown()).min(1).max(10_000) }).strict().parse(raw); return withStoryLock(this.root, slug, "manual subtitle edit", () => saveManualSubtitles(this.root, slug, chapter, input.cues)); }
  async resetSubtitles(slug: string, chapter: number) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "discard manual subtitles", async () => { await discardManualSubtitles(this.root, slug, chapter); const story = await loadStory(storyPaths(this.root, slug, chapter).storyConfig); return generateStoredSubtitles({ root: this.root, story, chapter, force: true }); }); }

  startVideo(slug: string, raw: unknown) { slugSchema.parse(slug); const input = videoJobSchema.parse(raw); return this.jobs.create("video", slug, async (control) => withStoryLock(this.root, slug, "web chapter video rendering", async () => { let story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); if (input.subtitleMode) story = { ...story, video: { ...story.video, subtitleMode: input.subtitleMode } }; const selected = selectChapterRange((await loadImportedChapters(this.root, slug)).chapters, input.from, input.to); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); let rendered = 0; let reused = 0; const warnings: string[] = []; for (let index = 0; index < selected.length; index++) { if (shutdown.isRequested) return { status: "paused", rendered, reused, warnings: [...new Set(warnings)] }; const chapter = selected[index]!.chapter; if (story.video.subtitleMode !== "none") { const alignment = await alignStoredChapter({ root: this.root, storySlug: slug, chapter, language: story.outputLanguage, config: this.alignConfig, engine: this.aligner }); const subtitles = await generateStoredSubtitles({ root: this.root, story, chapter }); warnings.push(...(alignment.warnings ?? []), ...(subtitles.warnings ?? [])); } control.update({ type: "video.chapter.started", chapter, index: index + 1, total: selected.length }); const result = await renderStoredChapterVideo({ root: this.root, story, chapter, processor: this.video, force: input.force }); result.reused ? reused++ : rendered++; warnings.push(...(result.warnings ?? [])); control.update({ type: "video.chapter.completed", chapter, index: index + 1, total: selected.length, reused: result.reused, warnings: result.warnings }); } return { rendered, reused, total: selected.length, warnings: [...new Set(warnings)] }; })); }

  startVideoExport(slug: string, raw: unknown) { slugSchema.parse(slug); const input = rangeJobSchema.parse(raw); return this.jobs.create("videoExport", slug, async (control) => withStoryLock(this.root, slug, "web combined video export", async () => { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const selected = selectChapterRange((await loadImportedChapters(this.root, slug)).chapters, input.from, input.to); const warnings: string[] = []; for (let index = 0; index < selected.length; index++) { const chapter = selected[index]!.chapter; if (story.video.subtitleMode !== "none") { const alignment = await alignStoredChapter({ root: this.root, storySlug: slug, chapter, language: story.outputLanguage, config: this.alignConfig, engine: this.aligner }); const subtitles = await generateStoredSubtitles({ root: this.root, story, chapter }); warnings.push(...(alignment.warnings ?? []), ...(subtitles.warnings ?? [])); } const rendered = await renderStoredChapterVideo({ root: this.root, story, chapter, processor: this.video }); warnings.push(...(rendered.warnings ?? [])); control.update({ type: "video.chapter.completed", chapter, index: index + 1, total: selected.length, reused: rendered.reused, warnings: rendered.warnings }); } const assembled = await assembleVideoExport({ root: this.root, story, from: selected[0]!.chapter, to: selected.at(-1)!.chapter, processor: this.videoExport, force: input.force, onProgress: (event) => control.update(event) }); return { ...assembled, warnings: [...new Set(warnings)] }; })); }

  startScenes(slug: string, raw: unknown) { slugSchema.parse(slug); const input = explicitRangeJobSchema.parse(raw); return this.jobs.create("scenes", slug, async (control) => withStoryLock(this.root, slug, "web scene planning", async () => { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const selected = selectChapterRange((await loadImportedChapters(this.root, slug)).chapters, input.from, input.to); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); let planned = 0; let reused = 0; const warnings: string[] = []; for (let index = 0; index < selected.length; index++) { if (shutdown.isRequested) return { status: "paused", planned, reused, warnings: [...new Set(warnings)] }; const chapter = selected[index]!.chapter; control.update({ type: "scenes.chapter.started", chapter, index: index + 1, total: selected.length }); const provider = this.scenePlanner ?? this.runtime.router.forStage(story.pipeline.scenePlanner); const result = await withUsageScope({story:slug,chapter,stage:"scenePlanning"},()=>planStoredScenes({ root: this.root, story, chapter, provider, force: input.force })); result.reused ? reused++ : planned++; warnings.push(...(result.warnings ?? [])); control.update({ type: "scenes.chapter.completed", chapter, index: index + 1, total: selected.length, scenes: result.manifest.scenes.length, reused: result.reused, warnings: result.warnings }); } return { planned, reused, total: selected.length, warnings: [...new Set(warnings)] }; }), raw); }

  async inspectArtworkVisualPreflight(slug: string, raw: unknown) {
    slugSchema.parse(slug);
    const input = artworkJobSchema.parse(raw);
    const selected = selectChapterRange((await loadImportedChapters(this.root, slug)).chapters, input.from, input.to);
    const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig);
    // Reuse the exact candidate calculation and authoritative preflight from
    // generation. dryRun never validates or calls the provider.
    const reports = await Promise.all(selected.map((chapter) => generateStoredArtwork({
      root: this.root,
      story,
      chapter: chapter.chapter,
      provider: resolveImageProvider(this.image, story),
      sceneId: input.scene,
      sceneIds: input.scenes,
      force: input.force,
      dryRun: true,
      allowUnprofiledEntityIds: input.allowUnprofiledEntityIds,
    })));
    const preflights = reports.map((report) => {
      if (!report.preflight) throw new Error("Artwork dry-run did not return a Visual Profile preflight");
      return report.preflight;
    });
    const entities = new Map<string, any>();
    for (const preflight of preflights) for (const entity of preflight.entities) {
      const current = entities.get(entity.entityId);
      if (current) current.affectedSceneIds = [...new Set([...current.affectedSceneIds, ...entity.affectedSceneIds])];
      else entities.set(entity.entityId, { ...entity, affectedSceneIds: [...entity.affectedSceneIds] });
    }
    const all = [...entities.values()];
    const requiresDecision = all.filter((entity) => (entity.state === "missing_profile" || entity.state === "draft_profile") && !input.allowUnprofiledEntityIds.includes(entity.entityId));
    return { ready: requiresDecision.length === 0, entities: all, requiresDecision, fingerprint: fingerprint({ reports: preflights.map((preflight) => preflight.fingerprint) }), imageCountEstimate: reports.reduce((total, report) => total + report.imagesToGenerate, 0) };
  }

  async updateEntityVisualProfilePolicy(slug: string, entityId: string, raw: unknown) {
    slugSchema.parse(slug);
    canonicalEntitySchema.shape.id.parse(entityId);
    const input = z.object({ mode: z.enum(["prompt", "skip"]) }).strict().parse(raw);
    return this.updateCanonicalEntity(slug, entityId, { visualProfilePolicy: input });
  }

  async getEntityVisualProfilePolicy(slug: string, entityId: string) {
    slugSchema.parse(slug);
    canonicalEntitySchema.shape.id.parse(entityId);
    const entity = (await getStoryBible(this.root, slug)).canonicalEntities.find((item) => item.id === entityId);
    if (!entity) throw new Error("Canonical entity was not found");
    return { mode: entity.visualProfilePolicy?.mode ?? "prompt" };
  }

  startArtwork(slug: string, raw: unknown) { slugSchema.parse(slug); const input = artworkJobSchema.parse(raw); return this.jobs.create("artwork", slug, async (control) => withStoryLock(this.root, slug, "web artwork generation", async () => { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const selected = selectChapterRange((await loadImportedChapters(this.root, slug)).chapters, input.from, input.to); const shutdown = new ShutdownController(); control.setPause(() => shutdown.request()); let generated = 0; let estimate = 0; const warnings: string[] = []; for (let index = 0; index < selected.length; index++) { if (shutdown.isRequested) return { status: "paused", generated, estimate, warnings: [...new Set(warnings)] }; const chapter = selected[index]!.chapter; const result = await withUsageScope({story:slug,chapter,stage:"artwork"},()=>generateStoredArtwork({ root: this.root, story, chapter, provider: resolveImageProvider(this.image, story), sceneId: input.scene, sceneIds: input.scenes, force: input.force, dryRun: input.dryRun, allowUnprofiledEntityIds: input.allowUnprofiledEntityIds, onProgress: (event) => control.update({ ...event, chapterIndex: index + 1, chapterTotal: selected.length }) })); generated += "generated" in result ? result.generated ?? 0 : 0; estimate += result.imagesToGenerate; warnings.push(...(result.warnings ?? [])); } return { dryRun: input.dryRun, generated, imageCountEstimate: estimate, chapters: selected.length, provider: story.artwork.provider, model: story.artwork.model, warnings: [...new Set(warnings)] }; }), raw); }

  getActiveStoryJob(slug: string) {
    slugSchema.parse(slug);
    return this.jobs.getActiveForStory(slug);
  }

  async retryJob(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job '${id}' was not found`);
    switch (job.type) {
      case "scenes": return this.startScenes(job.story, job.payload ?? {});
      case "artwork": return this.startArtwork(job.story, job.payload ?? {});
      case "batch": return this.startBatch(job.story, job.payload ?? {});
      case "audio": return this.startAudio(job.story, job.payload ?? {});
      case "audiobook": return this.startAudiobook(job.story, job.payload ?? {});
      case "subtitles": return this.startSubtitles(job.story, job.payload ?? {});
      case "alignment": return this.startAlignment(job.story, job.payload ?? {});
      case "video": return this.startVideo(job.story, job.payload ?? {});
      case "videoExport": return this.startVideoExport(job.story, job.payload ?? {});
      case "production": return this.startProduction(job.story, job.payload ?? {});
      default: throw new Error(`Retry is not supported for job type '${job.type}'`);
    }
  }

  async updateScenes(slug: string, chapter: number, scenes: unknown) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "manual scene edit", async () => { const story = await loadStory(storyPaths(this.root, slug, chapter).storyConfig); return updateStoredSceneManifest({ root: this.root, story, chapter, scenes }); }); }
  async updateScene(slug: string, chapter: number, sceneId: string, scene: unknown, expectedFingerprint: string) {
    slugSchema.parse(slug);
    return withStoryLock(this.root, slug, "manual single scene edit", async () => {
      const story = await loadStory(storyPaths(this.root, slug, chapter).storyConfig);
      return updateStoredScene({ root: this.root, story, chapter, sceneId, scene, expectedFingerprint });
    });
  }
  async previewChapterSceneRegeneration(slug: string, chapter: number, sceneId: string, mode: unknown) {
    slugSchema.parse(slug);
    const story = await loadStory(storyPaths(this.root, slug, chapter).storyConfig);
    const provider = this.scenePlanner ?? this.runtime.router.forStage(story.pipeline.scenePlanner);
    return withUsageScope({ story: slug, chapter, stage: "scenePlanning" }, () => previewStoredSceneRegeneration({ root: this.root, story, chapter, sceneId, mode, provider }));
  }
  async applyChapterSceneRegeneration(slug: string, chapter: number, sceneId: string, proposal: unknown) {
    slugSchema.parse(slug);
    return withStoryLock(this.root, slug, "chapter scene regeneration apply", async () => {
      const story = await loadStory(storyPaths(this.root, slug, chapter).storyConfig);
      return applyStoredSceneRegeneration({ root: this.root, story, chapter, sceneId, proposal });
    });
  }
  async updateSceneContinuity(slug: string, chapter: number, sceneId: string, raw: unknown) {
    slugSchema.parse(slug);
    const input = visualContinuityOverrideEntrySchema.omit({ revision: true, updatedAt: true }).parse({ ...(typeof raw === "object" && raw !== null ? raw : {}), sceneId });
    return withStoryLock(this.root, slug, "manual visual continuity override", async () => {
      const overlay = await upsertVisualContinuityOverride({ root: this.root, slug, chapter, entry: visualContinuityOverrideEntrySchema.parse({ ...input, revision: 1, updatedAt: new Date().toISOString() }) });
      await this.afterContinuityOverride(slug, chapter);
      return overlay;
    });
  }
  async deleteSceneContinuity(slug: string, chapter: number, sceneId: string) {
    slugSchema.parse(slug);
    return withStoryLock(this.root, slug, "manual visual continuity override reset", async () => {
      const overlay = await removeVisualContinuityOverride({ root: this.root, slug, chapter, sceneId });
      await this.afterContinuityOverride(slug, chapter);
      return overlay;
    });
  }
  private async afterContinuityOverride(slug: string, chapter: number) {
    const paths = storyPaths(this.root, slug, chapter);
    // Targeted invalidation: the overlay fingerprint feeds the scene-planning
    // input fingerprint, so mark this chapter's scene plan stale (not missing).
    const rawChapter = await readJsonIfExists<Chapter>(paths.chapterMeta);
    if (rawChapter) {
      const metadata = chapterSchema.parse(rawChapter);
      if (metadata.stages.scenePlanning.status === "complete") {
        metadata.stages.scenePlanning = { ...metadata.stages.scenePlanning, staleReason: "Manual visual continuity override changed" };
        metadata.updatedAt = new Date().toISOString();
        await atomicWriteJson(paths.chapterMeta, metadata);
      }
    }
    const rawManifest = await readJsonIfExists<SceneManifest>(paths.scenesManifest);
    const manifest = rawManifest ? sceneManifestSchema.safeParse(rawManifest) : undefined;
    if (manifest?.success) await persistChapterVisualContinuity({ root: this.root, slug, chapter, manifest: manifest.data, origin: "manual" });
  }
  async reviewArtwork(slug: string, chapter: number, sceneId: string, review: unknown) { slugSchema.parse(slug); return withStoryLock(this.root, slug, "artwork review", async () => { const story = await loadStory(storyPaths(this.root, slug, chapter).storyConfig); return reviewStoredArtwork({ root: this.root, story, chapter, sceneId, review }); }); }
  async reviewArtworkVersion(slug: string, chapter: number, sceneId: string, versionId: string, review?: unknown) {
    slugSchema.parse(slug);
    return withStoryLock(this.root, slug, "artwork version review", async () => {
      const story = await loadStory(storyPaths(this.root, slug, chapter).storyConfig);
      const parsedReview = review !== undefined ? artworkReviewSchema.parse(review) : "approved";
      return reviewStoredArtworkVersion({
        root: this.root,
        story,
        chapter,
        sceneId,
        versionId,
        review: parsedReview,
      });
    });
  }

  async reupscaleArtwork(slug: string, chapter: number, raw: unknown) {
    slugSchema.parse(slug);
    const input = z.object({ sceneId: z.string().regex(/^scene-\d{3}$/).optional(), versionNumber: z.number().int().positive().optional() }).strict().parse(raw ?? {});
    return withStoryLock(this.root, slug, "artwork re-upscale", async () => {
      const story = await loadStory(storyPaths(this.root, slug, chapter).storyConfig);
      return reupscaleStoredArtwork({ root: this.root, story, chapter, sceneId: input.sceneId, versionNumber: input.versionNumber });
    });
  }

  async getVisualProfiles(slug: string) {
    slugSchema.parse(slug);
    const profiles = await loadVisualProfiles(this.root, slug);
    return Object.values(profiles);
  }

  async getVisualProfile(slug: string, entityId: string) {
    slugSchema.parse(slug);
    canonicalEntitySchema.shape.id.parse(entityId);
    return loadVisualProfileEntity(this.root, slug, entityId);
  }

  async updateVisualProfile(slug: string, entityId: string, input: unknown) {
    slugSchema.parse(slug);
    canonicalEntitySchema.shape.id.parse(entityId);
    return withStoryLock(this.root, slug, "update visual profile", async () => {
      const bible = await getStoryBible(this.root, slug);
      const entity = bible.canonicalEntities.find((e) => e.id === entityId);
      if (!entity) {
        throw new Error(`Cannot update visual profile: entity ${entityId} does not exist in Story Bible`);
      }
      const rawProfile = (typeof input === "object" && input !== null && "profile" in input) ? (input as any).profile : input;
      const parsed = visualProfileSchema.parse({ ...rawProfile, entityId });
      const updated = await updateVisualProfile(this.root, slug, entityId, parsed);
      // An approved profile supersedes an earlier opt-out. Keep the policy
      // explicit, but never let a stale skip hide newly approved visual canon.
      if (updated.status === "approved" && entity.visualProfilePolicy?.mode === "skip") {
        const base = await getStoryBible(this.root, slug, { includeCanonicalOverlay: false });
        await updateCanonicalEntity(this.root, slug, base, entityId, { visualProfilePolicy: { mode: "prompt" } });
      }
      return updated;
    });
  }

  async deleteVisualProfile(slug: string, entityId: string) {
    slugSchema.parse(slug);
    canonicalEntitySchema.shape.id.parse(entityId);
    return withStoryLock(this.root, slug, "delete visual profile", async () => {
      return deleteVisualProfile(this.root, slug, entityId);
    });
  }

  async deleteVisualReferenceImage(slug: string, entityId: string, refId: string) {
    slugSchema.parse(slug);
    canonicalEntitySchema.shape.id.parse(entityId);
    return withStoryLock(this.root, slug, "delete visual reference image", async () => {
      return deleteVisualReferenceImage(this.root, slug, entityId, refId);
    });
  }

  async addVisualReferenceImage(slug: string, entityId: string, imageBuffer: Buffer, ext: string, viewType: string, notes?: string) {
    slugSchema.parse(slug);
    canonicalEntitySchema.shape.id.parse(entityId);
    return withStoryLock(this.root, slug, "add visual reference image", async () => {
      return addVisualReferenceImage(this.root, slug, entityId, {
        data: imageBuffer,
        ext,
        role: viewType as any,
        prompt: notes,
      });
    });
  }

  async generateStyleSheet(slug: string, entityId: string, options?: { promptOverride?: string; role?: any; presetId?: string }) {
    slugSchema.parse(slug);
    canonicalEntitySchema.shape.id.parse(entityId);
    return withStoryLock(this.root, slug, "generate style sheet", async () => {
      const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig);
      const provider = resolveImageProvider(this.image, story);
      return withUsageScope({ story: slug, stage: "visual-reference" }, () => generateStyleSheet(this.root, slug, entityId, provider, story, options));
    });
  }

  async inspectVisualProfile(slug: string, entityId: string) {
    slugSchema.parse(slug);
    canonicalEntitySchema.shape.id.parse(entityId);
    return withStoryLock(this.root, slug, "inspect visual profile", async () => synchronizeVisualProfileConflicts(this.root, slug, await getStoryBible(this.root, slug), entityId));
  }

  async proposeVisualProfile(slug: string, entityId: string, input: unknown) {
    slugSchema.parse(slug);
    canonicalEntitySchema.shape.id.parse(entityId);
    const parsed = z.object({ fields: z.array(z.string().min(1)).max(20).optional(), regenerate: z.boolean().optional() }).strict().parse(input ?? {});
    return withStoryLock(this.root, slug, "propose visual profile details", async () => {
      const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig);
      return withUsageScope({ story: slug, stage: "visual-profile" }, async () => proposeMissingVisualDetails(this.root, slug, await getStoryBible(this.root, slug), entityId, this.llm.forStage(story.pipeline.storyBible), story.pipeline.storyBible, parsed));
    });
  }

  async applyVisualProfileProposal(slug: string, entityId: string, input: unknown) {
    slugSchema.parse(slug);
    canonicalEntitySchema.shape.id.parse(entityId);
    const parsed = z.object({ proposal: visualProfileProposalSchema.extend({ entityId: z.string(), visualType: visualProfileSchema.shape.visualType, eligibleFields: z.array(z.string()), protectedFields: z.array(z.string()), contextFingerprint: z.string(), provider: z.string(), model: z.string() }), selectedFields: z.array(z.string()).max(20) }).strict().parse(input);
    if (parsed.proposal.entityId !== entityId) throw new Error("Visual profile proposal belongs to a different entity");
    return withStoryLock(this.root, slug, "apply visual profile proposal", async () => applyVisualProfileProposal(this.root, slug, await getStoryBible(this.root, slug), parsed.proposal, parsed.selectedFields));
  }

  async approveVisualReference(slug: string, entityId: string, refId: string, input: unknown) {
    slugSchema.parse(slug);
    canonicalEntitySchema.shape.id.parse(entityId);
    const parsed = z.object({ primary: z.boolean().optional() }).strict().parse(input ?? {});
    return withStoryLock(this.root, slug, "approve visual reference", async () => approveVisualReference(this.root, slug, entityId, refId, parsed.primary));
  }

  async resolveVisualProfileConflict(slug: string, entityId: string, conflictId: string, input: unknown) {
    slugSchema.parse(slug);
    canonicalEntitySchema.shape.id.parse(entityId);
    const parsed = z.object({ action: z.enum(["accept_canonical", "retain_manual_override"]) }).strict().parse(input);
    return withStoryLock(this.root, slug, "resolve visual profile conflict", async () => resolveVisualProfileConflict(this.root, slug, await getStoryBible(this.root, slug), entityId, conflictId, parsed.action));
  }

  async getArtDirection(slug: string) {
    slugSchema.parse(slug);
    return loadStoryArtDirection(this.root, slug);
  }

  async updateArtDirection(slug: string, input: unknown) {
    slugSchema.parse(slug);
    return withStoryLock(this.root, slug, "update art direction", async () => {
      const rawArtDirection = (typeof input === "object" && input !== null && "artDirection" in input) ? (input as any).artDirection : input;
      const parsed = storyArtDirectionSchema.parse(rawArtDirection);
      await saveStoryArtDirection(this.root, slug, parsed);
      return parsed;
    });
  }

  async createArtDirectionPreset(slug: string, input: unknown) {
    slugSchema.parse(slug);
    return withStoryLock(this.root, slug, "create art direction preset", async () => {
      const parsed = createArtDirectionPresetSchema.parse(input);
      const preset = await createPreset(this.root, slug, parsed);
      return { preset, artDirection: await loadStoryArtDirection(this.root, slug) };
    });
  }

  async updateArtDirectionPreset(slug: string, presetId: string, input: unknown) {
    slugSchema.parse(slug);
    return withStoryLock(this.root, slug, "update art direction preset", async () => {
      const parsed = artDirectionPresetEditSchema.parse(input);
      await updatePreset(this.root, slug, presetId, parsed);
      return loadStoryArtDirection(this.root, slug);
    });
  }

  async deleteArtDirectionPreset(slug: string, presetId: string) {
    slugSchema.parse(slug);
    return withStoryLock(this.root, slug, "delete art direction preset", async () => {
      await deletePreset(this.root, slug, presetId);
      return loadStoryArtDirection(this.root, slug);
    });
  }

  async duplicateArtDirectionPreset(slug: string, presetId: string, newName?: string) {
    slugSchema.parse(slug);
    return withStoryLock(this.root, slug, "duplicate art direction preset", async () => {
      const preset = await duplicatePreset(this.root, slug, presetId, newName);
      return { preset, artDirection: await loadStoryArtDirection(this.root, slug) };
    });
  }

  async setDefaultArtDirectionPreset(slug: string, presetId: string) {
    slugSchema.parse(slug);
    return withStoryLock(this.root, slug, "set default art direction preset", async () => {
      await setDefaultPreset(this.root, slug, presetId);
      return loadStoryArtDirection(this.root, slug);
    });
  }

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
      const { provider } = await this.registry.resolve(manifest.origin.url, manifest.type); const directory = await this.registry.inspect(provider, manifest.origin.url, { refresh: true });
      const activeProvider = this.registry.novelProviderIdForUrl(manifest.origin.url);
      const providerDirectory = activeProvider
        ? manifest.remote.directory.filter((item) => (item.metadata.provider ?? this.registry.novelProviderIdForUrl(String(item.metadata.sourceUrl ?? "")) ?? activeProvider) === activeProvider)
        : manifest.remote.directory;
      const providerManifest = { ...manifest, remote: { ...manifest.remote, chapterCountAtInspection: providerDirectory.length, directory: providerDirectory } };
      const comparison = compareRemoteDirectory(providerManifest, directory);
      let imported: number[] = [];
      if (importNew && comparison.added.length) {
        if (comparison.removed.length || comparison.reordered.length) throw new SourceConflictError("Cannot import automatically because existing chapters were removed or reordered");
        const inspection = await this.registry.inspect(provider, manifest.origin.url, { chapters: comparison.added.map((item) => item.chapter) }); const result = await importSource(this.root, slug, inspection); imported = result.added;
      }
      return { ...comparison, previousImportedCount: manifest.chapters.length, imported };
    });
  }

  async close() { clearInterval(this.inspectionTimer); await this.jobs.flushDurable(); await Promise.all([...this.inspections.keys()].map((id) => this.discardInspection(id))); }
  private expireInspections() { const cutoff = Date.now() - 30 * 60_000; for (const [id, record] of this.inspections) if (record.createdAt < cutoff) void this.discardInspection(id).catch((error) => logger.warn({ event: "web.inspection.cleanup_failed", inspectionId: id, error: error instanceof Error ? error.message : String(error) })); }
  private async discardInspection(id: string) {
    const record = this.inspections.get(id); if (!record) return;
    this.inspections.delete(id); this.inspectionBytes = Math.max(0, this.inspectionBytes - record.bytes);
    if (record.temporaryDirectory) await rm(record.temporaryDirectory, { recursive: true, force: true });
  }
}

function supportsBulk(provider: StorySourceProvider) { const capabilities = (provider as unknown as { capabilities?: { acquisition?: string[] } }).capabilities; return capabilities?.acquisition?.includes("bulk-download") === true; }
function sameLanguage(left: string, right: string) { return left.trim().toLowerCase().replaceAll("_", "-") === right.trim().toLowerCase().replaceAll("_", "-"); }
function defaultLocale(language: string) { const value = language.trim(); if (/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)) return value; return ({ english: "en-US", chinese: "zh-CN", spanish: "es-ES", french: "fr-FR", german: "de-DE", japanese: "ja-JP", korean: "ko-KR", portuguese: "pt-BR", italian: "it-IT", russian: "ru-RU" } as Record<string, string>)[value.toLocaleLowerCase()] ?? "en-US"; }

function batchStopAfter(force?: z.infer<typeof batchInputSchema>["force"]): StageName | undefined {
  if (!force || force === "all") return undefined;
  return force === "story-bible" ? "storyBible" : force === "audio" ? "audioMastering" : force;
}

async function sourceUpdatePreview(sourceRoot: string, previous: SourceManifest, inspection: SourceInspection) {
  const before = new Map<number, string>();
  for (const item of previous.chapters) {
    const text = await readFile(resolve(sourceRoot, item.file), "utf8");
    before.set(item.chapter, item.contentFingerprint ?? importedChapterContentFingerprint(text));
  }
  const incoming = inspection.chapters.map((item) => {
    const text = item.text.endsWith("\n") ? item.text : `${item.text}\n`;
    return { chapter: item.ref.chapter, fingerprint: importedChapterContentFingerprint(text) };
  });
  const added = incoming.filter((item) => !before.has(item.chapter)).map((item) => item.chapter);
  const replaced = incoming.filter((item) => before.has(item.chapter) && before.get(item.chapter) !== item.fingerprint).map((item) => item.chapter);
  const unchanged = incoming.filter((item) => before.get(item.chapter) === item.fingerprint).map((item) => item.chapter);
  const incomingNumbers = new Set(incoming.map((item) => item.chapter));
  const preserved = previous.chapters.map((item) => item.chapter).filter((chapter) => !incomingNumbers.has(chapter));
  const after = [...new Set([...before.keys(), ...incomingNumbers])].sort((a, b) => a - b);
  const gaps = findChapterGaps(after, 200);
  return {
    existingCount: previous.chapters.length, afterCount: after.length, added, replaced, unchanged,
    preservedCount: preserved.length, missingCount: gaps.total, missingChapters: gaps.missing, missingSummary: gaps.summary,
    minimumChapter: after[0], maximumChapter: after.at(-1),
  };
}

async function readFileSafe(path: string) { try { return await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
function validationStatusFromMessage(message: string) { for (const status of ["TRUNCATED", "LOCKED", "CHALLENGE_REQUIRED", "BLOCKED", "INVALID"] as const) if (message.includes(status)) return status; return "INVALID"; }
function numberFromMessage(message: string) { const match = /Chapter\s+(\d+)/i.exec(message); return match ? Number(match[1]) : undefined; }
