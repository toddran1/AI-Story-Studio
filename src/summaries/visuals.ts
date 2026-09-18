import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadStory } from "../config/load-config.js";
import { storyPaths } from "../storage/paths.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { fingerprint } from "../utils/hash.js";
import { loadNarrationNamingEntities } from "../story-bible/narration-names.js";
import { resolveVisualEntities } from "../scenes/identity.js";
import { productionSceneFingerprint } from "../scenes/manifest.js";
import { sceneSchema, artworkReviewSchema, type Scene } from "../scenes/types.js";
import { bindNarrationSpans, timeNarrationScenes } from "../scenes/narration-spans.js";
import { loadCharacterVisualReferences } from "../scenes/visual-references.js";
import { artworkPrompt, generateSceneImage, validPngFingerprint } from "../artwork/generator.js";
import type { ImageProvider } from "../artwork/provider.js";
import type { ImageProviderRouter } from "../artwork/router.js";
import type { VideoProcessor } from "../video/renderer.js";
import type { AlignmentConfig, AlignmentEngine } from "../alignment/types.js";
import { reconcileAndValidateAlignment } from "../alignment/quality.js";
import { generateSubtitleTiming } from "../subtitles/timing.js";
import { generateAlignedSubtitleTiming } from "../subtitles/aligned-timing.js";
import { toSrt } from "../subtitles/srt.js";
import { SummaryMediaService, summaryMediaPaths, summaryScenesInputSchema } from "./media.js";
import { summarySchema, type StorySummary } from "./types.js";
import { summaryPath } from "./service.js";
import { validateSceneCoverage } from "../scenes/timing.js";
import { withUsageScope } from "../cost/context.js";

export class SummaryArtifactNotFoundError extends Error {}

export const summaryVisualInputSchema = z.object({ force: z.boolean().default(false), missingOnly: z.boolean().default(false),
  scenes: z.array(z.string().regex(/^scene-\d{3}$/)).min(1).max(100).optional() }).strict();
export const summaryProduceInputSchema = summaryScenesInputSchema.safeExtend({ missingOnly: z.boolean().default(false) });
export const summarySceneEditSchema = z.union([
  z.object({ scenes: z.array(sceneSchema).min(1).max(100) }).strict(),
  z.object({ acceptCurrent: z.literal(true) }).strict(),
]);
export type SummaryVisualProgress = (event: { type: string; scene?: string; index?: number; total?: number }) => void;

/** Source adapter only. Image generation, prompts, alignment quality, captions,
 * TTS/mastering and video rendering all use the chapter production engines. */
