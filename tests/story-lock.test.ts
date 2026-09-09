import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireStoryLock } from "../src/storage/story-lock.js";

describe("story lock", () => {
  it("rejects a second live owner and permits work after release", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-lock-"));
    const release = await acquireStoryLock(root, "novel", "first operation");
    await expect(acquireStoryLock(root, "novel", "second operation")).rejects.toThrow(/locked by PID/);
    await release();
    const releaseAgain = await acquireStoryLock(root, "novel", "second operation");
    await releaseAgain();
  });

  it("recovers a lock owned by a process that is no longer running", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-lock-stale-"));
    const lock = join(root, "stories", "novel", ".lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "old", pid: 2_147_483_647, operation: "crashed", startedAt: new Date(0).toISOString() }));
    const release = await acquireStoryLock(root, "novel", "recovery");
    await release();
  });
});
