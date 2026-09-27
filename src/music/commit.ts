import { rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { exists } from "../storage/story-files.js";

/** Replace an export and its manifest, restoring the last completed edition if commit fails. */
export async function commitMusicExport(staged: string, output: string, manifestPath: string, manifest: unknown) {
  const backupId = randomUUID();
  const previousOutput = `${output}.previous-${backupId}`;
  const previousManifest = `${manifestPath}.previous-${backupId}`;
  const hadOutput = await exists(output);
  const hadManifest = await exists(manifestPath);
  let movedOutput = false; let movedManifest = false; let publishedOutput = false;
  try {
    if (hadOutput) { await rename(output, previousOutput); movedOutput = true; }
    if (hadManifest) { await rename(manifestPath, previousManifest); movedManifest = true; }
    await rename(staged, output); publishedOutput = true;
    await atomicWriteJson(manifestPath, manifest);
    await Promise.allSettled([rm(previousOutput, { force: true }), rm(previousManifest, { force: true })]);
  } catch (error) {
    if (publishedOutput) await rm(output, { force: true });
    if (movedManifest) { await rm(manifestPath, { force: true }); await rename(previousManifest, manifestPath); }
    if (movedOutput) await rename(previousOutput, output);
    throw error;
  }
}
