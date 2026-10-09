import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { chapterSchema } from "../domain/chapter.js";
import type { CostFilters } from "./types.js";

/** Current artifact provenance, separate from historical billable API usage. */
export async function subscriptionProcessing(root: string, slug: string, filters: CostFilters = {}) {
  const directory = join(storyPaths(root, slug, 1).story, "chapters");
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const items: Array<{ chapter: number; stage: string; agent: string; model: string; status: string; apiCostUsd: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const chapter = Number(entry.name);
    if (filters.chapterFrom !== undefined && chapter < filters.chapterFrom || filters.chapterTo !== undefined && chapter > filters.chapterTo) continue;
    const raw = await readJsonIfExists(storyPaths(root, slug, chapter).chapterMeta);
    if (!raw) continue;
    const metadata = chapterSchema.parse(raw);
    for (const [stage, state] of Object.entries(metadata.stages)) {
      if (state.execution?.source !== "subscription-agent" || state.execution.apiRequests !== 0) continue;
      if (filters.stage && stage !== filters.stage || filters.provider && state.provider !== filters.provider || filters.model && state.model !== filters.model) continue;
      if (filters.fromDate && (!state.completedAt || state.completedAt < filters.fromDate) || filters.toDate && (!state.completedAt || state.completedAt >= filters.toDate)) continue;
      if (filters.productionRunId || filters.queueJobId) continue;
      items.push({ chapter, stage, agent: state.execution.agent, model: state.model ?? "unknown", status: state.status, apiCostUsd: 0 });
    }
  }
  return items.sort((a, b) => a.chapter - b.chapter || a.stage.localeCompare(b.stage));
}
