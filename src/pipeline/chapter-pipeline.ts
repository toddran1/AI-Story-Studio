import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Chapter, StageName, StageState, chapterSchema } from "../domain/chapter.js";
import { ttsQualityMode, ttsSynthesisSettings } from "../domain/provider.js";
import { Story } from "../domain/story.js";
import { StoryBibleUpdate, storyBibleUpdateSchema, storyBibleSchema } from "../domain/story-bible.js";
import { activeQaIssues, QaResult, QaState, qaResultSchema } from "../domain/qa.js";
import { LLMRouter } from "../llm/router.js";
import { TTSProvider } from "../tts/provider.js";
import { pronunciationProvider, pronunciationFingerprint, resolvePronunciations } from "../tts/pronunciation.js";
import { enrichStoryPronunciations } from "../story-bible/pronunciation.js";
import { TTSProviderRouter } from "../tts/router.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { readJsonIfExists, readTextIfExists } from "../storage/story-files.js";
import { storyPaths } from "../storage/paths.js";
import { fingerprint } from "../utils/hash.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { logger } from "../utils/logger.js";
import { TRANSLATION_FINGERPRINT_VERSION, TRANSLATION_PROMPT_VERSION } from "../translation/prompts.js";
import { translate } from "../translation/translator.js";
import { NARRATION_PROMPT_VERSION } from "../narration/prompts.js";
import { polishNarration } from "../narration/narration-editor.js";
import { narrationDeliveryProfile, stripDeliveryCues } from "../narration/tts-direction.js";
import { STORY_BIBLE_PROMPT_VERSION } from "../story-bible/prompts.js";
import { extractStoryBible } from "../story-bible/extractor.js";
import { QA_PROMPT_VERSION } from "../qa/prompts.js";
import { computeQaDependencyFingerprint, computeQaDependencyFingerprints, qaDependencySnapshot, loadQaDeterministicDependencies, resolveStoredQaContext } from "../qa/freshness.js";
import { validateChapterQuality } from "../qa/validator.js";
import { buildQaState, prepareQaDetections } from "../qa/review.js";
import { runDeterministicQaChecks } from "../qa/deterministic.js";
import { exceptionsPromptSection, filterExceptedFindings, listQaExceptions } from "../qa/exceptions.js";
import { mergeStoryBible, normalizeStoryBibleUpdate } from "../story-bible/updater.js";
import { backfillCanonicalSnapshots, loadStoryBibleWithCanonicalOverlay } from "../story-bible/canonical.js";
import { rebuildStoryBibleBeforeChapter } from "../story-bible/rebuild.js";
import { PipelineError, QualityGateError } from "./errors.js";
import { AudioMasteringProcessor, FfmpegMasteringProcessor } from "../audio/mastering.js";
import { masterStoredChapter } from "../audio/chapter-audio.js";
import { retrieveRelevantContext } from "../story-bible/retrieval.js";
import { analyzeAndPersistContinuity } from "../story-bible/continuity.js";
import { withUsageScope } from "../cost/context.js";
import { loadNarrationNamingEntities, selectNarrationNamingEntities } from "../story-bible/narration-names.js";
import { loadEligibleSummaryContext } from "../summaries/service.js";
import { CENSOR_AUDIO_VERSION, CensorAudioService, FfmpegCensorAudioService, censorToneConfig } from "../tts/censor-audio.js";
import { SpeechTranscriber, summarizeQuality, type TtsQualityProgress } from "../tts/quality-guard.js";
import { persistChapterTtsQuality, removeChapterTtsQuality } from "../tts/chapter-quality.js";
import { createEffectiveTtsProvider } from "../tts/effective-provider.js";
import { normalizeSpeechForProvider } from "../tts/speech-normalization.js";
import { manualAcceptanceFingerprint } from "../studio/stage-acceptance.js";
import { StageExecutionNode, dependentProcessingStages } from "../studio/stage-execution.js";
import { persistQaStateWithMetadata } from "../qa/persistence.js";

export type ForceStage = "translation" | "narration" | "qa" | "story-bible" | "continuity" | "tts" | "audio" | "all";
export type PipelineStageEvent = { stage: StageName; status: "started" | "progress" | "completed" | "reused"; state: StageState; detail?: string; currentChunk?: number; totalChunks?: number };
export type PipelineOptions = {
  root: string; story: Story; chapter: number; inputPath: string; force?: ForceStage;
  stopAfter?: StageName;
  source?: Chapter["source"];
  productionRunId?: string; queueJobId?: string;
  onStageEvent?: (event: PipelineStageEvent) => void;
  /** A dependency-aware manual execution plan. Omitted for normal production. */
  executionStages?: StageExecutionNode[];
  /** Internal guard: one automatic recovery per chapter invocation. */
  qaRecoveryAttempted?: boolean;
};

