import { readFile, rm } from "node:fs/promises";
import { Chapter } from "../domain/chapter.js";
import { QaState } from "../domain/qa.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { QaPersistenceRollbackError } from "./errors.js";

type Paths = { qa: string; chapterMeta: string };
type MetadataFactory = (outputFingerprint: string, previous: Chapter) => Chapter;

async function readPrevious(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function restore(path: string, value: Buffer | undefined): Promise<void> {
  if (value === undefined) await rm(path, { force: true });
  else await atomicWrite(path, value);
}

/**
 * Persist the QA artifact and its chapter summary as one recoverable unit.
 * Filesystem writes are not a true multi-file transaction, so retain exact prior
 * bytes and roll back both paths if either write fails.
 */
export async function persistQaStateWithMetadata(
  paths: Paths,
  state: QaState,
  previousMetadata: Chapter,
  updateMetadata: MetadataFactory,
): Promise<{ metadata: Chapter; outputFingerprint: string }> {
  const [oldQa, oldMetadata] = await Promise.all([readPrevious(paths.qa), readPrevious(paths.chapterMeta)]);
  let qaTouched = false;
  let metadataTouched = false;
  try {
    await atomicWriteJson(paths.qa, state);
    qaTouched = true;
    const outputFingerprint = await fileFingerprint(paths.qa);
    if (!outputFingerprint) throw new Error("QA output fingerprint could not be computed after persistence");
    const metadata = updateMetadata(outputFingerprint, previousMetadata);
    await atomicWriteJson(paths.chapterMeta, metadata);
    metadataTouched = true;
    return { metadata, outputFingerprint };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    // Restore in reverse write order, even if the metadata write failed midway.
    if (metadataTouched || qaTouched) {
      try { await restore(paths.chapterMeta, oldMetadata); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (qaTouched) {
      try { await restore(paths.qa, oldQa); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) throw new QaPersistenceRollbackError([error, ...rollbackErrors], "QA persistence failed and rollback could not restore consistent QA state");
    throw error;
  }
}
