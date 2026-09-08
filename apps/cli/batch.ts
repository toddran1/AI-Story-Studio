#!/usr/bin/env node
import { resolve } from "node:path";
import { loadEnvironment } from "../../src/config/env.js";
import { defaultStory, loadStory } from "../../src/config/load-config.js";
import { createPipeline } from "../../src/pipeline/create-pipeline.js";
import { ForceStage } from "../../src/pipeline/chapter-pipeline.js";
import { atomicWriteJson } from "../../src/storage/atomic-write.js";
import { exists } from "../../src/storage/story-files.js";
import { storyPaths } from "../../src/storage/paths.js";
import { discoveryIssues, inspectChapterDirectory } from "../../src/batch/chapter-discovery.js";
import { selectChapterRange } from "../../src/batch/range.js";
import { createBatchPlan } from "../../src/batch/plan.js";
import { createBatchState, loadLatestBatch } from "../../src/batch/batch-state.js";
import { BatchRunner, ProgressEvent } from "../../src/batch/batch-runner.js";
import { ShutdownController } from "../../src/batch/shutdown.js";
import { retryConfigSchema } from "../../src/batch/types.js";
import { BatchValidationError } from "../../src/pipeline/errors.js";

async function main() {
  const args = parseArgs(process.argv.slice(2)); validateSlug(args.story);
  const root = process.cwd();
  let directory = args.input ? resolve(args.input) : undefined;
  let retryNumbers: Set<number> | undefined;
  if (args.retryFailed) {
    const previous = await loadLatestBatch(root, args.story);
    directory ??= previous.inputDirectory;
    retryNumbers = new Set(Object.entries(previous.chapters).filter(([, state]) => state.status === "failed").map(([number]) => Number(number)));
    if (!retryNumbers.size) throw new BatchValidationError(`Latest batch '${previous.id}' has no failed chapters`);
  }
  if (!directory) usage("--input is required unless --retry-failed can use a previous batch directory");

  const report = await inspectChapterDirectory(directory);
  const selectedByRange = selectChapterRange(report.chapters, args.from, args.to);
  const selected = retryNumbers ? selectedByRange.filter((item) => retryNumbers!.has(item.chapter)) : selectedByRange;
  if (!selected.length) throw new BatchValidationError("No chapters match the requested retry/range selection");
  const plan = await createBatchPlan(root, args.story, report, selected);
  if (args.dryRun) {
    process.stdout.write(`${formatPlan(args.story, directory, plan)}\n`);
    const issues = discoveryIssues(report, args.allowGaps); if (issues.length) throw new BatchValidationError(issues.join("; "));
    return;
  }
  const issues = discoveryIssues(report, args.allowGaps); if (issues.length) throw new BatchValidationError(`Batch validation failed before processing:\n- ${issues.join("\n- ")}`);

  const env = loadEnvironment(); const paths = storyPaths(root, args.story, selected[0]!.chapter);
  const story = await exists(paths.storyConfig) ? await loadStory(paths.storyConfig) : defaultStory(args.story, env);
  await atomicWriteJson(paths.storyConfig, story); await atomicWriteJson(paths.pipelineConfig, story.pipeline);
  const state = createBatchState({ root, story: args.story, inputDirectory: directory, chapters: selected,
    allowGaps: args.allowGaps, continueOnError: args.continueOnError, delayMs: args.delayMs, force: args.force });
  const shutdown = new ShutdownController();
  const requestShutdown = () => { shutdown.request(); process.stderr.write("\nShutdown requested; stopping after the current safe chapter boundary.\n"); };
  process.once("SIGINT", requestShutdown); process.once("SIGTERM", requestShutdown);
  process.stdout.write(`AI Story Studio\nStory: ${story.slug}\nBatch: ${state.id}\nRange: ${state.selection.from}-${state.selection.to}\nTotal: ${selected.length}\n`);
  try {
    const result = await new BatchRunner(createPipeline(env)).run({ root, story, chapters: selected, state, shutdown,
      retry: retryConfigSchema.parse({ maxAttempts: args.maxAttempts, initialDelayMs: args.initialDelayMs, maxDelayMs: args.maxDelayMs }),
      onProgress: printProgress });
    process.stdout.write(`${formatSummary(result)}\n`);
    if (result.status === "failed" || result.status === "completed_with_errors") process.exitCode = 1;
    if (result.status === "paused") process.exitCode = 130;
  } finally { process.removeListener("SIGINT", requestShutdown); process.removeListener("SIGTERM", requestShutdown); }
}

