import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobManager } from "../apps/server/job-manager.js";
import { listJobErrors, saveJobError } from "../apps/server/job-error-history.js";
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
  it("captures failures during a running batch, preserves them on completion, and deduplicates final results", async () => {
    const root = await mkdtemp(join(tmpdir(), "live-batch-errors-"));
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const first = createErrorDiagnostic(new Error("First chapter failed"), { chapter: 4, stage: "tts" });
    const second = createErrorDiagnostic(new Error("Second chapter failed"), { chapter: 5, stage: "tts" });
    const manager = new JobManager(); manager.configureErrorHistory(root);
    const job = manager.create("batch", "test-story", async control => {
      control.update({ type: "chapter.failed", chapter: 4, error: first.summary, diagnostic: first });
      control.update({ type: "chapter.failed", chapter: 5, error: second.summary, diagnostic: second });
      await hold;
      return { status: "completed_with_errors", results: [{ chapter: 4, status: "failed", diagnostic: first }, { chapter: 5, status: "failed", diagnostic: second }] };
    });
    try {
      for (let attempt=0; attempt<100; attempt++) {
        if ((await listJobErrors(root,"test-story"))[0]?.failures.length === 2) break;
        await new Promise(resolve => setTimeout(resolve,10));
      }
      expect(manager.get(job.id)?.status).toBe("running");
      expect((await listJobErrors(root,"test-story"))[0]?.failures.map(row => row.chapter)).toEqual([4,5]);
      release();
      for (let attempt=0; attempt<100 && manager.get(job.id)?.status === "running"; attempt++) await new Promise(resolve => setTimeout(resolve,10));
      expect((await listJobErrors(root,"test-story"))[0]?.failures).toHaveLength(2);
    } finally { release(); await rm(root, { recursive: true, force: true }); }
  });
  it("captures result-only errors even when the job reports completed", async () => {
    const root = await mkdtemp(join(tmpdir(), "completed-batch-errors-"));
    const manager = new JobManager(); manager.configureErrorHistory(root);
    const job = manager.create("audioRegeneration", "test-story", async () => ({ status: "completed", results: [{ chapter: 322, segment: 1, status: "failed", error: "Connection reset" }, { chapter: 322, segment: 2, status: "failed", error: "Connection reset" }] }));
    try {
      for (let attempt=0; attempt<100 && !["completed","failed"].includes(manager.get(job.id)?.status ?? ""); attempt++) await new Promise(resolve => setTimeout(resolve,10));
      const records = await listJobErrors(root,"test-story");
      expect(records[0]?.failures).toHaveLength(2);
      expect(records[0]?.failures.map(row => row.diagnostic.summary)).toEqual(expect.arrayContaining([expect.stringContaining("Segment 1"), expect.stringContaining("Segment 2")]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not overwrite earlier chapter errors when a later fatal error stops the job", async () => {
    const root = await mkdtemp(join(tmpdir(), "fatal-batch-errors-"));
    const manager = new JobManager(); manager.configureErrorHistory(root);
    const diagnostic = createErrorDiagnostic(new Error("Chapter error before fatal stop"), { chapter: 4 });
    const job = manager.create("batch", "test-story", async control => {
      control.update({ type: "chapter.failed", chapter: 4, error: diagnostic.summary, diagnostic });
      throw new Error("Fatal later failure");
    });
    try {
      for (let attempt=0; attempt<100 && manager.get(job.id)?.status !== "failed"; attempt++) await new Promise(resolve => setTimeout(resolve,10));
      const [record] = await listJobErrors(root,"test-story");
      expect(record?.failures).toHaveLength(2);
      expect(record?.failures[0]?.diagnostic.id).toBe(diagnostic.id);
      expect(record?.failures[1]?.diagnostic.summary).toContain("Fatal later failure");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("adds chapter titles to legacy diagnostics and per-chapter failures without rewriting saved records", async () => {
    const root = await mkdtemp(join(tmpdir(), "chapter-error-titles-"));
    const jobId = "12345678-1234-4234-8234-123456789abc";
    const diagnostic = createErrorDiagnostic(new Error("Story=test-story Chapter=260 Stage=tts: timeout"));
    const failure = createErrorDiagnostic(new Error("Connection error"));
    try {
      await atomicWriteJson(storyPaths(root,"test-story",260).chapterMeta, { chapter:260, originalTitle:"原文", translatedTitle:"The old tower" });
      await atomicWriteJson(storyPaths(root,"test-story",271).chapterMeta, { chapter:271, originalTitle:"黎明" });
      await saveJobError(root, { jobId, story:"test-story", type:"batch", createdAt:new Date().toISOString(), failedAt:new Date().toISOString(), diagnostic, failures:[{chapter:271,diagnostic:failure},{chapter:275,diagnostic:failure}] });
      const [record] = await listJobErrors(root,"test-story");
      expect(record?.diagnostic).toMatchObject({ chapter:260, chapterTitle:"The old tower" });
      expect(record?.failures[0]?.diagnostic).toMatchObject({ chapter:271, chapterTitle:"黎明" });
      expect(record?.failures[1]?.diagnostic).toMatchObject({ chapter:275 });
      expect(record?.failures[1]?.diagnostic.chapterTitle).toBeUndefined();
      expect(await readFile(join(root,"job-errors","test-story",`${jobId}.json`),"utf8")).not.toContain("chapterTitle");
    } finally { await rm(root, {recursive:true,force:true}); }
  });

});
