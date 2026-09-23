import { randomUUID } from "node:crypto";
import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadStory } from "../config/load-config.js";
import { storyPaths } from "../storage/paths.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { exists } from "../storage/story-files.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { fingerprint } from "../utils/hash.js";
import { productionSceneFingerprint } from "../scenes/manifest.js";
import { sceneSchema, sceneDirectionSchema, sceneOverridesSchema, artworkReviewSchema, type Scene, type ArtworkVersion } from "../scenes/types.js";
import { bindNarrationSpans, timeNarrationScenes } from "../scenes/narration-spans.js";
import {
  generateSceneImage,
  loadApprovedVisualProfileReferences,
  REFERENCE_USAGE_INSTRUCTION,
  validPngFingerprint,
  backingArtworkVersion,
  resolveBestProductionAssetForPaths,
  ensureArtworkVersionProductionAssetForPaths,
  syncCanonicalSceneImageForPaths,
  needsProductionDerivative,
  resolveUpscaler,
} from "../artwork/generator.js";
import { imageDimensions } from "../artwork/resolution.js";
import { resolveVideoSettings } from "../video/config.js";
import type { ImageProvider } from "../artwork/provider.js";
import type { ImageProviderRouter } from "../artwork/router.js";
import type { ImageUpscaler } from "../artwork/upscaler.js";
import type { VideoProcessor } from "../video/renderer.js";
import type { AlignmentConfig, AlignmentEngine } from "../alignment/types.js";
import { reconcileAndValidateAlignment } from "../alignment/quality.js";
import { generateSubtitleTiming } from "../subtitles/timing.js";
import { generateAlignedSubtitleTiming } from "../subtitles/aligned-timing.js";
import { toSrt } from "../subtitles/srt.js";
import { SummaryMediaService, summaryMediaPaths, summaryScenesInputSchema, summarySceneProposalSourceFingerprint, summarySceneRegenerationProposalSchema, SummarySceneProposalConflictError } from "./media.js";
import { summarySchema, summaryAudioAvailable, summaryNarrationTextAvailable, summaryScenePlanAvailable, type StorySummary } from "./types.js";
import { summaryPath } from "./service.js";
import { validateSceneCoverage } from "../scenes/timing.js";
import { withUsageScope } from "../cost/context.js";
import { loadStoryBibleWithCanonicalOverlay } from "../story-bible/canonical.js";
import { loadVisualProfiles } from "../visual-canon/profiles.js";
import { loadStoryArtDirection } from "../visual-canon/art-direction.js";
import { resolveVisualCanonPrompt } from "../visual-canon/resolver.js";
import { inspectArtworkVisualPreflightForScenes } from "../visual-canon/preflight.js";
import { renderSceneContinuity, resolveVisualContinuity } from "../visual-canon/continuity.js";
import type { VisualContinuityReferenceDecision } from "../visual-canon/continuity-state.js";
import { MAX_REFERENCE_IMAGE_BYTES, MAX_REFERENCE_IMAGES, MAX_REFERENCE_TOTAL_BYTES, providerSupportsReferenceImages } from "../artwork/providers.js";
import { resolveSummarySceneArtDirection } from "./art-direction.js";

export class SummaryArtifactNotFoundError extends Error {}

export const summaryVisualInputSchema = z.object({
  force: z.boolean().default(false),
  missingOnly: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  scenes: z.array(z.string().regex(/^scene-\d{3}$/)).min(1).max(100).optional(),
  allowUnprofiledEntityIds: z.array(z.string().regex(/^ent_[a-f0-9]{24}$/)).max(100).default([]),
}).strict();
export const summaryReupscaleInputSchema = z.object({
  sceneId: z.string().regex(/^scene-\d{3}$/).optional(),
  versionNumber: z.number().int().positive().optional(),
}).strict();
export const summaryProduceInputSchema = summaryScenesInputSchema.safeExtend({
  missingOnly: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  allowUnprofiledEntityIds: z.array(z.string().regex(/^ent_[a-f0-9]{24}$/)).max(100).default([]),
});
export const summarySceneEditSchema = z.union([
  z.object({ scenes: z.array(sceneSchema).min(1).max(100) }).strict(),
  z.object({ acceptCurrent: z.literal(true) }).strict(),
]);
export const summarySingleSceneEditSchema = z.object({ scene: z.object({
  summary: z.string().trim().min(1).max(1000), visualPrompt: z.string().trim().min(1).max(8000),
  characters: z.array(z.string().trim().min(1)).max(20), entityIds: z.array(z.string().trim().min(1)).max(100),
  location: z.string().trim().max(300).optional(), startSeconds: z.number().min(0), endSeconds: z.number().positive(),
  disabled: z.boolean().optional(), importance: z.enum(["transition", "standard", "major"]),
  direction: sceneDirectionSchema.optional(), overrides: sceneOverridesSchema.optional(),
}).strict() }).strict();
export type SummaryVisualProgress = (event: {
  type: string;
  scene?: string;
  index?: number;
  total?: number;
  imagesToGenerate?: number;
  reusable?: number;
  derivativesToBuild?: number;
}) => void;

/** Source adapter only. Image generation, prompts, alignment quality, captions,
 * TTS/mastering and video rendering all use the chapter production engines. */