export class SummaryVisualService {
  constructor(private readonly root: string, private readonly media: SummaryMediaService,
    private readonly images: ImageProviderRouter | ImageProvider, private readonly renderer: VideoProcessor,
    private readonly alignmentConfig: AlignmentConfig, private readonly aligner?: AlignmentEngine) {}
  paths(slug: string, id: string) { const paths = summaryMediaPaths(this.root, slug, id); return { ...paths, video: join(paths.directory, "video.mp4"), subtitles: join(paths.directory, "subtitles.srt"), image: (scene: string) => { if (!/^scene-\d{3}$/.test(scene)) throw new Error("Invalid scene ID"); return join(paths.directory, "artwork", `${scene}.png`); } }; }
  private save(slug: string, summary: StorySummary) { summary.updatedAt = new Date().toISOString(); return atomicWriteJson(summaryPath(this.root, slug, summary.id), summarySchema.parse(summary)).then(() => summary); }
  private async context(slug: string) { const story = await loadStory(storyPaths(this.root, slug, 1).storyConfig); const entities = await loadNarrationNamingEntities(this.root, slug); const provider = "forName" in this.images ? this.images.forName(story.artwork.provider) : this.images; if (provider.name !== story.artwork.provider) throw new Error("Configured artwork provider does not match the available provider"); return { story, entities, provider }; }
  private async imageInput(slug: string, scene: Scene) {
    const context = await this.context(slug);
    const entities = context.entities.filter((entity) => scene.entityIds?.includes(entity.id));
    for (const entity of resolveVisualEntities([...scene.characters, ...(scene.location ? [scene.location] : [])], context.entities)) if (!entities.some((item) => item.id === entity.id)) entities.push(entity);
    const refs = await loadCharacterVisualReferences(this.root, slug, [...scene.characters, ...entities.map((entity) => entity.canonicalName)]);
    const canonical = entities.map((entity) => ({ name: entity.canonicalName, description: [entity.description, entity.notes].filter(Boolean).join(". ") }));
    const visualScene = { ...scene, characters: entities.length ? entities.map((entity) => entity.canonicalName) : scene.characters };
    const prompt = artworkPrompt(visualScene, [...canonical, ...refs], context.story.artwork.stylePrompt, context.story.artwork.size);
    return { ...context, prompt, entityIds: entities.map((entity) => entity.id), inputFingerprint: fingerprint({ version: "source-artwork-v1", prompt, refs: refs.map((ref) => ref.fingerprint), settings: context.story.artwork, providerVersion: context.provider.version }) };
  }
  private videoFingerprint(summary: StorySummary, settings: unknown) { return fingerprint({ version: "summary-video-v1", audio: summary.audio?.outputFingerprint, scenes: summary.scenePlan?.scenes.filter((scene) => !scene.disabled).map((scene) => ({ id: scene.id, start: scene.startSeconds, end: scene.endSeconds, image: scene.artwork.imageFingerprint, review: scene.artwork.review })), settings, alignment: summary.alignment?.inputFingerprint, renderer: this.renderer.version }); }
  async get(slug: string, id: string) {
    const summary = await this.media.get(slug, id); const paths = this.paths(slug, id);
    let intact = true;
    for (const scene of summary.scenePlan?.scenes.filter((scene) => !scene.disabled) ?? []) {
      const input = await this.imageInput(slug, scene); const actual = await validPngFingerprint(paths.image(scene.id));
      if (scene.artwork.status !== "complete" || actual !== scene.artwork.imageFingerprint || !actual || scene.artwork.fingerprint !== input.inputFingerprint || ["rejected", "needs-regeneration"].includes(scene.artwork.review)) intact = false;
    }
    if (summary.artwork?.status === "current" && !intact) summary.artwork.status = "stale";
    if (summary.artwork?.status === "stale" && intact) summary.artwork.status = "current";
    const { story } = await this.context(slug);
    if (summary.video?.status === "current" && (summary.audio?.status !== "current" || summary.scenes?.status !== "current" || !intact || summary.video.inputFingerprint !== this.videoFingerprint(summary, { ...story.video, introDurationSeconds: 0 }) || summary.video.outputFingerprint !== await fileFingerprint(paths.video))) summary.video.status = "stale";
    return summary;
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
    const { story } = await this.context(slug); const { force, ...pacing } = options;
    const onlyTiming = before.scenePlan && before.narration?.status === "current" && before.scenes?.sourceFingerprint === fingerprint(before.narration.text) && before.scenes.configurationFingerprint === fingerprint({ config: story.pipeline.scenePlanner, settings: story.scenes }) && before.scenes.outputFingerprint === productionSceneFingerprint(before.scenePlan) && !force && fingerprint(before.scenePacing ?? pacing) === fingerprint(pacing);
    // A reviewed manual timeline is authoritative while its narration and audio remain current.
    if (onlyTiming && before.scenes?.status === "current" && before.scenePlan?.manuallyEdited && before.audio?.status === "current" && before.scenePlan.durationSeconds === before.audio.durationSeconds) return before;
    let summary = onlyTiming ? before : await this.media.scenes(slug, id, options);
    if (before.scenePlan && summary.scenePlan && !onlyTiming) for (const scene of summary.scenePlan.scenes) { const previous = before.scenePlan.scenes.find((item) => item.id === scene.id); if (previous) { const oldInput = await this.imageInput(slug, previous); const nextInput = await this.imageInput(slug, scene); if (oldInput.inputFingerprint === nextInput.inputFingerprint || previous.artwork.review === "approved" || previous.artwork.manuallyEdited) scene.artwork = previous.artwork; } }
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
  async artwork(slug: string, id: string, raw: unknown = {}, progress?: SummaryVisualProgress, paused?: () => boolean) {
    const options = summaryVisualInputSchema.parse(raw); let summary = await this.get(slug, id);
    if (!summary.scenePlan || summary.scenes?.status !== "current") throw new Error("Generate or review current scenes before artwork production");
    const selected = summary.scenePlan.scenes.filter((scene) => !scene.disabled && (!options.scenes || options.scenes.includes(scene.id)));
    if (options.scenes?.some((sceneId) => !selected.some((scene) => scene.id === sceneId))) throw new Error("Selected scene was not found or is disabled");
    summary.artwork = { ...summary.artwork, status: "generating", inputFingerprint: "per-scene", manuallyEdited: false, reviewRequired: false }; await this.save(slug, summary);
    try {
      for (let index = 0; index < selected.length; index++) {
        if (paused?.()) { summary.artwork.status = "stale"; return this.save(slug, summary); }
        const scene = selected[index]!; const input = await this.imageInput(slug, scene); const actual = await validPngFingerprint(this.paths(slug, id).image(scene.id));
        const current = scene.artwork.status === "complete" && Boolean(actual) && actual === scene.artwork.imageFingerprint && scene.artwork.fingerprint === input.inputFingerprint && !["rejected", "needs-regeneration"].includes(scene.artwork.review);
        if ((!options.force && current) || (options.missingOnly && actual && scene.artwork.status === "complete")) continue;
        if (!options.force && (scene.artwork.review === "approved" || scene.artwork.manuallyEdited)) continue;
        progress?.({ type: "summary.artwork.started", scene: scene.id, index: index + 1, total: selected.length });
        await input.provider.validateConfiguration(); scene.artwork = { ...scene.artwork, status: "running", error: undefined }; await this.save(slug, summary);
        try { const result = await withUsageScope({ story: slug, stage: "artwork" }, () => generateSceneImage(input.provider, input.story, input.prompt)); await atomicWrite(this.paths(slug, id).image(scene.id), result.data);
          scene.artwork = { status: "complete", review: "unreviewed", fingerprint: input.inputFingerprint, imageFingerprint: fingerprint(result.data.toString("base64")), provider: input.provider.name, model: input.story.artwork.model, generatedAt: new Date().toISOString(), prompt: input.prompt, sourceType: "summary", sourceId: id, entityIds: input.entityIds, versions: [] }; }
        catch (error) { scene.artwork = { ...scene.artwork, status: "failed", error: error instanceof Error ? error.message : String(error) }; throw error; }
        if (summary.video) summary.video.status = "stale"; await this.save(slug, summary); progress?.({ type: "summary.artwork.completed", scene: scene.id, index: index + 1, total: selected.length });
      }
      summary.artwork.status = "current"; await this.save(slug, summary); summary = await this.get(slug, id); return this.save(slug, summary);
    } catch (error) { summary.artwork!.status = "failed"; summary.artwork!.error = error instanceof Error ? error.message : String(error); await this.save(slug, summary); throw error; }
  }
  async reviewArtwork(slug: string, id: string, sceneId: string, raw: unknown) {
    const review = artworkReviewSchema.parse(raw); const summary = await this.get(slug, id); const scene = summary.scenePlan?.scenes.find((item) => item.id === sceneId); if (!scene) throw new Error("Scene was not found");
    if (review === "approved") { const actual = await validPngFingerprint(this.paths(slug, id).image(sceneId)); if (!actual || scene.artwork.status !== "complete" || actual !== scene.artwork.imageFingerprint) throw new Error("Only intact artwork can be approved"); const input = await this.imageInput(slug, scene); if (scene.artwork.fingerprint !== input.inputFingerprint) { scene.artwork.originalFingerprint ??= scene.artwork.fingerprint; scene.artwork.fingerprint = input.inputFingerprint; scene.artwork.manuallyEdited = true; scene.artwork.acceptedAt = new Date().toISOString(); } }
    scene.artwork.review = review; if (summary.video) summary.video.status = "stale"; await this.save(slug, summary); return this.get(slug, id);
  }
  async video(slug: string, id: string, raw: unknown = {}, progress?: SummaryVisualProgress) {
    const { force } = summaryVisualInputSchema.parse(raw); const summary = await this.get(slug, id); const { story } = await this.context(slug);
    if (!summary.scenePlan || summary.scenes?.status !== "current" || summary.audio?.status !== "current" || !summary.audio.durationSeconds) throw new Error("Current audio and scenes are required for summary video");
    const scenes = summary.scenePlan.scenes.filter((scene) => !scene.disabled); for (const scene of scenes) { const input = await this.imageInput(slug, scene); const actual = await validPngFingerprint(this.paths(slug, id).image(scene.id)); if (!actual || actual !== scene.artwork.imageFingerprint || scene.artwork.status !== "complete" || scene.artwork.fingerprint !== input.inputFingerprint || ["rejected", "needs-regeneration"].includes(scene.artwork.review)) throw new Error(`${scene.id} needs current artwork; review protected artwork or regenerate it explicitly`); }
    const settings = { ...story.video, introDurationSeconds: 0 }; const inputFingerprint = this.videoFingerprint(summary, settings);
    if (!force && summary.video?.status === "current" && summary.video.inputFingerprint === inputFingerprint) return summary;
    const paths = this.paths(slug, id); let subtitles: string | undefined;
    if (settings.subtitleMode !== "none") { const document = summary.alignment?.mode === "aligned" ? generateAlignedSubtitleTiming(summary.alignment.words, summary.audio.durationSeconds, story.subtitles) : generateSubtitleTiming(summary.narration!.text!, summary.audio.durationSeconds, story.subtitles); await atomicWrite(paths.subtitles, toSrt(document)); subtitles = paths.subtitles; }
    summary.video = { ...summary.video, status: "generating", inputFingerprint, manuallyEdited: false, reviewRequired: false }; await this.save(slug, summary); progress?.({ type: "summary.video.started" });
    const staging = join(paths.directory, `video-${randomUUID()}.mp4`);
    try { const probe = await this.renderer.render({ audio: paths.audio, subtitles, storyTitle: story.title, chapterLabel: "Summary", chapterTitle: summary.title, audioDurationSeconds: summary.audio.durationSeconds,
        sceneArtwork: scenes.map((scene) => ({ path: paths.image(scene.id), durationSeconds: scene.endSeconds - scene.startSeconds })) }, staging, settings);
      if (Math.abs(probe.durationSeconds - summary.audio.durationSeconds) > Math.max(.25, 2 / settings.fps)) throw new Error("Rendered summary video duration does not match mastered audio");
      await rename(staging, paths.video); summary.video = { status: "current", inputFingerprint, outputFingerprint: await fileFingerprint(paths.video), durationSeconds: probe.durationSeconds, width: probe.width, height: probe.height, sceneCount: scenes.length, sourceFingerprint: summary.audio.outputFingerprint, generatedAt: new Date().toISOString(), manuallyEdited: false, reviewRequired: false }; progress?.({ type: "summary.video.completed" }); return this.save(slug, summary);
    } catch (error) { summary.video!.status = "failed"; summary.video!.error = error instanceof Error ? error.message : String(error); await this.save(slug, summary); throw error; }
    finally { await rm(staging, { force: true }).catch(() => undefined); }
  }
  async produce(slug: string, id: string, raw: unknown = {}, progress?: SummaryVisualProgress, paused?: () => boolean) {
    const options = summaryProduceInputSchema.parse(raw); progress?.({ type: "summary.narration.preparing" });
    if (paused?.()) return this.get(slug, id); await withUsageScope({ story: slug, stage: "narration" }, () => this.media.narration(slug, id));
    if (paused?.()) return this.get(slug, id); progress?.({ type: "summary.audio.preparing" }); await withUsageScope({ story: slug, stage: "tts" }, () => this.media.audio(slug, id));
    if (paused?.()) return this.get(slug, id); const { missingOnly, ...pacing } = options;
    const recorded = (await this.media.get(slug, id)).scenePacing;
    const sceneOptions = options.pacing === "automatic" && options.sceneCount === undefined && options.secondsPerScene === undefined && recorded ? { ...recorded, force: options.force } : pacing;
    await withUsageScope({ story: slug, stage: "scenePlanning" }, () => this.scenes(slug, id, sceneOptions, progress));
    if (paused?.()) return this.get(slug, id); await this.artwork(slug, id, { missingOnly }, progress, paused);
    if (paused?.()) return this.get(slug, id); return this.video(slug, id, {}, progress);
  }
  async export(slug: string, id: string, type: "video" | "artwork", sceneId?: string) {
    const summary = await this.get(slug, id); const paths = this.paths(slug, id);
    if (type === "video") { if (!summary.video?.outputFingerprint || summary.video.outputFingerprint !== await fileFingerprint(paths.video)) throw new SummaryArtifactNotFoundError("Summary video is missing or damaged; generate it first"); return { path: paths.video, name: `${id}-video.mp4`, contentType: "video/mp4" }; }
    const scene = summary.scenePlan?.scenes.find((item) => item.id === sceneId); if (!scene || !scene.artwork.imageFingerprint || scene.artwork.imageFingerprint !== await validPngFingerprint(paths.image(scene.id))) throw new SummaryArtifactNotFoundError("Scene artwork is missing or damaged"); return { path: paths.image(scene.id), name: `${id}-${scene.id}.png`, contentType: "image/png" };
  }
}
