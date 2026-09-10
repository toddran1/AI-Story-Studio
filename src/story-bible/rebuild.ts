import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { StoryBible, StoryBibleUpdate, emptyStoryBible, storyBibleUpdateSchema } from "../domain/story-bible.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { Chapter } from "../domain/chapter.js";
import { mergeStoryBible, normalizeStoryBibleUpdate } from "./updater.js";
import { SourceManifest, sourceManifestSchema } from "../source/types.js";
import { applyManualBibleOverlay } from "../studio/workflow.js";

/** Rebuilds canonical context solely from chronological per-chapter updates. */
export async function rebuildStoryBibleBeforeChapter(root: string, slug: string, chapter: number, options: { includeCanonicalOverlay?: boolean } = {}): Promise<StoryBible> {
  let bible = emptyStoryBible();
  const paths = storyPaths(root, slug, chapter); const chaptersDir = join(paths.story, "chapters");
  const manifestRaw = await readJsonIfExists<SourceManifest>(paths.sourceManifest);
  const manifest = manifestRaw ? sourceManifestSchema.safeParse(manifestRaw) : undefined;
  const currentSources = manifest?.success ? new Map(manifest.data.chapters.map((item) => [item.chapter, item.fingerprint])) : undefined;
  let numbers: number[] = [];
  try {
    numbers = (await readdir(chaptersDir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name)).filter((number) => Number.isSafeInteger(number) && number > 0 && number < chapter).sort((a, b) => a - b);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const number of numbers) {
    const metadata = await readJsonIfExists<Chapter>(storyPaths(root, slug, number).chapterMeta);
    if (metadata && metadata.stages?.storyBible?.status !== "complete") continue;
    if (currentSources && metadata?.source?.fingerprint !== currentSources.get(number)) continue;
    const raw = await readJsonIfExists<StoryBibleUpdate>(storyPaths(root, slug, number).bibleUpdate);
    if (raw) bible = mergeStoryBible(bible, normalizeStoryBibleUpdate(storyBibleUpdateSchema.parse(raw), number), number);
  }
  return (await applyManualBibleOverlay(root, slug, bible, { includeCanonical: options.includeCanonicalOverlay !== false })).bible;
}
