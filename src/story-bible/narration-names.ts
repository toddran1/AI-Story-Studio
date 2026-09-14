import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CanonicalEntity, StoryBible, storyBibleSchema } from "../domain/story-bible.js";
import { Chapter, StageName, chapterSchema } from "../domain/chapter.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { applyCanonicalOverlay } from "./canonical.js";

const downstream: StageName[] = ["qa", "tts", "audioMastering", "alignment", "subtitles", "scenePlanning", "artwork", "video"];

export function narrationNamingChanged(before: CanonicalEntity, after: CanonicalEntity) {
  return before.preferredNarrationName !== after.preferredNarrationName || JSON.stringify(before.aliasNarrationRules) !== JSON.stringify(after.aliasNarrationRules) || JSON.stringify(before.localizedNaming) !== JSON.stringify(after.localizedNaming);
}

export async function loadNarrationNamingEntities(root: string, slug: string) {
  const raw = await readJsonIfExists<StoryBible>(storyPaths(root, slug, 1).bible); if (!raw) return [];
  return (await applyCanonicalOverlay(root, slug, storyBibleSchema.parse(raw))).bible.canonicalEntities.filter((entity) => entity.localizedNaming || entity.preferredNarrationName || entity.aliasNarrationRules.length);
}

export async function invalidateNarrationNamingChange(root: string, slug: string, before: CanonicalEntity, after: CanonicalEntity) {
  if (!narrationNamingChanged(before, after)) return { affectedChapters: [] as number[], manualNarrationChapters: [] as number[], exportCleanupWarnings: [] as string[] };
  const story = storyPaths(root, slug, 1).story;
  const chapterRoot = join(story, "chapters");
  const entries = await readdir(chapterRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const available = entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map((entry) => Number(entry.name)).filter(Number.isSafeInteger).sort((a, b) => a - b);
  const affected = new Set([...before.provenance, ...after.provenance].map((item) => item.chapter));
  const names = [...new Set([before.canonicalName, before.originalName, ...before.aliases, after.canonicalName, after.originalName, ...after.aliases].map((value) => value.trim().toLocaleLowerCase()).filter(Boolean))];

  const matches = await mapBounded(available, 16, async (chapter) => {
    const paths = storyPaths(root, slug, chapter);
    const artifacts = await Promise.all([paths.original, paths.english, paths.storyContext].map((path) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; })));
    const text = artifacts.join("\n").toLocaleLowerCase();
    return text.includes(before.id.toLocaleLowerCase()) || names.some((name) => text.includes(name)) ? chapter : undefined;
  });
  for (const chapter of matches) if (chapter !== undefined) affected.add(chapter);
  if (!affected.size && available.length) for (const chapter of available) if (chapter >= Math.min(before.firstAppearance, after.firstAppearance) && chapter <= Math.max(before.lastKnownAppearance, after.lastKnownAppearance)) affected.add(chapter);

  const reason = `Narration naming preferences changed for ${after.canonicalName}`;
  const manualNarrationChapters: number[] = [];
  const availableSet = new Set(available); const chapterNumbers = [...affected].filter((chapter) => availableSet.has(chapter)).sort((a, b) => a - b);
  // Parse and prepare every affected record before the first write. A corrupt
  // chapter therefore cannot leave earlier chapters partially invalidated.
  const updates = await mapBounded(chapterNumbers, 16, async (chapterNumber) => {
    const path = storyPaths(root, slug, chapterNumber).chapterMeta;
    const raw = await readJsonIfExists<Chapter>(path); if (!raw) return undefined;
    const original = chapterSchema.parse(raw); const chapter = structuredClone(original); const narration = chapter.stages.narration;
    if (narration.provider === "manual" && narration.status === "complete") {
      chapter.stages.narration = { ...narration, staleReason: reason, manualReviewRequired: true };
      manualNarrationChapters.push(chapterNumber);
    } else chapter.stages.narration = { status: "pending", staleReason: reason };
    for (const stage of downstream) chapter.stages[stage] = { status: "pending", staleReason: reason };
    chapter.updatedAt = new Date().toISOString(); return { path, original, chapter };
  });
  const prepared = updates.filter((item): item is NonNullable<typeof item> => Boolean(item)); const written: typeof prepared = [];
  try { for (const update of prepared) { await atomicWriteJson(update.path, update.chapter); written.push(update); } }
  catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const update of written.reverse()) try { await atomicWriteJson(update.path, update.original); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Narration naming invalidation failed and some chapter metadata could not be restored");
    throw error;
  }
  const exportsDirectory = join(story, "exports");
  const exportNames = await readdir(exportsDirectory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const exportCleanupWarnings: string[] = [];
  await Promise.all(exportNames.filter((name) => name.endsWith(".json")).map(async (name) => { try { await rm(join(exportsDirectory, name), { force: true }); } catch { exportCleanupWarnings.push(name); } }));
  return { affectedChapters: prepared.map((item) => item.chapter.chapter), manualNarrationChapters: manualNarrationChapters.sort((a, b) => a - b), exportCleanupWarnings: exportCleanupWarnings.sort() };
}

async function mapBounded<T, U>(items: T[], concurrency: number, work: (item: T) => Promise<U>): Promise<U[]> {
  const output = new Array<U>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (true) { const index = next++; if (index >= items.length) return; output[index] = await work(items[index]!); } }));
  return output;
}
