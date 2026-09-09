import { ChapterReference, SourceInspection, SourceManifest } from "./types.js";

export type RemoteRefresh = {
  previousCount: number; currentCount: number; added: ChapterReference[]; removed: ChapterReference[];
  retitled: Array<{ chapter: number; before?: string; after?: string }>;
  reordered: Array<{ sourceId: string; before: number; after: number }>;
};

export function compareRemoteDirectory(manifest: SourceManifest, inspection: SourceInspection): RemoteRefresh {
  if (!manifest.remote || !inspection.directory) throw new Error("Refresh requires remote directory metadata");
  const before = new Map(manifest.remote.directory.map((ref) => [ref.sourceId, ref]));
  const after = new Map(inspection.directory.map((ref) => [ref.sourceId, ref]));
  const added = inspection.directory.filter((ref) => !before.has(ref.sourceId));
  const removed = manifest.remote.directory.filter((ref) => !after.has(ref.sourceId));
  const retitled = inspection.directory.flatMap((ref) => {
    const old = before.get(ref.sourceId); return old && old.originalTitle !== ref.originalTitle
      ? [{ chapter: ref.chapter, before: old.originalTitle, after: ref.originalTitle }] : [];
  });
  const reordered = inspection.directory.flatMap((ref) => { const old = before.get(ref.sourceId); return old && old.chapter !== ref.chapter ? [{ sourceId: ref.sourceId, before: old.chapter, after: ref.chapter }] : []; });
  return { previousCount: manifest.remote.chapterCountAtInspection, currentCount: inspection.remote?.chapterCountAtInspection ?? inspection.directory.length, added, removed, retitled, reordered };
}
