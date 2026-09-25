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
});
