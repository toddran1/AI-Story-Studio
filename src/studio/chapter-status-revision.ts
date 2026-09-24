import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";

const schema = z.object({ version: z.literal(1), revision: z.string().uuid(), updatedAt: z.string() });
export function chapterStatusReadRevisionPath(root: string, slug: string) {
  return join(storyPaths(root, slug, 1).story, "chapter-status-read-revision.json");
}
export async function getChapterStatusReadRevision(root: string, slug: string): Promise<string> {
  try {
    const parsed = schema.safeParse(await readJsonIfExists(chapterStatusReadRevisionPath(root, slug)));
    return parsed.success ? parsed.data.revision : "missing";
  } catch (error) {
    if (error instanceof SyntaxError) return "missing";
    throw error;
  }
}
export async function bumpChapterStatusReadRevision(root: string, slug: string): Promise<string> {
  const revision = randomUUID();
  await atomicWriteJson(chapterStatusReadRevisionPath(root, slug), { version: 1, revision, updatedAt: new Date().toISOString() });
  return revision;
}
