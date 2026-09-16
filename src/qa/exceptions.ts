import { QaException, qaExceptionsFileSchema } from "../domain/qa.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { storyPaths } from "../storage/paths.js";
import { fingerprint } from "../utils/hash.js";
import { normalizeQaText } from "./findings.js";
import type { FreshQaDetection } from "./review.js";

const exceptionsPath = (root: string, slug: string) => storyPaths(root, slug, 1).qaExceptions;

export async function listQaExceptions(root: string, slug: string): Promise<QaException[]> {
  const raw = await readJsonIfExists(exceptionsPath(root, slug));
  return raw ? qaExceptionsFileSchema.parse(raw).exceptions : [];
}

export async function addQaException(
  root: string,
  slug: string,
  input: { category: QaException["category"]; matchKind: QaException["matchKind"]; value: string; reason?: string },
): Promise<{ exception: QaException; exceptions: QaException[]; created: boolean }> {
  const exceptions = await listQaExceptions(root, slug);
  const value = input.value.trim();
  if (!value) throw new Error("QA exception value must not be empty");
  const id = `qax_${fingerprint({ v: 1, category: input.category, matchKind: input.matchKind, value: normalizeQaText(value) }).slice(0, 24)}`;
  const existing = exceptions.find((exception) => exception.id === id);
  if (existing) return { exception: existing, exceptions, created: false };
  const exception: QaException = { id, category: input.category, matchKind: input.matchKind, value, ...(input.reason ? { reason: input.reason } : {}), createdAt: new Date().toISOString() };
  const next = [...exceptions, exception];
  await atomicWriteJson(exceptionsPath(root, slug), { version: 1, exceptions: next });
  return { exception, exceptions: next, created: true };
}

export async function removeQaException(root: string, slug: string, id: string): Promise<{ removed: boolean; exceptions: QaException[] }> {
  const exceptions = await listQaExceptions(root, slug);
  const next = exceptions.filter((exception) => exception.id !== id);
  if (next.length === exceptions.length) return { removed: false, exceptions };
  await atomicWriteJson(exceptionsPath(root, slug), { version: 1, exceptions: next });
  return { removed: true, exceptions: next };
}

/**
 * Drop new detections covered by a story-scoped exception: same category, and
 * the exception value appears in the message/evidence or (entity matchKind)
 * matches a detection's entity ids. Existing findings are never touched here;
 * reconciliation decides their fate independently.
 */
export function filterExceptedFindings<T extends FreshQaDetection>(detections: T[], exceptions: QaException[]): T[] {
  if (!exceptions.length) return detections;
  return detections.filter((detection) => !exceptions.some((exception) => {
    if (exception.category !== detection.category) return false;
    if (exception.matchKind === "entity" && detection.entityIds?.includes(exception.value)) return true;
    const haystack = normalizeQaText(`${detection.message}\n${detection.evidence}`);
    const needle = normalizeQaText(exception.value);
    return needle.length > 0 && haystack.includes(needle);
  }));
}

/** Compact prompt block of approved exceptions; rendered only when non-empty. */
export function exceptionsPromptSection(exceptions: QaException[]): string | undefined {
  if (!exceptions.length) return undefined;
  const lines = exceptions.map((exception) => `- [${exception.category}/${exception.matchKind}] "${exception.value}"${exception.reason ? ` — ${exception.reason}` : ""}`);
  return `APPROVED QA EXCEPTIONS (the studio has reviewed and approved these; do not report them again unless the problem is materially different from the approved case):\n${lines.join("\n")}`;
}
