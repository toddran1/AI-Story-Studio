import { StoryBible, StoryBibleUpdate, emptyStoryBible, storyBibleSchema, storyBibleUpdateSchema } from "../domain/story-bible.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { mergeStoryBible } from "./updater.js";

/** Rebuilds canonical context solely from chronological per-chapter updates. */
export async function rebuildStoryBibleBeforeChapter(root: string, slug: string, chapter: number): Promise<StoryBible> {
  const cumulative = await readJsonIfExists<StoryBible>(storyPaths(root, slug, chapter).bible);
  if (cumulative) {
    const parsed = storyBibleSchema.parse(cumulative);
    const hasFutureContext = Object.keys(parsed.chapterSummaries).some((number) => Number(number) >= chapter);
    if (!hasFutureContext) return parsed;
  }
  let bible = emptyStoryBible();
  for (let number = 1; number < chapter; number++) {
    const raw = await readJsonIfExists<StoryBibleUpdate>(storyPaths(root, slug, number).bibleUpdate);
    if (raw) bible = mergeStoryBible(bible, storyBibleUpdateSchema.parse(raw), number);
  }
  return bible;
}