const pending = (): StageState => ({ status: "pending" });

export class ChapterPipeline {
  private readonly tts: TTSProviderRouter;
  constructor(private readonly llms: LLMRouter, tts: TTSProviderRouter | TTSProvider, private readonly audio: AudioMasteringProcessor = new FfmpegMasteringProcessor(), private readonly censor: CensorAudioService = new FfmpegCensorAudioService(), private readonly qualityVerification?: { transcriber?: SpeechTranscriber }) { this.tts = tts instanceof TTSProviderRouter ? tts : new TTSProviderRouter(tts); }

  async run(options: PipelineOptions): Promise<Chapter> {
    const paths = storyPaths(options.root, options.story.slug, options.chapter);
    const executionStages = options.executionStages ? new Set(options.executionStages) : undefined;
    const shouldRun = (stage: StageExecutionNode) => !executionStages || executionStages.has(stage);
    await mkdir(paths.chapterDir, { recursive: true });
    const now = new Date().toISOString();
    let chapter = chapterSchema.parse((await readJsonIfExists<Chapter>(paths.chapterMeta)) ?? {
      chapter: options.chapter, sourceLanguage: options.story.sourceLanguage, outputLanguage: options.story.outputLanguage,
      counts: { originalCharacters: 0, englishWords: 0, narrationWords: 0 }, createdAt: now, updatedAt: now,
      stages: { ingestion: pending(), translation: pending(), narration: pending(), qa: pending(), storyBible: pending(), continuity: pending(), tts: pending(), audioMastering: pending(), alignment: pending(), subtitles: pending(), scenePlanning: pending(), artwork: pending(), video: pending() },
    });
    if (chapter.chapter !== options.chapter) throw new PipelineError(`Chapter metadata mismatch at ${paths.chapterMeta}: expected ${options.chapter}, found ${chapter.chapter}`);
    chapter.sourceLanguage = options.story.sourceLanguage; chapter.outputLanguage = options.story.outputLanguage;
    if (options.source) {
      chapter.source = options.source;
      chapter.originalTitle = options.source.originalTitle;
    }
    const source = await readFile(options.inputPath, "utf8");
    if (!source.trim()) throw new PipelineError(`Input file is empty: ${options.inputPath}`);
    const savedBible = await readJsonIfExists(paths.bible);
    if (savedBible) await backfillCanonicalSnapshots(options.root, options.story.slug, storyBibleSchema.parse(savedBible));
    let bible = await rebuildStoryBibleBeforeChapter(options.root, options.story.slug, options.chapter);
    const eligibleSummaries = await loadEligibleSummaryContext(options.root, options.story.slug, options.chapter, source);
    const baseTranslationContext = retrieveRelevantContext(bible, source, options.chapter, { recentSummaryCount: options.story.context.recentChapterSummaries });
    const translationContext = eligibleSummaries.length ? { ...baseTranslationContext, eligibleSummaries } : baseTranslationContext;
    const narrationNamingEntities = await loadNarrationNamingEntities(options.root, options.story.slug);
    const basePriorContext = retrieveRelevantContext(bible, source, options.chapter, { recentSummaryCount: options.story.context.recentChapterSummaries, narrationNamingEntities });
    const priorContext = eligibleSummaries.length ? { ...basePriorContext, eligibleSummaries } : basePriorContext;
    // A selected-only run may use an existing stale context. Do not rewrite it
    // merely because it was read as part of a later-stage invocation.
    if (shouldRun("context")) await atomicWriteJson(paths.storyContext, priorContext);

    const persist = async () => { chapter.updatedAt = new Date().toISOString(); await atomicWriteJson(paths.chapterMeta, chapter); };
    if (options.source) await persist();
    const runStage = async <T>(stage: StageName, fp: string, outputPath: string, details: Partial<StageState>, action: () => Promise<T>): Promise<T | undefined> => {
      const state = chapter.stages[stage];
      if (!shouldRun(stage)) return undefined;
      const forced = Boolean(executionStages?.has(stage)) || isForced(options.force, stage);
      const currentOutputFingerprint = await fileFingerprint(outputPath);
      if (!forced && !state.staleReason && state.status === "complete" && state.manualAcceptance && currentOutputFingerprint && state.outputFingerprint === currentOutputFingerprint && state.manualAcceptance.acceptedFingerprint === manualAcceptanceFingerprint(stage, currentOutputFingerprint, options.story)) {
        logger.info({ event: "pipeline.stage.reused_manual_acceptance", story: options.story.slug, chapter: options.chapter, stage });
        options.onStageEvent?.({ stage, status: "reused", state });
        return undefined;
      }
      if (!forced && !state.staleReason && state.status === "complete" && state.provider === "manual" && currentOutputFingerprint && state.outputFingerprint === currentOutputFingerprint) {
        logger.info({ event: "pipeline.stage.reused_manual", story: options.story.slug, chapter: options.chapter, stage });
        options.onStageEvent?.({ stage, status: "reused", state });
        return undefined;
      }
      if (!forced && !state.staleReason && state.status === "complete" && state.fingerprint === fp && currentOutputFingerprint && (!state.outputFingerprint || state.outputFingerprint === currentOutputFingerprint)) {
        if (!state.outputFingerprint) { state.outputFingerprint = currentOutputFingerprint; await persist(); }
        logger.info({ event: "pipeline.stage.reused", story: options.story.slug, chapter: options.chapter, stage });
        options.onStageEvent?.({ stage, status: "reused", state });
        return undefined;
      }
      const started = Date.now();
      if (stage === "qa") await resetChapterQaForExecution(paths.qa, chapter);
      if (stage !== "qa") invalidateDownstream(chapter, stage);
      chapter.stages[stage] = { ...details, status: "running", fingerprint: fp, startedAt: new Date().toISOString() };
      await persist();
      options.onStageEvent?.({ stage, status: "started", state: chapter.stages[stage], detail: stage === "audioMastering" ? "Mastering audio…" : undefined });
      logger.info({ event: "pipeline.stage.started", story: options.story.slug, chapter: options.chapter, stage, provider: details.provider, model: details.model });
      try {
        const value = await withUsageScope({ story: options.story.slug, chapter: options.chapter, productionRunId: options.productionRunId, queueJobId: options.queueJobId, stage }, action);
        if (stage === "qa") {
          const qaState = value as QaState;
          chapter.quality = { status: qaState.status, score: qaState.score, issueCategories: [...new Set(activeQaIssues(qaState).map((issue) => issue.category))] };
        }
        const producedFingerprint = await fileFingerprint(outputPath);
        // QA writes its artifact and chapter summary together. The QA action
        // returns the state instead of writing qa.json itself, so a metadata
        // failure cannot leave a new QA artifact paired with old chapter data.
        if (stage === "qa") {
          const qaState = value as QaState;
          chapter.stages[stage] = { ...chapter.stages[stage], status: "complete", completedAt: new Date().toISOString(), durationMs: Date.now() - started, error: undefined };
          const committed = await persistQaStateWithMetadata(paths, qaState, chapter, (outputFingerprint, previous) => ({
            ...previous,
            updatedAt: new Date().toISOString(),
            stages: { ...previous.stages, qa: { ...previous.stages.qa, outputFingerprint } },
          }));
          chapter = committed.metadata;
          options.onStageEvent?.({ stage, status: "completed", state: chapter.stages[stage] });
          logger.info({ event: "pipeline.stage.completed", story: options.story.slug, chapter: options.chapter, stage, provider: details.provider, model: details.model, durationMs: Date.now() - started });
          return value;
        }
        if (!producedFingerprint) throw new Error(`Stage '${stage}' did not produce a non-empty output at ${outputPath}`);
        chapter.stages[stage] = { ...chapter.stages[stage], status: "complete", outputFingerprint: producedFingerprint, completedAt: new Date().toISOString(), durationMs: Date.now() - started, error: undefined };
        await persist();
        options.onStageEvent?.({ stage, status: "completed", state: chapter.stages[stage], detail: stage === "tts" ? `Audio generated · Fish requests: ${chapter.stages.tts.usage?.requests ?? 0} · Automatic retries: ${ttsQualityMode(options.story.pipeline.tts) === "auto_repair" ? "enabled" : "off"}` : stage === "audioMastering" ? "Audio complete" : undefined });
        logger.info({ event: "pipeline.stage.completed", story: options.story.slug, chapter: options.chapter, stage, provider: details.provider, model: details.model, durationMs: Date.now() - started });
        return value;
      } catch (error) {
        chapter.stages[stage] = { ...chapter.stages[stage], status: "failed", durationMs: Date.now() - started,
          error: { message: error instanceof Error ? error.message : String(error), cause: error instanceof Error && error.cause ? String(error.cause) : undefined } };
        await persist();
        throw new PipelineError(`Story=${options.story.slug} Chapter=${options.chapter} Stage=${stage} Provider=${details.provider ?? "local"} Model=${details.model ?? "n/a"}: ${chapter.stages[stage].error?.message}`, { cause: error });
      }
    };

    const ingestionFp = fingerprint({ source, sourceLanguage: options.story.sourceLanguage, outputLanguage: options.story.outputLanguage });
    await runStage("ingestion", ingestionFp, paths.original, {}, async () => {
      await atomicWrite(paths.original, source);
      chapter.counts.originalCharacters = [...source].length;
    });

    const translationConfig = options.story.pipeline.translation;
    const passthroughTranslation = sameLanguage(options.story.sourceLanguage, options.story.outputLanguage);
    const translationFp = fingerprint({ source: ingestionFp, config: passthroughTranslation ? "passthrough" : translationConfig, prompt: passthroughTranslation ? "passthrough-v1" : TRANSLATION_FINGERPRINT_VERSION, context: translationContext });
    const translationResult = await runStage("translation", translationFp, paths.english, {
      provider: passthroughTranslation ? "passthrough" : translationConfig.provider,
      model: passthroughTranslation ? undefined : translationConfig.model,
      promptVersion: passthroughTranslation ? "passthrough-v1" : TRANSLATION_PROMPT_VERSION,
    }, async () => {
      if (passthroughTranslation) {
        await atomicWrite(paths.english, source);
        chapter.counts.englishWords = wordCount(source);
        return source;
      }
      const provider = this.llms.forStage(translationConfig);
      const result = await translate(provider, translationConfig, source, translationContext, options.story.sourceLanguage, options.story.outputLanguage);
      await atomicWrite(paths.english, result.text);
      chapter.counts.englishWords = wordCount(result.text);
      chapter.stages.translation.usage = result.usage;
      return result.text;
    });
    let english = translationResult ?? await requireText(paths.english, "translation");
    if (options.stopAfter === "translation") { await persist(); return chapter; }

    const narrationContext = {
      ...retrieveRelevantContext(bible, `${source}\n${english}`, options.chapter, { recentSummaryCount: options.story.context.recentChapterSummaries, narrationNamingEntities }),
      narrationNamingEntities: selectNarrationNamingEntities(narrationNamingEntities, `${source}\n${english}`, options.chapter),
      ...(eligibleSummaries.length ? { eligibleSummaries } : {}),
    };

    const narrationConfig = options.story.pipeline.narration;
    const ttsConfig = options.story.pipeline.tts;
    const deliveryProfile = narrationDeliveryProfile(ttsConfig.provider, ttsConfig.model);
    const narrationBehavior = { profanityMode: options.story.narrationSettings.profanityMode, includeChapterTitle: options.story.narrationSettings.includeChapterTitle };
    const narrationFp = fingerprint({ english: fingerprint(english), context: narrationContext, config: narrationConfig, narrationSettings: narrationBehavior, deliveryProfile, deliveryIntensity: ttsConfig.deliveryIntensity, prompt: NARRATION_PROMPT_VERSION });
    const narrationResult = await runStage("narration", narrationFp, paths.narration, {
      provider: narrationConfig.provider, model: narrationConfig.model, promptVersion: NARRATION_PROMPT_VERSION,
    }, async () => {
      const result = await polishNarration(this.llms.forStage(narrationConfig), narrationConfig, english, options.story.outputLanguage, narrationContext, ttsConfig.provider, ttsConfig.model, options.story.narrationSettings.profanityMode, ttsConfig.deliveryIntensity, options.story.narrationSettings.includeChapterTitle !== false);
      const cleanNarration = stripDeliveryCues(result.text, ttsConfig.provider, ttsConfig.model);
      if (!cleanNarration) throw new PipelineError("Narration delivery cues cannot replace the chapter's spoken narration");
      const previousNarration = await readTextIfExists(paths.narration);
      const previousNarrationTts = await readTextIfExists(paths.narrationTts);
      try {
        await atomicWrite(paths.narration, cleanNarration);
        await atomicWrite(paths.narrationTts, result.text);
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        const restore = async (path: string, content: string | undefined) => {
          try {
            if (content !== undefined) await atomicWrite(path, content);
            else await rm(path, { force: true });
          } catch (restoreError) {
            rollbackErrors.push(restoreError);
          }
        };
        await restore(paths.narration, previousNarration);
        await restore(paths.narrationTts, previousNarrationTts);
        if (rollbackErrors.length) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            "Narration pair write failed and rollback was incomplete"
          );
        }
        throw error;
      }
      chapter.counts.narrationWords = wordCount(cleanNarration);
      chapter.stages.narration.usage = result.usage;
      return cleanNarration;
    });
    let narration = narrationResult ?? await requireText(paths.narration, "narration");
    if (options.stopAfter === "narration") { await persist(); return chapter; }

    const qaConfig = options.story.pipeline.qa;
    const qaDeterministicDeps = await loadQaDeterministicDependencies(options.root, options.story.slug);
    const qaContext = await resolveStoredQaContext({ storyContext: paths.storyContext, chapter: options.chapter });
    const qaFp = computeQaDependencyFingerprint({
      source: ingestionFp, translation: fingerprint(english), narration: fingerprint(narration),
      context: qaContext.raw, config: qaConfig, narrationSettings: narrationBehavior, prompt: QA_PROMPT_VERSION, mode: options.story.qaMode,
      ...qaDeterministicDeps,
    });
    const qaResult = await runStage("qa", qaFp, paths.qa, {
      provider: qaConfig.provider, model: qaConfig.model, promptVersion: QA_PROMPT_VERSION,
    }, async () => {
      const [deterministic, exceptions] = await Promise.all([
        runDeterministicQaChecks({ root: options.root, story: options.story, chapter: options.chapter, source, translation: english, narration }),
        listQaExceptions(options.root, options.story.slug),
      ]);
      const result = await validateChapterQuality(this.llms.forStage(qaConfig), qaConfig, {
        chapter: options.chapter, sourceLanguage: options.story.sourceLanguage, outputLanguage: options.story.outputLanguage,
        source, translation: english, narration, context: qaContext.parsed, authorizedNarrationEntities: narrationNamingEntities, profanityMode: options.story.narrationSettings.profanityMode, includeChapterTitle: options.story.narrationSettings.includeChapterTitle !== false,
        exceptionsContext: exceptionsPromptSection(exceptions), mode: options.story.qaMode,
      });
      const effectiveNamingEntities = (await loadStoryBibleWithCanonicalOverlay(options.root, options.story.slug)).canonicalEntities;
      const detections = prepareQaDetections([...deterministic.detections, ...result.value.issues], { canonicalEntities: qaContext.parsed.canonicalEntities, effectiveNamingEntities, translation: english, narration });
      const { state } = buildQaState(undefined, filterExceptedFindings(detections, exceptions), {
        chapter: options.chapter, canonicalEntities: qaContext.parsed.canonicalEntities, effectiveNamingEntities, translation: english, narration,
        baseScore: { score: result.value.score, originalScore: result.value.originalScore, status: result.value.status, originalStatus: result.value.originalStatus },
        mode: options.story.qaMode,
        acceptedContinuity: deterministic.acceptedContinuity,
        dependencyFingerprint: qaFp,
        dependencySnapshot: qaDependencySnapshot(computeQaDependencyFingerprints({
          source: ingestionFp, translation: fingerprint(english), narration: fingerprint(narration), context: qaContext.raw,
          config: qaConfig, narrationSettings: narrationBehavior, prompt: QA_PROMPT_VERSION, mode: options.story.qaMode, ...qaDeterministicDeps,
        })),
      });
      chapter.stages.qa.usage = result.usage;
      return state;
    });
    if (shouldRun("qa")) {
      let quality = qaResult ?? qaResultSchema.parse(await readJsonIfExists<QaResult>(paths.qa));
      // Legacy/reused QA artifacts may predate the chapter-level summary.
      const expectedQuality = { status: quality.status, score: quality.score, issueCategories: [...new Set(activeQaIssues(quality).map((issue) => issue.category))] };
      if (JSON.stringify(chapter.quality) !== JSON.stringify(expectedQuality)) { chapter.quality = expectedQuality; await persist(); }
      if (qaResult && !options.qaRecoveryAttempted) {
        const issueCount = activeQaIssues(quality).filter((issue) => issue.severity === "warn" || issue.severity === "fail").length;
        if (issueCount > 4) {
          logger.info({ event: "pipeline.qa.auto_recovery", story: options.story.slug, chapter: options.chapter, issueCount, threshold: 4,
            detail: `QA found ${issueCount} issues. Regenerating Translation, Narration, and QA once.` });
          const [savedEnglish, savedNarration, savedNarrationTts, savedQa] = await Promise.all([
            readTextIfExists(paths.english),
            readTextIfExists(paths.narration),
            readTextIfExists(paths.narrationTts),
            readTextIfExists(paths.qa),
          ]);
          const previousChapterSnapshot = structuredClone(chapter);
          const recoveryStages: StageExecutionNode[] = ["translation", "narration", "qa"];
          try {
            const recoveredChapter = await this.run({
              ...options,
              executionStages: recoveryStages,
              force: "translation",
              stopAfter: "qa",
              qaRecoveryAttempted: true,
            });
            chapter = recoveredChapter;
            english = await requireText(paths.english, "translation");
            narration = await requireText(paths.narration, "narration");
            quality = qaResultSchema.parse(await readJsonIfExists<QaResult>(paths.qa));
          } catch (recoveryError) {
            if (recoveryError instanceof QualityGateError) throw recoveryError;
            logger.warn({ event: "pipeline.qa.auto_recovery_failed", story: options.story.slug, chapter: options.chapter,
              err: recoveryError instanceof Error ? recoveryError.message : String(recoveryError) }, "QA auto-recovery failed; restoring prior stage artifacts and metadata");
            const rollbackErrors: unknown[] = [];
            const restoreFile = async (path: string, content: string | undefined) => {
              try {
                if (content !== undefined) await atomicWrite(path, content);
                else await rm(path, { force: true });
              } catch (fileError) {
                rollbackErrors.push(fileError);
              }
            };
            await restoreFile(paths.english, savedEnglish);
            await restoreFile(paths.narration, savedNarration);
            await restoreFile(paths.narrationTts, savedNarrationTts);
            await restoreFile(paths.qa, savedQa);

            chapter = structuredClone(previousChapterSnapshot);
            chapter.stages.qa = {
              ...previousChapterSnapshot.stages.qa,
              status: "failed",
              error: {
                message: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
                cause: recoveryError instanceof Error && recoveryError.cause ? String(recoveryError.cause) : undefined,
              },
            };
            chapter.quality = previousChapterSnapshot.quality;
            try {
              await persist();
            } catch (persistError) {
              rollbackErrors.push(persistError);
            }

            if (rollbackErrors.length) {
              const aggregate = new AggregateError([recoveryError, ...rollbackErrors],
                `QA auto-recovery failed and artifact/metadata rollback encountered ${rollbackErrors.length} failure(s)`);
              logger.error({ event: "pipeline.qa.auto_recovery_rollback_failed", story: options.story.slug, chapter: options.chapter,
                err: aggregate.message, rollbackErrors: rollbackErrors.map((err) => err instanceof Error ? err.message : String(err)) });
              throw aggregate;
            }
            throw recoveryError;
          }
        }
      }
      if (quality.status === "warn") logger.warn({ event: "pipeline.qa.warn", story: options.story.slug, chapter: options.chapter, score: quality.score, issues: quality.issues.length });
      if (quality.status === "fail") {
        chapter.stages.storyBible = pending();
        chapter.stages.continuity = pending();
        chapter.stages.tts = pending();
        await persist();
        // QA failure must not replace the last known-good canonical snapshot with
        // the pre-chapter context. The rejected chapter can be retried later.
        // The gate diagnostic must carry only active open findings, never resolved history.
        throw new QualityGateError(`Chapter ${options.chapter} failed QA`, { ...quality, issues: activeQaIssues(quality) }, { dependencyFingerprint: qaFp });
      }
    }
    const hasRemainingCoreStages = executionStages
      ? ["storyBible", "continuity", "tts", "audioMastering"].some((stage) => executionStages.has(stage as StageExecutionNode))
      : true;
    if (options.stopAfter === "qa" || !hasRemainingCoreStages) { await persist(); return chapter; }

    const bibleConfig = options.story.pipeline.storyBible;
    const bibleFp = fingerprint({ narration: fingerprint(narration), config: bibleConfig, prompt: STORY_BIBLE_PROMPT_VERSION, context: priorContext });
    const persistFullBible = async (update: StoryBibleUpdate) => {
      // A rerun of an early chapter starts with only its prior context. Never let
      // that partial context replace the cumulative Story Bible snapshot.
      bible = mergeStoryBible(bible, update, options.chapter);
      const cumulative = await rebuildStoryBibleBeforeChapter(options.root, options.story.slug, Number.MAX_SAFE_INTEGER, { chapterOverride: { chapter: options.chapter, update } });
      await atomicWriteJson(paths.bible, cumulative);
    };
    const bibleResult = await runStage("storyBible", bibleFp, paths.bibleUpdate, {
      provider: bibleConfig.provider, model: bibleConfig.model, promptVersion: STORY_BIBLE_PROMPT_VERSION,
    }, async () => {
      const result = await extractStoryBible(this.llms.forStage(bibleConfig), bibleConfig, options.chapter, narration, priorContext);
      const update = normalizeStoryBibleUpdate(storyBibleUpdateSchema.parse(result.value), options.chapter);
      await atomicWriteJson(paths.bibleUpdate, update);
      await persistFullBible(update);
      chapter.stages.storyBible.usage = result.usage;
      return bible;
    });
    if (bibleResult) bible = bibleResult;
    else {
      const cachedUpdate = storyBibleUpdateSchema.parse(await readJsonIfExists<StoryBibleUpdate>(paths.bibleUpdate));
      // Continuity and TTS need this chapter's cumulative Bible in memory, but
      // selected-only mode must not modify reused Story Bible artifacts.
      if (shouldRun("storyBible")) await persistFullBible(cachedUpdate);
      else bible = mergeStoryBible(bible, cachedUpdate, options.chapter);
    }
    if (options.stopAfter === "storyBible") { await persist(); return chapter; }

    const continuityFp = fingerprint({ bible: bible.version, entities: bible.canonicalEntities, relationships: bible.canonicalRelationships, timeline: bible.entityTimeline });
    await runStage("continuity", continuityFp, paths.continuityAnalysis, { provider: "local", model: "deterministic-continuity-v1" }, async () => analyzeAndPersistContinuity(options.root, options.story.slug, bible, options.chapter));
    if (options.stopAfter === "continuity") { await persist(); return chapter; }

    // A visual/manual stage can rely on existing audio without invoking Fish or
    // rebuilding an unrelated core prefix.
    if (executionStages && !shouldRun("tts") && !shouldRun("audioMastering")) { await persist(); return chapter; }

    // Reader-facing narration remains clean for QA, subtitles, Story Bible, and
    // scene planning. Only Fish receives the model-specific delivery script.
    const ttsScript = (await readTextIfExists(paths.narrationTts))?.trim() || narration;
    // A blank per-story voice intentionally inherits the environment default. Include
    // the resolved value in the fingerprint so a changed default cannot reuse audio
    // generated with a different voice.
    const pronunciationData = await withUsageScope({ story: options.story.slug, chapter: options.chapter, stage: "pronunciation" }, () => enrichStoryPronunciations(options.root, options.story.slug, bible, this.llms.forStage(bibleConfig), bibleConfig, options.story.sourceLanguage, undefined, false, false,
      (progress) => { if (progress.total > 0) options.onStageEvent?.({ stage: "tts", status: "started", state: chapter.stages.tts, detail: `Enriching pronunciations ${progress.processed}/${progress.total}` }); }));
    const qualityMode = ttsQualityMode(ttsConfig);
    const onQualityProgress = (progress: TtsQualityProgress) => {
      if (qualityMode === "off") return;
      const detail = progress.phase === "retry"
        ? `Retrying audio · Chunk ${progress.currentChunk} of ${progress.totalChunks} · Attempt ${progress.attempt ?? 2}${progress.status === "completed" ? " · completed" : ""}`
        : `Checking audio quality · Chunk ${progress.currentChunk} of ${progress.totalChunks} · Quality mode: ${qualityMode === "auto_repair" ? "Auto repair" : "Verify only · Automatic retries: off"}${progress.status === "completed" ? " · completed" : ""}`;
      options.onStageEvent?.({
        stage: "tts",
        status: "progress",
        state: chapter.stages.tts,
        currentChunk: progress.currentChunk,
        totalChunks: progress.totalChunks,
        detail,
      });
    };
    const { provider: ttsProvider, basePronunciationProvider: baseTtsProvider } = createEffectiveTtsProvider({
      baseProvider: this.tts.forName(ttsConfig.provider),
      pronunciationEntities: pronunciationData.entities,
      qualityMode,
      maxQualityRetries: ttsConfig.maxQualityRetries,
      language: options.story.outputLanguage,
      transcriber: this.qualityVerification?.transcriber,
      onQualityProgress,
    });
    const speech = normalizeSpeechForProvider(ttsScript, options.story.outputLanguage, options.story.narrationSettings, ttsProvider, ttsConfig.model);
    const pronunciationFp = pronunciationFingerprint(resolvePronunciations(speech.normalized.text, pronunciationData.entities));
    const referenceId = ttsProvider.resolveReferenceId?.(ttsConfig.referenceId) ?? ttsConfig.referenceId;
    const bleepStrongProfanity = options.story.narrationSettings.bleepStrongProfanity === true;
    // Verification-policy settings change whether verification runs, not what is
    // synthesized, so they stay out of the synthesis fingerprint: toggling the
    // guard never invalidates existing audio. maxCharsPerRequest stays in.
    const ttsFp = fingerprint({ narration: fingerprint(ttsScript), speech: speech.fingerprint, config: { ...ttsSynthesisSettings(ttsConfig), referenceId }, deliveryProfile, inputNormalizationVersion: ttsProvider.inputNormalizationVersion,
      ...(pronunciationFp ? { pronunciation: pronunciationFp } : {}),
      ...(bleepStrongProfanity ? { bleepStrongProfanity: true, censor: { version: this.censor.version || CENSOR_AUDIO_VERSION, config: censorToneConfig } } : {}) });
    await runStage("tts", ttsFp, paths.audioRaw, { provider: ttsConfig.provider, model: ttsConfig.model }, async () => {
      const result = await this.censor.synthesize(ttsProvider, { text: speech.normalized.text, model: ttsConfig.model, referenceId, secondaryReferenceId: ttsConfig.secondaryReferenceId,
        voiceMode: ttsConfig.voiceMode, deliveryIntensity: ttsConfig.deliveryIntensity, qualityGuard: qualityMode !== "off", providerQualityGuard: ttsConfig.providerQualityGuard, bleepStrongProfanity,
        onChunkProgress: ({ currentChunk, totalChunks, status }) => options.onStageEvent?.({ stage: "tts", status: "progress", state: chapter.stages.tts, currentChunk, totalChunks, detail: `Generating audio · Chunk ${currentChunk} of ${totalChunks} · Fish ${ttsConfig.model} · Automatic retries: ${qualityMode === "auto_repair" ? "on" : "off"}${status === "completed" ? " · completed" : ""}` }),
        onQualityProgress,
        speed: ttsConfig.speed, format: ttsConfig.format, sampleRate: ttsConfig.sampleRate, bitrate: ttsConfig.bitrate,
        normalize: ttsConfig.normalize, maxCharsPerRequest: ttsConfig.maxCharsPerRequest });
      await atomicWrite(paths.audioRaw, result.audio);
      await rm(paths.segments, { recursive: true, force: true });
      if (!result.assembled) {
        await mkdir(paths.segments, { recursive: true });
        await Promise.all(result.segments.map((segment, index) => atomicWrite(join(paths.segments, `${String(index + 1).padStart(4, "0")}.mp3`), segment)));
      }
      chapter.stages.tts.usage = {
        requestId: result.requestIds?.join(","), requests: result.providerRequests ?? (result.censor ? Math.max(0, result.segments.length - result.censor.segments) : result.segments.length),
        chunks: result.assembled ? (result.providerRequests ?? 0) : result.segments.length,
        characters: result.generatedCharacters ?? [...speech.normalized.text].length, bytes: result.audio.byteLength,
        censoredSegments: result.censor?.segments, censorDurationSeconds: result.censor?.durationSeconds,
      };
      if (result.quality) {
        const summary = summarizeQuality(result.quality.segments);
        chapter.stages.tts.usage.quality = { status: summary.status, segments: result.quality.segments.length, needsReview: summary.needsReview, retried: summary.retried, manuallyAccepted: summary.manuallyAccepted };
        await persistChapterTtsQuality({ root: options.root, story: options.story, chapter: options.chapter, report: result.quality, maxRetries: ttsConfig.maxQualityRetries, transcriber: this.qualityVerification?.transcriber?.name ?? "unavailable" });
      } else if (!result.assembled && result.segmentTexts?.length === result.segments.length) {
        // Keep the exact text sent for each saved chunk so manual verification can
        // inspect the existing audio later without another Fish request.
        await persistChapterTtsQuality({
          root: options.root, story: options.story, chapter: options.chapter,
          report: { version: 1, status: "unverified", retried: 0, segments: result.segmentTexts.map((expectedText, index) => ({
            index, expectedText, status: "unverified", attempts: [], finalAttempt: 0, issues: [],
          })) },
          maxRetries: 0, transcriber: "not_run",
        });
      } else await removeChapterTtsQuality(options.root, options.story.slug, options.chapter);
    });
    if (options.stopAfter === "tts") { await persist(); return chapter; }

    if (!shouldRun("audioMastering")) { await persist(); return chapter; }
    const mastered = await masterStoredChapter({ root: options.root, story: options.story, chapter: options.chapter, processor: this.audio,
      force: Boolean(executionStages?.has("audioMastering")) || isForced(options.force, "audioMastering"), onEvent: (event) => options.onStageEvent?.({ stage: "audioMastering", status: event.status, state: event.state, detail: event.status === "started" ? "Mastering audio…" : event.status === "completed" ? "Audio complete" : undefined }) });
    chapter = mastered.chapter;

    return chapter;
  }
}

