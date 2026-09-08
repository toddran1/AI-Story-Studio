import { Chapter } from "../domain/chapter.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { DiscoveryReport } from "./chapter-discovery.js";
import { DiscoveredChapter } from "./types.js";

export type BatchPlan = {
  discovered: number; selected: number[]; missing: number[]; duplicates: DiscoveryReport["duplicateChapters"];
  invalidFiles: string[]; emptyFiles: string[]; wouldProcess: number; likelyReusable: number[];
};

export async function createBatchPlan(root: string, story: string, report: DiscoveryReport, selected: DiscoveredChapter[]): Promise<BatchPlan> {
  const likelyReusable: number[] = [];
  for (const item of selected) {
    const metadata = await readJsonIfExists<Chapter>(storyPaths(root, story, item.chapter).chapterMeta);
    if (metadata && Object.values(metadata.stages).every((stage) => stage.status === "complete")) likelyReusable.push(item.chapter);
  }
  return {
    discovered: report.chapters.length, selected: selected.map((item) => item.chapter), missing: report.missingChapters,
    duplicates: report.duplicateChapters, invalidFiles: report.invalidFiles, emptyFiles: report.emptyFiles,
    wouldProcess: selected.length, likelyReusable,
  };
}
