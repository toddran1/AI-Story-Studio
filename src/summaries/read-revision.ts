import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { invalidateStoryReadCache } from "../story-bible/read-cache.js";

const schema = z.object({ version: z.literal(1), revision: z.string().uuid() });
const path = (root: string, slug: string) => join(storyPaths(root, slug, 1).story, "summary-read-revision.json");
export async function getSummaryReadRevision(root: string, slug: string): Promise<string> {
  try { const parsed = schema.safeParse(await readJsonIfExists(path(root, slug))); return parsed.success ? parsed.data.revision : "missing"; }
  catch (error) { if (error instanceof SyntaxError) return "missing"; throw error; }
}
export async function invalidateSummaryReads(root: string, slug: string) {
  invalidateStoryReadCache(root, slug, "summary-index");
  const revision = randomUUID();
  await atomicWriteJson(path(root, slug), { version: 1, revision, updatedAt: new Date().toISOString() });
}
