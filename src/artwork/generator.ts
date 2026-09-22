import { readFile } from "node:fs/promises";
import { Chapter, chapterSchema } from "../domain/chapter.js";
import { Story } from "../domain/story.js";
import { ArtworkError, ConfigurationError } from "../pipeline/errors.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { sceneImagePath, sceneVersionImagePath, sceneVersionProductionImagePath, storyPaths } from "../storage/paths.js";
import { exists, readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { sceneContentFingerprint } from "../scenes/manifest.js";
import { loadCharacterVisualReferences } from "../scenes/visual-references.js";
import { artworkReviewSchema, ArtworkVersion, Scene, SceneManifest, sceneManifestSchema } from "../scenes/types.js";
import { ImageAspectRatio, ImageProvider, ImageReferenceImage } from "./provider.js";
import { artworkCompositionGuidance, resolveArtworkAspectRatio } from "./composition.js";
import { withRetry } from "../batch/retry.js";
import { retryConfigSchema } from "../batch/types.js";
import { loadVisualProfiles } from "../visual-canon/profiles.js";
import { loadStoryArtDirection, resolveActiveArtDirection } from "../visual-canon/art-direction.js";
import { resolveVisualCanonPrompt, ResolvedSceneVisualPrompt } from "../visual-canon/resolver.js";
import { renderSceneContinuity, resolveChapterVisualContinuity, VisualContinuityReferenceDecision } from "../visual-canon/continuity.js";
import { emptyStoryBible, storyBibleSchema, StoryBible } from "../domain/story-bible.js";
import { assertImageModelCompatible, imageNativeTiers, MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES, MAX_REFERENCE_TOTAL_BYTES, providerSupportsReferenceImages } from "./providers.js";
import { findVisualReferenceFile, mimeForVisualReferenceExtension } from "../visual-canon/assets.js";
import { VisualReferenceImage } from "../domain/visual-profile.js";
import { stageFreshness, stalePrerequisiteWarning } from "../studio/artifact-state.js";
import { estimateNativeDimensions, imageDimensions, planResolution, qualityTierIndex, resolveTargetDimensions } from "./resolution.js";
import { ImageUpscaler, upscaleFingerprint } from "./upscaler.js";
import { createLocalUpscaler } from "./local-realesrgan.upscaler.js";
import { loadEnvironment } from "../config/env.js";
import { inspectArtworkVisualPreflight } from "../visual-canon/preflight.js";

/** Reference images establish recognizable identity only. They must never
 * silently override temporary state described by the current scene. */
export const REFERENCE_USAGE_INSTRUCTION =
  "REFERENCE USAGE: Use supplied reference images only to preserve recognizable identity and permanent traits. Do not copy conflicting clothing, shoes, accessories, weapons, equipment, pose, expression, injury state, dirt, damage, or environment from a reference image. Follow CURRENT VISUAL CONTINUITY, SCENE BEAT, SCENE DIRECTION, and SCENE OVERRIDES for this artwork.";

// Bump when shared Visual Canon prompt semantics change. This intentionally
// makes old artwork eligible for regeneration without touching story text.
const VISUAL_CANON_ARTWORK_VERSION = "visual-canon-v2";

/** Derivative production assets are only derived when a final output
 * resolution is requested and upscaling is enabled. Generation fingerprints
 * never include these settings — originals stay reusable across resolution
 * changes. */
export function needsProductionDerivative(story: Story): boolean {
  return story.artwork.outputResolution !== "native" && story.artwork.upscaling !== "off";
}

export function resolveUpscaler(provided?: ImageUpscaler): ImageUpscaler {
  return provided ?? createLocalUpscaler(loadEnvironment());
}

export async function generateStoredArtwork(options: {
  root: string;
  story: Story;
  chapter: number;
  provider: ImageProvider;
  sceneId?: string;
  force?: boolean;
  dryRun?: boolean;
  /** Explicit, one-request fallback; never persisted by generation itself. */
  allowUnprofiledEntityIds?: string[];
  upscaler?: ImageUpscaler;
  onProgress?: (event: { type: string; chapter: number; scene?: string; index?: number; total?: number; warnings?: string[] }) => void;
}) {
  const paths = storyPaths(options.root, options.story.slug, options.chapter);
  const raw = await readJsonIfExists<SceneManifest>(paths.scenesManifest);
  if (!raw) throw new ArtworkError(`Chapter ${options.chapter} has no scene plan`);
  const manifest = sceneManifestSchema.parse(raw);

  if (options.provider.name !== options.story.artwork.provider) {
    throw new ArtworkError(
      `Artwork provider mismatch: story '${options.story.slug}' is configured for '${options.story.artwork.provider}' but the resolved provider is '${options.provider.name}'`
    );
  }
  assertImageModelCompatible(options.story.artwork.provider, options.story.artwork.model);

  const rawChapter = await readJsonIfExists<Chapter>(paths.chapterMeta);
  if (!rawChapter) throw new ArtworkError(`Chapter ${options.chapter} has no pipeline metadata`);
  const chapter = chapterSchema.parse(rawChapter);

  const warnings: string[] = [];
  if (stageFreshness(chapter, "scenePlanning") === "stale") warnings.push(stalePrerequisiteWarning("scenePlanning"));
  if (warnings.length) options.onProgress?.({ type: "artwork.prerequisites", chapter: options.chapter, warnings });

  const rawBible = await readJsonIfExists<StoryBible>(paths.bible);
  const bible = rawBible ? storyBibleSchema.parse(rawBible) : emptyStoryBible();

  const artDirectionConfig = await loadStoryArtDirection(options.root, options.story.slug);
  const visualProfiles = await loadVisualProfiles(options.root, options.story.slug);

  // Recompute-on-read visual continuity: manifest deltas + previous handoff +
  // manual overlay. Textual continuity joins the prompt; approved prior artwork
  // may join the reference images. Never blocks generation.
  const continuity = await resolveChapterVisualContinuity({
    root: options.root,
    slug: options.story.slug,
    chapter: options.chapter,
    manifest,
    contentFingerprints: Object.fromEntries(manifest.scenes.map((scene) => [scene.id, sceneContentFingerprint(scene)])),
  });
  const continuityByScene = new Map(continuity.resolved.perScene.map((entry) => [entry.sceneId, entry]));

  // Migrate any legacy scenes without versions array
  for (const scene of manifest.scenes) {
    if (scene.artwork.status === "complete" && (!scene.artwork.versions || scene.artwork.versions.length === 0)) {
      const v1: ArtworkVersion = {
        id: "v1",
        versionNumber: 1,
        sceneId: scene.id,
        imagePath: `${scene.id}.png`,
        imageFingerprint: scene.artwork.imageFingerprint ?? "",
        createdAt: scene.artwork.generatedAt ?? new Date().toISOString(),
        provider: scene.artwork.provider ?? options.story.artwork.provider,
        model: scene.artwork.model ?? options.story.artwork.model,
        prompt: scene.artwork.prompt ?? scene.visualPrompt,
        promptFingerprint: scene.artwork.fingerprint ?? "",
        resolvedVisualProfileReferences: [],
        artDirectionFingerprint: "",
        settings: {
          quality: options.story.artwork.quality,
          size: options.story.artwork.size,
          aspectRatio: options.story.artwork.aspectRatio,
          outputFormat: options.story.artwork.outputFormat,
        },
        review: scene.artwork.review ?? "unreviewed",
      };
      scene.artwork.versions = [v1];
      if (scene.artwork.review === "approved") {
        scene.artwork.approvedVersionId = "v1";
      }
    }
  }

  let selected = options.sceneId ? manifest.scenes.filter((scene) => scene.id === options.sceneId) : manifest.scenes;
  if (options.sceneId && !selected.length) throw new ArtworkError(`Scene '${options.sceneId}' was not found`);

  const candidates: Array<{
    scene: Scene;
    prompt: string;
    resolved: ResolvedSceneVisualPrompt;
    refs: Awaited<ReturnType<typeof loadCharacterVisualReferences>>;
    continuityReference?: VisualContinuityReferenceDecision;
    inputFingerprint: string;
  }> = [];

  for (const scene of selected) {
    const refs = await loadCharacterVisualReferences(options.root, options.story.slug, scene.characters);
    const activePreset = resolveActiveArtDirection(artDirectionConfig, scene.overrides?.artDirectionPresetId);
    const sceneContinuity = continuityByScene.get(scene.id);
    const continuityText = sceneContinuity ? renderSceneContinuity(sceneContinuity) : undefined;
    const continuityReference = sceneContinuity?.referenceDecision?.used ? sceneContinuity.referenceDecision : undefined;
    const resolved = resolveVisualCanonPrompt({
      scene,
      story: options.story,
      bible,
      artDirection: activePreset,
      visualProfiles,
      visualContinuity: continuityText,
    });

    const inputFingerprint = artworkFingerprint(
      scene,
      [...refs.map((ref) => ref.fingerprint), ...(continuityReference?.imageFingerprint ? [continuityReference.imageFingerprint] : [])],
      options.story,
      options.provider.version,
      {
        artDirectionFingerprint: resolved.artDirectionFingerprint,
        entityVisualFingerprints: resolved.entityVisualFingerprints,
        sceneDirectionFingerprint: resolved.sceneDirectionFingerprint,
        resolvedPromptFingerprint: resolved.resolvedPromptFingerprint,
        visualContinuityFingerprint: resolved.visualContinuityFingerprint,
      }
    );

    const actualImageFingerprint = await validPngFingerprint(
      sceneImagePath(options.root, options.story.slug, options.chapter, scene.id)
    );
    const validFile = Boolean(actualImageFingerprint && actualImageFingerprint === scene.artwork.imageFingerprint);
    const needs =
      options.force ||
      scene.artwork.status !== "complete" ||
      !validFile ||
      scene.artwork.fingerprint !== inputFingerprint ||
      scene.artwork.review === "needs-regeneration";

    if (needs) {
      candidates.push({ scene, prompt: resolved.prompt, resolved, refs, continuityReference: sceneContinuity?.referenceDecision, inputFingerprint });
    }
  }

  // Revalidate at the spend boundary, but only for scenes that will actually
  // call an image provider. Reused artwork never needs a new profile decision.
  const preflight = await inspectArtworkVisualPreflight({
    root: options.root,
    slug: options.story.slug,
    chapters: [options.chapter],
    sceneIds: candidates.map((candidate) => candidate.scene.id),
    allowUnprofiledEntityIds: options.allowUnprofiledEntityIds,
  });
  if (!preflight.ready && !options.dryRun) {
    throw new ArtworkError(`Visual Profile Check required before generating artwork: ${preflight.requiresDecision.map((entity) => entity.name).join(", ")}`);
  }

  if (options.dryRun) {
    return {
      dryRun: true,
      chapter: options.chapter,
      provider: options.story.artwork.provider,
      model: options.story.artwork.model,
      planned: manifest.scenes.length,
      selected: selected.length,
      imagesToGenerate: candidates.length,
      sceneIds: candidates.map((item) => item.scene.id),
      warnings,
      preflight,
    };
  }

  // Derivative freshness is per-version: scenes whose ORIGINALS are reused
  // still get stale/missing production derivatives rebuilt from those
  // originals (no provider calls).
  const candidateSceneIds = new Set(candidates.map((item) => item.scene.id));
  const upscaler = needsProductionDerivative(options.story) ? resolveUpscaler(options.upscaler) : undefined;
  let derivativesChanged = false;
  for (const scene of selected) {
    if (candidateSceneIds.has(scene.id) || scene.artwork.status !== "complete") continue;
    const version = backingArtworkVersion(scene);
    if (!version) continue;
    const changed = await ensureVersionProductionAsset({
      root: options.root, story: options.story, chapter: options.chapter,
      sceneId: scene.id, version, upscaler, warnings,
    });
    const synced = await syncCanonicalSceneImage(options.root, options.story, options.chapter, scene);
    derivativesChanged = derivativesChanged || changed || synced;
  }
  if (derivativesChanged) {
    manifest.updatedAt = new Date().toISOString();
    await atomicWriteJson(paths.scenesManifest, manifest);
    chapter.stages.video = { status: "pending" };
    chapter.video = undefined;
    await persistChapter(paths.chapterMeta, chapter);
  }

  if (!candidates.length) {
    return {
      dryRun: false,
      chapter: options.chapter,
      planned: manifest.scenes.length,
      selected: selected.length,
      imagesToGenerate: 0,
      generated: 0,
      reused: selected.length,
      warnings,
    };
  }

  await options.provider.validateConfiguration();
  const started = Date.now();
  chapter.stages.artwork = {
    status: "running",
    provider: options.story.artwork.provider,
    model: options.story.artwork.model,
    fingerprint: fingerprint({
      manifest: manifest.planningFingerprint,
      manualRevision: manifest.manualRevision,
      settings: options.story.artwork,
    }),
    startedAt: new Date().toISOString(),
  };
  await persistChapter(paths.chapterMeta, chapter);

  let generated = 0;
  let reused = selected.length - candidates.length;

  for (let index = 0; index < candidates.length; index++) {
    const item = candidates[index]!;
    item.scene.artwork = {
      ...item.scene.artwork,
      status: "running",
      provider: options.provider.name,
      model: options.story.artwork.model,
      fingerprint: item.inputFingerprint,
      error: undefined,
    };
    manifest.updatedAt = new Date().toISOString();
    await atomicWriteJson(paths.scenesManifest, manifest);

    options.onProgress?.({
      type: "artwork.scene.started",
      chapter: options.chapter,
      scene: item.scene.id,
      index: index + 1,
      total: candidates.length,
    });

    try {
      const references = await loadSceneReferenceImages(options.root, options.story, item.resolved, item.continuityReference, options.chapter);
      const providerPrompt = references.images.length
        ? `${item.prompt}\n\n${REFERENCE_USAGE_INSTRUCTION}`
        : item.prompt;
      const result = await generateSceneImage(options.provider, options.story, providerPrompt, {
        negativePrompt: item.resolved.negativePrompt || undefined,
        referenceImages: references.images,
      });
      const imageFingerprint = fingerprint(result.data.toString("base64"));
      const returnedDimensions = result.width && result.height ? { width: result.width, height: result.height } : imageDimensions(result.data);

      // Determine next version number
      const existingVersions = item.scene.artwork.versions ?? [];
      const nextVersionNumber =
        existingVersions.length > 0 ? Math.max(...existingVersions.map((v) => v.versionNumber), 0) + 1 : 1;
      const versionId = `v${nextVersionNumber}`;

      // Write version-specific file (the immutable ORIGINAL provider image)
      const versionImagePath = sceneVersionImagePath(
        options.root,
        options.story.slug,
        options.chapter,
        item.scene.id,
        nextVersionNumber
      );
      await atomicWrite(versionImagePath, result.data);

      // Create new artwork version record
      const newVersion: ArtworkVersion = {
        id: versionId,
        versionNumber: nextVersionNumber,
        sceneId: item.scene.id,
        imagePath: `${item.scene.id}-v${nextVersionNumber}.png`,
        imageFingerprint,
        createdAt: new Date().toISOString(),
        provider: options.provider.name,
        model: options.story.artwork.model,
        prompt: providerPrompt,
        promptFingerprint: item.inputFingerprint,
        resolvedVisualProfileReferences: item.resolved.resolvedEntities.map((e) => ({
          entityId: e.entityId,
          name: e.name,
          role: e.type,
        })),
        artDirectionFingerprint: item.resolved.artDirectionFingerprint,
        settings: {
          quality: options.story.artwork.quality,
          size: options.story.artwork.size,
          aspectRatio: options.story.artwork.aspectRatio,
          outputFormat: options.story.artwork.outputFormat,
        },
        ...(returnedDimensions
          ? { original: { ...returnedDimensions, fingerprint: imageFingerprint, provider: options.provider.name, model: options.story.artwork.model } }
          : {}),
        provenance: {
          referencesUsed: references.mode,
          referenceImageCount: references.images.length,
          availableReferenceCount: references.available,
          continuityReference: references.continuityReference,
        },
        review: "unreviewed",
      };

      // Derive the production asset (upscaled/normalized derivative) from the
      // preserved original. Never fails generation: an unavailable or failed
      // upscaler leaves the original as the production asset with a warning.
      await ensureVersionProductionAsset({
        root: options.root, story: options.story, chapter: options.chapter,
        sceneId: item.scene.id, version: newVersion, upscaler, warnings,
      });

      item.scene.artwork.versions = [...existingVersions, newVersion];
      item.scene.artwork.status = "complete";

      // If no version is approved yet, keep standard scene image updated for preview
      if (!item.scene.artwork.approvedVersionId) {
        const asset = await bestProductionAsset(options.root, options.story, options.chapter, item.scene.id, newVersion);
        const standardImagePath = sceneImagePath(options.root, options.story.slug, options.chapter, item.scene.id);
        await atomicWrite(standardImagePath, await readFile(asset.path));
        item.scene.artwork.review = "unreviewed";
        item.scene.artwork.provider = options.provider.name;
        item.scene.artwork.model = options.story.artwork.model;
        item.scene.artwork.fingerprint = item.inputFingerprint;
        item.scene.artwork.imageFingerprint = asset.fingerprint;
        item.scene.artwork.generatedAt = new Date().toISOString();
      }

      generated++;
      options.onProgress?.({
        type: "artwork.scene.completed",
        chapter: options.chapter,
        scene: item.scene.id,
        index: index + 1,
        total: candidates.length,
      });
    } catch (error) {
      item.scene.artwork = {
        ...item.scene.artwork,
        status: "failed",
        review: "needs-regeneration",
        error: error instanceof Error ? error.message : String(error),
      };
      await atomicWriteJson(paths.scenesManifest, manifest);
      chapter.stages.artwork = {
        ...chapter.stages.artwork,
        status: "failed",
        durationMs: Date.now() - started,
        error: { message: `${item.scene.id}: ${item.scene.artwork.error}` },
      };
      await persistChapter(paths.chapterMeta, chapter);
      throw new ArtworkError(`Artwork generation failed for ${item.scene.id}: ${item.scene.artwork.error}`, {
        cause: error,
      });
    }
    await atomicWriteJson(paths.scenesManifest, manifest);
  }

  const outputFingerprint = fingerprint(
    manifest.scenes.map((scene) => ({
      id: scene.id,
      fingerprint: scene.artwork.fingerprint,
      imageFingerprint: scene.artwork.imageFingerprint,
      review: scene.artwork.review,
      approvedVersionId: scene.artwork.approvedVersionId,
    }))
  );
  const allGenerated = manifest.scenes.every((scene) => scene.artwork.status === "complete");
  chapter.stages.artwork = {
    ...chapter.stages.artwork,
    status: allGenerated ? "complete" : "pending",
    outputFingerprint,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    usage: { requests: generated },
  };
  chapter.scenes = {
    total: manifest.scenes.length,
    generated: manifest.scenes.filter((scene) => scene.artwork.status === "complete").length,
    approved: manifest.scenes.filter((scene) => scene.artwork.review === "approved").length,
  };
  if (generated) {
    chapter.stages.video = { status: "pending" };
    chapter.video = undefined;
  }
  await persistChapter(paths.chapterMeta, chapter);
  return {
    dryRun: false,
    chapter: options.chapter,
    planned: manifest.scenes.length,
    selected: selected.length,
    imagesToGenerate: candidates.length,
    generated,
    reused,
    warnings,
  };
}

export async function reviewStoredArtworkVersion(options: {
  root: string;
  story: Story;
  chapter: number;
  sceneId: string;
  versionId: string;
  review?: "approved" | "unreviewed" | "rejected" | "needs-regeneration";
}) {
  const reviewAction = options.review ?? "approved";
  const paths = storyPaths(options.root, options.story.slug, options.chapter);
  const raw = await readJsonIfExists<SceneManifest>(paths.scenesManifest);
  if (!raw) throw new ArtworkError(`Chapter ${options.chapter} has no scene plan`);
  const manifest = sceneManifestSchema.parse(raw);
  const scene = manifest.scenes.find((item) => item.id === options.sceneId);
  if (!scene) throw new ArtworkError(`Scene '${options.sceneId}' was not found`);

  const version = scene.artwork.versions.find((v) => v.id === options.versionId);
  if (!version) throw new ArtworkError(`Artwork version '${options.versionId}' was not found for scene '${options.sceneId}'`);

  if (reviewAction === "approved") {
    // Locate the version image file
    let versionPath = sceneVersionImagePath(options.root, options.story.slug, options.chapter, scene.id, version.versionNumber);
    let versionFileExists = await exists(versionPath);
    if (!versionFileExists) {
      // Check if legacy imagePath can be found
      const fallbackPath = sceneImagePath(options.root, options.story.slug, options.chapter, scene.id);
      if (await exists(fallbackPath)) {
        versionPath = fallbackPath;
        versionFileExists = true;
      }
    }
    if (!versionFileExists) {
      throw new ArtworkError("Version image file does not exist on disk");
    }

    const actualFingerprint = await validPngFingerprint(versionPath);
    if (!actualFingerprint || (version.imageFingerprint && actualFingerprint !== version.imageFingerprint)) {
      throw new ArtworkError("Only intact, successfully generated artwork can be approved");
    }

    // Update versions state
    for (const v of scene.artwork.versions) {
      v.review = v.id === options.versionId ? "approved" : "unreviewed";
    }
    scene.artwork.approvedVersionId = options.versionId;
    scene.artwork.review = "approved";
    // Sync the approved version's best production asset to sceneImagePath
    // (${sceneId}.png) for downstream video.
    await syncCanonicalSceneImage(options.root, options.story, options.chapter, scene);
    scene.artwork.fingerprint = version.promptFingerprint;
  } else {
    // Unapproving or marking needs-regeneration
    version.review = reviewAction;
    if (scene.artwork.approvedVersionId === options.versionId) {
      scene.artwork.approvedVersionId = undefined;
      scene.artwork.review = reviewAction;
    }
  }

  manifest.updatedAt = new Date().toISOString();
  await atomicWriteJson(paths.scenesManifest, manifest);

  const chapterRaw = await readJsonIfExists<Chapter>(paths.chapterMeta);
  if (chapterRaw) {
    const chapter = chapterSchema.parse(chapterRaw);
    chapter.scenes = {
      total: manifest.scenes.length,
      generated: manifest.scenes.filter((item) => item.artwork.status === "complete").length,
      approved: manifest.scenes.filter((item) => item.artwork.review === "approved").length,
    };
    chapter.stages.video = { status: "pending" };
    chapter.video = undefined;
    await persistChapter(paths.chapterMeta, chapter);
  }

  return manifest;
}

export async function reviewStoredArtwork(options: {
  root: string;
  story: Story;
  chapter: number;
  sceneId: string;
  review: unknown;
}) {
  const review = artworkReviewSchema.parse(options.review);
  const paths = storyPaths(options.root, options.story.slug, options.chapter);
  const raw = await readJsonIfExists<SceneManifest>(paths.scenesManifest);
  if (!raw) throw new ArtworkError(`Chapter ${options.chapter} has no scene plan`);
  const manifest = sceneManifestSchema.parse(raw);
  const scene = manifest.scenes.find((item) => item.id === options.sceneId);
  if (!scene) throw new ArtworkError(`Scene '${options.sceneId}' was not found`);

  if (review === "approved") {
    const actual = await validPngFingerprint(
      sceneImagePath(options.root, options.story.slug, options.chapter, scene.id)
    );
    if (scene.artwork.status !== "complete" || !actual || (scene.artwork.imageFingerprint && actual !== scene.artwork.imageFingerprint)) {
      throw new ArtworkError("Only intact, successfully generated artwork can be approved");
    }

    // If versions exist, approve the approvedVersionId or the latest version
    if (scene.artwork.versions && scene.artwork.versions.length > 0) {
      const targetVersionId = scene.artwork.approvedVersionId ?? scene.artwork.versions[scene.artwork.versions.length - 1]!.id;
      return reviewStoredArtworkVersion({
        root: options.root,
        story: options.story,
        chapter: options.chapter,
        sceneId: options.sceneId,
        versionId: targetVersionId,
        review: "approved",
      });
    }
  }

  scene.artwork.review = review;
  if (review !== "approved") {
    scene.artwork.approvedVersionId = undefined;
  }
  manifest.updatedAt = new Date().toISOString();
  await atomicWriteJson(paths.scenesManifest, manifest);

  const chapterRaw = await readJsonIfExists<Chapter>(paths.chapterMeta);
  if (chapterRaw) {
    const chapter = chapterSchema.parse(chapterRaw);
    chapter.scenes = {
      total: manifest.scenes.length,
      generated: manifest.scenes.filter((item) => item.artwork.status === "complete").length,
      approved: manifest.scenes.filter((item) => item.artwork.review === "approved").length,
    };
    chapter.stages.video = { status: "pending" };
    chapter.video = undefined;
    await persistChapter(paths.chapterMeta, chapter);
  }
  return manifest;
}

export function artworkFingerprint(
  scene: Scene,
  visualReferenceFingerprints: string[],
  story: Story,
  providerVersion: string,
  extra?: {
    artDirectionFingerprint?: string;
    entityVisualFingerprints?: Record<string, string>;
    sceneDirectionFingerprint?: string;
    resolvedPromptFingerprint?: string;
    visualContinuityFingerprint?: string;
  }
) {
  const artDirectionFingerprint =
    extra?.artDirectionFingerprint ??
    (scene.artwork.versions?.length
      ? scene.artwork.versions[scene.artwork.versions.length - 1]?.artDirectionFingerprint
      : undefined);

  return fingerprint({
    scene: sceneContentFingerprint(scene),
    visualReferenceFingerprints,
    style: story.artwork.stylePrompt,
    aspectRatio: story.artwork.aspectRatio,
    quality: story.artwork.quality,
    size: story.artwork.size,
    outputFormat: story.artwork.outputFormat,
    provider: story.artwork.provider,
    model: story.artwork.model,
    providerVersion,
    visualCanonArtworkVersion: VISUAL_CANON_ARTWORK_VERSION,
    ...(artDirectionFingerprint ? { artDirectionFingerprint } : {}),
    ...(extra?.entityVisualFingerprints && Object.keys(extra.entityVisualFingerprints).length > 0
      ? { entityVisualFingerprints: extra.entityVisualFingerprints }
      : {}),
    ...(extra?.visualContinuityFingerprint ? { visualContinuityFingerprint: extra.visualContinuityFingerprint } : {}),
  });
}

export function artworkPrompt(
  scene: Scene,
  refs: Array<{ name: string; description: string }>,
  style: string,
  size: string,
  aspectRatio?: ImageAspectRatio
) {
  const resolvedRatio = resolveArtworkAspectRatio({
    artwork: { aspectRatio, size },
  });
  return [
    `STORY-WIDE ART DIRECTION: ${style}`,
    `SCENE: ${scene.visualPrompt}`,
    `SUMMARY: ${scene.summary}`,
    scene.location ? `LOCATION: ${scene.location}` : "",
    scene.characters.length ? `CHARACTERS: ${scene.characters.join(", ")}` : "",
    ...refs.map((ref) => `CANONICAL VISUAL REFERENCE — ${ref.name}: ${ref.description}`),
    artworkCompositionGuidance(resolvedRatio),
    `Create one polished still illustration. No text, captions, speech bubbles, logos, or watermarks.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generateSceneImage(
  provider: ImageProvider,
  story: Story,
  prompt: string,
  extras?: { negativePrompt?: string; referenceImages?: ImageReferenceImage[] }
) {
  const result = await withRetry(
    () =>
      provider.generate({
        model: story.artwork.model,
        prompt,
        negativePrompt: extras?.negativePrompt,
        aspectRatio: story.artwork.aspectRatio,
        quality: story.artwork.quality,
        size: story.artwork.size,
        outputFormat: story.artwork.outputFormat,
        referenceImages: extras?.referenceImages,
      }),
    retryConfigSchema.parse({})
  );
  validatePng(result.data);
  return result;
}

type ContinuityReferenceProvenance = { kind: "previous-scene" | "previous-chapter" | "none"; used: boolean; reason?: string };
type SceneReferencePayload = { images: ImageReferenceImage[]; available: number; mode: "images" | "text-only" | "none"; continuityReference: ContinuityReferenceProvenance };

export type VisualProfileReferencePayload = {
  images: ImageReferenceImage[];
  available: number;
  mode: "images" | "text-only" | "none";
  loadedEntityIds: string[];
  loadedReferenceIds: string[];
  referenceFingerprints: string[];
};

/** Shared, approved-only Visual Profile reference loader. Summary artwork uses
 * the same reference eligibility and byte limits as chapter artwork. */
export async function loadApprovedVisualProfileReferences(root: string, story: Story, resolved: ResolvedSceneVisualPrompt): Promise<VisualProfileReferencePayload> {
  const byEntity: VisualReferenceImage[][] = [];
  for (const entity of resolved.resolvedEntities) {
    if (!entity.useVisualProfile) continue;
    const refs = (entity.references ?? []).filter((ref) => ref.approved).sort((left, right) => Number(right.role === "primary_reference") - Number(left.role === "primary_reference"));
    if (refs.length) byEntity.push(refs);
  }
  // Give each visible entity a chance to contribute its primary reference
  // before spending the shared provider budget on additional references.
  const wanted: VisualReferenceImage[] = [];
  const maxRefs = Math.max(0, ...byEntity.map((refs) => refs.length));
  for (let index = 0; index < maxRefs; index++) for (const refs of byEntity) if (refs[index]) wanted.push(refs[index]!);
  const available = wanted.length;
  if (!available) return { images: [], available: 0, mode: "none", loadedEntityIds: [], loadedReferenceIds: [], referenceFingerprints: [] };
  if (!providerSupportsReferenceImages(story.artwork.provider, story.artwork.model)) return { images: [], available, mode: "text-only", loadedEntityIds: [], loadedReferenceIds: [], referenceFingerprints: [] };
  const images: ImageReferenceImage[] = [];
  const loadedEntityIds = new Set<string>();
  const loadedReferenceIds: string[] = [];
  const referenceFingerprints: string[] = [];
  let totalBytes = 0;
  for (const ref of wanted) {
    if (images.length >= MAX_REFERENCE_IMAGES) break;
    const hint = /\.([a-zA-Z0-9]+)$/.exec(ref.imagePath)?.[1];
    const file = await findVisualReferenceFile(root, story.slug, ref.entityId, ref.id, hint);
    if (!file) continue;
    const data = await readFile(file.path);
    if (!data.length || data.length > MAX_REFERENCE_IMAGE_BYTES || totalBytes + data.length > MAX_REFERENCE_TOTAL_BYTES) continue;
    totalBytes += data.length;
    images.push({ data, mimeType: mimeForVisualReferenceExtension(file.ext), role: ref.role });
    loadedEntityIds.add(ref.entityId);
    loadedReferenceIds.push(ref.id);
    referenceFingerprints.push(fingerprint(data.toString("base64")));
  }
  return { images, available, mode: images.length ? "images" : "text-only", loadedEntityIds: [...loadedEntityIds], loadedReferenceIds, referenceFingerprints };
}

/** Collect Visual Canon reference images for a scene, then the resolved visual
 * continuity reference (previous scene / previous chapter approved artwork)
 * after canonical refs within the same budget. Bytes are resolved only through
 * controlled scene/version paths — always the ORIGINAL provider images, never
 * 4K production derivatives, so the reference budget stays bounded. When the
 * effective provider/model cannot consume image input, the textual canon stays
 * in the prompt and provenance records the text-only fallback. A missing or
 * unreadable continuity image is skipped — generation never fails on it. */
async function loadSceneReferenceImages(root: string, story: Story, resolved: ResolvedSceneVisualPrompt, continuityDecision?: VisualContinuityReferenceDecision, chapter?: number): Promise<SceneReferencePayload> {
  const canonicalReferences = await loadApprovedVisualProfileReferences(root, story, resolved);
  const continuityReference: ContinuityReferenceProvenance = continuityDecision
    ? { kind: continuityDecision.kind, used: false, reason: continuityDecision.reason }
    : { kind: "none", used: false };
  const supportsImages = providerSupportsReferenceImages(story.artwork.provider, story.artwork.model);
  const available = canonicalReferences.available + (continuityDecision?.used ? 1 : 0);
  if (!available) return { images: [], available: 0, mode: "none", continuityReference };
  if (!supportsImages) {
    if (continuityDecision?.used) continuityReference.reason = continuityReference.reason ? `${continuityReference.reason}; provider cannot consume reference images, textual continuity retained` : "provider cannot consume reference images, textual continuity retained";
    return { images: [], available, mode: "text-only", continuityReference };
  }
  const images: ImageReferenceImage[] = [...canonicalReferences.images];
  let totalBytes = images.reduce((sum, image) => sum + image.data.length, 0);
  if (continuityDecision?.used && continuityDecision.sourceSceneId && continuityDecision.versionNumber && chapter !== undefined && images.length < MAX_REFERENCE_IMAGES) {
    const sourceChapter = continuityDecision.kind === "previous-chapter" ? continuityDecision.sourceChapter : chapter;
    try {
      if (sourceChapter === undefined) throw new Error("missing source chapter");
      const path = sceneVersionImagePath(root, story.slug, sourceChapter, continuityDecision.sourceSceneId, continuityDecision.versionNumber);
      const data = await readFile(path);
      if (!data.length || data.length > MAX_REFERENCE_IMAGE_BYTES || totalBytes + data.length > MAX_REFERENCE_TOTAL_BYTES) throw new Error("continuity reference exceeds reference image budget");
      validatePng(data);
      images.push({ data, mimeType: "image/png", role: continuityDecision.kind });
      continuityReference.used = true;
    } catch {
      continuityReference.reason = continuityReference.reason ? `${continuityReference.reason}; continuity image unavailable, textual continuity retained` : "continuity image unavailable, textual continuity retained";
    }
  }
  return { images, available, mode: images.length ? "images" : "text-only", continuityReference };
}

function validatePng(data: Buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 45 || !data.subarray(0, 8).equals(signature))
    throw new ArtworkError("Image provider returned invalid PNG data");
  let offset = 8;
  let sawHeader = false;
  let sawEnd = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) throw new ArtworkError("Image provider returned truncated PNG data");
    const type = data.toString("ascii", offset + 4, offset + 8);
    if (!sawHeader) {
      if (
        type !== "IHDR" ||
        length !== 13 ||
        data.readUInt32BE(offset + 8) === 0 ||
        data.readUInt32BE(offset + 12) === 0
      )
        throw new ArtworkError("Image provider returned invalid PNG header data");
      sawHeader = true;
    }
    if (type === "IEND") {
      if (length !== 0 || end !== data.length) throw new ArtworkError("Image provider returned invalid PNG trailer data");
      sawEnd = true;
      break;
    }
    offset = end;
  }
  if (!sawHeader || !sawEnd) throw new ArtworkError("Image provider returned incomplete PNG data");
}

export async function validPngFingerprint(path: string) {
  try {
    const data = await readFile(path);
    validatePng(data);
    return fingerprint(data.toString("base64"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof ArtworkError) return undefined;
    throw error;
  }
}

/** The version currently backing the canonical scene image: the approved
 * version when one exists, otherwise the latest generated version. */
export function backingArtworkVersion(scene: Scene): ArtworkVersion | undefined {
  const versions = scene.artwork.versions ?? [];
  if (!versions.length) return undefined;
  if (scene.artwork.approvedVersionId) {
    const approved = versions.find((version) => version.id === scene.artwork.approvedVersionId);
    if (approved) return approved;
  }
  return versions[versions.length - 1];
}

/** The asset consumers should render: the production derivative when it is
 * current (upscale fingerprint matches today's settings and the derivative
 * file is intact), otherwise the immutable ORIGINAL provider image. */
export async function resolveBestProductionAssetForPaths(options: {
  story: Story;
  version: ArtworkVersion;
  originalPath: string;
  productionPath: string;
}): Promise<{ path: string; fingerprint: string; width?: number; height?: number; upscaled: boolean; engine?: string }> {
  const { story, version, originalPath, productionPath } = options;
  const original = {
    path: originalPath,
    fingerprint: version.imageFingerprint,
    width: version.original?.width,
    height: version.original?.height,
    upscaled: false,
  };
  const upscale = version.upscale;
  if (upscale?.status !== "applied" || !upscale.fingerprint || !upscale.outputFingerprint) return original;
  const expected = upscaleFingerprint({
    originalFingerprint: version.imageFingerprint,
    resolution: story.artwork.outputResolution,
    upscaling: story.artwork.upscaling,
    engine: story.artwork.upscaler,
    model: upscale.model,
    target: resolveTargetDimensions(story.artwork.outputResolution, story.artwork.aspectRatio),
  });
  if (upscale.fingerprint !== expected) return original;
  const actual = await validPngFingerprint(productionPath);
  if (!actual || actual !== upscale.outputFingerprint) return original;
  return {
    path: productionPath,
    fingerprint: upscale.outputFingerprint,
    width: upscale.finalDimensions?.width,
    height: upscale.finalDimensions?.height,
    upscaled: true,
    engine: upscale.engine,
  };
}

/** The asset consumers should render: the production derivative when it is
 * current (upscale fingerprint matches today's settings and the derivative
 * file is intact), otherwise the immutable ORIGINAL provider image. */
export async function bestProductionAsset(
  root: string,
  story: Story,
  chapter: number,
  sceneId: string,
  version: ArtworkVersion
): Promise<{ path: string; fingerprint: string; width?: number; height?: number; upscaled: boolean; engine?: string }> {
  return resolveBestProductionAssetForPaths({
    story,
    version,
    originalPath: sceneVersionImagePath(root, story.slug, chapter, sceneId, version.versionNumber),
    productionPath: sceneVersionProductionImagePath(root, story.slug, chapter, sceneId, version.versionNumber),
  });
}

export async function syncCanonicalSceneImageForPaths(options: {
  story: Story;
  scene: Scene;
  originalPath: string;
  productionPath: string;
  standardImagePath: string;
}): Promise<boolean> {
  const { story, scene, originalPath, productionPath, standardImagePath } = options;
  const version = backingArtworkVersion(scene);
  if (!version || scene.artwork.status !== "complete") return false;
  const asset = await resolveBestProductionAssetForPaths({ story, version, originalPath, productionPath });
  const current = await validPngFingerprint(standardImagePath);
  if (current === asset.fingerprint && scene.artwork.imageFingerprint === asset.fingerprint) return false;
  await atomicWrite(standardImagePath, await readFile(asset.path));
  scene.artwork.imageFingerprint = asset.fingerprint;
  return true;
}

/** Keep the canonical ${sceneId}.png in sync with the backing version's best
 * production asset. Returns true when the canonical image (or its recorded
 * fingerprint) changed. */
async function syncCanonicalSceneImage(root: string, story: Story, chapter: number, scene: Scene): Promise<boolean> {
  const version = backingArtworkVersion(scene);
  if (!version) return false;
  return syncCanonicalSceneImageForPaths({
    story,
    scene,
    originalPath: sceneVersionImagePath(root, story.slug, chapter, scene.id, version.versionNumber),
    productionPath: sceneVersionProductionImagePath(root, story.slug, chapter, scene.id, version.versionNumber),
    standardImagePath: sceneImagePath(root, story.slug, chapter, scene.id),
  });
}

export async function ensureArtworkVersionProductionAssetForPaths(options: {
  story: Story;
  sceneId: string;
  version: ArtworkVersion;
  originalPath: string;
  productionPath: string;
  upscaler?: ImageUpscaler;
  warnings: string[];
}): Promise<boolean> {
  const { story, version, originalPath, productionPath } = options;
  const settings = story.artwork;
  let sourceDimensions = version.original ? { width: version.original.width, height: version.original.height } : undefined;
  if (!sourceDimensions) {
    sourceDimensions = (await exists(originalPath)) ? imageDimensions(await readFile(originalPath)) : undefined;
  }
  const estimate = estimateNativeDimensions(
    imageNativeTiers(settings.provider, settings.aspectRatio, settings.model),
    qualityTierIndex(settings.quality)
  );
  const plan = planResolution({
    requested: settings.outputResolution,
    aspectRatio: settings.aspectRatio,
    upscaling: settings.upscaling,
    nativeWidth: sourceDimensions?.width,
    nativeHeight: sourceDimensions?.height,
    nativeEstimate: estimate,
  });
  const expectedFingerprint = upscaleFingerprint({
    originalFingerprint: version.imageFingerprint,
    resolution: settings.outputResolution,
    upscaling: settings.upscaling,
    engine: settings.upscaler,
    model: options.upscaler?.model,
    target: plan.target,
  });
  if (!sourceDimensions) {
    if (plan.action !== "none") options.warnings.push(`Scene ${options.sceneId}: cannot derive production asset, original image dimensions are unknown.`);
    return false;
  }
  const base = {
    engine: settings.upscaler,
    model: options.upscaler?.model,
    sourceFingerprint: version.imageFingerprint,
    sourceDimensions,
    targetDimensions: plan.target ?? sourceDimensions,
    fingerprint: expectedFingerprint,
  };
  const current = version.upscale;
  if (plan.action === "none") {
    if (current?.status === "skipped-not-required" && current.fingerprint === expectedFingerprint) return false;
    version.upscale = { ...base, status: "skipped-not-required" };
    return true;
  }
  if (!options.upscaler) return false;
  if (current?.status === "applied" && current.fingerprint === expectedFingerprint) {
    const actual = await validPngFingerprint(productionPath);
    if (actual && actual === current.outputFingerprint) return false;
  }
  const request = {
    sourcePath: originalPath,
    sourceWidth: sourceDimensions.width,
    sourceHeight: sourceDimensions.height,
    targetWidth: plan.target!.width,
    targetHeight: plan.target!.height,
    outputPath: productionPath,
  };
  try {
    const result = plan.action === "normalize" ? await options.upscaler.normalize(request) : await options.upscaler.upscale(request);
    const outputFingerprint = await validPngFingerprint(result.outputPath);
    if (!outputFingerprint) throw new Error("upscaler produced an invalid image");
    version.upscale = {
      ...base,
      status: "applied",
      finalDimensions: result.finalDimensions,
      scaleFactor: result.scaleFactor,
      fit: result.fit,
      outputFingerprint,
    };
    return true;
  } catch (error) {
    const unavailable = error instanceof ConfigurationError;
    const warning = error instanceof Error ? error.message : String(error);
    version.upscale = { ...base, status: unavailable ? "unavailable" : "failed", warning };
    options.warnings.push(
      unavailable
        ? `Scene ${options.sceneId}: upscaler unavailable (${warning}). The original image remains the production asset.`
        : `Scene ${options.sceneId}: upscaling failed (${warning}). The original image remains the production asset.`
    );
    return true;
  }
}

/** Derive (or record the skip of) the production derivative for ONE artwork
 * version, always consuming the preserved ORIGINAL provider image — never a
 * derivative. Generation is never failed by upscaler problems. */
async function ensureVersionProductionAsset(options: {
  root: string;
  story: Story;
  chapter: number;
  sceneId: string;
  version: ArtworkVersion;
  upscaler?: ImageUpscaler;
  warnings: string[];
}): Promise<boolean> {
  return ensureArtworkVersionProductionAssetForPaths({
    story: options.story,
    sceneId: options.sceneId,
    version: options.version,
    originalPath: sceneVersionImagePath(options.root, options.story.slug, options.chapter, options.sceneId, options.version.versionNumber),
    productionPath: sceneVersionProductionImagePath(options.root, options.story.slug, options.chapter, options.sceneId, options.version.versionNumber),
    upscaler: options.upscaler,
    warnings: options.warnings,
  });
}

/** Re-run ONLY the derivative step from preserved originals (no provider
 * calls) for versions whose upscale fingerprint is stale or missing. Used
 * when outputResolution/upscaling/upscaler settings change. */
export async function reupscaleStoredArtwork(options: {
  root: string;
  story: Story;
  chapter: number;
  sceneId?: string;
  versionNumber?: number;
  upscaler?: ImageUpscaler;
}) {
  const paths = storyPaths(options.root, options.story.slug, options.chapter);
  const raw = await readJsonIfExists<SceneManifest>(paths.scenesManifest);
  if (!raw) throw new ArtworkError(`Chapter ${options.chapter} has no scene plan`);
  const manifest = sceneManifestSchema.parse(raw);
  const scenes = options.sceneId ? manifest.scenes.filter((scene) => scene.id === options.sceneId) : manifest.scenes;
  if (options.sceneId && !scenes.length) throw new ArtworkError(`Scene '${options.sceneId}' was not found`);

  const warnings: string[] = [];
  const upscaler = needsProductionDerivative(options.story) ? resolveUpscaler(options.upscaler) : undefined;
  const rederived: Array<{ sceneId: string; versionId: string; status: string }> = [];
  let changed = false;
  for (const scene of scenes) {
    for (const version of scene.artwork.versions ?? []) {
      if (options.versionNumber !== undefined && version.versionNumber !== options.versionNumber) continue;
      const originalPath = sceneVersionImagePath(options.root, options.story.slug, options.chapter, scene.id, version.versionNumber);
      const actual = await validPngFingerprint(originalPath);
      if (!actual || actual !== version.imageFingerprint) {
        warnings.push(`Scene ${scene.id} ${version.id}: original image is missing or corrupt, skipping re-upscale.`);
        continue;
      }
      const didChange = await ensureVersionProductionAsset({
        root: options.root, story: options.story, chapter: options.chapter,
        sceneId: scene.id, version, upscaler, warnings,
      });
      if (didChange) {
        changed = true;
        rederived.push({ sceneId: scene.id, versionId: version.id, status: version.upscale?.status ?? "unknown" });
      }
    }
    if (await syncCanonicalSceneImage(options.root, options.story, options.chapter, scene)) changed = true;
  }

  if (changed) {
    manifest.updatedAt = new Date().toISOString();
    await atomicWriteJson(paths.scenesManifest, manifest);
    const chapterRaw = await readJsonIfExists<Chapter>(paths.chapterMeta);
    if (chapterRaw) {
      const chapter = chapterSchema.parse(chapterRaw);
      chapter.stages.video = { status: "pending" };
      chapter.video = undefined;
      await persistChapter(paths.chapterMeta, chapter);
    }
  }
  return { chapter: options.chapter, rederived, warnings };
}

async function persistChapter(path: string, chapter: Chapter) {
  chapter.updatedAt = new Date().toISOString();
  await atomicWriteJson(path, chapterSchema.parse(chapter));
}
