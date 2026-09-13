import { Story } from "../domain/story.js";
import { PipelineOptions, PipelineStageEvent } from "../pipeline/chapter-pipeline.js";
import { BatchState, DiscoveredChapter, RetryConfig } from "./types.js";
import { persistBatchState } from "./batch-state.js";
import { ShutdownController } from "./shutdown.js";
import { withRetry } from "./retry.js";
import { Chapter } from "../domain/chapter.js";
import { QaCategory, QaStatus } from "../domain/qa.js";
import { QualityGateError } from "../pipeline/errors.js";
import { createErrorDiagnostic, ErrorDiagnostic } from "../errors/diagnostic.js";

export interface ChapterProcessor { run(options: PipelineOptions): Promise<unknown>; }
export type ProgressEvent =
  | { type: "chapter.started"; index: number; total: number; chapter: number }
  | { type: "stage"; chapter: number; event: PipelineStageEvent }
  | { type: "chapter.completed"; index: number; total: number; chapter: number }
  | { type: "chapter.retrying"; chapter: number; attempt: number }
  | { type: "chapter.failed"; index: number; total: number; chapter: number; error: string; attempts: number; diagnostic: ErrorDiagnostic };

export type BatchRunOptions = {
  root: string; story: Story; chapters: DiscoveredChapter[]; state: BatchState; retry: RetryConfig;
  shutdown: ShutdownController; onProgress?: (event: ProgressEvent) => void;
  sleep?: (ms: number) => Promise<void>; random?: () => number;
};

export class BatchRunner {
  constructor(private readonly processor: ChapterProcessor) {}

  async run(options: BatchRunOptions): Promise<BatchState> {
    const started = Date.now(); options.state.status = "running"; await persistBatchState(options.root, options.state);
    for (let index = 0; index < options.chapters.length; index++) {
      const discovered = options.chapters[index]!; const entry = options.state.chapters[String(discovered.chapter)]!;
      if (options.shutdown.isRequested) { options.state.status = "paused"; options.state.stopReason = "Shutdown requested"; break; }
      entry.status = "running"; entry.startedAt ??= new Date().toISOString(); entry.error = undefined; entry.diagnostic = undefined;
      options.onProgress?.({ type: "chapter.started", index: index + 1, total: options.chapters.length, chapter: discovered.chapter });
      await persistBatchState(options.root, options.state);
      try {
        let currentAttempt = 0;
        const processed = await withRetry(() => this.processor.run({
          root: options.root, story: options.story, chapter: discovered.chapter, inputPath: discovered.path,
          source: discovered.source,
          // Force is an invocation intent, not a retry intent. Later attempts
          // rely on ChapterPipeline fingerprints to avoid repeating paid work.
          force: currentAttempt === 1 ? options.state.options.force as PipelineOptions["force"] : undefined,
          stopAfter: options.state.options.stopAfter as PipelineOptions["stopAfter"],
          onStageEvent: (event) => {
            entry.currentStage = event.stage;
            options.onProgress?.({ type: "stage", chapter: discovered.chapter, event });
            if (event.status === "completed") addUsage(options.state, event);
          },
        }), options.retry, {
          sleep: (ms) => interruptibleDelay(ms, options.shutdown, options.sleep), random: options.random,
          shouldStop: () => options.shutdown.isRequested,
          onAttempt: async (attempt) => {
            currentAttempt = attempt; entry.attempts = attempt;
            if (attempt > 1) options.onProgress?.({ type: "chapter.retrying", chapter: discovered.chapter, attempt });
            await persistBatchState(options.root, options.state);
          },
        });
        const quality = (processed as Chapter | undefined)?.quality;
        if (quality) addQuality(options.state, quality.status, quality.issueCategories);
        entry.status = "complete"; entry.completedAt = new Date().toISOString();
        options.onProgress?.({ type: "chapter.completed", index: index + 1, total: options.chapters.length, chapter: discovered.chapter });
      } catch (error) {
        if (error instanceof QualityGateError) addQuality(options.state, error.result.status, error.result.issues.map((issue) => issue.category));
        entry.status = "failed"; entry.error = error instanceof Error ? error.message : String(error);
        entry.diagnostic = createErrorDiagnostic(error, { chapter: discovered.chapter, stage: entry.currentStage });
        options.onProgress?.({ type: "chapter.failed", index: index + 1, total: options.chapters.length, chapter: discovered.chapter, error: entry.error, attempts: entry.attempts, diagnostic: entry.diagnostic });
        if (options.shutdown.isRequested) {
          options.state.status = "paused"; options.state.stopReason = `Shutdown requested during Chapter ${discovered.chapter}`;
          await persistBatchState(options.root, options.state); break;
        }
        if (!options.state.options.continueOnError) {
          options.state.status = "failed"; options.state.stopReason = `Chapter ${discovered.chapter} failed`; await persistBatchState(options.root, options.state); break;
        }
      }
      options.state.elapsedMs = Date.now() - started;
      await persistBatchState(options.root, options.state);
      if (options.shutdown.isRequested) { options.state.status = "paused"; options.state.stopReason = "Shutdown requested after safe chapter boundary"; break; }
      if (index < options.chapters.length - 1 && options.state.options.delayMs > 0) await interruptibleDelay(options.state.options.delayMs, options.shutdown, options.sleep);
    }
    options.state.elapsedMs = Date.now() - started;
    if (options.state.status === "running") options.state.status = options.state.summary.failed ? "completed_with_errors" : "completed";
    await persistBatchState(options.root, options.state);
    return options.state;
  }
}

function addQuality(state: BatchState, status: QaStatus, categories: QaCategory[]): void {
  state.qa[status]++;
  for (const category of new Set(categories)) state.qa.issueCategories[category] = (state.qa.issueCategories[category] ?? 0) + 1;
}

function addUsage(state: BatchState, event: PipelineStageEvent): void {
  const provider = event.state.provider; const usage = event.state.usage;
  if (!provider || !usage) return;
  const totals = state.usage[provider] ??= {};
  for (const key of ["inputTokens", "outputTokens", "cachedTokens", "requests", "characters", "bytes"] as const) {
    if (usage[key] !== undefined) totals[key] = (totals[key] ?? 0) + usage[key]!;
  }
}

async function interruptibleDelay(ms: number, shutdown: ShutdownController, sleeper?: (ms: number) => Promise<void>) {
  const sleep = sleeper ?? ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay)));
  let remaining = ms;
  while (remaining > 0 && !shutdown.isRequested) { const slice = Math.min(remaining, 100); await sleep(slice); remaining -= slice; }
}
