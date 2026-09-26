import { readFile, rename, rm, stat } from "node:fs/promises";

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  const text = await readTextIfExists(path); return text === undefined ? undefined : JSON.parse(text) as T;
}
export async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export async function renamePath(source: string, destination: string): Promise<void> {
  await rename(source, destination);
}
export async function removePath(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true });
}
