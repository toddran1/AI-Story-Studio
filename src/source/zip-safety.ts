import { readFile, stat } from "node:fs/promises";
import { unzipSync } from "fflate";

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 300 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

export async function readSafeZip(path: string, extract = true): Promise<{ bytes: Buffer; archive: Record<string, Uint8Array> }> {
  const info = await stat(path); if (!info.isFile()) throw new Error(`Archive source is not a file: ${path}`);
  if (info.size > MAX_ARCHIVE_BYTES) throw new Error(`Archive exceeds the ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB compressed-size limit: ${path}`);
  const bytes = await readFile(path); let count = 0; let expanded = 0;
  try {
    const archive = unzipSync(bytes, { filter: (entry) => {
      count++; expanded += entry.originalSize;
      if (count > MAX_ENTRIES) throw new Error(`archive has more than ${MAX_ENTRIES} entries`);
      if (entry.originalSize > MAX_ENTRY_BYTES) throw new Error(`entry '${entry.name}' exceeds ${MAX_ENTRY_BYTES / 1024 / 1024} MB`);
      if (expanded > MAX_EXPANDED_BYTES) throw new Error(`expanded archive exceeds ${MAX_EXPANDED_BYTES / 1024 / 1024} MB`);
      return extract;
    } });
    return { bytes, archive };
  } catch (error) { throw new Error(`Unsafe or invalid ZIP archive: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}