export class SummaryVisualService {
  constructor(
    private readonly root: string,
    private readonly media: SummaryMediaService,
    private readonly images: ImageProviderRouter | ImageProvider,
    private readonly renderer: VideoProcessor,
    private readonly alignmentConfig: AlignmentConfig,
    private readonly aligner?: AlignmentEngine,
    private readonly upscaler?: ImageUpscaler
  ) {}
  paths(slug: string, id: string) {
    const paths = summaryMediaPaths(this.root, slug, id);
    return {
      ...paths,
      video: join(paths.directory, "video.mp4"),
      subtitles: join(paths.directory, "subtitles.srt"),
      image: (scene: string) => {
        if (!/^scene-\d{3}$/.test(scene)) throw new Error("Invalid scene ID");
        return join(paths.directory, "artwork", `${scene}.png`);
      },
      sceneVersionImage: (scene: string, versionNumber: number) => {
        if (!/^scene-\d{3}$/.test(scene)) throw new Error("Invalid scene ID");
        return join(paths.directory, "artwork", `${scene}-v${versionNumber}.png`);
      },
      sceneVersionProductionImage: (scene: string, versionNumber: number) => {
        if (!/^scene-\d{3}$/.test(scene)) throw new Error("Invalid scene ID");
        return join(paths.directory, "artwork", `${scene}-v${versionNumber}-production.png`);
      },
    };
  }
  private save(slug: string, summary: StorySummary) { summary.updatedAt = new Date().toISOString(); return atomicWriteJson(summaryPath(this.root, slug, summary.id), summarySchema.parse(summary)).then(() => summary); }
  private async context(slug: string) {
    const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig);
    const [bible, visualProfiles, artDirection] = await Promise.all([
      loadStoryBibleWithCanonicalOverlay(this.root, slug), loadVisualProfiles(this.root, slug), loadStoryArtDirection(this.root, slug),
    ]);
    const provider = "forName" in this.images ? this.images.forName(story.artwork.provider) : this.images;
    if (provider.name !== story.artwork.provider) throw new Error("Configured artwork provider does not match the available provider");
    return { story, bible, visualProfiles, artDirection, provider };
  }
  /** Keep Produce's early Visual Profile gate aligned with the exact fast path
   * used by scenes(). A plan qualifies only when scenes() itself will skip the
   * scene planner and retain that plan (retiming it locally if needed). */
  private willReuseScenePlan(summary: StorySummary, story: Awaited<ReturnType<typeof loadStory>>, options: z.infer<typeof summaryScenesInputSchema>) {
    const { force, ...pacing } = options;
    return Boolean(summary.scenePlan && summary.narration?.status === "current" &&
      summary.scenes?.sourceFingerprint === fingerprint(summary.narration.text) &&
      summary.scenes.configurationFingerprint === fingerprint({ config: story.pipeline.scenePlanner, settings: story.scenes }) &&
      summary.scenes.outputFingerprint === productionSceneFingerprint(summary.scenePlan) &&
      !force && fingerprint(summary.scenePacing ?? pacing) === fingerprint(pacing));
  }
  private async sceneContinuity(slug: string, id: string, scenes: readonly Scene[]) {
    const paths = this.paths(slug, id);
    const continuityScenes = await Promise.all(scenes.filter((scene) => !scene.disabled).map(async (scene) => {
      const approvedId = scene.artwork.approvedVersionId;
      const approved = scene.artwork.versions?.find((version) => version.id === approvedId && version.review === "approved");
      if (!approved) return { id: scene.id, location: scene.location, visualChanges: scene.visualChanges };
      const imagePath = paths.sceneVersionImage(scene.id, approved.versionNumber);
      const actual = await validPngFingerprint(imagePath).catch(() => undefined);
      if (!actual || actual !== approved.imageFingerprint) return { id: scene.id, location: scene.location, visualChanges: scene.visualChanges,
        // Preserve the attempted identity for diagnostic provenance. imageInput
        // will verify it again before sending and will fingerprint text-only if
        // the file is missing, damaged, or unreadable.
        approvedArtwork: { versionId: approved.id, versionNumber: approved.versionNumber, imageFingerprint: approved.imageFingerprint } };
      return { id: scene.id, location: scene.location, visualChanges: scene.visualChanges,
        approvedArtwork: { versionId: approved.id, versionNumber: approved.versionNumber, imageFingerprint: actual } };
    }));
    const resolved = resolveVisualContinuity({ scenes: continuityScenes });
    return new Map(resolved.perScene.map((entry) => [entry.sceneId, { text: renderSceneContinuity(entry), decision: entry.referenceDecision }]));
  }
  private async imageInput(slug: string, id: string, scene: Scene, visualContinuity?: string, continuityDecision?: VisualContinuityReferenceDecision, summaryDirection?: StorySummary["artDirectionOverride"]) {
    const context = await this.context(slug);
    const effectiveDirection = resolveSummarySceneArtDirection(context.artDirection, summaryDirection, scene);
    const effectiveScene = effectiveDirection.source === "disabled" ? { ...scene, direction: { ...sceneDirectionSchema.parse(scene.direction ?? {}), useStoryArtDirection: false } } : scene;
    const artDirection = effectiveDirection.preset;
    const resolved = resolveVisualCanonPrompt({ scene: effectiveScene, story: context.story, bible: context.bible, artDirection, visualProfiles: context.visualProfiles, visualContinuity });
    const references = await loadApprovedVisualProfileReferences(this.root, context.story, resolved);
    const continuityReference = { kind: continuityDecision?.kind ?? "none", used: false, reason: continuityDecision?.reason } as { kind: string; used: boolean; reason?: string; sourceSceneId?: string; versionId?: string; versionNumber?: number; imageFingerprint?: string };
    if (continuityDecision?.used && continuityDecision.sourceSceneId && continuityDecision.versionNumber) {
      references.available += 1;
      continuityReference.sourceSceneId = continuityDecision.sourceSceneId;
      continuityReference.versionId = continuityDecision.versionId;
      continuityReference.versionNumber = continuityDecision.versionNumber;
      continuityReference.imageFingerprint = continuityDecision.imageFingerprint;
      if (!providerSupportsReferenceImages(context.story.artwork.provider, context.story.artwork.model)) {
        if (references.mode === "none") references.mode = "text-only";
        continuityReference.reason = "provider cannot consume reference images; textual continuity retained";
      } else if (references.images.length >= MAX_REFERENCE_IMAGES) {
        if (references.mode === "none") references.mode = "text-only";
        continuityReference.reason = "reference image count budget is full; textual continuity retained";
      } else {
        const sourcePath = this.paths(slug, id).sceneVersionImage(continuityDecision.sourceSceneId, continuityDecision.versionNumber);
        let actual: string | undefined;
        let data: Buffer | undefined;
        try {
          actual = await validPngFingerprint(sourcePath);
          if (actual === continuityDecision.imageFingerprint) data = await readFile(sourcePath);
        } catch {
          // Reference loading is best-effort. The textual continuity prompt is
          // still valid if the immutable image cannot be read at generation time.
          actual = undefined;
          data = undefined;
        }
        const totalBytes = references.images.reduce((sum, image) => sum + image.data.length, 0);
        if (data?.length && data.length <= MAX_REFERENCE_IMAGE_BYTES && totalBytes + data.length <= MAX_REFERENCE_TOTAL_BYTES) {
          references.images.push({ data, mimeType: "image/png", role: "previous-scene" });
          references.mode = "images";
          continuityReference.used = true;
        } else { if (references.mode === "none") references.mode = "text-only"; continuityReference.reason = "approved previous-scene image unavailable or outside reference budget; textual continuity retained"; }
      }
    }
    const bookStyle = effectiveDirection.source === "disabled" ? "" : context.story.artwork.stylePrompt?.trim() ? `BOOK ART STYLE: ${context.story.artwork.stylePrompt.trim()}` : "";
    const prompt = [resolved.prompt, bookStyle, references.images.length ? REFERENCE_USAGE_INSTRUCTION : ""].filter(Boolean).join("\n\n");
    const { provider: pName, model, quality, aspectRatio, size, stylePrompt, outputFormat } = context.story.artwork;
    // Provenance keeps the attempted source and diagnostic reason. Fingerprints
    // include only the image actually sent; a text-only fallback has a stable
    // representation independent of unused source version/hash/error wording.
    const effectiveContinuityReference = continuityReference.used ? {
      kind: continuityReference.kind,
      used: true,
      sourceSceneId: continuityReference.sourceSceneId,
      versionId: continuityReference.versionId,
      versionNumber: continuityReference.versionNumber,
      imageFingerprint: continuityReference.imageFingerprint,
    } : { kind: continuityReference.kind, used: false, mode: "text-only" as const };
    return {
      ...context,
      prompt,
      resolved,
      references,
      continuityReference,
      artDirectionProvenance: { source: effectiveDirection.source, presetId: effectiveDirection.source === "disabled" ? undefined : artDirection.id, presetName: effectiveDirection.source === "disabled" ? undefined : artDirection.name, missingPresetId: effectiveDirection.missingPresetId, fingerprint: resolved.artDirectionFingerprint },
      entityIds: resolved.resolvedEntities.map((entity) => entity.entityId),
      grounding: resolved.resolvedEntities.map((entity) => ({
        entityId: entity.entityId,
        name: entity.name,
        source: entity.hasApprovedProfile ? "approved Visual Profile" : context.bible.canonicalEntities.find((item) => item.id === entity.entityId)?.visualProfilePolicy?.mode === "skip" ? "Story Bible fallback (skip policy)" : "Story Bible fallback",
        reference: references.loadedEntityIds.includes(entity.entityId),
        primaryReference: references.loadedEntityIds.includes(entity.entityId) && (entity.references ?? []).some((reference) => reference.approved && reference.role === "primary_reference" && references.loadedReferenceIds.includes(reference.id)),
        profileRevision: entity.profileRevision,
      })),
      inputFingerprint: fingerprint({
        version: "summary-visual-canon-v1",
        prompt,
        references: references.loadedReferenceIds.map((id, index) => ({ id, fingerprint: references.referenceFingerprints[index] })),
        continuityReference: effectiveContinuityReference,
        artDirection: resolved.artDirectionFingerprint,
        entityVisual: resolved.entityVisualFingerprints,
        sceneDirection: resolved.sceneDirectionFingerprint,
        resolvedPrompt: resolved.resolvedPromptFingerprint,
        settings: { provider: pName, model, quality, aspectRatio, size, ...(effectiveDirection.source === "disabled" ? {} : { stylePrompt }), outputFormat },
        providerVersion: context.provider.version,
      }),
    };
  }
  private videoFingerprint(summary: StorySummary, settings: unknown) { return fingerprint({ version: "summary-video-v1", audio: summary.audio?.outputFingerprint, scenes: summary.scenePlan?.scenes.filter((scene) => !scene.disabled).map((scene) => ({ id: scene.id, start: scene.startSeconds, end: scene.endSeconds, image: scene.artwork.imageFingerprint, review: scene.artwork.review })), settings, alignment: summary.alignment?.inputFingerprint, renderer: this.renderer.version }); }
  private async sceneArtworkFreshness(slug: string, summary: StorySummary) {
    const paths = this.paths(slug, summary.id);
    const continuity = await this.sceneContinuity(slug, summary.id, summary.scenePlan?.scenes ?? []);
    return new Map(await Promise.all((summary.scenePlan?.scenes ?? []).map(async (scene) => {
      const visual = continuity.get(scene.id);
      const input = await this.imageInput(slug, summary.id, scene, visual?.text, visual?.decision, summary.artDirectionOverride);
      const actual = await validPngFingerprint(paths.image(scene.id));
      const hasImage = Boolean(actual && scene.artwork.imageFingerprint === actual);
      const current = hasImage && scene.artwork.status === "complete" && scene.artwork.fingerprint === input.inputFingerprint && !["rejected", "needs-regeneration"].includes(scene.artwork.review);
      return [scene.id, { input, actual, hasImage, current }] as const;
    })));
  }
  /** Reconcile visual freshness from the exact same generation inputs used by
   * artwork production. This is metadata-only: it never calls a provider. */
  async reconcileSummaryVisualFreshness(slug: string, summary: StorySummary, persist = false) {
    const before = { artwork: summary.artwork?.status, video: summary.video?.status };
    const paths = this.paths(slug, summary.id);
    const freshness = await this.sceneArtworkFreshness(slug, summary);
    const intact = (summary.scenePlan?.scenes.filter((scene) => !scene.disabled) ?? []).every((scene) => freshness.get(scene.id)?.current);
    if ((summary.artwork?.status === "current" || summary.artwork?.status === "stale") && summary.scenePlan) summary.artwork.status = intact ? "current" : "stale";
    const { story } = await this.context(slug);
    const settings = { ...resolveVideoSettings(story.video), introDurationSeconds: 0 };
    if (summary.video?.status === "current" || summary.video?.status === "stale") {
      const videoCurrent = summary.audio?.status === "current" && summary.scenes?.status === "current" && intact &&
        summary.video.inputFingerprint === this.videoFingerprint(summary, settings) && summary.video.outputFingerprint === await fileFingerprint(paths.video);
      summary.video.status = videoCurrent ? "current" : "stale";
    }
    if (persist && (before.artwork !== summary.artwork?.status || before.video !== summary.video?.status)) await this.save(slug, summary);
    return summary;
  }
  async get(slug: string, id: string) {
    const summary = await this.media.get(slug, id);
    return this.reconcileSummaryVisualFreshness(slug, summary);
  }
  async align(slug: string, id: string, progress?: SummaryVisualProgress) {
    const summary = await this.media.get(slug, id); if (summary.audio?.status !== "current" || !summary.audio.durationSeconds || !summary.narration?.text) throw new Error("Current mastered summary audio is required for alignment");
    const { story } = await this.context(slug); const paths = this.paths(slug, id);
    const inputFingerprint = fingerprint({ version: "summary-alignment-v1", audio: summary.audio.outputFingerprint, narration: summary.narration.outputFingerprint, config: this.alignmentConfig, engine: this.aligner?.version });
    if (summary.alignment?.inputFingerprint === inputFingerprint) return summary;
    progress?.({ type: "summary.alignment.started" }); const narration = summary.narration.text;
    let quality = reconcileAndValidateAlignment(narration, [], summary.audio.durationSeconds, this.alignmentConfig); let warning = "Alignment engine is disabled or unavailable";
    if (this.aligner) try { const observations = await this.aligner.align({ audioPath: paths.audio, narration, language: story.outputLanguage, model: this.alignmentConfig.model, device: this.alignmentConfig.device }); quality = reconcileAndValidateAlignment(narration, observations, summary.audio.durationSeconds, this.alignmentConfig); warning = quality.warnings.join("; "); } catch (error) { warning = error instanceof Error ? error.message : String(error); }
    summary.alignment = { version: 1, sourceType: "summary", sourceId: id, mode: quality.usable ? "aligned" : "estimated", engine: this.aligner?.name ?? "deterministic", engineVersion: this.aligner?.version ?? "estimated-v1", model: this.alignmentConfig.model, createdAt: new Date().toISOString(), audioFingerprint: summary.audio.outputFingerprint!, narrationFingerprint: summary.narration.outputFingerprint!, inputFingerprint, metrics: quality.metrics, words: quality.usable ? quality.words : [], warning: quality.usable ? undefined : warning };
    return this.save(slug, summary);
  }
  async scenes(slug: string, id: string, raw: unknown = {}, progress?: SummaryVisualProgress) {
    const options = summaryScenesInputSchema.parse(raw); const before = await this.media.get(slug, id);
    // Retiming is local: do not call the scene model merely because audio duration changed.
    const { story } = await this.context(slug);
    const onlyTiming = this.willReuseScenePlan(before, story, options);
    // A reviewed manual timeline is authoritative while its narration and audio remain current.
    if (onlyTiming && before.scenes?.status === "current" && before.scenePlan?.manuallyEdited && before.audio?.status === "current" && before.scenePlan.durationSeconds === before.audio.durationSeconds) return before;
    let summary = onlyTiming ? before : await this.media.scenes(slug, id, options);
    if (before.scenePlan && summary.scenePlan && !onlyTiming) {
      const [oldContinuity, nextContinuity] = await Promise.all([this.sceneContinuity(slug, id, before.scenePlan.scenes), this.sceneContinuity(slug, id, summary.scenePlan.scenes)]);
      for (const scene of summary.scenePlan.scenes) { const previous = before.scenePlan.scenes.find((item) => item.id === scene.id); if (previous) { const oldVisual = oldContinuity.get(previous.id), nextVisual = nextContinuity.get(scene.id); const oldInput = await this.imageInput(slug, id, previous, oldVisual?.text, oldVisual?.decision, before.artDirectionOverride); const nextInput = await this.imageInput(slug, id, scene, nextVisual?.text, nextVisual?.decision, summary.artDirectionOverride); if (oldInput.inputFingerprint === nextInput.inputFingerprint || previous.artwork.review === "approved" || previous.artwork.manuallyEdited) scene.artwork = previous.artwork; } }
    }
    if (summary.audio?.status === "current") summary = await this.alignWithPlan(slug, summary, progress);
    if (!summary.scenePlan || !summary.narration?.text) throw new Error("Summary scene plan is missing");
    summary.scenePlan.scenes = bindNarrationSpans(summary.scenePlan.scenes, summary.narration.text);
    const timed = timeNarrationScenes(summary.scenePlan.scenes, summary.audio?.status === "current" ? summary.audio.durationSeconds! : summary.scenePlan.durationSeconds, summary.alignment?.mode === "aligned" ? summary.alignment.words : undefined);
    const byId = new Map(timed.scenes.map((scene) => [scene.id, scene])); summary.scenePlan.scenes = summary.scenePlan.scenes.map((scene) => byId.get(scene.id) ?? scene);
    summary.scenePlan.durationSeconds = timed.scenes.at(-1)!.endSeconds; summary.scenePlan.timingMethod = timed.timingMethod;
    summary.scenes = { ...summary.scenes!, status: "current", outputFingerprint: productionSceneFingerprint(summary.scenePlan) };
    if (summary.video && productionSceneFingerprint(before.scenePlan) !== productionSceneFingerprint(summary.scenePlan)) summary.video.status = "stale";
    return this.save(slug, summary);
  }
  private async alignWithPlan(slug: string, summary: StorySummary, progress?: SummaryVisualProgress) { await this.save(slug, summary); return this.align(slug, summary.id, progress); }
  async editScenes(slug: string, id: string, raw: unknown) {
    const input = summarySceneEditSchema.parse(raw); const summary = await this.media.get(slug, id); if (!summary.scenePlan || !summary.narration?.text) throw new Error("Generate scenes before editing them");
    // Editorial policy (not availability): accepting or hand-editing a scene timeline marks it
    // authoritative against reviewed, current narration, so it deliberately requires current narration
    // even though scene *generation* only requires usable narration text.
    if (summary.narration.status !== "current") throw new Error("Review narration before accepting or editing scenes");
    let keepTiming = false;
    if ("scenes" in input) {
      keepTiming = input.scenes.length === summary.scenePlan.scenes.length && input.scenes.every((scene, index) => scene.id === summary.scenePlan!.scenes[index]!.id && Boolean(scene.disabled) === Boolean(summary.scenePlan!.scenes[index]!.disabled));
      const prior = new Map(summary.scenePlan.scenes.map((scene) => [scene.id, scene])); const ids = new Set<string>();
      for (const scene of input.scenes) { if (!prior.has(scene.id) || ids.has(scene.id)) throw new Error("Scene IDs must remain unique and stable"); ids.add(scene.id); scene.artwork = prior.get(scene.id)!.artwork; }
      // Reordering visual beats is supported; narration spans remain chronological slots.
      const slots = summary.scenePlan.scenes.filter((scene) => ids.has(scene.id));
      summary.scenePlan.scenes = input.scenes.map((scene, index) => ({ ...scene, narrationStartWord: slots[index]!.narrationStartWord, narrationEndWord: slots[index]!.narrationEndWord }));
      if (summary.scenePlan.scenes.length !== prior.size) summary.scenePlan.scenes.forEach((scene) => { scene.narrationStartWord = undefined; scene.narrationEndWord = undefined; });
      summary.scenePlan.scenes = bindNarrationSpans(summary.scenePlan.scenes, summary.narration.text);
    }
    const duration = summary.audio?.status === "current" ? summary.audio.durationSeconds! : summary.scenePlan.durationSeconds;
    if (keepTiming) validateSceneCoverage(summary.scenePlan.scenes.filter((scene) => !scene.disabled), duration);
    const timed = keepTiming ? { scenes: summary.scenePlan.scenes.filter((scene) => !scene.disabled), timingMethod: "estimated" as const } : timeNarrationScenes(summary.scenePlan.scenes, duration, summary.alignment?.mode === "aligned" ? summary.alignment.words : undefined);
    const byId = new Map(timed.scenes.map((scene) => [scene.id, scene])); summary.scenePlan.scenes = summary.scenePlan.scenes.map((scene) => byId.get(scene.id) ?? scene); summary.scenePlan.durationSeconds = timed.scenes.at(-1)!.endSeconds;
    summary.scenePlan.manuallyEdited = true; summary.scenePlan.manualRevision++; summary.scenePlan.timingMethod = timed.timingMethod;
    const { story } = await this.context(slug);
    summary.scenes = { ...summary.scenes!, status: "current", manuallyEdited: true, reviewRequired: false, outputFingerprint: productionSceneFingerprint(summary.scenePlan), sourceFingerprint: fingerprint(summary.narration.text), configurationFingerprint: fingerprint({ config: story.pipeline.scenePlanner, settings: story.scenes }) };
    if (summary.video) summary.video.status = "stale"; return this.save(slug, summary);
  }
  async updateScene(slug: string, id: string, sceneId: string, raw: unknown) {
    const input = summarySingleSceneEditSchema.parse(raw);
    const summary = await this.media.get(slug, id);
    const previous = summary.scenePlan?.scenes.find((scene) => scene.id === sceneId);
    if (!previous || !summary.scenePlan) throw new Error("Scene was not found");
    const replacement = sceneSchema.parse({ ...previous, ...input.scene, id: previous.id, artwork: previous.artwork,
      narrationText: previous.narrationText, narrationStartWord: previous.narrationStartWord, narrationEndWord: previous.narrationEndWord });
    const editable = (scene: Scene) => ({ summary: scene.summary, visualPrompt: scene.visualPrompt, characters: scene.characters,
      entityIds: scene.entityIds, location: scene.location, startSeconds: scene.startSeconds, endSeconds: scene.endSeconds,
      disabled: scene.disabled, importance: scene.importance, direction: scene.direction, overrides: scene.overrides });
    if (fingerprint(editable(previous)) === fingerprint(editable(replacement))) return this.get(slug, id);
    const scenes = summary.scenePlan.scenes.map((scene) => scene.id === sceneId ? replacement : scene);
    return this.editScenes(slug, id, { scenes });
  }
  async applySceneRegeneration(slug: string, id: string, sceneId: string, raw: unknown) {
    const proposal = summarySceneRegenerationProposalSchema.parse(raw);
    if (proposal.sceneId !== sceneId) throw new Error("Proposal scene ID does not match the selected scene");
    const summary = await this.media.get(slug, id);
    const scene = summary.scenePlan?.scenes.find((item) => item.id === sceneId);
    if (!scene) throw new Error("Scene was not found");
    if (summarySceneProposalSourceFingerprint(scene) !== proposal.sourceFingerprint) throw new SummarySceneProposalConflictError("This scene changed since the proposal was generated. Generate a new proposal before applying it.");
    const proposed = proposal.mode === "image_prompt" ? { visualPrompt: proposal.proposed.visualPrompt } : proposal.proposed;
    return this.updateScene(slug, id, sceneId, { scene: {
      summary: scene.summary, characters: scene.characters, entityIds: scene.entityIds ?? [],
      location: scene.location, startSeconds: scene.startSeconds, endSeconds: scene.endSeconds,
      disabled: scene.disabled, importance: scene.importance, direction: scene.direction, overrides: scene.overrides,
      ...proposed,
    } });
  }
  async sceneArtworkGrounding(slug: string, id: string) {
    const summary = await this.media.get(slug, id);
    const freshness = await this.sceneArtworkFreshness(slug, summary);
    return Promise.all((summary.scenePlan?.scenes ?? []).map(async (scene) => {
      const state = freshness.get(scene.id)!; const { input, hasImage, current } = state;
      const backing = backingArtworkVersion(scene);
      const recordedGrounding = backing?.provenance?.visualCanon;
      const recordedArtDirection = backing?.provenance?.artDirection;
      const groundingRecorded = Array.isArray(recordedGrounding);
      const visualGrounding = groundingRecorded ? recordedGrounding as typeof input.grounding : [];
      return { sceneId: scene.id, status: !hasImage ? "missing" as const : current ? "current" as const : "stale" as const,
        grounding: visualGrounding, groundingRecorded, legacyGroundingUnknown: Boolean(hasImage && !groundingRecorded),
        artDirection: recordedArtDirection && typeof recordedArtDirection === "object" ? recordedArtDirection as typeof input.artDirectionProvenance : undefined,
        approvedHistoricalVersion: Boolean(!current && (scene.artwork.review === "approved" || scene.artwork.versions?.some((version) => version.review === "approved"))) };
    }));
  }
  async artwork(slug: string, id: string, raw: unknown = {}, progress?: SummaryVisualProgress, paused?: () => boolean, upscalerOverride?: ImageUpscaler) {
    const options = summaryVisualInputSchema.parse(raw);
    let summary = await this.get(slug, id);
    // Availability, not freshness: a valid-but-stale scene plan is consumable for artwork.
    if (!summary.scenePlan || !summaryScenePlanAvailable(summary)) throw new Error("Generate scenes before artwork production");
    const selected = summary.scenePlan.scenes.filter((scene) => !scene.disabled && (!options.scenes || options.scenes.includes(scene.id)));
    if (options.scenes?.some((sceneId) => !selected.some((scene) => scene.id === sceneId))) throw new Error("Selected scene was not found or is disabled");

    const { story } = await this.context(slug);
    const paths = this.paths(slug, id);
    const continuity = await this.sceneContinuity(slug, id, summary.scenePlan.scenes);
    const upscaler = needsProductionDerivative(story) ? resolveUpscaler(upscalerOverride ?? this.upscaler) : undefined;

    let imagesToGenerate = 0;
    let reusable = 0;
    let derivativesToBuild = 0;

    type PlanItem = {
      scene: Scene;
      input: Awaited<ReturnType<SummaryVisualService["imageInput"]>>;
      needsGeneration: boolean;
      backingVersion?: ArtworkVersion;
    };
    const planItems: PlanItem[] = [];

    for (const scene of selected) {
      const visual = continuity.get(scene.id); const input = await this.imageInput(slug, id, scene, visual?.text, visual?.decision, summary.artDirectionOverride);
      const backing = backingArtworkVersion(scene);
      let intactOriginal = false;
      if (backing) {
        const originalPath = paths.sceneVersionImage(scene.id, backing.versionNumber);
        const actualOrig = await validPngFingerprint(originalPath);
        if (actualOrig && actualOrig === backing.imageFingerprint) {
          intactOriginal = true;
        }
      }
      if (!intactOriginal) {
        const standardActual = await validPngFingerprint(paths.image(scene.id));
        if (standardActual && standardActual === scene.artwork.imageFingerprint) {
          intactOriginal = true;
        }
      }

      const isCurrent = scene.artwork.status === "complete" && intactOriginal && scene.artwork.fingerprint === input.inputFingerprint && !["rejected", "needs-regeneration"].includes(scene.artwork.review);
      const isProtected = scene.artwork.review === "approved" || scene.artwork.manuallyEdited;
      const skipGeneration = (!options.force && isCurrent) || (options.missingOnly && intactOriginal && scene.artwork.status === "complete") || (!options.force && isProtected);

      if (skipGeneration) {
        reusable++;
        if (needsProductionDerivative(story) && backing) {
          const prodPath = paths.sceneVersionProductionImage(scene.id, backing.versionNumber);
          const actualProd = await validPngFingerprint(prodPath);
          if (!actualProd || actualProd !== backing.upscale?.outputFingerprint) {
            derivativesToBuild++;
          }
        }
        planItems.push({ scene, input, needsGeneration: false, backingVersion: backing });
      } else {
        imagesToGenerate++;
        if (needsProductionDerivative(story)) {
          derivativesToBuild++;
        }
        planItems.push({ scene, input, needsGeneration: true });
      }
    }

    const preflight = await inspectArtworkVisualPreflightForScenes({
      root: this.root,
      slug,
      candidates: planItems.filter((item) => item.needsGeneration).map((item) => ({ id: item.scene.id, scene: item.scene })),
      allowUnprofiledEntityIds: options.allowUnprofiledEntityIds,
    });
    if (!preflight.ready && !options.dryRun) {
      throw new Error(`Visual Profile Check required before generating summary artwork: ${preflight.requiresDecision.map((entity) => entity.name).join(", ")}`);
    }

    if (options.dryRun) {
      return {
        summary,
        dryRun: true,
        imagesToGenerate,
        sceneIds: planItems.filter((item) => item.needsGeneration).map((item) => item.scene.id),
        reusable,
        derivativesToBuild,
        preflight,
      };
    }

    // Migrate legacy assets only for real production. A dry run is strictly read-only.
    for (const scene of selected) {
      if (scene.artwork.status === "complete" && (!scene.artwork.versions || scene.artwork.versions.length === 0)) {
        const actual = await validPngFingerprint(paths.image(scene.id));
        if (actual && actual === scene.artwork.imageFingerprint) {
          const v1Path = paths.sceneVersionImage(scene.id, 1);
          if (!(await exists(v1Path))) await atomicWrite(v1Path, await readFile(paths.image(scene.id)));
          const dims = (await exists(v1Path)) ? imageDimensions(await readFile(v1Path)) : undefined;
          const v1: ArtworkVersion = {
            id: "v1", versionNumber: 1, sceneId: scene.id, imagePath: `${scene.id}-v1.png`, imageFingerprint: scene.artwork.imageFingerprint,
            createdAt: scene.artwork.generatedAt ?? new Date().toISOString(), provider: scene.artwork.provider ?? story.artwork.provider,
            model: scene.artwork.model ?? story.artwork.model, prompt: scene.artwork.prompt ?? scene.visualPrompt,
            promptFingerprint: scene.artwork.fingerprint ?? "", resolvedVisualProfileReferences: [], artDirectionFingerprint: "",
            settings: { quality: story.artwork.quality, size: story.artwork.size, aspectRatio: story.artwork.aspectRatio, outputFormat: story.artwork.outputFormat },
            original: dims ? { width: dims.width, height: dims.height, fingerprint: scene.artwork.imageFingerprint, provider: scene.artwork.provider ?? story.artwork.provider, model: scene.artwork.model ?? story.artwork.model } : undefined,
            review: scene.artwork.review ?? "unreviewed",
          };
          scene.artwork.versions = [v1];
        }
      }
    }

    summary.artwork = { ...summary.artwork, status: "generating", inputFingerprint: "per-scene", manuallyEdited: false, reviewRequired: false };
    await this.save(slug, summary);

    try {
      for (let index = 0; index < planItems.length; index++) {
        if (paused?.()) { summary.artwork.status = "stale"; return this.save(slug, summary); }
        const item = planItems[index]!;
        const scene = item.scene;
        const input = item.input;

        if (!item.needsGeneration) {
          if (item.backingVersion && needsProductionDerivative(story)) {
            const originalPath = paths.sceneVersionImage(scene.id, item.backingVersion.versionNumber);
            const productionPath = paths.sceneVersionProductionImage(scene.id, item.backingVersion.versionNumber);
            const warnings: string[] = [];
            const didChange = await ensureArtworkVersionProductionAssetForPaths({
              story,
              sceneId: scene.id,
              version: item.backingVersion,
              originalPath,
              productionPath,
              upscaler,
              warnings,
            });
            if (didChange) {
              await syncCanonicalSceneImageForPaths({
                story,
                scene,
                originalPath,
                productionPath,
                standardImagePath: paths.image(scene.id),
              });
              if (summary.video) summary.video.status = "stale";
              await this.save(slug, summary);
            }
          }
          continue;
        }

        progress?.({ type: "summary.artwork.started", scene: scene.id, index: index + 1, total: planItems.length });
        await input.provider.validateConfiguration();
        scene.artwork = { ...scene.artwork, status: "running", error: undefined };
        await this.save(slug, summary);

        try {
          const result = await withUsageScope({ story: slug, stage: "artwork" }, () => generateSceneImage(input.provider, input.story, input.prompt, {
            negativePrompt: input.resolved.negativePrompt || undefined,
            referenceImages: input.references.images,
          }));
          const versionNumber = (scene.artwork.versions?.length ?? 0) + 1;
          const versionId = `v${versionNumber}`;
          const originalPath = paths.sceneVersionImage(scene.id, versionNumber);
          const productionPath = paths.sceneVersionProductionImage(scene.id, versionNumber);
          const standardPath = paths.image(scene.id);

          await atomicWrite(originalPath, result.data);
          const dims = imageDimensions(result.data);
          const newVersion: ArtworkVersion = {
            id: versionId,
            versionNumber,
            sceneId: scene.id,
            imagePath: `${scene.id}-v${versionNumber}.png`,
            imageFingerprint: fingerprint(result.data.toString("base64")),
            createdAt: new Date().toISOString(),
            provider: input.provider.name,
            model: input.story.artwork.model,
            prompt: input.prompt,
            promptFingerprint: input.inputFingerprint,
            resolvedVisualProfileReferences: input.resolved.resolvedEntities.filter((entity) => entity.hasApprovedProfile).map((entity) => ({ entityId: entity.entityId, name: entity.name, role: entity.type })),
            artDirectionFingerprint: input.resolved.artDirectionFingerprint,
            settings: {
              quality: input.story.artwork.quality,
              size: input.story.artwork.size,
              aspectRatio: input.story.artwork.aspectRatio,
              outputFormat: input.story.artwork.outputFormat,
            },
            original: dims ? { width: dims.width, height: dims.height, fingerprint: fingerprint(result.data.toString("base64")), provider: input.provider.name, model: input.story.artwork.model } : undefined,
            provenance: {
              referencesUsed: input.references.mode,
              referenceImageCount: input.references.images.length,
              availableReferenceCount: input.references.available,
              continuityReference: input.continuityReference,
              artDirection: input.artDirectionProvenance,
              visualCanon: input.grounding.map((entity) => ({
                ...entity,
                source: entity.source === "Story Bible fallback" && options.allowUnprofiledEntityIds.includes(entity.entityId)
                  ? "Story Bible fallback (one-time)"
                  : entity.source,
              })),
            },
            review: "unreviewed",
          };

          const warnings: string[] = [];
          await ensureArtworkVersionProductionAssetForPaths({
            story: input.story,
            sceneId: scene.id,
            version: newVersion,
            originalPath,
            productionPath,
            upscaler,
            warnings,
          });

          scene.artwork.versions = [...(scene.artwork.versions ?? []), newVersion];
          scene.artwork = {
            ...scene.artwork,
            status: "complete",
            review: "unreviewed",
            fingerprint: input.inputFingerprint,
            imageFingerprint: newVersion.imageFingerprint,
            provider: input.provider.name,
            model: input.story.artwork.model,
            generatedAt: new Date().toISOString(),
            prompt: input.prompt,
            sourceType: "summary",
            sourceId: id,
            entityIds: input.entityIds,
            versions: scene.artwork.versions,
          };

          await syncCanonicalSceneImageForPaths({
            story: input.story,
            scene,
            originalPath,
            productionPath,
            standardImagePath: standardPath,
          });
        } catch (error) {
          scene.artwork = { ...scene.artwork, status: "failed", error: error instanceof Error ? error.message : String(error) };
          throw error;
        }

        if (summary.video) summary.video.status = "stale";
        await this.save(slug, summary);
        progress?.({ type: "summary.artwork.completed", scene: scene.id, index: index + 1, total: planItems.length });
      }

      summary.artwork.status = "current";
      await this.save(slug, summary);
      summary = await this.get(slug, id);
      return this.save(slug, summary);
    } catch (error) {
      summary.artwork!.status = "failed";
      summary.artwork!.error = error instanceof Error ? error.message : String(error);
      await this.save(slug, summary);
      throw error;
    }
  }
  async reupscale(slug: string, id: string, raw: unknown = {}, upscalerOverride?: ImageUpscaler) {
    const options = summaryReupscaleInputSchema.parse(raw);
    const summary = await this.get(slug, id);
    if (!summary.scenePlan) throw new Error("Summary has no scene plan");
    const { story } = await this.context(slug);
    const paths = this.paths(slug, id);
    const scenes = options.sceneId
      ? summary.scenePlan.scenes.filter((scene) => scene.id === options.sceneId)
      : summary.scenePlan.scenes;
    if (options.sceneId && !scenes.length) throw new Error(`Scene '${options.sceneId}' was not found`);

    // Migrate any legacy scenes without versions array
    for (const scene of scenes) {
      if (scene.artwork.status === "complete" && (!scene.artwork.versions || scene.artwork.versions.length === 0)) {
        const actual = await validPngFingerprint(paths.image(scene.id));
        if (actual && actual === scene.artwork.imageFingerprint) {
          const v1Path = paths.sceneVersionImage(scene.id, 1);
          if (!(await exists(v1Path))) {
            await atomicWrite(v1Path, await readFile(paths.image(scene.id)));
          }
          const dims = (await exists(v1Path)) ? imageDimensions(await readFile(v1Path)) : undefined;
          const v1: ArtworkVersion = {
            id: "v1",
            versionNumber: 1,
            sceneId: scene.id,
            imagePath: `${scene.id}-v1.png`,
            imageFingerprint: scene.artwork.imageFingerprint,
            createdAt: scene.artwork.generatedAt ?? new Date().toISOString(),
            provider: scene.artwork.provider ?? story.artwork.provider,
            model: scene.artwork.model ?? story.artwork.model,
            prompt: scene.artwork.prompt ?? scene.visualPrompt,
            promptFingerprint: scene.artwork.fingerprint ?? "",
            resolvedVisualProfileReferences: [],
            artDirectionFingerprint: "",
            settings: {
              quality: story.artwork.quality,
              size: story.artwork.size,
              aspectRatio: story.artwork.aspectRatio,
              outputFormat: story.artwork.outputFormat,
            },
            original: dims ? { width: dims.width, height: dims.height, fingerprint: scene.artwork.imageFingerprint, provider: scene.artwork.provider ?? story.artwork.provider, model: scene.artwork.model ?? story.artwork.model } : undefined,
            review: scene.artwork.review ?? "unreviewed",
          };
          scene.artwork.versions = [v1];
        }
      }
    }

    const warnings: string[] = [];
    const upscaler = needsProductionDerivative(story) ? resolveUpscaler(upscalerOverride ?? this.upscaler) : undefined;
    const rederived: Array<{ sceneId: string; versionId: string; status: string }> = [];
    let changed = false;

    for (const scene of scenes) {
      for (const version of scene.artwork.versions ?? []) {
        if (options.versionNumber !== undefined && version.versionNumber !== options.versionNumber) continue;
        const originalPath = paths.sceneVersionImage(scene.id, version.versionNumber);
        const actual = await validPngFingerprint(originalPath);
        if (!actual || actual !== version.imageFingerprint) {
          warnings.push(`Scene ${scene.id} ${version.id}: original image is missing or corrupt, skipping re-upscale.`);
          continue;
        }
        const productionPath = paths.sceneVersionProductionImage(scene.id, version.versionNumber);
        const didChange = await ensureArtworkVersionProductionAssetForPaths({
          story,
          sceneId: scene.id,
          version,
          originalPath,
          productionPath,
          upscaler,
          warnings,
        });
        if (didChange) {
          changed = true;
          rederived.push({ sceneId: scene.id, versionId: version.id, status: version.upscale?.status ?? "unknown" });
        }
      }
      const backing = backingArtworkVersion(scene);
      if (backing) {
        const originalPath = paths.sceneVersionImage(scene.id, backing.versionNumber);
        const productionPath = paths.sceneVersionProductionImage(scene.id, backing.versionNumber);
        const standardImagePath = paths.image(scene.id);
        if (await syncCanonicalSceneImageForPaths({ story, scene, originalPath, productionPath, standardImagePath })) {
          changed = true;
        }
      }
    }

    if (changed) {
      if (summary.video) summary.video.status = "stale";
      await this.save(slug, summary);
    }
    return { id, rederived, warnings };
  }
  async reviewArtwork(slug: string, id: string, sceneId: string, raw: unknown) {
    const review = artworkReviewSchema.parse(raw); const summary = await this.get(slug, id); const scene = summary.scenePlan?.scenes.find((item) => item.id === sceneId); if (!scene) throw new Error("Scene was not found");
    if (review === "approved") { const actual = await validPngFingerprint(this.paths(slug, id).image(sceneId)); if (!actual || scene.artwork.status !== "complete" || actual !== scene.artwork.imageFingerprint) throw new Error("Only intact artwork can be approved"); const continuity = await this.sceneContinuity(slug, id, summary.scenePlan?.scenes ?? []); const visual = continuity.get(scene.id); const input = await this.imageInput(slug, id, scene, visual?.text, visual?.decision, summary.artDirectionOverride); if (scene.artwork.fingerprint !== input.inputFingerprint) { scene.artwork.originalFingerprint ??= scene.artwork.fingerprint; scene.artwork.fingerprint = input.inputFingerprint; scene.artwork.manuallyEdited = true; scene.artwork.acceptedAt = new Date().toISOString(); } }
    scene.artwork.review = review;
    if (review === "approved" && scene.artwork.versions?.length) {
      const target = scene.artwork.versions.find((version) => version.id === scene.artwork.approvedVersionId) ?? scene.artwork.versions.at(-1)!;
      target.review = "approved"; scene.artwork.approvedVersionId = target.id;
    } else if (review === "rejected") {
      const target = scene.artwork.versions?.find((version) => version.id === scene.artwork.approvedVersionId) ?? scene.artwork.versions?.at(-1);
      if (target) target.review = "rejected";
      scene.artwork.approvedVersionId = undefined;
    }
    if (summary.video) summary.video.status = "stale"; await this.save(slug, summary); return this.get(slug, id);
  }
  async video(slug: string, id: string, raw: unknown = {}, progress?: SummaryVisualProgress) {
    const { force } = summaryVisualInputSchema.parse(raw); const summary = await this.get(slug, id); const { story } = await this.context(slug);
    const paths = this.paths(slug, id);
    const continuity = await this.sceneContinuity(slug, id, summary.scenePlan?.scenes ?? []);
    // Availability + integrity, not freshness: stale-but-valid audio/scenes render with a warning upstream in the UI.
    if (!summary.scenePlan || !summaryScenePlanAvailable(summary) || !summary.audio?.outputFingerprint || !summary.audio.durationSeconds || (await fileFingerprint(paths.audio)) !== summary.audio.outputFingerprint) throw new Error("Usable mastered audio and a scene plan are required for summary video");
    const scenes = summary.scenePlan.scenes.filter((scene) => !scene.disabled);
    for (const scene of scenes) {
      const visual = continuity.get(scene.id); const input = await this.imageInput(slug, id, scene, visual?.text, visual?.decision, summary.artDirectionOverride);
      const actual = await validPngFingerprint(paths.image(scene.id));
      if (!actual || actual !== scene.artwork.imageFingerprint || scene.artwork.status !== "complete" || scene.artwork.fingerprint !== input.inputFingerprint || ["rejected", "needs-regeneration"].includes(scene.artwork.review)) {
        throw new Error(`${scene.id} needs current artwork; review protected artwork or regenerate it explicitly`);
      }
    }
    const settings = { ...resolveVideoSettings(story.video), introDurationSeconds: 0 };
    const inputFingerprint = this.videoFingerprint(summary, settings);
    if (!force && summary.video?.status === "current" && summary.video.inputFingerprint === inputFingerprint) return summary;
    let subtitles: string | undefined;
    if (settings.subtitleMode !== "none") {
      const document = summary.alignment?.mode === "aligned"
        ? generateAlignedSubtitleTiming(summary.alignment.words, summary.audio.durationSeconds, story.subtitles)
        : generateSubtitleTiming(summary.narration!.text!, summary.audio.durationSeconds, story.subtitles);
      await atomicWrite(paths.subtitles, toSrt(document));
      subtitles = paths.subtitles;
    }
    summary.video = { ...summary.video, status: "generating", inputFingerprint, manuallyEdited: false, reviewRequired: false };
    await this.save(slug, summary);
    progress?.({ type: "summary.video.started" });

    const sceneArtwork = await Promise.all(scenes.map(async (scene) => {
      const backing = backingArtworkVersion(scene);
      let path = paths.image(scene.id);
      if (backing) {
        const originalPath = paths.sceneVersionImage(scene.id, backing.versionNumber);
        const productionPath = paths.sceneVersionProductionImage(scene.id, backing.versionNumber);
        const asset = await resolveBestProductionAssetForPaths({ story, version: backing, originalPath, productionPath });
        if (await validPngFingerprint(asset.path)) {
          path = asset.path;
        }
      }
      return { path, durationSeconds: scene.endSeconds - scene.startSeconds };
    }));

    const staging = join(paths.directory, `video-${randomUUID()}.mp4`);
    try {
      const probe = await this.renderer.render({
        audio: paths.audio,
        subtitles,
        storyTitle: story.title,
        chapterLabel: "Summary",
        chapterTitle: summary.title,
        audioDurationSeconds: summary.audio.durationSeconds,
        sceneArtwork,
      }, staging, settings);
      if (Math.abs(probe.durationSeconds - summary.audio.durationSeconds) > Math.max(.25, 2 / settings.fps)) {
        throw new Error("Rendered summary video duration does not match mastered audio");
      }
      await rename(staging, paths.video);
      summary.video = {
        status: "current",
        inputFingerprint,
        outputFingerprint: await fileFingerprint(paths.video),
        durationSeconds: probe.durationSeconds,
        width: probe.width,
        height: probe.height,
        sceneCount: scenes.length,
        sourceFingerprint: summary.audio.outputFingerprint,
        generatedAt: new Date().toISOString(),
        manuallyEdited: false,
        reviewRequired: false,
      };
      progress?.({ type: "summary.video.completed" });
      return this.save(slug, summary);
    } catch (error) {
      summary.video!.status = "failed";
      summary.video!.error = error instanceof Error ? error.message : String(error);
      await this.save(slug, summary);
      throw error;
    } finally {
      await rm(staging, { force: true }).catch(() => undefined);
    }
  }
  async produce(slug: string, id: string, raw: unknown = {}, progress?: SummaryVisualProgress, paused?: () => boolean) {
    const options = summaryProduceInputSchema.parse(raw);
    if (options.dryRun) return this.planProduce(slug, id, options);
    const initial = await this.media.get(slug, id);
    const { missingOnly, dryRun, allowUnprofiledEntityIds, ...pacing } = options;
    const recorded = initial.scenePacing;
    const sceneOptions = options.pacing === "automatic" && options.sceneCount === undefined && options.secondsPerScene === undefined && recorded
      ? { ...recorded, force: options.force }
      : pacing;
    const parsedSceneOptions = summaryScenesInputSchema.parse(sceneOptions);
    const { story } = await this.context(slug);
    // If Produce can reuse the existing scene plan, its artwork candidates are
    // already knowable. Check the gate before narration/TTS can incur spend.
    const canPreflightBeforeUpstream = summaryScenePlanAvailable(initial) && this.willReuseScenePlan(initial, story, parsedSceneOptions);
    if (canPreflightBeforeUpstream) {
      const report = await this.artwork(slug, id, { missingOnly: options.missingOnly, dryRun: true, allowUnprofiledEntityIds: options.allowUnprofiledEntityIds });
      if ("preflight" in report && !report.preflight.ready) return this.produceBlocked(id, report.preflight, true);
    }
    progress?.({ type: "summary.narration.preparing" });
    if (paused?.()) return this.get(slug, id); await withUsageScope({ story: slug, stage: "narration" }, () => this.media.narration(slug, id, { force: options.force }));
    if (paused?.()) return this.get(slug, id); progress?.({ type: "summary.audio.preparing" }); await withUsageScope({ story: slug, stage: "tts" }, () => this.media.audio(slug, id, { force: options.force }));
    if (paused?.()) return this.get(slug, id);
    await withUsageScope({ story: slug, stage: "scenePlanning" }, () => this.scenes(slug, id, sceneOptions, progress));
    if (paused?.()) return this.get(slug, id);
    const artworkPlan = await this.artwork(slug, id, { force: options.force, missingOnly, dryRun: true, allowUnprofiledEntityIds }, progress, paused);
    if ("preflight" in artworkPlan && !artworkPlan.preflight.ready) return this.produceBlocked(id, artworkPlan.preflight, false);
    await this.artwork(slug, id, { force: options.force, missingOnly, allowUnprofiledEntityIds }, progress, paused);
    if (paused?.()) return this.get(slug, id); return this.video(slug, id, { force: options.force }, progress);
  }
  private produceBlocked(id: string, preflight: Awaited<ReturnType<typeof inspectArtworkVisualPreflightForScenes>>, beforeUpstream: boolean) {
    return { id, status: "blocked" as const, reason: "visual-profile-decisions-required" as const, beforeUpstream,
      message: "Visual Profile decisions are required before summary artwork can be generated.", preflight };
  }
  private async planProduce(slug: string, id: string, options: z.infer<typeof summaryProduceInputSchema>) {
    // This path deliberately reads metadata and existing files only. It must never call a
    // provider, master audio, render video, alter freshness, or write an artifact.
    const summary = await this.get(slug, id);
    const narration = summary.narration?.status === "current"
      ? { action: "reuse", status: summary.narration.status }
      : { action: "generate", status: summary.narration?.status ?? "missing" };
    const audio = summary.audio?.status === "current"
      ? { action: "reuse", status: summary.audio.status }
      : { action: "generate", status: summary.audio?.status ?? "missing" };
    const scenes = summary.scenes?.status === "current" && summaryScenePlanAvailable(summary)
      ? { action: "reuse", status: summary.scenes.status }
      : { action: "generate", status: summary.scenes?.status ?? "missing" };
    const artwork = summaryScenePlanAvailable(summary)
      ? await this.artwork(slug, id, { missingOnly: options.missingOnly, dryRun: true, allowUnprofiledEntityIds: options.allowUnprofiledEntityIds })
      : { blocked: true, reason: "A scene plan will be generated before artwork can be planned" };
    const canRenderVideo = summaryAudioAvailable(summary) && summaryNarrationTextAvailable(summary) && summaryScenePlanAvailable(summary);
    const video = summary.video?.status === "current" && canRenderVideo
      ? { action: "reuse", status: summary.video.status }
      : canRenderVideo
        ? { action: "render", status: summary.video?.status ?? "missing" }
        : { action: "blocked", status: summary.video?.status ?? "missing", reason: "Audio and scene plan are required" };
    return { dryRun: true, id, narration, audio, scenes, artwork, video };
  }
  async export(slug: string, id: string, type: "video" | "artwork", sceneId?: string) {
    const summary = await this.get(slug, id); const paths = this.paths(slug, id);
    if (type === "video") { if (!summary.video?.outputFingerprint || summary.video.outputFingerprint !== await fileFingerprint(paths.video)) throw new SummaryArtifactNotFoundError("Summary video is missing or damaged; generate it first"); return { path: paths.video, name: `${id}-video.mp4`, contentType: "video/mp4" }; }
    const scene = summary.scenePlan?.scenes.find((item) => item.id === sceneId); if (!scene || !scene.artwork.imageFingerprint || scene.artwork.imageFingerprint !== await validPngFingerprint(paths.image(scene.id))) throw new SummaryArtifactNotFoundError("Scene artwork is missing or damaged"); return { path: paths.image(scene.id), name: `${id}-${scene.id}.png`, contentType: "image/png" };
  }
}
