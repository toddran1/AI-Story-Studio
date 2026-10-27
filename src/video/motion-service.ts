import { invalidateSummaryReads } from "../summaries/read-revision.js";
import { backingArtworkVersion, validPngFingerprint } from "../artwork/generator.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mkdir, readFile, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Scene } from "../scenes/types.js";
import type { Story } from "../domain/story.js";
import type { LLMImageInput } from "../llm/types.js";
import type { LLMProvider } from "../llm/provider.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { fingerprint } from "../utils/hash.js";
import { imageDimensions } from "../artwork/resolution.js";
import { analyzeArtworkVisuals, readVisualCheckImage, visualCheckTargetFingerprint } from "../artwork/visual-check.js";
import { resolveVideoSettings } from "./config.js";
import { FfmpegMotionTools, MOTION_SAMPLE_VERSION } from "./motion-tools.js";
import { loadMotionAssets, saveMotionAssets, motionAssetPaths, motionAssetBinding, motionAssetReady, motionAssetIdSchema, newMotionAssetId, type MotionTarget, type MotionClipProvider, type MotionAsset } from "./motion-assets.js";
import { chapterSchema } from "../domain/chapter.js";
import { summarySchema } from "../summaries/types.js";
import { summaryMediaPaths } from "../summaries/media.js";
import { withUsageScope } from "../cost/context.js";

