import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { storyPaths } from "./paths.js";

type LockOwner = { token: string; pid: number; operation: string; startedAt: string };

export async function acquireStoryLock(root: string, slug: string, operation: string): Promise<() => Promise<void>> {
  const story = storyPaths(root, slug, 1).story; const lockDir = join(story, ".lock"); const ownerPath = join(lockDir, "owner.json");
  const candidate = join(story, `.lock-candidate-${randomUUID()}`);
  await mkdir(story, { recursive: true }); const owner: LockOwner = { token: randomUUID(), pid: process.pid, operation, startedAt: new Date().toISOString() };
  await mkdir(candidate);
  try { await writeFile(join(candidate, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8"); }
  catch (error) { await rm(candidate, { recursive: true, force: true }); throw error; }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rename(candidate, lockDir);
      break;
    }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        await rm(candidate, { recursive: true, force: true }); throw error;
      }
      const existing = await readOwner(ownerPath);
      if (existing && processIsRunning(existing.pid)) {
        await rm(candidate, { recursive: true, force: true });
        throw new Error(`Story '${slug}' is locked by PID ${existing.pid} (${existing.operation}, started ${existing.startedAt})`);
      }
      const stale = join(story, `.lock-stale-${randomUUID()}`);
      try { await rename(lockDir, stale); await rm(stale, { recursive: true, force: true }); }
      catch (recoveryError) {
        if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT") {
          await rm(candidate, { recursive: true, force: true }); throw recoveryError;
        }
      }
      if (attempt === 2) { await rm(candidate, { recursive: true, force: true }); throw new Error(`Unable to recover stale lock for story '${slug}'`); }
    }
  }
  return async () => {
    const current = await readOwner(ownerPath); if (current?.token === owner.token) await rm(lockDir, { recursive: true, force: true });
  };
}

export async function withStoryLock<T>(root: string, slug: string, operation: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireStoryLock(root, slug, operation);
  try { const result = await action(); await release(); return result; }
  catch (error) { try { await release(); } catch { /* Preserve the operation failure. */ } throw error; }
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as LockOwner; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined; throw error; }
}
function processIsRunning(pid: number) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
