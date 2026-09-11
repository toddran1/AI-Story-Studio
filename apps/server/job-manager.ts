import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createErrorDiagnostic, ErrorDiagnostic, errorDiagnosticSchema } from "../../src/errors/diagnostic.js";
import { logger } from "../../src/utils/logger.js";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "paused";
export type Job = { id: string; type: "batch" | "preview" | "voicePreview" | "audio" | "audiobook" | "alignment" | "subtitles" | "video" | "videoExport" | "scenes" | "artwork" | "production"; story: string; status: JobStatus; createdAt: string; updatedAt: string; progress?: unknown; result?: unknown; error?: string; diagnostic?: ErrorDiagnostic };
type JobControl = { update(progress: unknown): void; setPause(handler: () => void): void };

export class JobConflictError extends Error {}

export class JobManager {
  private static readonly maxRetainedJobs = 200;
  private readonly jobs = new Map<string, Job>();
  private readonly events = new Map<string, EventEmitter>();
  private readonly activeStories = new Map<string, string>();
  private readonly pauseHandlers = new Map<string, () => void>();

  create(type: Job["type"], story: string, runner: (control: JobControl) => Promise<unknown>): Job {
    this.prune();
    const active = this.activeStories.get(story);
    if (active) throw new JobConflictError(`Story '${story}' already has active job ${active}`);
    const now = new Date().toISOString(); const job: Job = { id: randomUUID(), type, story, status: "queued", createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job); this.events.set(job.id, new EventEmitter()); this.activeStories.set(story, job.id);
    queueMicrotask(() => this.run(job, runner)); return { ...job };
  }

  get(id: string): Job | undefined { const job = this.jobs.get(id); return job ? structuredClone(job) : undefined; }
  list(): Job[] { return [...this.jobs.values()].map((job) => structuredClone(job)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  subscribe(id: string, listener: (job: Job) => void): (() => void) | undefined {
    const job = this.get(id); if (!job) return undefined;
    listener(job);
    if (isTerminal(job.status)) return () => undefined;
    const emitter = this.events.get(id); if (!emitter) return () => undefined;
    emitter.on("update", listener); return () => emitter.off("update", listener);
  }
  pause(id: string): boolean { const handler = this.pauseHandlers.get(id); if (!handler) return false; handler(); return true; }
  pauseAll(): void { for (const handler of this.pauseHandlers.values()) handler(); }

  private async run(job: Job, runner: (control: JobControl) => Promise<unknown>) {
    this.set(job, { status: "running" });
    try {
      const result = await runner({
        update: (progress) => this.set(job, { progress }),
        setPause: (handler) => this.pauseHandlers.set(job.id, handler),
      });
      const resultStatus = typeof result === "object" && result !== null && "status" in result ? (result as { status?: unknown; stopReason?: unknown }).status : undefined;
      if (resultStatus === "paused") this.set(job, { status: "paused", result });
      else if (resultStatus === "failed" || resultStatus === "completed_with_errors") {
        const reason = typeof (result as { stopReason?: unknown }).stopReason === "string" ? (result as { stopReason: string }).stopReason : `Batch ${resultStatus}`;
        const diagnostic = diagnosticFromResult(result) ?? createErrorDiagnostic(new Error(reason), { summary: reason });
        logFailure(job, diagnostic);
        this.set(job, { status: "failed", result, error: diagnostic.summary, diagnostic });
      } else this.set(job, { status: "completed", result });
    } catch (error) { const diagnostic = createErrorDiagnostic(error); logFailure(job, diagnostic); this.set(job, { status: "failed", error: diagnostic.summary, diagnostic }); }
    finally {
      this.pauseHandlers.delete(job.id); if (this.activeStories.get(job.story) === job.id) this.activeStories.delete(job.story);
      this.events.delete(job.id); this.prune();
    }
  }
  private set(job: Job, patch: Partial<Job>) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.events.get(job.id)?.emit("update", structuredClone(job));
  }
  private prune() {
    const terminal = [...this.jobs.values()].filter((job) => isTerminal(job.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const job of terminal.slice(JobManager.maxRetainedJobs)) { this.jobs.delete(job.id); this.events.delete(job.id); }
  }
}

const isTerminal = (status: JobStatus) => status === "completed" || status === "failed" || status === "paused";
function logFailure(job: Job, diagnostic: ErrorDiagnostic) { logger.error({ event: "web.job.failed", jobId: job.id, type: job.type, story: job.story, diagnostic }); }

function diagnosticFromResult(result: unknown): ErrorDiagnostic | undefined {
  if (!result || typeof result !== "object") return undefined;
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
