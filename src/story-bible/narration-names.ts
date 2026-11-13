import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CanonicalEntity } from "../domain/story-bible.js";
import { Chapter, SOURCE_NAME_HOLD_REASON, StageName, chapterSchema } from "../domain/chapter.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { loadAmbiguousSourceNames, loadSourceNameRules } from "../naming/source-index.js";
import { loadStoryBibleWithCanonicalOverlay } from "./canonical.js";

const downstream: StageName[] = ["qa", "tts", "audioMastering", "alignment", "subtitles", "scenePlanning", "artwork", "video"];

export function narrationNamingChanged(before: CanonicalEntity, after: CanonicalEntity) {
  return before.preferredNarrationName !== after.preferredNarrationName || JSON.stringify(before.aliasNarrationRules) !== JSON.stringify(after.aliasNarrationRules) || JSON.stringify(before.localizedNaming) !== JSON.stringify(after.localizedNaming);
}

export type NarrationNamingEntity = CanonicalEntity & { sourceIndexSpellings?: string[] };

export async function loadNarrationNamingEntities(root: string, slug: string, options: { includeUnmapped?: boolean } = {}) {
  const [bible, sourceRules] = await Promise.all([loadStoryBibleWithCanonicalOverlay(root, slug), loadSourceNameRules(root, slug)]);
  const blocked = new Set(Object.keys(sourceRules).length ? await loadAmbiguousSourceNames(root, slug) : []);
  const key = (name: string) => name.normalize("NFKC").toLowerCase();
  const entities: NarrationNamingEntity[] = [...bible.canonicalEntities];
  for (const rule of Object.values(sourceRules)) {
    if (blocked.has(key(rule.originalName))) continue;
    const aliases = rule.aliases.filter(alias => !blocked.has(key(alias)));
    const sourceIndexSpellings = [rule.originalName, ...aliases];
    const matches = entities.filter(entity => key(entity.originalName) === key(rule.originalName));
    if (!matches.length) entities.push({ ...rule, aliases, sourceIndexSpellings });
    else if (matches.length === 1 && matches[0]!.type === rule.type && !matches[0]!.localizedNaming && !matches[0]!.preferredNarrationName && !matches[0]!.aliasNarrationRules.length) {
      const entity = matches[0]!;
      entities[entities.indexOf(entity)] = { ...entity, localizedNaming: rule.localizedNaming, firstAppearance: rule.firstAppearance, sourceIndexSpellings,
        aliases: [...new Set([...entity.aliases, ...aliases, rule.canonicalName])] };
    }
  }
  return entities.filter(entity => options.includeUnmapped || entity.localizedNaming || entity.preferredNarrationName || entity.aliasNarrationRules.length);
}

/** A compact, current-chapter naming roster independent of the general Story
 * Bible context budget. Translation can introduce an English alias that did
 * not occur in the Chinese source, so callers pass both texts. */
