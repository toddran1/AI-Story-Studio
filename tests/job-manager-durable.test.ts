import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JobManager } from "../apps/server/job-manager.js";
import { atomicWrite } from "../src/storage/atomic-write.js";

describe("JobManager durable summary job lifecycle hardening", () => {
  it("deletes the durable JSON file from disk when a terminal job is pruned", async () => {
    const directory = await mkdtemp(join(tmpdir(), "job-prune-test-"));
    // Configure JobManager to retain at most 2 jobs
    const jobs = new JobManager({ maxRetainedJobs: 2 });

    const job1 = await jobs.createDurable(directory, "story-1", async () => ({ res: 1 }));
    await vi.waitFor(() => expect(jobs.get(job1.id)?.status).toBe("completed"));
    await jobs.flushDurable();

    const job2 = await jobs.createDurable(directory, "story-2", async () => ({ res: 2 }));
    await vi.waitFor(() => expect(jobs.get(job2.id)?.status).toBe("completed"));
    await jobs.flushDurable();

    // Verify both files exist
    let files = await readdir(directory);
    expect(files).toContain(`${job1.id}.json`);
    expect(files).toContain(`${job2.id}.json`);

    // Creating job 3 will trigger prune() because retained terminal jobs (2) exceeds threshold when job 3 completes
    const job3 = await jobs.createDurable(directory, "story-3", async () => ({ res: 3 }));
    await vi.waitFor(() => expect(jobs.get(job3.id)?.status).toBe("completed"));
    await jobs.flushDurable();

    // The oldest terminal job (job1) should be pruned from memory AND deleted from disk
    expect(jobs.get(job1.id)).toBeUndefined();
    expect(jobs.get(job2.id)).toBeDefined();
    expect(jobs.get(job3.id)).toBeDefined();

    files = await readdir(directory);
    expect(files).not.toContain(`${job1.id}.json`);
    expect(files).toContain(`${job2.id}.json`);
    expect(files).toContain(`${job3.id}.json`);
  });

  it("does not resurrect pruned jobs upon server restart with restoreDurable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "job-restart-prune-"));
    const jobs = new JobManager({ maxRetainedJobs: 1 });

    const job1 = await jobs.createDurable(directory, "story-1", async () => ({ res: 1 }));
    await vi.waitFor(() => expect(jobs.get(job1.id)?.status).toBe("completed"));
    await jobs.flushDurable();

    const job2 = await jobs.createDurable(directory, "story-2", async () => ({ res: 2 }));
    await vi.waitFor(() => expect(jobs.get(job2.id)?.status).toBe("completed"));
    await jobs.flushDurable();

    // Restart with a new JobManager instance
    const restored = new JobManager({ maxRetainedJobs: 1 });
    await restored.restoreDurable(directory);

    // Job 1 was pruned and deleted from disk; it MUST NOT be restored
    expect(restored.get(job1.id)).toBeUndefined();
    expect(restored.get(job2.id)?.status).toBe("completed");
  });

  it("prunes excess jobs and deletes them from disk when restoreDurable loads a directory with excess records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "job-excess-restore-"));

    // Pre-create 3 durable records manually in directory
    const now = new Date();
    const id1 = "11111111-1111-4111-8111-111111111111";
    const id2 = "22222222-2222-4222-8222-222222222222";
    const id3 = "33333333-3333-4333-8333-333333333333";

    const makeRecord = (id: string, timeOffsetSec: number) => ({
      id,
      type: "summary",
      story: `story-${id.slice(0, 4)}`,
      status: "completed",
      createdAt: new Date(now.getTime() + timeOffsetSec * 1000).toISOString(),
      updatedAt: new Date(now.getTime() + timeOffsetSec * 1000).toISOString(),
      result: { ok: true },
    });

    await atomicWrite(join(directory, `${id1}.json`), JSON.stringify(makeRecord(id1, 10)));
    await atomicWrite(join(directory, `${id2}.json`), JSON.stringify(makeRecord(id2, 20)));
    await atomicWrite(join(directory, `${id3}.json`), JSON.stringify(makeRecord(id3, 30)));

    // Restore with maxRetainedJobs = 2
    const jobs = new JobManager({ maxRetainedJobs: 2 });
    await jobs.restoreDurable(directory);

    // id1 is oldest updatedAt, so it must be pruned
    expect(jobs.get(id1)).toBeUndefined();
    expect(jobs.get(id2)).toBeDefined();
    expect(jobs.get(id3)).toBeDefined();

    const files = await readdir(directory);
    expect(files).not.toContain(`${id1}.json`);
    expect(files).toContain(`${id2}.json`);
    expect(files).toContain(`${id3}.json`);
  });

  it("awaits pending in-flight writes before deleting the file during pruning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "job-inflight-write-"));
    const jobs = new JobManager({ maxRetainedJobs: 1 });

    let resolveSlowTask!: () => void;
    const slowTask = new Promise<void>((resolve) => {
      resolveSlowTask = resolve;
    });

    const job1 = await jobs.createDurable(directory, "story-1", async (control) => {
      control.update({ step: 1 });
      await slowTask;
      return { done: true };
    });

    await vi.waitFor(() => expect(jobs.get(job1.id)?.status).toBe("running"));

    resolveSlowTask();
    await vi.waitFor(() => expect(jobs.get(job1.id)?.status).toBe("completed"));

    // Now immediately create job2 to trigger pruning of job1 while job1's completion write settles
    const job2 = await jobs.createDurable(directory, "story-2", async () => ({ res: 2 }));
    await vi.waitFor(() => expect(jobs.get(job2.id)?.status).toBe("completed"));

    // flushDurable awaits all pending writes and file deletions
    await jobs.flushDurable();

    const files = await readdir(directory);
    expect(files).not.toContain(`${job1.id}.json`);
    expect(files).toContain(`${job2.id}.json`);
  });

  describe("flushDurable hardening and allSettled draining", () => {
    it("A. Multiple successful writes: waits for all and leaves tracking map empty", async () => {
      const jobs = new JobManager();
      let done1 = false;
      let done2 = false;
      const p1 = new Promise<void>((resolve) => setTimeout(() => { done1 = true; resolve(); }, 20));
      const p2 = new Promise<void>((resolve) => setTimeout(() => { done2 = true; resolve(); }, 30));

      (jobs as any).durableWrites.set("job-1", p1);
      (jobs as any).durableWrites.set("job-2", p2);

      await jobs.flushDurable();
      expect(done1).toBe(true);
      expect(done2).toBe(true);
      expect((jobs as any).durableWrites.size).toBe(0);
    });

    it("B. One rejected write + one delayed successful write: does not exit early on first rejection", async () => {
      const jobs = new JobManager();
      let delayedCompleted = false;
      const rejectedPromise = Promise.reject(new Error("Disk IO failure"));
      const delayedPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          delayedCompleted = true;
          resolve();
        }, 40);
      });

      (jobs as any).durableWrites.set("failing-job", rejectedPromise);
      (jobs as any).durableWrites.set("delayed-job", delayedPromise);

      let thrownError: unknown;
      try {
        await jobs.flushDurable();
      } catch (err) {
        thrownError = err;
      }

      // CRITICAL: Must not return or reject before the delayed write completes
      expect(delayedCompleted).toBe(true);
      expect(thrownError).toBeInstanceOf(AggregateError);
      const agg = thrownError as AggregateError;
      expect(agg.errors[0]?.message).toBe("Disk IO failure");
      expect((jobs as any).durableWrites.size).toBe(0);
    });

    it("C. Rejected prune cleanup: aggregates deletion error and waits for other cleanups to settle", async () => {
      const jobs = new JobManager();
      let cleanup2Done = false;
      const failingCleanup = Promise.reject(new Error("EACCES: permission denied"));
      const successfulCleanup = new Promise<void>((resolve) => {
        setTimeout(() => {
          cleanup2Done = true;
          resolve();
        }, 30);
      });

      (jobs as any).durableWrites.set("prune-1", failingCleanup);
      (jobs as any).durableWrites.set("prune-2", successfulCleanup);

      let thrownError: unknown;
      try {
        await jobs.flushDurable();
      } catch (err) {
        thrownError = err;
      }

      expect(cleanup2Done).toBe(true);
      expect(thrownError).toBeInstanceOf(AggregateError);
      expect((jobs as any).durableWrites.size).toBe(0);
    });

    it("D. New write added while flushing: while loop drains subsequent batch before returning", async () => {
      const jobs = new JobManager();
      let batch1Done = false;
      let batch2Done = false;

      const batch1Promise = new Promise<void>((resolve) => {
        setTimeout(() => {
          batch1Done = true;
          // While batch 1 is settling, a new durable write is added
          const batch2Promise = new Promise<void>((res) => {
            setTimeout(() => {
              batch2Done = true;
              res();
            }, 30);
          });
          (jobs as any).durableWrites.set("batch-2-job", batch2Promise);
          resolve();
        }, 20);
      });

      (jobs as any).durableWrites.set("batch-1-job", batch1Promise);

      await jobs.flushDurable();
      expect(batch1Done).toBe(true);
      expect(batch2Done).toBe(true);
      expect((jobs as any).durableWrites.size).toBe(0);
    });

    it("E. Empty map: flushDurable returns immediately", async () => {
      const jobs = new JobManager();
      const start = Date.now();
      await expect(jobs.flushDurable()).resolves.toBeUndefined();
      expect(Date.now() - start).toBeLessThan(50);
    });
  });
});