type Args = {
  story: string; input?: string; from?: number; to?: number; allowGaps: boolean; dryRun: boolean; retryFailed: boolean;
  continueOnError: boolean; delayMs: number; maxAttempts: number; initialDelayMs: number; maxDelayMs: number; force?: ForceStage;
};
function parseArgs(values: string[]): Args {
  const args: Args = { story: "", allowGaps: false, dryRun: false, retryFailed: false, continueOnError: false,
    delayMs: 0, maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 30000 };
  for (let index = 0; index < values.length; index++) {
    const key = values[index]!;
    if (["--allow-gaps", "--dry-run", "--retry-failed", "--continue-on-error"].includes(key)) {
      if (key === "--allow-gaps") args.allowGaps = true; else if (key === "--dry-run") args.dryRun = true;
      else if (key === "--retry-failed") args.retryFailed = true; else args.continueOnError = true;
      continue;
    }
    const value = values[++index]; if (value === undefined) usage(`Missing value for ${key}`);
    if (key === "--story") args.story = value; else if (key === "--input") args.input = value;
    else if (key === "--from") args.from = integer(value, key); else if (key === "--to") args.to = integer(value, key);
    else if (key === "--delay-ms") args.delayMs = nonnegative(value, key); else if (key === "--max-attempts") args.maxAttempts = integer(value, key);
    else if (key === "--initial-delay-ms") args.initialDelayMs = nonnegative(value, key); else if (key === "--max-delay-ms") args.maxDelayMs = nonnegative(value, key);
    else if (key === "--force") { if (!forceValues.includes(value as ForceStage)) usage("Invalid --force stage"); args.force = value as ForceStage; }
    else usage(`Unknown argument: ${key}`);
  }
  return args;
}
const forceValues: ForceStage[] = ["translation", "narration", "story-bible", "tts", "all"];
function validateSlug(slug: string) { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) usage("--story must be a lowercase kebab-case slug"); }
function integer(value: string, key: string) { const number = Number(value); if (!Number.isInteger(number) || number < 1) usage(`${key} must be a positive integer`); return number; }
function nonnegative(value: string, key: string) { const number = Number(value); if (!Number.isInteger(number) || number < 0) usage(`${key} must be a non-negative integer`); return number; }
function usage(message: string): never { throw new Error(`${message}\nUsage: npm run story:batch -- --story <slug> --input <directory> [--from N] [--to N] [--allow-gaps] [--dry-run] [--retry-failed] [--force stage]`); }
function printProgress(event: ProgressEvent) {
  if (event.type === "chapter.started") process.stdout.write(`[${event.index}/${event.total}] Chapter ${event.chapter}\n`);
  else if (event.type === "stage") process.stdout.write(`  ${event.event.status === "completed" ? "✓" : event.event.status === "reused" ? "↺" : "→"} ${event.event.stage}${event.event.status === "reused" ? " (reused)" : ""}\n`);
  else if (event.type === "chapter.completed") process.stdout.write(`  Complete (${event.index}/${event.total})\n`);
  else if (event.type === "chapter.retrying") process.stdout.write(`  Retrying Chapter ${event.chapter} (attempt ${event.attempt})\n`);
  else process.stdout.write(`  Failed after ${event.attempts} attempt(s): ${event.error}\n`);
}
function formatPlan(story: string, directory: string, plan: Awaited<ReturnType<typeof createBatchPlan>>) {
  return [`Batch dry run`, `Story: ${story}`, `Input: ${directory}`, `Discovered: ${plan.discovered}`,
    `Selected: ${formatNumbers(plan.selected)}`, `Missing: ${formatNumbers(plan.missing)}`,
    `Duplicates: ${plan.duplicates.length ? plan.duplicates.map((item) => `${item.chapter} (${item.filenames.join(", ")})`).join("; ") : "none"}`,
    `Invalid files: ${plan.invalidFiles.join(", ") || "none"}`, `Empty files: ${plan.emptyFiles.join(", ") || "none"}`,
    `Would process: ${plan.wouldProcess}`, `Already present (likely reusable): ${plan.likelyReusable.length}`].join("\n");
}
function formatSummary(state: Awaited<ReturnType<BatchRunner["run"]>>) {
  const failed = Object.entries(state.chapters).filter(([, item]) => item.status === "failed").map(([number]) => number);
  return [`Batch ${state.status}`, `Story: ${state.story}`, `Range: ${state.selection.from}-${state.selection.to}`,
    `Total: ${state.summary.total}`, `Complete: ${state.summary.complete}`, `Failed: ${state.summary.failed}`,
    `Skipped: ${state.summary.skipped}`, `Elapsed: ${formatDuration(state.elapsedMs)}`,
    `Failed chapters: ${failed.join(", ") || "none"}`, `Usage: ${JSON.stringify(state.usage)}`,
    `Manifest: stories/${state.story}/batches/${state.id}.json`, `Outputs: stories/${state.story}/chapters/`].join("\n");
}
function formatNumbers(numbers: number[]) { if (!numbers.length) return "none"; return numbers.join(", "); }
function formatDuration(ms: number) { const seconds = Math.floor(ms / 1000); return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }

main().catch((error: unknown) => { process.stderr.write(`${JSON.stringify({ event: "batch.failed", error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`); process.exitCode = 1; });