export function nameMatcher(text: string) {
  const normalized = text.normalize("NFKC");
  const lower = normalized.toLowerCase();
  return (name: string) => {
    const value = name.trim().normalize("NFKC");
    if (value.length < 2) return false;
    if (!/^[\p{Script=Latin}\p{N}]/u.test(value)) return lower.includes(value.toLowerCase());
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{Script=Latin}\\p{N}_])${escaped}(?![\\p{Script=Latin}\\p{N}_])`, "iu").test(normalized);
  };
}

export function relevantNarrationNamingEntities(entities: NarrationNamingEntity[], chapterText: string, chapter: number, source?: string) {
  const inChapter = nameMatcher(chapterText);
  const inSource = source === undefined ? undefined : nameMatcher(source);
  return entities.filter(entity => {
    if (entity.firstAppearance > chapter) return false;
    if (entity.sourceIndexSpellings && inSource) {
      return entity.sourceIndexSpellings.some(inSource);
    }
    return [entity.canonicalName, entity.originalName, ...entity.aliases, entity.preferredNarrationName, entity.localizedNaming?.fullName, entity.localizedNaming?.shortName]
      .some(name => name && inChapter(name));
  });
}

export function selectNarrationNamingEntities(entities: NarrationNamingEntity[], chapterText: string, chapter: number, source?: string) {
  return relevantNarrationNamingEntities(entities, chapterText, chapter, source)
    .map(entity => ({ id: entity.id, canonicalName: entity.canonicalName, originalName: entity.originalName, aliases: entity.aliases, preferredNarrationName: entity.preferredNarrationName, localizedNaming: entity.localizedNaming, aliasNarrationRules: entity.aliasNarrationRules }));
}

async function listChapterNumbers(root: string, slug: string) {
  const chapterRoot = join(storyPaths(root, slug, 1).story, "chapters");
  const entries = await readdir(chapterRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  return entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map((entry) => Number(entry.name)).filter(Number.isSafeInteger).sort((a, b) => a - b);
}

// Story context can contain a broad slice of the canonical Bible, including
// entities that never appear in this chapter. Scan only chapter-authored text
// so a naming edit does not invalidate unrelated narration and audio.
async function readChapterAuthoredText(root: string, slug: string, chapter: number) {
  const paths = storyPaths(root, slug, chapter);
  const artifacts = await Promise.all([paths.original, paths.english, paths.narration].map((path) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; })));
  return artifacts.join("\n").toLocaleLowerCase();
}

function entityNames(entities: CanonicalEntity[]) {
  return [...new Set(entities.flatMap((entity) => [entity.canonicalName, entity.originalName, entity.preferredNarrationName, ...entity.aliases, entity.localizedNaming?.fullName, entity.localizedNaming?.shortName]).filter((value): value is string => Boolean(value)).map((value) => value.trim().toLocaleLowerCase()).filter(Boolean))];
}

/**
 * Chapters that reference the entities, from provenance plus a bounded
 * text scan of chapter-authored artifacts. Shared by the real invalidations
 * and by dry-run impact previews; performs no writes and no provider calls.
 */
export async function inspectEntityReferenceChapters(root: string, slug: string, entities: CanonicalEntity[]) {
  const available = await listChapterNumbers(root, slug);
  const provenance = new Set(entities.flatMap((entity) => entity.provenance.map((item) => item.chapter)));
  const names = entityNames(entities);
  const matches = await mapBounded(available, 16, async (chapter) => {
    if (provenance.has(chapter)) return chapter;
    const text = await readChapterAuthoredText(root, slug, chapter);
    return names.some((name) => containsName(text, name)) ? chapter : undefined;
  });
  return matches.filter((chapter): chapter is number => chapter !== undefined).sort((a, b) => a - b);
}

/**
 * Dry-run of the narration naming invalidation: the chapters a naming change
 * would reset. Consumed by both `invalidateNarrationNamingChange` (which then
 * performs the writes) and the impact-preview endpoint (which never writes).
 */
export async function inspectNarrationNamingImpact(root: string, slug: string, before: CanonicalEntity, after: CanonicalEntity) {
  if (!narrationNamingChanged(before, after)) return { affectedChapters: [] as number[] };
  const available = await listChapterNumbers(root, slug);
  const affected = new Set([...before.provenance, ...after.provenance].map((item) => item.chapter));
  const names = entityNames([before, after]);
  const matches = await mapBounded(available, 16, async (chapter) => {
    const text = await readChapterAuthoredText(root, slug, chapter);
    return names.some((name) => containsName(text, name)) ? chapter : undefined;
  });
  for (const chapter of matches) if (chapter !== undefined) affected.add(chapter);
  if (!affected.size && available.length) for (const chapter of available) if (chapter >= Math.min(before.firstAppearance, after.firstAppearance) && chapter <= Math.max(before.lastKnownAppearance, after.lastKnownAppearance)) affected.add(chapter);
  const availableSet = new Set(available);
  return { affectedChapters: [...affected].filter((chapter) => availableSet.has(chapter)).sort((a, b) => a - b) };
}

export async function invalidateNarrationNamingChange(root: string, slug: string, before: CanonicalEntity, after: CanonicalEntity, reason = `Narration naming preferences changed for ${after.canonicalName}`) {
  if (!narrationNamingChanged(before, after)) return { affectedChapters: [] as number[], manualNarrationChapters: [] as number[], exportCleanupWarnings: [] as string[] };
  const story = storyPaths(root, slug, 1).story;
  const chapterNumbers = (await inspectNarrationNamingImpact(root, slug, before, after)).affectedChapters;

  const manualNarrationChapters: number[] = [];
  // Parse and prepare every affected record before the first write. A corrupt
  // chapter therefore cannot leave earlier chapters partially invalidated.
  const updates = await mapBounded(chapterNumbers, 16, async (chapterNumber) => {
    const path = storyPaths(root, slug, chapterNumber).chapterMeta;
    const raw = await readJsonIfExists<Chapter>(path); if (!raw) return undefined;
    const original = chapterSchema.parse(raw); const chapter = structuredClone(original); const narration = chapter.stages.narration;
    const reasonFor = (stage: StageName) => chapter.stages[stage].staleReason === SOURCE_NAME_HOLD_REASON ? SOURCE_NAME_HOLD_REASON : reason;
    if (narration.provider === "manual" && narration.status === "complete") {
      chapter.stages.narration = { ...narration, staleReason: reasonFor("narration"), manualReviewRequired: true };
      manualNarrationChapters.push(chapterNumber);
    } else chapter.stages.narration = { status: "pending", staleReason: reasonFor("narration") };
    for (const stage of downstream) chapter.stages[stage] = { status: "pending", staleReason: reasonFor(stage) };
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

/** Mark only chapters that reference an edited identity. Artifacts remain usable;
 * this is a review/freshness signal, never an automatic production request. */
export async function invalidateCanonicalIdentityChange(root: string, slug: string, entities: CanonicalEntity[], reason: string, includeQa = true) {
  const chapters = await inspectEntityReferenceChapters(root, slug, entities);
  const updates = await mapBounded(chapters, 16, async (chapter) => {
    const paths = storyPaths(root, slug, chapter);
    const original = await readJsonIfExists<Chapter>(paths.chapterMeta);
    if (!original) return undefined;
    const chapterRecord = chapterSchema.parse(original);
    const next = structuredClone(chapterRecord);
    for (const stage of (includeQa ? ["qa", "scenePlanning", "artwork", "video"] : ["scenePlanning", "artwork", "video"]) as StageName[]) {
      if (next.stages[stage]?.status === "complete") next.stages[stage] = { ...next.stages[stage], staleReason: reason };
    }
    next.updatedAt = new Date().toISOString();
    return { path: paths.chapterMeta, original: chapterRecord, next };
  });
  const prepared = updates.filter((item): item is NonNullable<typeof item> => Boolean(item));
  const written: typeof prepared = [];
  try { for (const item of prepared) { await atomicWriteJson(item.path, item.next); written.push(item); } }
  catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const item of written.reverse()) try { await atomicWriteJson(item.path, item.original); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Canonical identity invalidation failed and some metadata could not be restored");
    throw error;
  }
  return prepared.map((item) => item.next.chapter);
}

function containsName(text: string, name: string) {
  if (!/^[a-z0-9][a-z0-9 .'-]*$/i.test(name)) return text.includes(name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i").test(text);
}

async function mapBounded<T, U>(items: T[], concurrency: number, work: (item: T) => Promise<U>): Promise<U[]> {
  const output = new Array<U>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (true) { const index = next++; if (index >= items.length) return; output[index] = await work(items[index]!); } }));
  return output;
}
