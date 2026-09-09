import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { exists, readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { chapterReferenceSchema, SourceInspection, SourceManifest, sourceManifestSchema } from "./types.js";
import { chapterWarnings } from "./inspection.js";

export const SOURCE_ADAPTER_VERSION = "milestone-3-v1";
export type ImportResult = {
  status: "unchanged" | "imported" | "updated";
  manifest: SourceManifest;
  added: number[];
  modified: number[];
  removed: number[];
};

export async function importSource(root: string, story: string, inspection: SourceInspection): Promise<ImportResult> {
  const paths = storyPaths(root, story, inspection.chapters[0]?.ref.chapter ?? 1);
  const previous = await readJsonIfExists<SourceManifest>(paths.sourceManifest);
  const parsedPrevious = previous ? sourceManifestSchema.safeParse(previous) : undefined;
  if (parsedPrevious?.success && parsedPrevious.data.fingerprint === inspection.fingerprint && await manifestFilesExist(paths.source, parsedPrevious.data)) {
    return { status: "unchanged", manifest: parsedPrevious.data, added: [], modified: [], removed: [] };
  }

  const duplicateWarnings = chapterWarnings(inspection.chapters, true).filter((warning) => warning.code === "duplicate_chapter_number");
  if (duplicateWarnings.length) throw new Error(duplicateWarnings.map((warning) => warning.message).join("; "));
  const stage = `${paths.source}.stage-${randomUUID()}`; const backup = `${paths.source}.backup-${randomUUID()}`;
  const chapters = [...inspection.chapters].sort((a, b) => a.ref.chapter - b.ref.chapter);
  const manifestChapters: SourceManifest["chapters"] = [];
  try {
    await mkdir(join(stage, "chapters"), { recursive: true });
    for (const chapter of chapters) {
      if (!chapter.text.trim()) throw new Error(`Chapter ${chapter.ref.chapter} is empty`);
      const file = join("chapters", `${String(chapter.ref.chapter).padStart(4, "0")}.txt`);
      const materializedText = chapter.text.endsWith("\n") ? chapter.text : `${chapter.text}\n`;
      const ref = chapterReferenceSchema.parse(JSON.parse(JSON.stringify(chapter.ref)));
      const chapterFingerprint = fingerprint({ ref, text: materializedText });
      await atomicWrite(join(stage, file), materializedText);
      manifestChapters.push({ chapter: ref.chapter, file, fingerprint: chapterFingerprint, ref });
    }
    const manifest = sourceManifestSchema.parse({
      version: 1, adapterVersion: SOURCE_ADAPTER_VERSION, type: inspection.sourceType,
      origin: { path: inspection.sourcePath, name: basename(inspection.sourcePath) }, fingerprint: inspection.fingerprint,
      importedAt: new Date().toISOString(), title: inspection.title, author: inspection.author, language: inspection.language,
      warnings: inspection.warnings, unnumberedSections: inspection.unnumberedSections, chapters: manifestChapters,
    });
    await atomicWriteJson(join(stage, "source.json"), manifest);
    const hadPrevious = await exists(paths.source);
    if (hadPrevious) await rename(paths.source, backup);
    try { await rename(stage, paths.source); }
    catch (error) { if (hadPrevious && await exists(backup)) await rename(backup, paths.source); throw error; }
    if (hadPrevious) await rm(backup, { recursive: true, force: true });
    const changes = compareChapters(parsedPrevious?.success ? parsedPrevious.data : undefined, manifest);
    return { status: parsedPrevious?.success ? "updated" : "imported", manifest, ...changes };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function loadImportedChapters(root: string, story: string) {
  const paths = storyPaths(root, story, 1); const raw = await readJsonIfExists<SourceManifest>(paths.sourceManifest);
  if (!raw) throw new Error(`No imported source exists for story '${story}'. Pass --input or run story:import first.`);
  const manifest = sourceManifestSchema.parse(raw);
  if (!(await manifestFilesExist(paths.source, manifest))) throw new Error(`Imported source manifest for '${story}' references missing chapter files`);
  return { manifest, directory: paths.sourceChapters, chapters: manifest.chapters.map((item) => ({
    chapter: item.chapter, filename: basename(item.file), path: resolve(paths.source, item.file),
    source: { type: item.ref.sourceType, sourceId: item.ref.sourceId, originalTitle: item.ref.originalTitle, fingerprint: item.fingerprint, metadata: item.ref.metadata },
  })) };
}

async function manifestFilesExist(sourceRoot: string, manifest: SourceManifest) {
  for (const chapter of manifest.chapters) {
    const path = resolve(sourceRoot, chapter.file); if (!(await exists(path))) return false;
    const text = await readFile(path, "utf8");
    if (fingerprint({ ref: chapter.ref, text }) !== chapter.fingerprint) return false;
  }
  return true;
}
function compareChapters(previous: SourceManifest | undefined, next: SourceManifest) {
  const before = new Map(previous?.chapters.map((item) => [item.chapter, item.fingerprint]) ?? []); const after = new Map(next.chapters.map((item) => [item.chapter, item.fingerprint]));
  return {
    added: [...after.keys()].filter((chapter) => !before.has(chapter)),
    modified: [...after].filter(([chapter, value]) => before.has(chapter) && before.get(chapter) !== value).map(([chapter]) => chapter),
    removed: [...before.keys()].filter((chapter) => !after.has(chapter)),
  };
}
