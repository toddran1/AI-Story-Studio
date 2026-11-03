import { atomicWriteJson } from "./atomic-write.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { type OperationScope, scopesConflict } from "./operation-scope.js";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { storyPaths } from "./paths.js";

type LockOwner = { token: string; pid: number; operation: string; startedAt: string };

async function acquireExclusiveLock(root: string, slug: string, operation: string, name = ".lock"): Promise<() => Promise<void>> {
  const story = storyPaths(root, slug, 1).story; const lockDir = join(story, name); const ownerPath = join(lockDir, "owner.json");
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

type ScopeControl = { stopped?: () => boolean; waiting?: () => void; acquired?: () => void };
const operationScope = new AsyncLocalStorage<{ slug: string; scope: OperationScope; control?: ScopeControl }>();
export function withOperationScope<T>(slug: string, scope: OperationScope, action: () => Promise<T>, control?: ScopeControl) { return operationScope.run({ slug, scope, control }, action); }
export class StoryLockConflictError extends Error { constructor(message: string, readonly sharedOnly = false) { super(message); } }
export class OperationStoppedError extends Error { constructor() { super("Operation stopped before acquiring its story resources"); } }

/** Admission is serialized across processes; leases retain chapter ownership
 * for the entire operation without holding the story-wide mutex. */
export async function acquireStoryLock(root: string, slug: string, operation: string, scope: OperationScope = { all: true }): Promise<() => Promise<void>> {
  let releaseAdmission: (() => Promise<void>) | undefined;
  for (let attempt = 0; !releaseAdmission; attempt++) {
    try { releaseAdmission = await acquireExclusiveLock(root, slug, operation, ".lock-admission"); }
    catch (error) { if (attempt >= 100 || !(error instanceof Error) || !error.message.includes("is locked by PID")) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  try {
    const story = storyPaths(root, slug, 1).story, directory = join(story, ".operation-locks");
    await mkdir(directory, { recursive: true });
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".json")) continue;
      const path = join(directory, name);
      let owner: LockOwner & { scope?: OperationScope };
      try { owner = JSON.parse(await readFile(path, "utf8")) as typeof owner; }
      catch (error) {
        // A lease can finish after readdir but before its owner is read.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (error instanceof SyntaxError) throw new StoryLockConflictError(`Story '${slug}' has an unreadable operation lock; inspect ${path} before retrying.`);
        throw error;
      }
      if (!owner || typeof owner !== "object") throw new StoryLockConflictError(`Story '${slug}' has an unreadable operation lock; inspect ${path} before retrying.`);
      if (!processIsRunning(owner.pid)) { await rm(path, { force: true }); continue; }
      const otherScope = owner.scope ?? { all: true };
      if (scopesConflict(scope, otherScope)) {
        const sharedOnly = !scopesConflict({ ...scope, resources: [] }, { ...otherScope, resources: [] }) && Boolean(scope.resources?.some(resource => (resource === "context" || resource.startsWith("export:")) && otherScope.resources?.includes(resource)));
        throw new StoryLockConflictError(`Story '${slug}' has overlapping work (${owner.operation}). Choose different chapters or wait for it to finish.`, sharedOnly);
      }
    }
    if (scope.all) return await acquireExclusiveLock(root, slug, operation);
    const globalOwner = await readOwner(join(story, ".lock", "owner.json"));
    if (globalOwner && processIsRunning(globalOwner.pid)) throw new StoryLockConflictError(`Story '${slug}' is locked (${globalOwner.operation}).`);
    const token = randomUUID(), path = join(directory, `${token}.json`);
    await atomicWriteJson(path, { token, pid: process.pid, operation, startedAt: new Date().toISOString(), scope });
    return async () => { await rm(path, { force: true }); };
  } finally { await releaseAdmission(); }
}

export async function withStoryLock<T>(root: string, slug: string, operation: string, action: () => Promise<T>): Promise<T> {
  const inherited = operationScope.getStore(); const control = inherited?.slug === slug ? inherited.control : undefined;
  const scope = inherited?.slug === slug ? inherited.scope : { all: true };
  let release: (() => Promise<void>) | undefined, waiting = false;
  const deadline = Date.now() + 10 * 60_000;
  while (!release) {
    if (control?.stopped?.()) throw new OperationStoppedError();
    try { release = await acquireStoryLock(root, slug, operation, scope); }
    catch (error) {
      if (!(error instanceof StoryLockConflictError) || !error.sharedOnly || Date.now() >= deadline) throw error;
      if (!waiting) { waiting = true; control?.waiting?.(); }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try {
    if (waiting) control?.acquired?.();
    if (control?.stopped?.()) throw new OperationStoppedError();
    const result = await action(); await release(); return result;
  } catch (error) { try { await release(); } catch { /* Preserve the operation failure. */ } throw error; }
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as LockOwner; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined; throw error; }
}
function processIsRunning(pid: number) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function withChapterLock<T>(root: string, slug: string, chapter: number, operation: string, action: () => Promise<T>) {
  if (!Number.isSafeInteger(chapter) || chapter < 1) throw new Error("Invalid chapter lock");
  const inherited = operationScope.getStore();
  if (inherited?.slug === slug) return withStoryLock(root, slug, operation, action);
  return withOperationScope(slug, { chapters: [chapter] }, () => withStoryLock(root, slug, operation, action));
}

/** A narrow cross-process mutex for shared sidecar files. Callers already own
 * their chapter or story lease; this only serializes the shared resource. */
export async function withStoryResource<T>(root: string, slug: string, resource: string, action: () => Promise<T>): Promise<T> {
  if (!/^[a-z-]+$/.test(resource)) throw new Error("Invalid shared resource");
  const deadline = Date.now() + 10 * 60_000;
  let release: (() => Promise<void>) | undefined;
  while (!release) {
    try { release = await acquireExclusiveLock(root, slug, resource, `.lock-${resource}`); }
    catch (error) { if (Date.now() >= deadline || !(error instanceof Error) || !error.message.includes("is locked by PID")) throw error; await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  try { return await action(); } finally { await release(); }
}

export function withScopedStoryLock<T>(root: string, slug: string, scope: OperationScope, operation: string, action: () => Promise<T>) {
  const inherited = operationScope.getStore();
  return inherited?.slug === slug ? withStoryLock(root, slug, operation, action) : withOperationScope(slug, scope, () => withStoryLock(root, slug, operation, action));
}
export function withSummaryLock<T>(root: string, slug: string, id: string, operation: string, action: () => Promise<T>) {
  return withScopedStoryLock(root, slug, { resources: [`summary:${id}`] }, operation, action);
}
