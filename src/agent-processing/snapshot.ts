import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, lstat } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { fingerprint } from "../utils/hash.js";
import { z } from "zod";
import { sourceManifestSchema } from "../source/types.js";
import { mapLimit } from "../utils/map-limit.js";

const excluded = new Set(["agent-runs", "production-runs", "batches", "exports", "previews", "voice-previews", ".lock"]);
export type FileMap = Record<string, string>;
export function safeRelative(path: string): string {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).some((part) => part === ".." || part === "." || !part)) throw new Error("Unsafe artifact path");
  return path;
}
/** Text stages need canonical history, selected chapter artifacts, and retained sources,
 * never audio/image trees. Undefined scope preserves the legacy/media inventory. */
export type TextInventoryScope = { chapters: number[] };
export async function inventory(directory: string, scope?: TextInventoryScope): Promise<FileMap> {
  const names: string[] = [];
  const selected = new Set(scope?.chapters);
  const contextFiles = new Set(["chapter.json", "story-bible-update.json", "visual-evidence-backfill.json"]);
  const sourceFiles = new Set(["source/source.json"]);
  if (scope) {
    try {
      for (const name of ["source", "source/source.json"]) {
        const info = await lstat(join(directory, name));
        if (info.isSymbolicLink()) throw new Error(`Agent processing rejects symlink: ${name}`);
      }
      const manifest = sourceManifestSchema.parse(JSON.parse(await readFile(join(directory, "source", "source.json"), "utf8")));
      for (const item of manifest.chapters) if (selected.has(item.chapter)) sourceFiles.add(`source/${safeRelative(item.file)}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const includes = (name: string, isDirectory: boolean) => {
    if (!scope) return true;
    const parts = name.split("/");
    if (parts[0] === "source") return isDirectory
      ? [...sourceFiles].some((file) => file.startsWith(`${name}/`)) : sourceFiles.has(name);
    if (parts[0] === "chapters") {
      if (isDirectory) return parts.length === 1 || (parts.length === 2 && /^\d+$/.test(parts[1]!));
      return parts.length === 3 && (selected.has(Number(parts[1]))
        ? /\.(json|txt)$/.test(parts[2]!) : contextFiles.has(parts[2]!));
    }
    // Eligible summaries live in direct JSON records; their media is irrelevant.
    if (parts[0] === "summaries") return isDirectory ? parts.length === 1 : parts.length === 2 && name.endsWith(".json");
    return !isDirectory && parts.length === 1 && /\.(json|txt)$/.test(name);
  };
  async function walk(dir: string) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && dir !== directory) return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".DS_Store" || entry.name.startsWith("._")) continue;
      if (dir === directory && (excluded.has(entry.name) || entry.name.startsWith(".lock-"))) continue;
      const path = join(dir, entry.name);
      const name = relative(directory, path);
      if (entry.isSymbolicLink()) {
        if (!scope || includes(name, true) || includes(name, false)) throw new Error(`Agent processing rejects symlink: ${name}`);
        continue;
      }
      if (!includes(name, entry.isDirectory())) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) names.push(name);
    }
  }
  await walk(directory);
  const hashes = await mapLimit(names, 8, async (name) => (await fileFingerprint(join(directory, name))) ?? "empty");
  return Object.fromEntries(names.map((name, index) => [name, hashes[index]!]));
}
export const inventoryFingerprint = (files: FileMap) => fingerprint(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
export async function copySnapshot(source: string, target: string, files: FileMap) {
  await mkdir(target, { recursive: true });
  await mapLimit(Object.keys(files), 8, async (name) => {
    const destination = join(target, safeRelative(name));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(source, name), destination, constants.COPYFILE_FICLONE);
  });
}
const journalSchema = z.object({
  version: z.literal(1), paths: z.array(z.string()), existing: z.array(z.string()), committed: z.boolean().default(false),
  beforeHashes: z.record(z.string(), z.string()).optional(), afterHashes: z.record(z.string(), z.string()).optional(),
});
async function currentHash(path: string) {
  try { return (await fileFingerprint(path)) ?? ((await lstat(path)).isFile() ? "empty" : undefined); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function restore(target: string, transaction: string) {
  const journal = journalSchema.parse(JSON.parse(await readFile(join(transaction, "journal.json"), "utf8")));
  if (journal.committed) { await rm(transaction, { recursive: true, force: true }); return; }
  // Never undo a user's post-interruption edit. Check every path before rollback.
  if (journal.beforeHashes && journal.afterHashes) for (const name of journal.paths) {
    const actual = await currentHash(join(target, safeRelative(name)));
    if (actual !== journal.beforeHashes[name] && actual !== journal.afterHashes[name]) throw new Error(`Recovery blocked: ${name} changed after an interrupted commit. Preserve/reconcile that edit before recovery.`);
  }
  const existing = new Set(journal.existing);
  for (const name of journal.paths) {
    safeRelative(name);
    if (existing.has(name)) await atomicWrite(join(target, name), await readFile(join(transaction, "before", name)));
    else await rm(join(target, name), { force: true });
  }
  await rm(transaction, { recursive: true, force: true });
}
/** Called under the story lock before every operation; unfinished commits roll back. */
export async function recoverTransactions(story: string) {
  const runs = join(story, "agent-runs");
  let entries;
  try { entries = await readdir(runs, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !z.string().uuid().safeParse(entry.name).success) continue;
    const transaction = join(runs, entry.name, "transaction");
    try { await lstat(join(transaction, "journal.json")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    await restore(story, transaction);
  }
}
/** Write only the delta, preserving exact old bytes in a durable rollback journal. */
export async function commitSnapshot(story: string, snapshot: string, runDir: string, before: FileMap, after: FileMap, checkpoint?: { path: string; data: string }, scope?: TextInventoryScope) {
  if (inventoryFingerprint(await inventory(story, scope)) !== inventoryFingerprint(before)) throw new Error("Story changed while the agent was working. Prepare a new run; no output was committed.");
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name]);
  if (checkpoint) paths.push(safeRelative(checkpoint.path));
  const transaction = join(runDir, "transaction");
  await rm(transaction, { recursive: true, force: true });
  const existing = paths.filter((name) => name in before);
  if (checkpoint) existing.push(checkpoint.path);
  for (const name of existing) {
    const backup = join(transaction, "before", safeRelative(name));
    await mkdir(dirname(backup), { recursive: true });
    await copyFile(join(story, name), backup, constants.COPYFILE_FICLONE);
  }
  const beforeHashes = Object.fromEntries(paths.filter((name) => name in before).map((name) => [name, before[name]!]));
  const afterHashes = Object.fromEntries(paths.filter((name) => name in after).map((name) => [name, after[name]!]));
  if (checkpoint) {
    beforeHashes[checkpoint.path] = (await currentHash(join(story, checkpoint.path)))!;
    afterHashes[checkpoint.path] = fingerprint(Buffer.from(checkpoint.data).toString("base64"));
  }
  const journal = { version: 1, paths, existing, beforeHashes, afterHashes, committed: false };
  await atomicWriteJson(join(transaction, "journal.json"), journal);
  try {
    // Chapter metadata is published last, after its artifacts and canonical side effects.
    const rank = (name: string) => name === checkpoint?.path ? 2 : name.endsWith("chapter.json") ? 1 : 0;
    paths.sort((a, b) => rank(a) - rank(b));
    for (const name of paths) {
      safeRelative(name);
      if (name === checkpoint?.path) await atomicWrite(join(story, name), checkpoint.data);
      else if (name in after) await atomicWrite(join(story, name), await readFile(join(snapshot, name)));
      else await rm(join(story, name), { force: true });
    }
    await atomicWriteJson(join(transaction, "journal.json"), { ...journal, committed: true });
    await rm(transaction, { recursive: true, force: true });
  } catch (error) {
    try { await restore(story, transaction); }
    catch (rollback) { throw new AggregateError([error, rollback], "Agent commit failed; rollback is incomplete. Resume to recover the transaction."); }
    throw error;
  }
}
