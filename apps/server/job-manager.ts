import { jobOperationScope, scopesConflict, type OperationScope } from "../../src/storage/operation-scope.js";
import { withOperationScope } from "../../src/storage/story-lock.js";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createErrorDiagnostic, ErrorDiagnostic, errorDiagnosticSchema } from "../../src/errors/diagnostic.js";
import { logger } from "../../src/utils/logger.js";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../../src/storage/atomic-write.js";
import { readJsonIfExists } from "../../src/storage/story-files.js";
import { failedResultDiagnostics, saveJobError } from "./job-error-history.js";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "paused" | "cancelled";
export type Job = { id: string; type: "audioRegeneration" | "visualWorkflow" | "batch" | "stageExecution" | "preview" | "voicePreview" | "metadataTranslation" | "entityLocalizationSuggestions" | "pronunciation" | "qaRepair" | "qaRecheck" | "summary" | "audio" | "audiobook" | "chapterMusicExport" | "summaryMusicExport" | "alignment" | "subtitles" | "video" | "videoExport" | "scenes" | "artwork" | "production" | "ttsQualityVerify" | "ttsSegmentRegenerate"; story: string; status: JobStatus; createdAt: string; updatedAt: string; scope?: OperationScope; cancelRequested?: boolean; pauseRequested?: boolean; payload?: unknown; progress?: unknown; result?: unknown; error?: string; diagnostic?: ErrorDiagnostic };
type JobControl = { update(progress: unknown): void; setPause(handler: () => void): void; reserve?(scope: OperationScope): Promise<void> };

export class JobConflictError extends Error {}

export class JobManager {
  private static readonly defaultMaxRetainedJobs = 200;
  private readonly maxRetainedJobs: number;
  private readonly jobs = new Map<string, Job>();
  private readonly events = new Map<string, EventEmitter>();
  private readonly reservations = new Map<string, { story: string; scope: OperationScope }>();
  private readonly pendingVisualPauses = new Set<string>();
  private readonly pauseHandlers = new Map<string, () => void>();
  private readonly durablePaths = new Map<string, string>();
  private readonly durableWrites = new Map<string, Promise<void>>();
  private errorHistoryRoot?: string;
  private readonly collectedFailures = new Map<string, Array<{ chapter?: number; diagnostic: ErrorDiagnostic }>>();
  private readonly errorWrites = new Map<string, Promise<void>>();

  constructor(options: { maxRetainedJobs?: number } = {}) {
    this.maxRetainedJobs = options.maxRetainedJobs ?? JobManager.defaultMaxRetainedJobs;
  }
  configureErrorHistory(root: string) { this.errorHistoryRoot = root; }

