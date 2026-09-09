import { randomUUID } from "node:crypto";
import { BatchState, batchStateSchema } from "./types.js";
import { DiscoveredChapter } from "./types.js";
import { ForceStage } from "../pipeline/chapter-pipeline.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { batchPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { BatchValidationError } from "../pipeline/errors.js";

export type NewBatchOptions = {
  root: string; story: string; inputDirectory: string; chapters: DiscoveredChapter[];
  allowGaps: boolean; continueOnError: boolean; delayMs: number; force?: ForceStage;
};

export function createBatchState(options: NewBatchOptions): BatchState {
  const now = new Date().toISOString(); const from = options.chapters[0]!.chapter; const to = options.chapters.at(-1)!.chapter;
  const stamp = now.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const id = `${stamp}-${String(from).padStart(3, "0")}-${String(to).padStart(3, "0")}-${randomUUID().slice(0, 8)}`;
  return batchStateSchema.parse({
    id, story: options.story, createdAt: now, updatedAt: now, inputDirectory: options.inputDirectory,
    selection: { from, to }, status: "pending",
    options: { allowGaps: options.allowGaps, continueOnError: options.continueOnError, delayMs: options.delayMs, force: options.force },
    chapters: Object.fromEntries(options.chapters.map((item) => [String(item.chapter), { status: "pending", input: item.path, attempts: 0 }])),
    summary: { total: options.chapters.length, complete: 0, failed: 0, pending: options.chapters.length, skipped: 0, cancelled: 0 },
    usage: {}, qa: { pass: 0, warn: 0, fail: 0, issueCategories: {} }, elapsedMs: 0,
  });
}

export function refreshSummary(state: BatchState): void {
  const entries = Object.values(state.chapters);
  state.summary = {
    total: entries.length,
    complete: entries.filter((item) => item.status === "complete").length,
    failed: entries.filter((item) => item.status === "failed").length,
    pending: entries.filter((item) => item.status === "pending" || item.status === "running").length,
    skipped: entries.filter((item) => item.status === "skipped").length,
    cancelled: entries.filter((item) => item.status === "cancelled").length,
  };
  state.updatedAt = new Date().toISOString();
}

export async function persistBatchState(root: string, state: BatchState): Promise<string> {
  refreshSummary(state); const paths = batchPaths(root, state.story, state.id);
  await atomicWriteJson(paths.manifest!, batchStateSchema.parse(state));
  await atomicWriteJson(paths.latest, { id: state.id });
  return paths.manifest!;
}

export async function loadLatestBatch(root: string, story: string): Promise<BatchState> {
  const pointer = await readJsonIfExists<{ id: string; manifest?: string }>(batchPaths(root, story).latest);
  if (!pointer) throw new BatchValidationError(`No previous batch exists for story '${story}'`);
  const manifest = pointer.manifest ?? batchPaths(root, story, pointer.id).manifest!;
  const state = await readJsonIfExists<BatchState>(manifest);
  if (!state) throw new BatchValidationError(`Latest batch manifest is missing: ${manifest}`);
  return batchStateSchema.parse(state);
}