function isForced(force: ForceStage | undefined, stage: StageName): boolean {
  if (force === "all") return true;
  const order: StageName[] = ["ingestion", "translation", "narration", "qa", "storyBible", "continuity", "tts", "audioMastering", "alignment", "subtitles", "scenePlanning", "artwork", "video"];
  const normalized = force === "story-bible" ? "storyBible" : force;
  const stageName = normalized === "audio" ? "audioMastering" : normalized;
  if (!stageName) return false;
  if (stageName === "continuity") return stage === "continuity";
  // Forcing an upstream transform also invalidates all dependent downstream stages.
  return order.indexOf(stage) >= order.indexOf(stageName as StageName);
}

async function resetChapterQaForExecution(qaPath: string, chapter: Chapter): Promise<void> {
  await rm(qaPath, { force: true });
  chapter.quality = undefined;
  chapter.stages.qa = pending();
}

async function requireText(path: string, stage: string): Promise<string> {
  const text = await readTextIfExists(path);
  if (text === undefined) throw new PipelineError(`${stage} metadata is complete but output is missing: ${path}`);
  return text;
}

const wordCount = (text: string) => text.trim() ? text.trim().split(/\s+/).length : 0;
const sameLanguage = (source: string, output: string) => source.trim().toLowerCase().replaceAll("_", "-") === output.trim().toLowerCase().replaceAll("_", "-");
function invalidateDownstream(chapter: Chapter, stage: StageName) {
  for (const dependent of dependentProcessingStages(stage)) chapter.stages[dependent] = pending();
  if (["ingestion", "translation", "narration", "qa"].includes(stage)) chapter.quality = undefined;
}
