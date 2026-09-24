import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";

/**
 * Cheap Story Bible read revision. App-level mutations bump this token so
 * derived read caches (health, stale extraction, review) can revalidate with
 * a single tiny file read instead of walking per-chapter artifacts. The
 * revision is authoritative for app mutations; external edits to the bible's
 * own root files are still caught by their mtime+size stamps.
 */

const legacyReadRevisionSchema = z.object({ version: z.literal(1), revision: z.number().int().min(0), updatedAt: z.string() });
const tokenReadRevisionSchema = z.object({ version: z.literal(2), revision: z.string().uuid(), updatedAt: z.string() });

export function storyBibleReadRevisionPath(root: string, slug: string): string {
  return join(storyPaths(root, slug, 1).story, "story-bible-read-revision.json");
}

/** Missing or invalid revision files share a stable pre-mutation fingerprint. */
export async function getStoryBibleReadRevision(root: string, slug: string): Promise<string> {
  let raw: unknown;
  try {
    raw = await readJsonIfExists(storyBibleReadRevisionPath(root, slug));
  } catch (error) {
    if (error instanceof SyntaxError) return "missing";
    throw error;
  }
  if (!raw) return "missing";
  const token = tokenReadRevisionSchema.safeParse(raw);
  if (token.success) return token.data.revision;
  const legacy = legacyReadRevisionSchema.safeParse(raw);
  return legacy.success ? `legacy:${legacy.data.revision}` : "missing";
}

export async function bumpStoryBibleReadRevision(root: string, slug: string): Promise<string> {
  const revision = randomUUID();
  await atomicWriteJson(storyBibleReadRevisionPath(root, slug), { version: 2, revision, updatedAt: new Date().toISOString() });
  return revision;
}
