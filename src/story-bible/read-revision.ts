import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";

/**
 * Cheap Story Bible read revision. App-level mutations bump this counter so
 * derived read caches (health, stale extraction, review) can revalidate with
 * a single tiny file read instead of walking per-chapter artifacts. The
 * revision is authoritative for app mutations; external edits to the bible's
 * own root files are still caught by their mtime+size stamps.
 */

const readRevisionSchema = z.object({ version: z.literal(1), revision: z.number().int().min(0), updatedAt: z.string() });

export function storyBibleReadRevisionPath(root: string, slug: string): string {
  return join(storyPaths(root, slug, 1).story, "story-bible-read-revision.json");
}

/** Missing or unreadable revision file means revision 0. */
export async function getStoryBibleReadRevision(root: string, slug: string): Promise<number> {
  const raw = await readJsonIfExists(storyBibleReadRevisionPath(root, slug));
  const parsed = raw ? readRevisionSchema.safeParse(raw) : undefined;
  return parsed?.success ? parsed.data.revision : 0;
}

export async function bumpStoryBibleReadRevision(root: string, slug: string): Promise<number> {
  const revision = (await getStoryBibleReadRevision(root, slug)) + 1;
  await atomicWriteJson(storyBibleReadRevisionPath(root, slug), { version: 1, revision, updatedAt: new Date().toISOString() });
  return revision;
}
