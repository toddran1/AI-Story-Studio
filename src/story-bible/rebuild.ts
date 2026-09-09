import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { StoryBible, StoryBibleUpdate, emptyStoryBible, storyBibleUpdateSchema } from "../domain/story-bible.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { Chapter } from "../domain/chapter.js";
import { mergeStoryBible, normalizeStoryBibleUpdate } from "./updater.js";

/** Rebuilds canonical context solely from chronological per-chapter updates. */
export async function rebuildStoryBibleBeforeChapter(root: string, slug: string, chapter: number): Promise<StoryBible> {
  let bible = emptyStoryBible();
  const chaptersDir = join(storyPaths(root, slug, chapter).story, "chapters");
  let numbers: number[] = [];
  try {
    numbers = (await readdir(chaptersDir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name)).filter((number) => Number.isSafeInteger(number) && number > 0 && number < chapter).sort((a, b) => a - b);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const number of numbers) {
    const metadata = await readJsonIfExists<Chapter>(storyPaths(root, slug, number).chapterMeta);
    if (metadata && metadata.stages?.storyBible?.status !== "complete") continue;
    const raw = await readJsonIfExists<StoryBibleUpdate>(storyPaths(root, slug, number).bibleUpdate);
    if (raw) bible = mergeStoryBible(bible, normalizeStoryBibleUpdate(storyBibleUpdateSchema.parse(raw), number), number);
  }
  return bible;
}
