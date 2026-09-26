import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobManager } from "../apps/server/job-manager.js";
import { listJobErrors } from "../apps/server/job-error-history.js";
import { createErrorDiagnostic } from "../src/errors/diagnostic.js";

describe("job error history", () => {
  it("persists a failed job after the in-memory job is gone, searchable by job and reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-job-errors-"));
    try {
      const manager = new JobManager({ maxRetainedJobs: 0 });
      manager.configureErrorHistory(root);
      const job = manager.create("stageExecution", "test-story", async () => { throw new Error("Test provider failure"); }, { privateStoryText: "do not persist me" });
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await listJobErrors(root, "test-story")).length) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(manager.get(job.id)).toBeUndefined();
      const records = await listJobErrors(root, "test-story");
      expect(records).toHaveLength(1);
      expect(records[0]?.diagnostic.summary).toContain("Test provider failure");
      expect(await listJobErrors(root, "test-story", job.id)).toHaveLength(1);
      expect(await listJobErrors(root, "test-story", records[0]!.diagnostic.id)).toHaveLength(1);
      const saved = await readFile(join(root, "job-errors", "test-story", `${job.id}.json`), "utf8");
      expect(saved).not.toContain("privateStoryText");
      expect(saved).not.toContain("do not persist me");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("retains individual chapter errors when a batch completes with errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-batch-errors-"));
    try {
      const manager = new JobManager(); manager.configureErrorHistory(root);
      const first = createErrorDiagnostic(new Error("Chapter 4 failed"), { chapter: 4, stage: "tts" });
      const second = createErrorDiagnostic(new Error("Chapter 5 failed"), { chapter: 5, stage: "audio" });
      const job = manager.create("batch", "test-story", async () => ({ status: "completed_with_errors", results: [
        { chapter: 4, status: "failed", diagnostic: first }, { chapter: 5, status: "failed", diagnostic: second },
      ] }));
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await listJobErrors(root, "test-story")).length) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const [record] = await listJobErrors(root, "test-story", second.id);
      expect(record?.jobId).toBe(job.id);
      expect(record?.failures.map((failure) => failure.chapter)).toEqual([4, 5]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