export type MotionContext = { scene: Scene; story: Story; imagePath: string; imageFingerprint: string; expected: string; images: LLMImageInput[] };
export const motionGenerationSchema = z.object({ model: z.string().trim().min(1).max(200), instruction: z.string().trim().min(1).max(2000), durationSeconds: z.number().min(1).max(12).default(4), allowanceUsd: z.number().positive().max(100).default(2) }).strict();
export const motionGenerationPrompt = (expected: string, instruction: string) => `Animate the supplied approved starting frame as one continuous short shot. Preserve every identity, face, normal/activated eyes, outfit, visible equipment, injuries, creature count, location and screen direction. Do not introduce props, abilities, costume changes or extra characters. No new shot, cut, text, dialogue, or audio is needed. Use restrained movement consistent with this scene.\nSCENE CONTEXT:\n${expected}\nREQUESTED MOTION:\n${instruction}`;
export class MotionAssetService {
  constructor(private readonly root: string, private readonly context: (slug: string, target: MotionTarget) => Promise<MotionContext>, private readonly qa: (story: Story) => LLMProvider, private readonly tools = new FfmpegMotionTools(), private readonly provider?: MotionClipProvider) {}
  private async source(slug: string, target: MotionTarget) {
    const context = await this.context(slug, target);
    if (context.scene.disabled || context.scene.artwork.review !== "approved") throw new Error("Motion requires an enabled scene with human-approved starting artwork.");
    await this.verifyStartingImage(context);
    return context;
  }
  private async verifyStartingImage(context: MotionContext) {
    const approved = backingArtworkVersion(context.scene);
    const expected = approved?.imageFingerprint ?? context.scene.artwork.imageFingerprint;
    const actual = await validPngFingerprint(context.imagePath);
    if (!expected || !actual || actual !== expected) throw new Error("The approved starting image is missing or changed. Review the current artwork before making motion.");
  }
  async list(slug: string, target: MotionTarget) {
    const manifest = await loadMotionAssets(this.root, slug, target);
    let context: MotionContext | undefined, binding: string | undefined, sourceError: string | undefined;
    try { context = await this.context(slug, target); if (context.scene.artwork.review === "approved") await this.verifyStartingImage(context); binding = await motionAssetBinding(this.root, slug, target, context.scene); }
    catch (error) { sourceError = error instanceof Error ? error.message : String(error); }
    return { ...manifest, sourceError, provider: this.provider ? { name: this.provider.name, version: this.provider.version } : null, recommended: context?.scene.importance === "major" || context?.scene.sequence?.beat === "action", startingFrameApproved: Boolean(context && !context.scene.disabled && context.scene.artwork.review === "approved" && !sourceError), assets: await Promise.all(manifest.assets.map(async asset => ({ ...asset, stale: asset.samplingVersion !== MOTION_SAMPLE_VERSION || !binding || asset.binding !== binding || asset.sourceFingerprint !== context?.imageFingerprint, ready: Boolean(binding && motionAssetReady(asset, binding)), intact: await fileFingerprint(motionAssetPaths(this.root, slug, target, asset.id).video) === asset.outputFingerprint }))) };
  }
  async planGeneration(slug: string, target: MotionTarget, raw: unknown) {
    const input = motionGenerationSchema.parse(raw); const context = await this.source(slug, target);
    if (!this.provider) throw new Error("No image-to-video provider is configured. Import a clip or add a provider adapter.");
    const binding = await motionAssetBinding(this.root, slug, target, context.scene);
    return { input, provider: this.provider.name, fingerprint: fingerprint({ input, provider: this.provider.name, version: this.provider.version, binding, source: context.imageFingerprint }), reservedUsd: input.allowanceUsd, requests: 1, note: "One provider request; allowance is a reservation, not a guaranteed billing cap. Continuity checks are a separate explicit step." };
  }
  async generate(slug: string, target: MotionTarget, raw: unknown, planFingerprint: string, stopped: () => boolean) {
    const plan = await this.planGeneration(slug, target, raw);
    if (plan.fingerprint !== planFingerprint) throw new Error("Motion inputs changed after preview. Preview again.");
    if (stopped()) return { status: "paused" };
    const context = await this.source(slug, target);
    const binding = await motionAssetBinding(this.root, slug, target, context.scene);
    const attemptPath = join(motionAssetPaths(this.root, slug, target).directory, `generation-${randomUUID()}.json`);
    const reservation = { version: 1, provider: this.provider!.name, model: plan.input.model, binding, sourceFingerprint: context.imageFingerprint, requests: 1, reservedUsd: plan.reservedUsd, createdAt: new Date().toISOString() };
    await atomicWriteJson(attemptPath, { ...reservation, status: "running" });
    try {
      const response = await withUsageScope({ story: slug, chapter: target.chapter, stage: "artwork" }, () => this.provider!.generate({ model: plan.input.model, source: context.images[0]!.data, prompt: motionGenerationPrompt(context.expected, plan.input.instruction), durationSeconds: plan.input.durationSeconds, signal: AbortSignal.timeout(10 * 60_000) }));
      // A finished paid response is retained even when pause was requested.
      const asset = await this.importClip(slug, target, response.data, { provider: this.provider!.name, model: plan.input.model, instruction: plan.input.instruction }, { context, binding });
      const result = { status: stopped() ? "paused" : "completed", asset, requests: 1, reservedUsd: plan.reservedUsd };
      await atomicWriteJson(attemptPath, { ...reservation, status: result.status, assetId: asset.id }); return result;
    } catch (error) {
      await atomicWriteJson(attemptPath, { ...reservation, status: "failed" }); throw error;
    }
  }
  async importClip(slug: string, target: MotionTarget, data: Buffer, provenance?: { provider: string; model: string; instruction: string }, snapshot?: { context: MotionContext; binding: string }) {
    if (!data.length || data.length > 100 * 1024 * 1024 || data.toString("ascii", 4, 8) !== "ftyp") throw new Error("Import a nonempty MP4 up to 100 MB.");
    return this.create(slug, target, "clip", provenance ? "provider" : "import", async (directory, output, settings) => {
      const source = join(directory, "upload.mp4"); await atomicWrite(source, data);
      return this.tools.normalize(source, output, settings.width, settings.height);
    }, provenance, snapshot);
  }
  async parallax(slug: string, target: MotionTarget, background: Buffer, foreground: Buffer, durationSeconds: number) {
    z.number().min(1).max(12).parse(durationSeconds);
    for (const data of [background, foreground]) if (!data.length || data.length > 15 * 1024 * 1024 || !data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("Parallax requires two PNG layers up to 15 MB each.");
    if (![4,6].includes(foreground[25]!)) throw new Error("The foreground must be a PNG with an alpha channel on a transparent background.");
    const bg = imageDimensions(background), fg = imageDimensions(foreground);
    if (!bg || !fg || bg.width !== fg.width || bg.height !== fg.height) throw new Error("Parallax layers must have matching canvas dimensions.");
    return this.create(slug, target, "parallax", "local", async (directory, output, settings) => {
      const bgPath = join(directory, "background.png"), fgPath = join(directory, "foreground.png");
      await atomicWrite(bgPath, background); await atomicWrite(fgPath, foreground);
      return this.tools.parallax(bgPath, fgPath, output, durationSeconds, settings.width, settings.height);
    });
  }
  private async create(slug: string, target: MotionTarget, kind: MotionAsset["kind"], origin: MotionAsset["origin"], produce: (directory: string, output: string, settings: { width: number; height: number }) => Promise<{ width: number; height: number; durationSeconds: number }>, provenance?: { provider: string; model: string; instruction: string }, snapshot?: { context: MotionContext; binding: string }) {
    const context = snapshot?.context ?? await this.source(slug, target); const binding = snapshot?.binding ?? await motionAssetBinding(this.root, slug, target, context.scene);
    const manifest = await loadMotionAssets(this.root, slug, target);
    if (manifest.assets.length >= 100) throw new Error("This scene has reached its 100 motion candidate limit.");
    const id = newMotionAssetId(), paths = motionAssetPaths(this.root, slug, target, id);
    const directory = join(paths.directory, `.stage-${id}`), output = join(directory, "clip.mp4"); await mkdir(directory, { recursive: true });
    try {
      const settings = resolveVideoSettings(context.story.video);
      const probe = await produce(directory, output, settings);
      const outputFingerprint = await fileFingerprint(output); if (!outputFingerprint) throw new Error("Motion processing produced an empty clip.");
      const frames = [0,1,2].map(i => join(directory, `${i}.png`)); await this.tools.frames(output, probe.durationSeconds, frames);
      await rename(output, paths.video);
      for (const [index, frame] of frames.entries()) await rename(frame, paths.frame(index));
      const asset: MotionAsset = { id, kind, origin, binding, sourceFingerprint: context.imageFingerprint, outputFingerprint, samplingVersion: MOTION_SAMPLE_VERSION, sampleFingerprints: await Promise.all([0,1,2].map(async index => (await readVisualCheckImage(paths.frame(index))).fingerprint)), ...probe, review: "unreviewed", checks: [], createdAt: new Date().toISOString(), ...provenance };
      manifest.assets.push(asset); await saveMotionAssets(this.root, slug, target, manifest); return asset;
    } catch (error) {
      // Candidates are immutable and have unique IDs; an unpublished candidate
      // must not leave media behind when sampling or manifest persistence fails.
      await Promise.all([paths.video, ...[0,1,2].map(index => paths.frame(index))].map(path => rm(path, { force: true }).catch(() => undefined)));
      throw error;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async check(slug: string, target: MotionTarget, rawId: string, stopped: () => boolean, progress: (value: unknown) => void, force = false) {
    const id = motionAssetIdSchema.parse(rawId); const context = await this.source(slug, target); const provider = this.qa(context.story);
    if (!provider.supportsImageInputs) throw new Error("Select an image-capable QA provider for motion continuity checks.");
    const manifest = await loadMotionAssets(this.root, slug, target); const asset = manifest.assets.find(a => a.id === id); if (!asset) throw new Error("Motion candidate was not found.");
    const paths = motionAssetPaths(this.root, slug, target, id); if (await fileFingerprint(paths.video) !== asset.outputFingerprint) throw new Error("Motion clip is missing or damaged.");
    if (asset.sourceFingerprint !== context.imageFingerprint) throw new Error("The approved starting image changed. Create a new clip from the current image.");
    const binding = await motionAssetBinding(this.root, slug, target, context.scene);
    const samplesIntact = await Promise.all([0,1,2].map(async index => {
      try { return (await readVisualCheckImage(paths.frame(index))).fingerprint === asset.sampleFingerprints[index]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return false; }
    }));
    if (asset.samplingVersion !== MOTION_SAMPLE_VERSION || samplesIntact.some(intact => !intact)) {
      await this.tools.frames(paths.video, asset.durationSeconds, [0,1,2].map(index => paths.frame(index)));
      asset.sampleFingerprints = await Promise.all([0,1,2].map(async index => (await readVisualCheckImage(paths.frame(index))).fingerprint));
      asset.samplingVersion = MOTION_SAMPLE_VERSION;
      asset.checks = []; asset.review = "unreviewed";
    }
    if (force || asset.checkedBinding !== binding) { asset.checks = []; asset.review = "unreviewed"; }
    asset.checkedBinding = binding;
    // Persist the reset before a request or pause can expose an apparently
    // complete mixture of old checks and newly requested sample reviews.
    await saveMotionAssets(this.root, slug, target, manifest);
    if (manifest.selectedId === asset.id && asset.review !== "approved") await this.markVideoStale(slug, target, "Selected scene motion needs review");
    for (let index = 0; index < 3; index++) {
      if (stopped()) { await saveMotionAssets(this.root, slug, target, manifest); return { status: "paused", checked: asset.checks.length }; }
      const frame = await readVisualCheckImage(paths.frame(index));
      let design: unknown = context.expected;
      try { const parsed = JSON.parse(context.expected) as Record<string, unknown>; const { referenceLabels: _labels, ...rest } = parsed; design = rest; } catch { /* Legacy plain text context remains valid. */ }
      const expected = `MOTION CONTINUITY SAMPLE: ${["starting", "middle", "ending"][index]} frame. Image 1 is the clip sample. Image 2 is its human-approved starting artwork. Preserve identities, clothing, eyes, equipment, creature count and setting throughout. The starting sample must also preserve the source composition. Do not require later frames to have an identical pose; permitted movement must follow the scene. A sampled check cannot establish that every intermediate frame is correct. Additional images are supporting identity references.\nEXPECTED SCENE:\n${typeof design === "string" ? design : JSON.stringify(design)}`;
      const references: LLMImageInput[] = []; let imageBytes = frame.image.data.length;
      for (const image of context.images) if (references.length < 3 && imageBytes + image.data.length <= 24 * 1024 * 1024) { references.push(image); imageBytes += image.data.length; }
      if (references[0] !== context.images[0]) throw new Error("Approved starting artwork exceeds the motion-check image budget.");
      const images = [frame.image, ...references];
      const targetFingerprint = visualCheckTargetFingerprint(expected, references.map(image => fingerprint(image.data.toString("base64"))), context.story.pipeline.qa);
      const previous = asset.checks[index];
      if (force || !previous || previous.imageFingerprint !== frame.fingerprint || previous.targetFingerprint !== targetFingerprint) {
        asset.checks[index] = await withUsageScope({ story: slug, chapter: target.chapter, stage: "visual-check" }, () => analyzeArtworkVisuals({ provider, model: context.story.pipeline.qa, expected, images, imageFingerprint: frame.fingerprint, targetFingerprint }));
        asset.review = "unreviewed";
        await saveMotionAssets(this.root, slug, target, manifest);
      }
      progress({ stage: "motion-check", index: index+1, completed: index+1, total: 3 });
    }
    asset.binding = binding; await saveMotionAssets(this.root, slug, target, manifest);
    return { status: "completed", asset };
  }
  async select(slug: string, target: MotionTarget, rawId?: string) {
    const manifest = await loadMotionAssets(this.root, slug, target);
    if (rawId) {
      const id = motionAssetIdSchema.parse(rawId); const context = await this.source(slug, target);
      const asset = manifest.assets.find(a => a.id === id); if (!asset) throw new Error("Motion candidate was not found.");
      const binding = await motionAssetBinding(this.root, slug, target, context.scene);
      if (asset.checkedBinding !== binding || asset.binding !== binding || asset.checks.length !== 3 || !asset.checks.every(c => !(context.scene.characters.length || context.scene.creatureGroups?.length) || c.identity.status === "match")) throw new Error("Run current identity and continuity checks before approving this motion.");
      const approved = { ...asset, review: "approved" as const };
      if (!motionAssetReady(approved, binding)) throw new Error("Resolve mismatches and uncertain continuity findings before approving this motion.");
      if (await fileFingerprint(motionAssetPaths(this.root, slug, target, id).video) !== asset.outputFingerprint) throw new Error("Motion clip is missing or damaged.");
      asset.review = "approved"; manifest.selectedId = id;
    } else manifest.selectedId = undefined;
    await saveMotionAssets(this.root, slug, target, manifest);
    await this.markVideoStale(slug, target, "Selected scene motion changed");
    return manifest;
  }
  private async markVideoStale(slug: string, target: MotionTarget, reason: string) {
    if (target.chapter) {
      const paths = storyPaths(this.root, slug, target.chapter); const chapter = chapterSchema.parse(await readJsonIfExists(paths.chapterMeta));
      chapter.stages.video.staleReason = reason; chapter.updatedAt = new Date().toISOString(); await atomicWriteJson(paths.chapterMeta, chapter);
    } else {
      const path = `${summaryMediaPaths(this.root, slug, target.summaryId!).directory}.json`; const summary = summarySchema.parse(await readJsonIfExists(path));
      if (summary.video) summary.video.status = "stale"; summary.updatedAt = new Date().toISOString(); await atomicWriteJson(path, summary); await invalidateSummaryReads(this.root, slug);
    }
  }

  async file(slug: string, target: MotionTarget, rawId: string) {
    const id = motionAssetIdSchema.parse(rawId); const manifest = await loadMotionAssets(this.root, slug, target); const asset = manifest.assets.find(a => a.id === id);
    if (!asset) throw new Error("Motion candidate was not found."); const path = motionAssetPaths(this.root, slug, target, id).video;
    if (await fileFingerprint(path) !== asset.outputFingerprint) throw new Error("Motion clip is missing or damaged."); return path;
  }
}
