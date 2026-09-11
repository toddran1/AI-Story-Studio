import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Hash a file without loading it into memory. Returns undefined for missing/empty files. */
export async function fileFingerprint(path: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  let bytes = 0;
  let remainder = Buffer.alloc(0);
  // Preserve the existing fingerprint(Buffer.toString("base64")) representation
  // while streaming: stableStringify wraps a string in JSON quotes.
  hash.update('"');
  try {
    for await (const chunk of createReadStream(path)) {
      const data = chunk as Buffer;
      bytes += data.length;
      const combined = remainder.length ? Buffer.concat([remainder, data]) : data;
      const completeLength = combined.length - (combined.length % 3);
      if (completeLength) hash.update(combined.subarray(0, completeLength).toString("base64"));
      remainder = Buffer.from(combined.subarray(completeLength));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!bytes) return undefined;
  if (remainder.length) hash.update(remainder.toString("base64"));
  hash.update('"');
  return hash.digest("hex");
}
