import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Hash a file without loading it into memory. Returns undefined for missing/empty files. */
export async function fileFingerprint(path: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  // Preserve the existing fingerprint(Buffer.toString("base64")) representation
  // while streaming: stableStringify wraps a string in JSON quotes.
  hash.update('"');
  try {
    const bytes = await updateBase64(hash, path);
    if (!bytes) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  hash.update('"');
  return hash.digest("hex");
}

/** Hash an ordered list of files using the legacy fingerprint(base64[]) representation. */
export async function filesFingerprint(paths: string[]): Promise<string | undefined> {
  if (!paths.length) return undefined;
  const hash = createHash("sha256");
  hash.update("[");
  try {
    for (const [index, path] of paths.entries()) {
      if (index) hash.update(",");
      hash.update('"');
      if (!(await updateBase64(hash, path))) return undefined;
      hash.update('"');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  hash.update("]");
  return hash.digest("hex");
}

async function updateBase64(hash: ReturnType<typeof createHash>, path: string) {
  let bytes = 0;
  let remainder = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    const combined = remainder.length ? Buffer.concat([remainder, data]) : data;
    const completeLength = combined.length - (combined.length % 3);
    if (completeLength) hash.update(combined.subarray(0, completeLength).toString("base64"));
    remainder = Buffer.from(combined.subarray(completeLength));
  }
  if (remainder.length) hash.update(remainder.toString("base64"));
  return bytes;
}
