import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireStoryLock } from "../src/storage/story-lock.js";

describe("story lock", () => {
  it("ignores AppleDouble metadata while retaining live chapter ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-lock-sidecar-"));
    const release = await acquireStoryLock(root, "novel", "first", { chapters: [718] });
    const directory = join(root, "stories", "novel", ".operation-locks");
    const [lease] = await readdir(directory);
    await writeFile(join(directory, `._${lease}`), Buffer.from([0, 5, 22, 7, 0, 2, 0, 0]));
    await writeFile(join(directory, "unrelated.json"), "metadata");
    try {
      const releaseSecond = await acquireStoryLock(root, "novel", "second", { chapters: [671] });
      await releaseSecond();
      await expect(acquireStoryLock(root, "novel", "overlap", { chapters: [718] })).rejects.toThrow(/overlapping/);
    } finally { await release(); }
  });

  it("still rejects unreadable actual UUID leases", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-lock-corrupt-"));
    const directory = join(root, "stories", "novel", ".operation-locks");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "f55b0165-14da-4bab-bdac-f71ae0847bb1.json"), "broken");
    await expect(acquireStoryLock(root, "novel", "second", { chapters: [671] })).rejects.toThrow(/unreadable operation lock/);
  });

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
