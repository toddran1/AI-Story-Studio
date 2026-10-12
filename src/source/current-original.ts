import { resolve, relative, isAbsolute } from "node:path";
import { readFile } from "node:fs/promises";
import { sourceManifestSchema } from "./types.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists, readTextIfExists } from "../storage/story-files.js";

/** Imported source is authoritative; production original is a legacy fallback. */
export async function readCurrentOriginal(root: string, slug: string, chapter: number): Promise<string | undefined> {
  const paths = storyPaths(root, slug, chapter);
  const raw = await readJsonIfExists(paths.sourceManifest);
  if (raw) {
    const entry = sourceManifestSchema.parse(raw).chapters.find(item => item.chapter === chapter);
    if (entry) {
      const file = resolve(paths.source, entry.file);
      const local = relative(paths.source, file);
      if (isAbsolute(local) || local === ".." || local.startsWith("../")) throw new Error("Invalid imported source path");
      const text = await readFile(file, "utf8");
      if (!text.trim()) throw new Error(`Imported source for Chapter ${chapter} is empty`);
      return text;
    }
  }
  return readTextIfExists(paths.original);
}
export async function requireCurrentOriginal(root: string, slug: string, chapter: number): Promise<string> {
  const text = await readCurrentOriginal(root, slug, chapter);
  if (!text?.trim()) throw new Error(`Chapter ${chapter} has no original source`);
  return text;
}
