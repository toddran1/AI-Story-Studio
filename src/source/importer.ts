import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
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

export async function importSource(root: string, story: string, inspection: SourceInspection, finalize?: () => Promise<void>): Promise<ImportResult> {
  if (!inspection.chapters.length) throw new Error("Source import contains no materialized chapters");
  const paths = storyPaths(root, story, inspection.chapters[0]?.ref.chapter ?? 1);
  await recoverInterruptedImport(paths.story, paths.source);
  let previous: SourceManifest | undefined;
  try { previous = await readJsonIfExists<SourceManifest>(paths.sourceManifest); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  const parsedPrevious = previous ? sourceManifestSchema.safeParse(previous) : undefined;
  const previousFilesValid = parsedPrevious?.success ? await manifestFilesExist(paths.source, parsedPrevious.data) : false;
  const additive = inspection.additive === true;
  if (additive && previous && !parsedPrevious?.success) throw new Error(`Cannot safely add to the invalid existing source manifest for '${story}'`);
  if (additive && parsedPrevious?.success) assertSameRemoteSource(parsedPrevious.data, inspection);
  if (parsedPrevious?.success && parsedPrevious.data.fingerprint === inspection.fingerprint && !additive && previousFilesValid) {
    await finalize?.();
    return { status: "unchanged", manifest: parsedPrevious.data, added: [], modified: [], removed: [] };
  }

  const duplicateWarnings = chapterWarnings(inspection.chapters, true).filter((warning) => warning.code === "duplicate_chapter_number");
  if (duplicateWarnings.length) throw new Error(duplicateWarnings.map((warning) => warning.message).join("; "));
  const unavailable = inspection.warnings.filter((warning) => warning.code === "unavailable_chapter");
  if (unavailable.length) throw new Error(unavailable.map((warning) => warning.message).join("; "));
  const stage = `${paths.source}.stage-${randomUUID()}`; const backup = `${paths.source}.backup-${randomUUID()}`;
  const chapters = [...inspection.chapters].sort((a, b) => a.ref.chapter - b.ref.chapter);
  const manifestChapters: SourceManifest["chapters"] = [];
  try {
    await mkdir(join(stage, "chapters"), { recursive: true });
    const incomingNumbers = new Set(chapters.map((chapter) => chapter.ref.chapter));
    const currentDirectory = new Map(inspection.directory?.map((ref) => [ref.chapter, ref]) ?? []);
    if (additive && parsedPrevious?.success) {
      if (!previousFilesValid) throw new Error(`Cannot safely add to '${story}' because its existing materialized source is missing or modified`);
      for (const item of parsedPrevious.data.chapters) {
        if (incomingNumbers.has(item.chapter)) continue;
        const text = await readFile(resolve(paths.source, item.file)); await atomicWrite(join(stage, item.file), text);
        const ref = currentDirectory.get(item.chapter) ?? item.ref;
        manifestChapters.push({ ...item, ref, fingerprint: fingerprint({ ref, text: text.toString("utf8") }) });
      }
    }
    for (const chapter of chapters) {
      if (!chapter.text.trim()) throw new Error(`Chapter ${chapter.ref.chapter} is empty`);
      const file = join("chapters", `${String(chapter.ref.chapter).padStart(4, "0")}.txt`);
      const materializedText = chapter.text.endsWith("\n") ? chapter.text : `${chapter.text}\n`;
      const ref = chapterReferenceSchema.parse(JSON.parse(JSON.stringify(chapter.ref)));
      const chapterFingerprint = fingerprint({ ref, text: materializedText });
      await atomicWrite(join(stage, file), materializedText);
      manifestChapters.push({ chapter: ref.chapter, file, fingerprint: chapterFingerprint, ref });
    }
    manifestChapters.sort((a, b) => a.chapter - b.chapter);
    const manifest = sourceManifestSchema.parse({
      version: 1, adapterVersion: inspection.adapterVersion ?? SOURCE_ADAPTER_VERSION, type: inspection.sourceType,
      origin: inspection.origin ?? { path: inspection.sourcePath, name: basename(inspection.sourcePath) }, fingerprint: inspection.fingerprint,
      importedAt: new Date().toISOString(), title: inspection.title, author: inspection.author, language: inspection.language,
      metadata: inspection.metadata,
      remote: inspection.remote ? { ...inspection.remote, directory: inspection.directory ?? [] } : undefined,
      warnings: inspection.warnings, unnumberedSections: inspection.unnumberedSections, chapters: manifestChapters,
    });
    await atomicWriteJson(join(stage, "source.json"), manifest);
    const hadPrevious = await exists(paths.source);
    if (hadPrevious) await rename(paths.source, backup);
    try { await rename(stage, paths.source); }
    catch (error) { if (hadPrevious && await exists(backup)) await rename(backup, paths.source); throw error; }
    try { await finalize?.(); }
    catch (error) {
      await rm(paths.source, { recursive: true, force: true });
      if (hadPrevious && await exists(backup)) await rename(backup, paths.source);
      throw error;
    }
    if (hadPrevious) { try { await rm(backup, { recursive: true, force: true }); } catch { /* The installed source is valid; a stale backup is recoverable. */ } }
    const changes = compareChapters(parsedPrevious?.success ? parsedPrevious.data : undefined, manifest);
    const unchanged = parsedPrevious?.success && previousFilesValid && parsedPrevious.data.fingerprint === manifest.fingerprint
      && !changes.added.length && !changes.modified.length && !changes.removed.length;
    return { status: unchanged ? "unchanged" : parsedPrevious?.success ? "updated" : "imported", manifest, ...changes };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

function assertSameRemoteSource(previous: SourceManifest, inspection: SourceInspection) {
  if (previous.type !== inspection.sourceType) throw new Error(`Existing source type '${previous.type}' does not match '${inspection.sourceType}'`);
  if (!("url" in previous.origin) || !inspection.origin) throw new Error("Remote additive import requires compatible URL origins");
  if (previous.origin.bookId && inspection.origin.bookId && previous.origin.bookId !== inspection.origin.bookId) throw new Error("Refusing to combine chapters from different remote books");
  if (!previous.origin.bookId && previous.origin.url !== inspection.origin.url) throw new Error("Refusing to combine chapters from different remote URLs");
  if (previous.remote && inspection.directory) {
    const current = new Map(inspection.directory.map((ref) => [ref.chapter, ref]));
    for (const item of previous.chapters) {
      const ref = current.get(item.chapter);
      if (!ref || ref.sourceId !== item.ref.sourceId) throw new Error(`Refusing additive import because remote Chapter ${item.chapter} was removed or reordered`);
    }
  }
}

async function recoverInterruptedImport(storyRoot: string, sourceRoot: string) {
  let entries: string[] = [];
  try { entries = await readdir(storyRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const backups = entries.filter((name) => name.startsWith("source.backup-"));
  const stages = entries.filter((name) => name.startsWith("source.stage-"));
  if (!(await exists(sourceRoot)) && backups.length) {
    const dated = await Promise.all(backups.map(async (name) => ({ name, modified: (await stat(join(storyRoot, name))).mtimeMs })));
    dated.sort((a, b) => a.modified - b.modified);
    await rename(join(storyRoot, dated.at(-1)!.name), sourceRoot);
  }
  for (const name of [...backups, ...stages]) {
    const path = join(storyRoot, name); if (path !== sourceRoot && await exists(path)) await rm(path, { recursive: true, force: true });
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
