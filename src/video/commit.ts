import { copyFile, link, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { VideoError } from "../pipeline/errors.js";

/** Validate before replacing, then retain a same-directory recovery copy until
 * metadata commits. Callers retain responsibility for restoring old metadata. */
export async function commitRenderedVideo<T>(staged: string, output: string, save: (fingerprint: string) => Promise<T>): Promise<T> {
  const outputFingerprint = await fileFingerprint(staged);
  if (!outputFingerprint) throw new VideoError("Video renderer produced an empty output");
  const backup = `${output}.previous-${randomUUID()}`;
  let retained = false, replaced = false, cleanup = true;
  try {
    try { await link(output, backup); retained = true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "ENOTSUP", "EXDEV"].includes(code ?? "")) { await copyFile(output, backup); retained = true; }
      else if (code !== "ENOENT") throw error;
    }
    await rename(staged, output); replaced = true;
    return await save(outputFingerprint);
  } catch (error) {
    if (replaced) {
      try { if (retained) await rename(backup, output); else await rm(output, { force: true }); }
      catch (rollback) {
        cleanup = false;
        throw new AggregateError([error, rollback], `Video commit failed and rollback could not restore the previous file. Recovery copy: ${backup}`);
      }
    }
    throw error;
  } finally {
    if (cleanup) await rm(backup, { force: true }).catch(() => undefined);
  }
}
