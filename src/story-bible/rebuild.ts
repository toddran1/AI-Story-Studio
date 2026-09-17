import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { StoryBible, StoryBibleUpdate, emptyStoryBible, storyBibleUpdateSchema } from "../domain/story-bible.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { Chapter } from "../domain/chapter.js";
import { canonicalOverlaySchema } from "./canonical.js";
import { mergeStoryBible, normalizeStoryBibleUpdate } from "./updater.js";
import { SourceManifest, sourceManifestSchema } from "../source/types.js";
import { applyManualBibleOverlay } from "../studio/workflow.js";

/** Rebuilds canonical context solely from chronological per-chapter updates. */
export async function rebuildStoryBibleBeforeChapter(root: string, slug: string, chapter: number, options: { includeCanonicalOverlay?: boolean; chapterOverride?: { chapter: number; update: StoryBibleUpdate } } = {}): Promise<StoryBible> {
  let bible = emptyStoryBible();
  const paths = storyPaths(root, slug, chapter); const chaptersDir = join(paths.story, "chapters");
  const overlayRaw = await readJsonIfExists(paths.bibleCanonicalManual);
  const parsedOverlay = overlayRaw ? canonicalOverlaySchema.safeParse(overlayRaw) : undefined;
  const overlay = parsedOverlay?.success ? parsedOverlay.data : undefined;
  const manifestRaw = await readJsonIfExists<SourceManifest>(paths.sourceManifest);
  const manifest = manifestRaw ? sourceManifestSchema.safeParse(manifestRaw) : undefined;
  let numbers: number[] = [];
  try {
    numbers = (await readdir(chaptersDir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name)).filter((number) => Number.isSafeInteger(number) && number > 0 && number < chapter).sort((a, b) => a - b);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const number of numbers) {
    if (number === options.chapterOverride?.chapter) { bible = mergeStoryBible(bible, normalizeStoryBibleUpdate(options.chapterOverride.update, number), number); continue; }
    if (number === options.chapterOverride?.chapter) { bible = mergeStoryBible(bible, normalizeStoryBibleUpdate(options.chapterOverride.update, number), number, { overlay }); continue; }
    const metadata = await readJsonIfExists<Chapter>(storyPaths(root, slug, number).chapterMeta);
    const state = metadata?.stages?.storyBible;
    if (state?.status === "failed" && !state.outputFingerprint && !state.completedAt) continue;
    // A source fingerprint mismatch marks the extraction stale, not absent:
    // the completed update is still valid canon and remains part of the rebuild.
    const raw = await readJsonIfExists<StoryBibleUpdate>(storyPaths(root, slug, number).bibleUpdate);
    if (raw) bible = mergeStoryBible(bible, normalizeStoryBibleUpdate(storyBibleUpdateSchema.parse(raw), number), number);
    if (raw) bible = mergeStoryBible(bible, normalizeStoryBibleUpdate(storyBibleUpdateSchema.parse(raw), number), number, { overlay });
  }
  return (await applyManualBibleOverlay(root, slug, bible, { includeCanonical: options.includeCanonicalOverlay !== false })).bible;
}

/**
 * Chapters whose Story Bible extraction is complete but no longer matches the
 * current source (fingerprint drift or an explicit staleReason). Their updates
 * still contribute canon; callers surface them as stale evidence.
 */
export async function computeStaleExtractionChapters(root: string, slug: string): Promise<number[]> {
  const paths = storyPaths(root, slug, 1); const chaptersDir = join(paths.story, "chapters");
  const manifestRaw = await readJsonIfExists<SourceManifest>(paths.sourceManifest);
  const manifest = manifestRaw ? sourceManifestSchema.safeParse(manifestRaw) : undefined;
  const currentSources = manifest?.success ? new Map(manifest.data.chapters.map((item) => [item.chapter, item.contentFingerprint ?? item.fingerprint])) : undefined;
  let numbers: number[] = [];
  try {
    numbers = (await readdir(chaptersDir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name)).filter((number) => Number.isSafeInteger(number) && number > 0);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const stale: number[] = [];
  for (const number of numbers) {
    const metadata = await readJsonIfExists<Chapter>(storyPaths(root, slug, number).chapterMeta);
    if (!metadata || !(await readJsonIfExists(storyPaths(root, slug, number).bibleUpdate))) continue;
    const state = metadata.stages?.storyBible;
    if (state?.status === "failed" && !state.outputFingerprint && !state.completedAt) continue;
    if (state?.status !== "complete" || state.staleReason || (currentSources && metadata.source?.fingerprint !== currentSources.get(number))) stale.push(number);
  }
  return stale.sort((a, b) => a - b);
}
