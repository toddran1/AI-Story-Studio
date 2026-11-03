import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { JobManager } from "../apps/server/job-manager.js";
import { acquireStoryLock, withChapterLock, withOperationScope, withStoryLock } from "../src/storage/story-lock.js";
import { jobOperationScope, scopesConflict } from "../src/storage/operation-scope.js";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
it("runs disjoint chapter jobs concurrently and rejects any overlapping selection", async () => {
  const jobs = new JobManager(), gate = deferred(), entered: number[] = [];
  const run = (chapter: number) => jobs.create("audio", "book", async () => { entered.push(chapter); await gate.promise; }, { from: chapter, to: chapter });
  const a = run(1), b = run(2); await vi.waitFor(() => expect(entered).toEqual([1, 2]));
  expect(() => run(1)).toThrow("overlapping"); expect(() => jobs.create("video", "book", async () => {}, { from: 1, to: 5 })).toThrow("overlapping");
  gate.resolve(); await vi.waitFor(() => expect(jobs.get(a.id)?.status).toBe("completed")); expect(jobs.get(b.id)?.status).toBe("completed"); expect(run(1)).toBeDefined();
});
it("keeps shared context writers ordered while allowing media on different chapters", () => {
  const context = jobOperationScope("stageExecution", { chapters: [20], stages: ["storyBible"], mode: "selected" });
  expect(scopesConflict(context, jobOperationScope("stageExecution", { chapters: [21], stages: ["storyBible"], mode: "selected" }))).toBe(true);
  expect(scopesConflict(context, jobOperationScope("stageExecution", { chapters: [3], stages: ["tts"], mode: "selected" }))).toBe(false);
  expect(scopesConflict({ from: 1, to: 9 }, { chapters: [10, 8] })).toBe(true);
  expect(jobOperationScope("audioRegeneration", { selections: [{ chapter: 1 }, { chapter: 4 }] }).chapters).toEqual([1, 4]);
});
it("protects same chapters across independent lock clients and excludes global changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "concurrent-lock-")); try {
    const releaseA = await acquireStoryLock(root, "book", "audio", { chapters: [1] });
    const releaseB = await acquireStoryLock(root, "book", "edit", { chapters: [2] });
    try { await expect(acquireStoryLock(root, "book", "overlap", { from: 1, to: 3 })).rejects.toThrow("overlapping"); await expect(acquireStoryLock(root, "book", "delete")).rejects.toThrow("overlapping"); }
    finally { await releaseB(); await releaseA(); }
    const release = await acquireStoryLock(root, "book", "settings"); try { await expect(acquireStoryLock(root, "book", "edit", { chapters: [2] })).rejects.toThrow("locked"); } finally { await release(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("lets chapter editing run alongside a scoped batch but preserves context resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "concurrent-edit-")), gate = deferred(), entered = deferred();
  try {
    const running = withOperationScope("book", { chapters: [1, 2], resources: ["context"] }, () => withStoryLock(root, "book", "context", async () => { entered.resolve(); await gate.promise; }));
    await entered.promise;
    await expect(withChapterLock(root, "book", 3, "text edit", async () => "saved")).resolves.toBe("saved");
    await expect(withChapterLock(root, "book", 2, "text edit", async () => {})).rejects.toThrow("overlapping");
    gate.resolve(); await running;
  } finally { gate.resolve(); await rm(root, { recursive: true, force: true }); }
});
it("cancels queued jobs without running and running jobs at safe boundaries", async () => {
  const jobs = new JobManager(), run = vi.fn(async () => {});
  const queued = jobs.create("audio", "a", run, { chapter: 1 }); expect(jobs.cancel(queued.id)).toBe(true);
  await vi.waitFor(() => expect(jobs.get(queued.id)?.status).toBe("cancelled")); expect(run).not.toHaveBeenCalled();
  const gate = deferred(), pause = vi.fn();
  const active = jobs.create("video", "a", async control => { control.setPause(pause); await gate.promise; return { rendered: 1 }; }, { chapter: 2 });
  await vi.waitFor(() => expect(jobs.get(active.id)?.status).toBe("running")); jobs.cancel(active.id); expect(pause).toHaveBeenCalled(); expect(jobs.get(active.id)?.status).toBe("running");
  gate.resolve(); await vi.waitFor(() => expect(jobs.get(active.id)?.status).toBe("cancelled")); expect(jobs.get(active.id)?.result).toEqual({ rendered: 1 });
});
it("supports a queued pause and releases its chapter reservation", async () => {
  const jobs = new JobManager(), run = vi.fn(async () => {}), first = jobs.create("audio", "a", run, { chapter: 1 }); jobs.pause(first.id);
  await vi.waitFor(() => expect(jobs.get(first.id)?.status).toBe("paused")); expect(run).not.toHaveBeenCalled(); expect(jobs.create("audio", "a", run, { chapter: 1 })).toBeDefined();
});
it("queues disjoint context batches in order while unrelated media runs", async () => {
  const jobs=new JobManager(), gate=deferred(), calls:string[]=[];
  const payload=(chapter:number)=>({chapters:[chapter],stages:["storyBible"],mode:"selected"});
  const first=jobs.create("stageExecution","book",async()=>{calls.push("first");await gate.promise;},payload(1));
  const second=jobs.create("stageExecution","book",async()=>{calls.push("second");},payload(2));
  const media=jobs.create("audio","book",async()=>{calls.push("media");},{from:3,to:3});
  await vi.waitFor(()=>expect(calls).toEqual(["first","media"]));expect(jobs.get(second.id)?.status).toBe("queued");expect(jobs.get(media.id)?.status).toBe("completed");
  gate.resolve();await vi.waitFor(()=>expect(jobs.get(second.id)?.status).toBe("completed"));expect(jobs.get(first.id)?.status).toBe("completed");expect(calls).toEqual(["first","media","second"]);
});
