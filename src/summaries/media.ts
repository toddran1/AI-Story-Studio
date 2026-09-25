import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { loadStory } from "../config/load-config.js";
import { storyBibleSchema } from "../domain/story-bible.js";
import { emptyStoryBible } from "../domain/story-bible.js";
import { enrichStoryPronunciations, loadPronunciationEntities } from "../story-bible/pronunciation.js";
import { pronunciationProvider, pronunciationFingerprint, resolvePronunciations } from "../tts/pronunciation.js";
import { createEffectiveTtsProvider } from "../tts/effective-provider.js";
import { ttsSynthesisSettings } from "../domain/provider.js";
import { ttsQualityMode, ttsSynthesisSettings } from "../domain/provider.js";
import type { SpeechTranscriber } from "../tts/quality-guard.js";
import { loadNarrationNamingEntities } from "../story-bible/narration-names.js";
import { retrieveRelevantContext } from "../story-bible/retrieval.js";
import { polishNarration } from "../narration/narration-editor.js";
import { NARRATION_PROMPT_VERSION } from "../narration/prompts.js";
import { narrationDeliveryProfile, stripDeliveryCues } from "../narration/tts-direction.js";
import type { LLMRouter } from "../llm/router.js";
import type { TTSProviderRouter } from "../tts/router.js";
import { censorToneConfig, type CensorAudioService } from "../tts/censor-audio.js";
import { normalizeSpeechForProvider } from "../tts/speech-normalization.js";
import type { AudioMasteringProcessor } from "../audio/mastering.js";
import { audioMasteringFingerprint, masteringInputs, inputFingerprints } from "../audio/chapter-audio.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { fingerprint } from "../utils/hash.js";
import { SummaryService, summaryPath } from "./service.js";
import { invalidateSummaryReads } from "./read-revision.js";
import { summarySchema, type StorySummary } from "./types.js";
import { planVisualScenes } from "../scenes/planner.js";
import { normalizeProductionSceneTiming } from "../scenes/timing.js";
import { normalizeVisualContinuityChange } from "../visual-canon/continuity.js";
import { scenePacingSchema, estimateScenePacing } from "../scenes/pacing.js";
import { resolveVisualEntities } from "../scenes/identity.js";
import { bindNarrationSpans } from "../scenes/narration-spans.js";
import { productionSceneFingerprint } from "../scenes/manifest.js";
import { sceneRegenerationModeSchema as summarySceneRegenerationModeSchema, sceneRegenerationProposalSchema as summarySceneRegenerationProposalSchema, sceneVisualSnapshotSchema as summarySceneVisualSnapshotSchema, sceneVisualSnapshot as summarySceneVisualSnapshot, sceneProposalSourceFingerprint as summarySceneProposalSourceFingerprint, type SceneRegenerationProposal as SummarySceneRegenerationProposal } from "../scenes/regeneration.js";
export { summarySceneRegenerationModeSchema, summarySceneRegenerationProposalSchema, summarySceneVisualSnapshot, summarySceneProposalSourceFingerprint };
export type { SummarySceneRegenerationProposal };
import { loadStoryArtDirection } from "../visual-canon/art-direction.js";
import { resolveSummarySceneArtDirection } from "./art-direction.js";

export const summaryMediaInputSchema = z.object({ force: z.boolean().default(false) }).strict();
export const summaryScenesInputSchema = scenePacingSchema.safeExtend({ force: z.boolean().default(false) });
export const summaryNarrationEditSchema = z.union([
  z.object({ text: z.string().trim().min(1).max(1_000_000) }).strict(),
  z.object({ acceptCurrent: z.literal(true) }).strict(),
]);
export class SummarySceneProposalConflictError extends Error {}
export const summaryExportTypeSchema = z.enum(["summary", "narration", "audio"]);
export function summaryMediaPaths(root: string, story: string, id: string) {
  const record = summaryPath(root, story, id);
  const directory = record.slice(0, -5);
  return { directory, segments: join(directory, "audio-segments"), canonical: join(directory, "summary.txt"), narration: join(directory, "narration.txt"), raw: join(directory, "audio-raw.mp3"), audio: join(directory, "audio.mp3") };
}
export function summaryDownloadName(summary: StorySummary, type: z.infer<typeof summaryExportTypeSchema>) {
  const range = summary.chapterRange;
  const prefix = range ? `chapters-${range.from}-${range.to}` : `chapters-${summary.chapters.slice(0, 8).join("-")}${summary.chapters.length > 8 ? "-recap" : ""}`;
  return `${prefix}-${type === "narration" ? "narration.txt" : type === "audio" ? "summary.mp3" : "summary.txt"}`;
}

