import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { StorageError } from "../pipeline/errors.js";

export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (error) {
    try { await rm(temp, { force: true }); } catch { /* Preserve the original storage failure. */ }
    throw new StorageError(`Atomic write failed for ${path}`, { cause: error });
  }
}

export const atomicWriteJson = (path: string, value: unknown) => atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
