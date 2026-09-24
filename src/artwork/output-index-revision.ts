import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { invalidateStoryReadCache } from "../story-bible/read-cache.js";

const schema = z.object({ version: z.literal(1), revision: z.string().uuid() });
const revisionPath = (root: string, slug: string) => join(storyPaths(root, slug, 1).story, "artwork-output-read-revision.json");

export async function getArtworkOutputReadRevision(root: string, slug: string): Promise<string> {
  try {
    const parsed = schema.safeParse(await readJsonIfExists(revisionPath(root, slug)));
    return parsed.success ? parsed.data.revision : "missing";
  } catch (error) { if (error instanceof SyntaxError) return "missing"; throw error; }
}

export async function invalidateArtworkOutputIndex(root: string, slug: string): Promise<void> {
  invalidateStoryReadCache(root, slug, "artwork-output-index");
  await atomicWriteJson(revisionPath(root, slug), { version: 1, revision: randomUUID() });
}

/** The one write path for chapter scene manifests that affect Artwork Outputs. */
export async function writeArtworkOutputManifest(root: string, slug: string, chapter: number, manifest: unknown): Promise<void> {
  await atomicWriteJson(storyPaths(root, slug, chapter).scenesManifest, manifest);
  await invalidateArtworkOutputIndex(root, slug);
}
