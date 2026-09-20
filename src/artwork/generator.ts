import { readFile } from "node:fs/promises";
import { Chapter, chapterSchema } from "../domain/chapter.js";
import { Story } from "../domain/story.js";
import { ArtworkError } from "../pipeline/errors.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { sceneImagePath, sceneVersionImagePath, storyPaths } from "../storage/paths.js";
import { exists, readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { sceneContentFingerprint } from "../scenes/manifest.js";
import { loadCharacterVisualReferences } from "../scenes/visual-references.js";
import { artworkReviewSchema, ArtworkVersion, Scene, SceneManifest, sceneManifestSchema } from "../scenes/types.js";
import { ImageProvider, ImageReferenceImage } from "./provider.js";
import { withRetry } from "../batch/retry.js";
import { retryConfigSchema } from "../batch/types.js";
import { loadVisualProfiles } from "../visual-canon/profiles.js";
import { loadStoryArtDirection, resolveActiveArtDirection } from "../visual-canon/art-direction.js";
import { resolveVisualCanonPrompt, ResolvedSceneVisualPrompt } from "../visual-canon/resolver.js";
import { renderSceneContinuity, resolveChapterVisualContinuity, VisualContinuityReferenceDecision } from "../visual-canon/continuity.js";
import { emptyStoryBible, storyBibleSchema, StoryBible } from "../domain/story-bible.js";
import { assertImageModelCompatible, MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES, MAX_REFERENCE_TOTAL_BYTES, providerSupportsReferenceImages } from "./providers.js";
import { findVisualReferenceFile, mimeForVisualReferenceExtension } from "../visual-canon/assets.js";
import { VisualReferenceImage } from "../domain/visual-profile.js";
import { stageFreshness, stalePrerequisiteWarning } from "../studio/artifact-state.js";

export async function generateStoredArtwork(options: {
  root: string;
  story: Story;
  chapter: number;
  provider: ImageProvider;
  sceneId?: string;
  force?: boolean;
  dryRun?: boolean;
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
    };
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
      const result = await generateSceneImage(options.provider, options.story, item.prompt, {
        negativePrompt: item.resolved.negativePrompt || undefined,
        referenceImages: references.images,
      });
      const imageFingerprint = fingerprint(result.data.toString("base64"));

      // Determine next version number
      const existingVersions = item.scene.artwork.versions ?? [];
      const nextVersionNumber =
        existingVersions.length > 0 ? Math.max(...existingVersions.map((v) => v.versionNumber), 0) + 1 : 1;
      const versionId = `v${nextVersionNumber}`;

      // Write version-specific file
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
        prompt: item.prompt,
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
        provenance: {
          referencesUsed: references.mode,
          referenceImageCount: references.images.length,
          availableReferenceCount: references.available,
          continuityReference: references.continuityReference,
        },
        review: "unreviewed",
      };

      item.scene.artwork.versions = [...existingVersions, newVersion];
      item.scene.artwork.status = "complete";

      // If no version is approved yet, keep standard scene image updated for preview
      if (!item.scene.artwork.approvedVersionId) {
        const standardImagePath = sceneImagePath(options.root, options.story.slug, options.chapter, item.scene.id);
        await atomicWrite(standardImagePath, result.data);
        item.scene.artwork.review = "unreviewed";
        item.scene.artwork.provider = options.provider.name;
        item.scene.artwork.model = options.story.artwork.model;
        item.scene.artwork.fingerprint = item.inputFingerprint;
        item.scene.artwork.imageFingerprint = imageFingerprint;
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

    // Sync approved image to sceneImagePath (${sceneId}.png) for downstream video
    const standardImagePath = sceneImagePath(options.root, options.story.slug, options.chapter, scene.id);
    const data = await readFile(versionPath);
    await atomicWrite(standardImagePath, data);

    // Update versions state
    for (const v of scene.artwork.versions) {
      v.review = v.id === options.versionId ? "approved" : "unreviewed";
    }
    scene.artwork.approvedVersionId = options.versionId;
    scene.artwork.review = "approved";
    scene.artwork.imageFingerprint = actualFingerprint;
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
  size: string
) {
  const [width = 0, height = 0] = size.split("x").map(Number);
  const orientation = width >= height ? "landscape" : "portrait";
  return [
    `STORY-WIDE ART DIRECTION: ${style}`,
    `SCENE: ${scene.visualPrompt}`,
    `SUMMARY: ${scene.summary}`,
    scene.location ? `LOCATION: ${scene.location}` : "",
    scene.characters.length ? `CHARACTERS: ${scene.characters.join(", ")}` : "",
    ...refs.map((ref) => `CANONICAL VISUAL REFERENCE — ${ref.name}: ${ref.description}`),
    `Create one polished still illustration. ${orientation}-safe composition. No text, captions, speech bubbles, logos, or watermarks.`,
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

/** Collect Visual Canon reference images for a scene, then the resolved visual
 * continuity reference (previous scene / previous chapter approved artwork)
 * after canonical refs within the same budget. Bytes are resolved only through
 * controlled scene/version paths. When the effective provider/model cannot
 * consume image input, the textual canon stays in the prompt and provenance
 * records the text-only fallback. A missing or unreadable continuity image is
 * skipped — generation never fails on it. */
async function loadSceneReferenceImages(root: string, story: Story, resolved: ResolvedSceneVisualPrompt, continuityDecision?: VisualContinuityReferenceDecision, chapter?: number): Promise<SceneReferencePayload> {
  const wanted: VisualReferenceImage[] = [];
  for (const entity of resolved.resolvedEntities) {
    const refs = entity.references ?? [];
    wanted.push(...refs.filter((ref) => ref.approved), ...refs.filter((ref) => !ref.approved));
  }
  const continuityReference: ContinuityReferenceProvenance = continuityDecision
    ? { kind: continuityDecision.kind, used: false, reason: continuityDecision.reason }
    : { kind: "none", used: false };
  const supportsImages = providerSupportsReferenceImages(story.artwork.provider, story.artwork.model);
  const available = wanted.length + (continuityDecision?.used ? 1 : 0);
  if (!available) return { images: [], available: 0, mode: "none", continuityReference };
  if (!supportsImages) {
    if (continuityDecision?.used) continuityReference.reason = continuityReference.reason ? `${continuityReference.reason}; provider cannot consume reference images, textual continuity retained` : "provider cannot consume reference images, textual continuity retained";
    return { images: [], available, mode: "text-only", continuityReference };
  }
  const images: ImageReferenceImage[] = [];
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
  }
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

async function persistChapter(path: string, chapter: Chapter) {
  chapter.updatedAt = new Date().toISOString();
  await atomicWriteJson(path, chapterSchema.parse(chapter));
}