/** Summary-specific orchestration only; providers, naming, censoring and mastering
 * remain the same services used by chapter production. Mutators require a story lock. */
export class SummaryMediaService {
  private readonly summaries: SummaryService;
  constructor(
    private readonly root: string,
    private readonly llms: LLMRouter,
    private readonly ttsRouter: TTSProviderRouter,
    private readonly censor: CensorAudioService,
    private readonly mastering: AudioMasteringProcessor,
    private readonly speechTranscriber?: SpeechTranscriber | (() => SpeechTranscriber | undefined)
  ) {
    this.summaries = new SummaryService(root, llms);
  }

  private async inputs(slug: string, summary: StorySummary) {
    const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig);
    const names = await loadNarrationNamingEntities(this.root, slug);
    const raw = await readJsonIfExists(storyPaths(this.root, slug, 1).bible);
    const context = retrieveRelevantContext(raw ? storyBibleSchema.parse(raw) : emptyStoryBible(), summary.text, Math.max(...summary.chapters) + 1,
      { recentSummaryCount: story.context.recentChapterSummaries, narrationNamingEntities: names });
    const config = story.pipeline.tts;
    const delivery = narrationDeliveryProfile(config.provider, config.model);
    const sourceFingerprint = fingerprint(summary.text);
    const namingFingerprint = fingerprint(context.canonicalEntities.map(({ id, canonicalName, originalName, aliases, localizedNaming, preferredNarrationName, aliasNarrationRules }) => ({ id, canonicalName, originalName, aliases, localizedNaming, preferredNarrationName, aliasNarrationRules })));
    const configurationFingerprint = fingerprint({ model: story.pipeline.narration, language: story.outputLanguage, profanity: story.narrationSettings.profanityMode, includeTitle: story.narrationSettings.includeChapterTitle !== false, intensity: config.deliveryIntensity, delivery, promptVersion: NARRATION_PROMPT_VERSION });
    const narrationFingerprint = fingerprint({ version: "summary-narration-v1", source: sourceFingerprint,
      model: story.pipeline.narration, language: story.outputLanguage, profanity: story.narrationSettings.profanityMode,
      includeTitle: story.narrationSettings.includeChapterTitle !== false, intensity: config.deliveryIntensity, delivery,
      promptVersion: NARRATION_PROMPT_VERSION, naming: context.canonicalEntities.map(({ id, canonicalName, originalName, aliases, localizedNaming, preferredNarrationName, aliasNarrationRules }) => ({ id, canonicalName, originalName, aliases, localizedNaming, preferredNarrationName, aliasNarrationRules })) });
    const pronunciationEntities = await loadPronunciationEntities(this.root, slug);
    const transcriber = typeof this.speechTranscriber === "function" ? this.speechTranscriber() : this.speechTranscriber;
    const { provider } = createEffectiveTtsProvider({
      baseProvider: this.ttsRouter.forName(config.provider),
      pronunciationEntities,
      qualityMode: config.qualityMode ?? (config.qualityGuard ? "verify" : "off"),
      qualityMode: ttsQualityMode(config),
      maxQualityRetries: config.maxQualityRetries,
      language: story.outputLanguage,
      transcriber,
    });
    const spoken = normalizeSpeechForProvider(summary.narration?.ttsText ?? summary.narration?.text ?? "", story.outputLanguage, story.narrationSettings, provider, config.model);
    const pronunciationFp = pronunciationFingerprint(resolvePronunciations(spoken.normalized.text, pronunciationEntities));
    const referenceId = provider.resolveReferenceId?.(config.referenceId) ?? config.referenceId;
    const ttsFingerprint = fingerprint({ version: "summary-tts-v1", text: summary.narration?.ttsText ?? summary.narration?.text, speech: spoken.fingerprint,
      config: { ...ttsSynthesisSettings(config), referenceId }, normalization: provider.inputNormalizationVersion,
      ...(pronunciationFp ? { pronunciation: pronunciationFp } : {}),
      bleep: story.narrationSettings.bleepStrongProfanity, censor: { version: this.censor.version, config: censorToneConfig } });
    return { story, context, provider, referenceId, spokenText: spoken.normalized.text, speechTransformations: spoken.normalized.transformations, sourceFingerprint, namingFingerprint, configurationFingerprint, narrationFingerprint, ttsFingerprint,
      audioFingerprint: audioMasteringFingerprint(summary.tts?.outputFingerprint, story.audio, this.mastering.version, summary.tts?.segmentFingerprints ?? []) };
  }

  async get(slug: string, id: string) {
    const summary = await this.summaries.get(slug, id); const input = await this.inputs(slug, summary);
    if (summary.narration && summary.narration.status === "current" && (summary.narration.inputFingerprint !== input.narrationFingerprint || fingerprint(summary.narration.text) !== summary.narration.outputFingerprint)) {
      summary.narration.status = "stale"; summary.narration.reviewRequired = summary.narration.manuallyEdited;
    }
    const paths = summaryMediaPaths(this.root, slug, id);
    if (summary.tts?.status === "current" && summary.tts.segmentFingerprints) {
      const actual = await inputFingerprints(await masteringInputs(paths.segments, paths.raw)).catch(() => []);
      if (fingerprint(actual) !== fingerprint(summary.tts.segmentFingerprints)) summary.tts.status = "stale";
    }
    if (summary.tts?.status === "current" && (summary.narration?.status !== "current" || summary.tts.inputFingerprint !== input.ttsFingerprint || await fileFingerprint(paths.raw) !== summary.tts.outputFingerprint)) summary.tts.status = "stale";
    if (summary.audio?.status === "current" && (summary.tts?.status !== "current" || summary.audio.inputFingerprint !== input.audioFingerprint || await fileFingerprint(paths.audio) !== summary.audio.outputFingerprint)) summary.audio.status = "stale";
    // Alignment is tied to the exact mastered recording, not merely its duration.
    // A replacement recording of identical length still has different word timing.
    if (summary.alignment && (summary.audio?.status !== "current" || summary.narration?.status !== "current" ||
      summary.alignment.audioFingerprint !== summary.audio.outputFingerprint || summary.alignment.narrationFingerprint !== summary.narration.outputFingerprint)) summary.alignment = undefined;
    if (summary.scenes?.status === "current" && (summary.narration?.status !== "current" ||
      summary.scenes.sourceFingerprint !== fingerprint(summary.narration.text) ||
      summary.scenes.configurationFingerprint !== fingerprint({ config: input.story.pipeline.scenePlanner, settings: input.story.scenes }) ||
      summary.scenes.outputFingerprint !== productionSceneFingerprint(summary.scenePlan) ||
      (summary.audio?.status === "current" && summary.audio.durationSeconds !== summary.scenePlan?.durationSeconds))) summary.scenes.status = "stale";
    return summary;
  }

  async speech(slug: string, id: string) {
    const summary = await this.get(slug, id); const input = await this.inputs(slug, summary);
    return { narrationText: summary.narration?.ttsText ?? summary.narration?.text ?? "", spokenText: input.spokenText, transformations: input.speechTransformations };
  }

  private async save(slug: string, summary: StorySummary) {
    const record = summarySchema.parse({ ...summary, updatedAt: new Date().toISOString() });
    await atomicWriteJson(summaryPath(this.root, slug, record.id), record); await invalidateSummaryReads(this.root, slug); return record;
  }

  async scenes(slug: string, id: string, raw: unknown = {}) {
    const options = summaryScenesInputSchema.parse(raw);
    const summary = await this.get(slug, id);
    // Availability, not freshness: valid-but-stale narration text is consumable for scene planning.
    if (!summary.narration?.text?.trim())
      throw new Error("Generate or review summary narration before planning scenes");
    const input = await this.inputs(slug, summary);
    const { force, ...pacing } = options;
    summary.scenePacing = pacing;
    const estimate = estimateScenePacing(summary.narration.text, pacing, summary.audio?.status === "current" ? summary.audio.durationSeconds : undefined);
    const identities = input.context.canonicalEntities.map((entity) => ({ entityId: entity.id, canonicalName: entity.canonicalName,
      originalName: entity.originalName, narrationNames: [entity.localizedNaming?.fullName, entity.localizedNaming?.shortName, entity.preferredNarrationName].filter((value): value is string => Boolean(value)) }));
    const inputFingerprint = fingerprint({ version: "summary-scenes-v1", narration: summary.narration.text, context: input.context,
      identities, estimate, pacing, config: input.story.pipeline.scenePlanner, settings: input.story.scenes });
    if (!force && summary.scenes?.status === "current" && summary.scenes.inputFingerprint === inputFingerprint && summary.scenePlan) return summary;
    if (!force && summary.scenePlan?.manuallyEdited) throw new Error("Manual scenes require explicit regeneration to replace them");
    const previous = summary.scenes; const previousScenePlan = summary.scenePlan;
    summary.scenes = { ...previous, status: "generating", inputFingerprint, manuallyEdited: false, reviewRequired: false };
    await this.save(slug, summary);
    try {
      const config = input.story.pipeline.scenePlanner;
      const planned = await planVisualScenes(this.llms.forStage(config), config, { sourceType: "summary", sourceId: id,
        sourceLabel: `SUMMARY: ${summary.title}`, sourceChapters: summary.chapters, canonicalSummary: summary.text,
        narration: summary.narration.text, durationSeconds: estimate.durationSeconds, targetSceneCount: estimate.sceneCount,
        bible: input.context, settings: input.story.scenes, namingIdentities: identities });
      const now = new Date().toISOString();
      summary.scenePlan = { version: 1, sourceType: "summary", sourceId: id, sourceChapters: summary.chapters,
        durationSeconds: estimate.durationSeconds, timingMethod: "estimated", planningFingerprint: inputFingerprint,
        planner: { provider: config.provider, model: config.model, promptVersion: "summary-scenes-v1" },
        manualRevision: 0, manuallyEdited: false, createdAt: summary.scenePlan?.createdAt ?? now, updatedAt: now,
        scenes: bindNarrationSpans(normalizeProductionSceneTiming(planned.value.scenes.map((s) => ({ ...s, location: s.location ?? undefined, visualChanges: normalizeVisualContinuityChange(s.visualChanges) })), estimate.durationSeconds), summary.narration.text).map((scene) => ({ ...scene,
          visualType: "image", entityIds: resolveVisualEntities(scene.characters, input.context.canonicalEntities).map((entity) => entity.id) })) };
      // Retain image provenance atomically with the new plan. A restart between
      // planning and artwork must never discard protected/approved image metadata.
      for (const scene of summary.scenePlan.scenes) {
        const before = previousScenePlan?.scenes.find((item) => item.id === scene.id);
        if (before) scene.artwork = before.artwork;
      }
      summary.scenes = { status: "current", inputFingerprint, outputFingerprint: productionSceneFingerprint(summary.scenePlan),
        sourceFingerprint: fingerprint(summary.narration.text), configurationFingerprint: fingerprint({ config, settings: input.story.scenes }),
        durationSeconds: estimate.durationSeconds, generatedAt: now, provider: config.provider, model: config.model,
        manuallyEdited: false, reviewRequired: false };
      return this.save(slug, summary);
    } catch (error) {
      summary.scenes = { ...summary.scenes, status: "failed", error: error instanceof Error ? error.message : String(error) };
      await this.save(slug, summary); throw error;
    }
  }

  async previewSceneRegeneration(slug: string, id: string, sceneId: string, raw: unknown) {
    const { mode } = z.object({ mode: summarySceneRegenerationModeSchema }).strict().parse(raw);
    const summary = await this.get(slug, id); const scene = summary.scenePlan?.scenes.find((item) => item.id === sceneId);
    if (!scene || !summary.narration?.text?.trim()) throw new Error("Narration text and an existing scene are required");
    const input = await this.inputs(slug, summary); const config = input.story.pipeline.scenePlanner;
    const provider = this.llms.forStage(config);
    const storyArtDirection = await loadStoryArtDirection(this.root, slug);
    const effectiveDirection = resolveSummarySceneArtDirection(storyArtDirection, summary.artDirectionOverride, scene);
    const visualDirectionContext = JSON.stringify({ source: effectiveDirection.source, preset: effectiveDirection.source === "disabled" ? undefined : effectiveDirection.preset, missingPresetId: effectiveDirection.missingPresetId, direction: scene.direction, overrides: scene.overrides });
    const current = summarySceneVisualSnapshot(scene);
    let proposed: typeof current;
    if (mode === "image_prompt") {
      await provider.validateConfiguration();
      const result = await provider.generateStructured({ model: config.model,
        schemaName: "summary_scene_image_prompt_proposal",
        schema: z.object({ visualPrompt: z.string().trim().min(1).max(8000) }).strict(),
        instructions: "Rewrite only the image prompt for this saved summary scene. Keep its visual beat, characters, location, importance, narration coverage, timing, and identity unchanged. Treat saved visual direction and manual overrides as editorial constraints, not suggestions. Describe the same moment with clear composition and scene state. Return only visualPrompt.",
        input: JSON.stringify({ scene: current, visualDirectionContext, narration: scene.narrationText ?? scene.summary,
          canonicalSummary: summary.text, canonicalEntities: input.context.canonicalEntities.map((entity) => ({ id: entity.id, name: entity.canonicalName, description: entity.description })) }),
      });
      proposed = { ...current, visualPrompt: result.value.visualPrompt };
    } else {
      const planned = await planVisualScenes(provider, config, { sourceType: "summary", sourceId: id,
        sourceLabel: `SUMMARY: ${summary.title} — regenerate ${sceneId} visual direction only`, narration: scene.narrationText ?? scene.summary,
        durationSeconds: scene.endSeconds - scene.startSeconds, targetSceneCount: 1, bible: input.context, settings: input.story.scenes,
        visualDirectionContext,
        canonicalSummary: summary.text, sourceChapters: summary.chapters,
        namingIdentities: input.context.canonicalEntities.map((entity) => ({ entityId: entity.id, canonicalName: entity.canonicalName, originalName: entity.originalName, narrationNames: [entity.localizedNaming?.fullName, entity.localizedNaming?.shortName, entity.preferredNarrationName].filter((value): value is string => Boolean(value)) })) });
      if (planned.value.scenes.length !== 1) throw new Error("Individual scene regeneration must return exactly one scene");
      const next = planned.value.scenes[0]!;
      proposed = summarySceneVisualSnapshotSchema.parse({ summary: next.summary, visualPrompt: next.visualPrompt,
        characters: next.characters, entityIds: resolveVisualEntities(next.characters, input.context.canonicalEntities).map((entity) => entity.id),
        location: next.location ?? undefined, importance: next.importance });
    }
    return summarySceneRegenerationProposalSchema.parse({ sceneId, mode, sourceFingerprint: summarySceneProposalSourceFingerprint(scene),
      current, proposed, provider: config.provider, model: config.model });
  }

  async narration(slug: string, id: string, raw: unknown = {}) {
    const { force } = summaryMediaInputSchema.parse(raw); const summary = await this.get(slug, id);
    if (!summary.text.trim() || summary.status !== "complete") throw new Error("Complete the canonical summary before generating narration");
    if (!force && summary.narration?.status === "current") return summary;
    if (!force && summary.narration?.manuallyEdited) throw new Error("Manual narration requires review. Retain/mark current or explicitly regenerate to replace it.");
    const input = await this.inputs(slug, summary); const previous = summary.narration;
    summary.narration = { ...previous, status: "generating", inputFingerprint: input.narrationFingerprint, manuallyEdited: previous?.manuallyEdited ?? false, reviewRequired: false };
    await this.save(slug, summary);
    try {
      const config = input.story.pipeline.narration, tts = input.story.pipeline.tts;
      const result = await polishNarration(this.llms.forStage(config), config, summary.text, input.story.outputLanguage,
        input.context, tts.provider, tts.model, input.story.narrationSettings.profanityMode, tts.deliveryIntensity,
        input.story.narrationSettings.includeChapterTitle !== false, "summary");
      const text = stripDeliveryCues(result.text, tts.provider, tts.model).trim();
      if (!text || text.length > 1_000_000) throw new Error("The narration model returned empty or oversized summary text");
      summary.narration = { status: "current", inputFingerprint: input.narrationFingerprint, outputFingerprint: fingerprint(text), text, ttsText: result.text,
        sourceFingerprint: input.sourceFingerprint, namingFingerprint: input.namingFingerprint, configurationFingerprint: input.configurationFingerprint,
        manuallyEdited: false, reviewRequired: false, provider: config.provider, model: config.model, generatedAt: new Date().toISOString() };
      if (summary.tts) summary.tts.status = "stale"; if (summary.audio) summary.audio.status = "stale";
      return await this.save(slug, summary);
    } catch (error) {
      summary.narration = { ...summary.narration, ...previous, status: "failed", error: error instanceof Error ? error.message : String(error) };
      await this.save(slug, summary); throw error;
    }
  }

  async editNarration(slug: string, id: string, raw: unknown) {
    const patch = summaryNarrationEditSchema.parse(raw); const summary = await this.get(slug, id); const input = await this.inputs(slug, summary);
    const text = "text" in patch ? patch.text : summary.narration?.text;
    if (!text?.trim()) throw new Error("No narration exists to retain");
    summary.narration = { ...summary.narration, text, ttsText: "text" in patch ? text : summary.narration?.ttsText ?? text,
      sourceFingerprint: input.sourceFingerprint, namingFingerprint: input.namingFingerprint, configurationFingerprint: input.configurationFingerprint, editedAt: new Date().toISOString(),
      status: "current", inputFingerprint: input.narrationFingerprint, outputFingerprint: fingerprint(text), manuallyEdited: "text" in patch || summary.narration?.manuallyEdited === true, reviewRequired: false, error: undefined };
    if (summary.tts) summary.tts.status = "stale"; if (summary.audio) summary.audio.status = "stale";
    return this.save(slug, summary);
  }

  async audio(slug: string, id: string, raw: unknown = {}, progress?: (event: { phase: string; completed: number; total: number }) => void) {
    const { force } = summaryMediaInputSchema.parse(raw); let summary = await this.get(slug, id);
    if (summary.narration?.status !== "current") summary = await this.narration(slug, id);
    const pronunciationStory = await loadStory(storyPaths(this.root, slug, 1).storyConfig);
    const pronunciationEntities = await loadPronunciationEntities(this.root, slug);
    const missing = pronunciationEntities.filter(entity => !entity.pronunciation).map(entity => ({ ...entity, pronunciation: { mode: "automatic" as const } }));
    const referenced = [...new Set(resolvePronunciations(summary.narration?.ttsText ?? summary.narration?.text ?? "", missing).map(occurrence => occurrence.entityId))];
    if (referenced.length) {
      const base = storyBibleSchema.parse(await readJsonIfExists(storyPaths(this.root, slug, 1).bible) ?? emptyStoryBible());
      await enrichStoryPronunciations(this.root, slug, base, this.llms.forStage(pronunciationStory.pipeline.storyBible), pronunciationStory.pipeline.storyBible, pronunciationStory.sourceLanguage, referenced, false);
      summary = await this.get(slug, id);
    }
    const input = await this.inputs(slug, summary), paths = summaryMediaPaths(this.root, slug, id);
    if (!force && summary.audio?.status === "current") return summary;
    await mkdir(paths.directory, { recursive: true });
    try {
      if (force || summary.tts?.status !== "current") {
        progress?.({ phase: "tts", completed: 0, total: 2 });
        summary.tts = { status: "generating", inputFingerprint: input.ttsFingerprint, manuallyEdited: false, reviewRequired: false };
        await this.save(slug, summary);
        const config = input.story.pipeline.tts;
        const result = await this.censor.synthesize(input.provider, { ...config, referenceId: input.referenceId,
          qualityGuard: (config.qualityMode ?? (config.qualityGuard ? "verify" : "off")) !== "off",
          qualityGuard: ttsQualityMode(config) !== "off",
          text: input.spokenText, bleepStrongProfanity: input.story.narrationSettings.bleepStrongProfanity });
        if (!result.audio.length) throw new Error("TTS returned empty summary audio");
        await atomicWrite(paths.raw, result.audio);
        await rm(paths.segments, { recursive: true, force: true });
        if (!result.assembled && result.segments.length) {
          await mkdir(paths.segments, { recursive: true });
          await Promise.all(result.segments.map((segment, index) => atomicWrite(join(paths.segments, `${String(index + 1).padStart(4, "0")}.mp3`), segment)));
        }
        const segmentFingerprints = await inputFingerprints(await masteringInputs(paths.segments, paths.raw));
        const reviewRequired = result.quality?.status === "needs_review";

        summary.tts = {
          status: "current",
          inputFingerprint: input.ttsFingerprint,
          outputFingerprint: (await fileFingerprint(paths.raw))!,
          manuallyEdited: false,
          reviewRequired,
          provider: config.provider,
          model: config.model,
          voice: input.referenceId,
          generatedAt: new Date().toISOString(),
          bytes: result.audio.length,
          segmentFingerprints,
          censoredSegments: result.censor?.segments,
          censorDurationSeconds: result.censor?.durationSeconds,
          quality: result.quality,
        };
        if (summary.audio) summary.audio.status = "stale";
        await this.save(slug, summary);
      }
      progress?.({ phase: "mastering", completed: 1, total: 2 });
      const inputs = await masteringInputs(paths.segments, paths.raw);
      const audioFingerprint = audioMasteringFingerprint(summary.tts!.outputFingerprint, input.story.audio, this.mastering.version, await inputFingerprints(inputs));
      const inheritedReviewRequired = summary.tts?.reviewRequired === true;
      summary.audio = { ...summary.audio, status: "generating", inputFingerprint: audioFingerprint, manuallyEdited: false, reviewRequired: inheritedReviewRequired };
      await this.save(slug, summary);
      const temporary = join(paths.directory, `.${randomUUID()}.mp3`);
      try {
        const probe = await this.mastering.master(inputs, temporary, input.story.audio);
        await rename(temporary, paths.audio);
        summary.audio = { status: "current", inputFingerprint: audioFingerprint, outputFingerprint: (await fileFingerprint(paths.audio))!,
          manuallyEdited: false, reviewRequired: inheritedReviewRequired, provider: summary.tts!.provider, model: summary.tts!.model, voice: summary.tts!.voice,
          generatedAt: new Date().toISOString(), durationSeconds: probe.durationSeconds, bytes: (await stat(paths.audio)).size };
      } finally { await rm(temporary, { force: true }); }
      progress?.({ phase: "complete", completed: 2, total: 2 }); return await this.save(slug, summary);
    } catch (error) {
      const stage = summary.tts?.status === "generating" ? "tts" : "audio";
      summary[stage] = { ...summary[stage]!, status: "failed", error: error instanceof Error ? error.message : String(error) };
      await this.save(slug, summary); throw error;
    }
  }

  async export(slug: string, id: string, rawType: unknown) {
    const type = summaryExportTypeSchema.parse(rawType), summary = await this.get(slug, id), paths = summaryMediaPaths(this.root, slug, id);
    const path = type === "summary" ? paths.canonical : type === "narration" ? paths.narration : paths.audio;
    if (type === "audio") { if (!summary.audio?.outputFingerprint || await fileFingerprint(path) !== summary.audio.outputFingerprint) throw new Error("Summary audio was not found. Generate audio first."); }
    else {
      const text = type === "summary" ? summary.text : summary.narration?.text;
      if (!text?.trim()) throw new Error(`${type} text was not found. Generate it first.`);
      await mkdir(dirname(path), { recursive: true }); await atomicWrite(path, text);
    }
    return { path, name: summaryDownloadName(summary, type), contentType: type === "audio" ? "audio/mpeg" : "text/plain; charset=utf-8" };
  }
}
