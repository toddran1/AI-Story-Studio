import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "paused";
export type Job = { id: string; type: "batch" | "preview"; story: string; status: JobStatus; createdAt: string; updatedAt: string; progress?: unknown; result?: unknown; error?: string };
type JobControl = { update(progress: unknown): void; setPause(handler: () => void): void };

export class JobConflictError extends Error {}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly events = new Map<string, EventEmitter>();
  private readonly activeStories = new Map<string, string>();
  private readonly pauseHandlers = new Map<string, () => void>();

  create(type: Job["type"], story: string, runner: (control: JobControl) => Promise<unknown>): Job {
    const active = this.activeStories.get(story);
    if (active) throw new JobConflictError(`Story '${story}' already has active job ${active}`);
    const now = new Date().toISOString(); const job: Job = { id: randomUUID(), type, story, status: "queued", createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job); this.events.set(job.id, new EventEmitter()); this.activeStories.set(story, job.id);
    queueMicrotask(() => this.run(job, runner)); return { ...job };
  }

  get(id: string): Job | undefined { const job = this.jobs.get(id); return job ? structuredClone(job) : undefined; }
  list(): Job[] { return [...this.jobs.values()].map((job) => structuredClone(job)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  subscribe(id: string, listener: (job: Job) => void): (() => void) | undefined {
    const emitter = this.events.get(id); const job = this.get(id); if (!emitter || !job) return undefined;
    emitter.on("update", listener); listener(job); return () => emitter.off("update", listener);
  }
  pause(id: string): boolean { const handler = this.pauseHandlers.get(id); if (!handler) return false; handler(); return true; }

  private async run(job: Job, runner: (control: JobControl) => Promise<unknown>) {
    this.set(job, { status: "running" });
    try {
      const result = await runner({
        update: (progress) => this.set(job, { progress }),
        setPause: (handler) => this.pauseHandlers.set(job.id, handler),
      });
      const paused = typeof result === "object" && result !== null && "status" in result && (result as { status?: unknown }).status === "paused";
      this.set(job, { status: paused ? "paused" : "completed", result });
    } catch (error) { this.set(job, { status: "failed", error: error instanceof Error ? error.message : String(error) }); }
    finally { this.pauseHandlers.delete(job.id); if (this.activeStories.get(job.story) === job.id) this.activeStories.delete(job.story); }
  }
  private set(job: Job, patch: Partial<Job>) {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.events.get(job.id)?.emit("update", structuredClone(job));
  }
}