  /** Persist non-chapter jobs without putting story content into the production
   * queue. Interrupted work is paused on startup, never silently replayed/paid. */
  async restoreDurable(directory: string) {
    const schema = z.object({ id: z.string().uuid(), type: z.enum(["summary", "visualWorkflow"]), story: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), status: z.enum(["queued", "running", "completed", "failed", "paused", "cancelled"]), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), cancelRequested: z.boolean().optional(), pauseRequested: z.boolean().optional(), payload: z.unknown().optional(), progress: z.unknown().optional(), result: z.unknown().optional(), error: z.string().optional() });
    for (const name of await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const path = join(directory, name), parsed = schema.safeParse(await readJsonIfExists(path).catch((error) => { logger.warn({ error, path }, "Ignoring unreadable durable job record"); return undefined; }));
      if (!parsed.success || `${parsed.data.id}.json` !== name) continue;
      const job: Job = parsed.data;
      if (job.status === "running" || job.status === "queued") { job.status = job.cancelRequested ? "cancelled" : "paused"; job.error = job.cancelRequested ? undefined : "Interrupted by a server restart. Retry the action to resume from completed artifacts."; await atomicWriteJson(path, job); }
      job.scope = jobOperationScope(job.type, job.payload);
      this.jobs.set(job.id, job); this.durablePaths.set(job.id, path);
    }
    this.prune();
    await this.flushDurable();
  }

  async createDurable(directory: string, story: string, runner: (control: JobControl) => Promise<unknown>, payload?: unknown, type: "summary" | "visualWorkflow" = "summary") {
    this.prune();
    const scope = jobOperationScope(type, payload); this.assertAvailable(story, scope);
    const now = new Date().toISOString(), job: Job = { id: randomUUID(), type, story, status: "queued", createdAt: now, updatedAt: now, payload, scope };
    const path = join(directory, `${job.id}.json`);
    // Reserve the story before awaiting IO, preventing concurrent submission races.
    this.reservations.set(job.id, { story, scope });
    try { await atomicWriteJson(path, job); } catch (error) { this.reservations.delete(job.id); throw error; }
    this.jobs.set(job.id, job); this.events.set(job.id, new EventEmitter()); this.durablePaths.set(job.id, path);
    queueMicrotask(() => this.run(job, runner)); return structuredClone(job);
  }

  create(type: Job["type"], story: string, runner: (control: JobControl) => Promise<unknown>, payload?: unknown, scope: OperationScope = jobOperationScope(type, payload)): Job {
    this.prune();
    this.assertAvailable(story, scope);
    const now = new Date().toISOString(); const job: Job = { id: randomUUID(), type, story, status: "queued", createdAt: now, updatedAt: now, payload, scope };
    this.jobs.set(job.id, job); this.events.set(job.id, new EventEmitter()); this.reservations.set(job.id, { story, scope });
    queueMicrotask(() => this.run(job, runner)); return structuredClone(job);
  }

  get(id: string): Job | undefined { const job = this.jobs.get(id); return job ? structuredClone(job) : undefined; }
  getActiveForStory(story: string): Job | undefined {
    const activeId = [...this.reservations].find(([,value]) => value.story === story)?.[0];
    if (activeId) {
      const job = this.jobs.get(activeId);
      if (job && (job.status === "queued" || job.status === "running")) return structuredClone(job);
    }
    const activeJobs = [...this.jobs.values()]
      .filter((job) => job.story === story && (job.status === "queued" || job.status === "running"))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return activeJobs[0] ? structuredClone(activeJobs[0]) : undefined;
  }
  list(): Job[] { return [...this.jobs.values()].map((job) => structuredClone(job)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  subscribe(id: string, listener: (job: Job) => void): (() => void) | undefined {
    const job = this.get(id); if (!job) return undefined;
    listener(job);
    if (isTerminal(job.status)) return () => undefined;
    const emitter = this.events.get(id); if (!emitter) return () => undefined;
    emitter.on("update", listener); return () => emitter.off("update", listener);
  }
  private assertAvailable(story: string, scope: OperationScope) {
    for (const [id, reservation] of this.reservations) if (reservation.story === story && scopesConflict(admissionScope(scope), admissionScope(reservation.scope))) throw new JobConflictError(`Story '${story}' has overlapping work in job ${id}. Choose different chapters or wait for it to finish.`);
  }
  pause(id: string): boolean {
    const job = this.jobs.get(id); if (!job || isTerminal(job.status)) return false;
    if (job.pauseRequested) return true;
    this.set(job, { pauseRequested: true }); this.pendingVisualPauses.add(id); this.pauseHandlers.get(id)?.(); return true;
  }
  cancel(id: string): boolean {
    const job = this.jobs.get(id); if (!job || isTerminal(job.status)) return false;
    if (job.cancelRequested) return true;
    this.set(job, { cancelRequested: true }); this.pendingVisualPauses.add(id); this.pauseHandlers.get(id)?.(); return true;
  }
  pauseAll(): void { for (const job of this.jobs.values()) if (!isTerminal(job.status)) this.pause(job.id); }
  async flushDurable(): Promise<void> {
    const failures: unknown[] = [];
    while (this.durableWrites.size > 0) {
      const pending = [...this.durableWrites.values()];
      const results = await Promise.allSettled(pending);
      for (const result of results) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        }
      }
      for (const [id, promise] of this.durableWrites.entries()) {
        if (pending.includes(promise)) {
          this.durableWrites.delete(id);
        }
      }
    }
    if (failures.length > 0) {
      const message = `Durable job persistence encountered ${failures.length} failure(s)`;
      logger.error({ event: "job_manager.flush_durable.failed", failures: failures.map((f) => f instanceof Error ? f.message : String(f)) }, message);
      throw new AggregateError(failures, message);
    }
  }

  private async run(job: Job, runner: (control: JobControl) => Promise<unknown>) {
    try {
      await this.waitForResources(job);
      if (job.cancelRequested) { this.set(job, { status: "cancelled" }); return; }
      if (job.pauseRequested) { this.set(job, { status: "paused" }); return; }
      this.set(job, { status: "running" });
      const result = await withOperationScope(job.story, job.scope ?? { all: true }, () => runner({
        update: (progress) => {
          this.set(job, { progress });
          if (progress && typeof progress === "object") {
            const event = progress as { type?: string; error?: string; chapter?: number; diagnostic?: ErrorDiagnostic };
            const failures = failedResultDiagnostics(progress);
            if (event.type?.endsWith("failed") && event.error) failures.push(...failedResultDiagnostics({ results: [{ ...event, status: "failed" }] }));
            for (const failure of failures) void this.recordFailure(job, failure.diagnostic, { results: [{ ...failure, status: "failed" }] });
          }
        },
        reserve: async (scope) => {
          const gainedResources = scope.resources?.some(resource => !job.scope?.resources?.includes(resource));
          for (const [id, reservation] of this.reservations) if (id !== job.id && reservation.story === job.story && scopesConflict(admissionScope(scope), admissionScope(reservation.scope))) throw new JobConflictError(`Story '${job.story}' has overlapping work in job ${id}.`);
          Object.assign(job.scope!, scope); for (const key of Object.keys(job.scope!)) if (!(key in scope)) delete (job.scope as Record<string, unknown>)[key];
          this.reservations.set(job.id, { story: job.story, scope: job.scope! }); this.set(job, { scope: job.scope });
          if (gainedResources) { this.set(job, { status: "queued" }); await this.waitForResources(job); if (!job.cancelRequested && !job.pauseRequested) this.set(job, { status: "running" }); }
        },
        setPause: (handler) => { this.pauseHandlers.set(job.id, handler); if (this.pendingVisualPauses.delete(job.id)) handler(); },
      }));
      const finalFailures = failedResultDiagnostics(result);
      if (finalFailures.length) await this.recordFailure(job, finalFailures.at(-1)!.diagnostic, result);
      await this.errorWrites.get(job.id);
      const resultStatus = typeof result === "object" && result !== null && "status" in result ? (result as { status?: unknown; stopReason?: unknown }).status : undefined;
      if (job.cancelRequested) this.set(job, { status: "cancelled", result });
      else if (resultStatus === "paused") this.set(job, { status: "paused", result });
      else if (resultStatus === "failed" || (resultStatus === "completed_with_errors" && job.type !== "batch")) {
        const reason = typeof (result as { stopReason?: unknown }).stopReason === "string" ? (result as { stopReason: string }).stopReason : `Batch ${resultStatus}`;
        const diagnostic = diagnosticFromResult(result) ?? createErrorDiagnostic(new Error(reason), { summary: reason });
        logFailure(job, diagnostic);
        await this.recordFailure(job, diagnostic, result);
        this.set(job, { status: "failed", result, error: diagnostic.summary, diagnostic });
      // A batch that was explicitly allowed to continue has completed its
      // range; individual errors remain in its manifest and Needs Review.
      } else {
        if (resultStatus === "completed_with_errors") {
          const diagnostic = diagnosticFromResult(result) ?? createErrorDiagnostic(new Error("Batch completed with chapter errors"));
          await this.recordFailure(job, diagnostic, result);
        }
        this.set(job, { status: "completed", result });
      }
    } catch (error) { const diagnostic = createErrorDiagnostic(error); logFailure(job, diagnostic); await this.recordFailure(job, diagnostic); this.set(job, { status: "failed", error: diagnostic.summary, diagnostic }); }
    finally {
      this.pauseHandlers.delete(job.id); this.pendingVisualPauses.delete(job.id); this.reservations.delete(job.id);
      this.events.delete(job.id); this.prune();
    }
  }
  private async waitForResources(job: Job) {
    let waiting = false;
    while (!job.pauseRequested && !job.cancelRequested) {
      const reservations = [...this.reservations]; const position = reservations.findIndex(([id]) => id === job.id);
      const blocked = reservations.some(([id, other], index) => id !== job.id && other.story === job.story && scopesConflict(job.scope ?? { all: true }, other.scope) && (index < position || this.jobs.get(id)?.status === "running"));
      if (!blocked) return;
      if (!waiting) { waiting = true; this.set(job, { status: "queued", progress: { type: "job.waiting", detail: "Waiting for shared story context or export files. Other-chapter media and edits can continue." } }); }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  private async recordFailure(job: Job, diagnostic: ErrorDiagnostic, result?: unknown) {
    if (!this.errorHistoryRoot) return;
    const collected = this.collectedFailures.get(job.id) ?? [];
    const incoming = failedResultDiagnostics(result);
    for (const failure of incoming.length ? incoming : [{ chapter: diagnostic.chapter, diagnostic }]) {
      if (!collected.some(item => item.chapter === failure.chapter && item.diagnostic.id === failure.diagnostic.id)) collected.push(failure);
    }
    this.collectedFailures.set(job.id, collected);
    const record = { jobId: job.id, story: job.story, type: job.type, createdAt: job.createdAt, failedAt: new Date().toISOString(), diagnostic, failures: [...collected] };
    const write = (this.errorWrites.get(job.id) ?? Promise.resolve()).then(() => saveJobError(this.errorHistoryRoot!, record)).catch(error => { logger.error({ error, jobId: job.id }, "Unable to save job error history"); });
    this.errorWrites.set(job.id, write);
    await write;
  }
  private set(job: Job, patch: Partial<Job>) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    const path = this.durablePaths.get(job.id);
    if (path) {
      const snapshot = structuredClone(job);
      const write = (this.durableWrites.get(job.id) ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => atomicWriteJson(path, snapshot));
      this.durableWrites.set(job.id, write);
      void write
        .catch((error) => logger.error({ error, jobId: job.id }, "Unable to persist summary job"))
        .finally(() => {
          if (this.durableWrites.get(job.id) === write) {
            this.durableWrites.delete(job.id);
          }
        });
    }
    this.events.get(job.id)?.emit("update", structuredClone(job));
  }
  private prune() {
    const terminal = [...this.jobs.values()].filter((job) => isTerminal(job.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const excess = terminal.slice(this.maxRetainedJobs);
    for (const job of excess) {
      this.jobs.delete(job.id);
      this.events.delete(job.id);
      this.collectedFailures.delete(job.id); this.errorWrites.delete(job.id);
      const path = this.durablePaths.get(job.id);
      if (path) {
        const inFlight = this.durableWrites.get(job.id) ?? Promise.resolve();
        const cleanupPromise = inFlight
          .catch(() => undefined)
          .then(async () => {
            try {
              await rm(path, { force: true });
            } catch (error) {
              logger.warn({ error, path, jobId: job.id }, "Failed to delete pruned durable job file");
              throw error;
            }
          })
          .finally(() => {
            this.durablePaths.delete(job.id);
            if (this.durableWrites.get(job.id) === cleanupPromise) {
              this.durableWrites.delete(job.id);
            }
          });
        this.durableWrites.set(job.id, cleanupPromise);
      }
    }
  }
}

const isTerminal = (status: JobStatus) => status === "completed" || status === "failed" || status === "paused" || status === "cancelled";
function logFailure(job: Job, diagnostic: ErrorDiagnostic) { logger.error({ event: "web.job.failed", jobId: job.id, type: job.type, story: job.story, diagnostic }); }

function diagnosticFromResult(result: unknown): ErrorDiagnostic | undefined {
  if (!result || typeof result !== "object") return undefined;
  const results = (result as { results?: unknown }).results;
  for (const item of Array.isArray(results) ? results : []) {
    if (!item || typeof item !== "object" || (item as { status?: unknown }).status !== "failed") continue;
    const value = item as { diagnostic?: unknown; error?: unknown; chapter?: unknown };
    const parsed = errorDiagnosticSchema.safeParse(value.diagnostic);
    if (parsed.success) return parsed.data;
    if (typeof value.error === "string") return createErrorDiagnostic(new Error(value.error), { chapter: typeof value.chapter === "number" ? value.chapter : undefined });
  }
  const chapters = (result as { chapters?: unknown }).chapters;
  for (const value of chapters && typeof chapters === "object" ? Object.values(chapters) : []) {
    if (value && typeof value === "object" && "diagnostic" in value) {
      const parsed = errorDiagnosticSchema.safeParse((value as { diagnostic?: unknown }).diagnostic); if (parsed.success) return parsed.data;
    }
  }
  const failure = Array.isArray((result as { failures?: unknown }).failures) ? (result as { failures: unknown[] }).failures[0] : undefined;
  if (failure && typeof failure === "object") {
    const value = failure as { message?: unknown; chapter?: unknown; stage?: unknown };
    if (typeof value.message === "string") return createErrorDiagnostic(new Error(value.message), {
      chapter: typeof value.chapter === "number" ? value.chapter : undefined,
      stage: typeof value.stage === "string" ? value.stage : undefined,
    });
  }
  return undefined;
}

function admissionScope(scope: OperationScope): OperationScope { return { ...scope, resources: scope.resources?.filter(resource => resource !== "context" && !resource.startsWith("export:")) }; }
