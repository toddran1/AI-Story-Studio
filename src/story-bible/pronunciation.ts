import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonicalEntitySchema, emptyStoryBible, storyBibleSchema, type CanonicalEntity, type StoryBible } from "../domain/story-bible.js";
import { chapterSchema, type StageName } from "../domain/chapter.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { applyCanonicalOverlay, updateCanonicalEntity } from "./canonical.js";
import { enrichPronunciation, pronunciationFingerprint, resolvePronunciations, PRONUNCIATION_VERSION } from "../tts/pronunciation.js";
import type { LLMProvider } from "../llm/provider.js";
import type { StageModelConfig } from "../domain/provider.js";
import { fingerprint } from "../utils/hash.js";

export async function loadPronunciationEntities(root: string, slug: string, base?: StoryBible) {
  const raw = base ?? await readJsonIfExists(storyPaths(root, slug, 1).bible);
  return (await applyCanonicalOverlay(root, slug, raw ? storyBibleSchema.parse(raw) : emptyStoryBible())).bible.canonicalEntities;
}

const attemptsSchema = z.record(z.string(), z.string());
const pendingSchema = z.array(z.object({ before: canonicalEntitySchema, after: canonicalEntitySchema }));
/** Caller holds the story lock. Cache ordinary-English/null results too. */
export async function enrichStoryPronunciations(root: string, slug: string, base: StoryBible, provider: LLMProvider, config: StageModelConfig, language: string, ids?: string[], force = Boolean(ids)) {
  const path = join(storyPaths(root, slug, 1).story, "pronunciation-enrichment.json");
  const pendingPath = join(storyPaths(root, slug, 1).story, "pronunciation-invalidation-pending.json");
  const recovery = pendingSchema.parse(await readJsonIfExists(pendingPath) ?? []);
  if (recovery.length) { await invalidatePronunciationChanges(root, slug, recovery); await atomicWriteJson(pendingPath, []); }
  const pending: z.infer<typeof pendingSchema> = [];
  const attempts = attemptsSchema.parse(await readJsonIfExists(path) ?? {});
  const entities = await loadPronunciationEntities(root, slug, base); const enriched: string[] = [];
  for (const entity of entities) {
    if (ids && !ids.includes(entity.id)) continue;
    if (entity.pronunciation?.locked || entity.pronunciation?.source === "manual" || (entity.pronunciation && entity.pronunciation.mode !== "automatic") || (!force && entity.pronunciation)) continue;
    if (!entity.originalName || (entity.originalName === entity.canonicalName && /^en(?:-|$)|^english$/i.test(language))) continue;
    const input = fingerprint({ version: PRONUNCIATION_VERSION, id: entity.id, name: entity.canonicalName, original: entity.originalName, language, type: entity.type });
    if (!force && attempts[entity.id] === input) continue;
    const result = await enrichPronunciation(provider, config, entity, language);
    if (result.pronunciation) {
      const pronunciation = { ...result.pronunciation, source: "ai" as const, mode: "automatic" as const, locked: false, updatedAt: new Date().toISOString() };
      pending.push({ before: entity, after: { ...entity, pronunciation } });
      await atomicWriteJson(pendingPath, pending);
      await updateCanonicalEntity(root, slug, base, entity.id, { pronunciation });
      enriched.push(entity.id);
    } else if (force && entity.pronunciation) {
      pending.push({ before: entity, after: { ...entity, pronunciation: undefined } });
      await atomicWriteJson(pendingPath, pending);
      await updateCanonicalEntity(root, slug, base, entity.id, { pronunciation: null });
      enriched.push(entity.id);
    }
    attempts[entity.id] = input; await atomicWriteJson(path, attempts);
  }
  if (pending.length) { await invalidatePronunciationChanges(root, slug, pending); await atomicWriteJson(pendingPath, []); }
  return { enriched, entities: await loadPronunciationEntities(root, slug, base) };
}

export async function clearPronunciationAttempt(root: string, slug: string, id: string) {
  const path = join(storyPaths(root, slug, 1).story, "pronunciation-enrichment.json");
  const attempts = attemptsSchema.parse(await readJsonIfExists(path) ?? {});
  delete attempts[id]; await atomicWriteJson(path, attempts);
}

/** Prepare all writes first, preserve artifacts and rollback metadata on filesystem failures. */
export async function invalidatePronunciationChange(root: string, slug: string, before: CanonicalEntity, after: CanonicalEntity) {
  return invalidatePronunciationChanges(root, slug, [{ before, after }]);
}

async function invalidatePronunciationChanges(root: string, slug: string, changes: z.infer<typeof pendingSchema>) {
  const parsed = pendingSchema.parse(changes);
  const beforeEntities = parsed.map(change => change.before), afterEntities = parsed.map(change => change.after);
  const entries = await readdir(join(storyPaths(root, slug, 1).story, "chapters"), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const updates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const number = Number(entry.name); const paths = storyPaths(root, slug, number);
    const text = await readFile(paths.narrationTts, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return readFile(paths.narration, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return ""; throw e; }); throw error; });
    if (pronunciationFingerprint(resolvePronunciations(text, beforeEntities)) === pronunciationFingerprint(resolvePronunciations(text, afterEntities))) continue;
    const raw = await readJsonIfExists(paths.chapterMeta); if (!raw) continue;
    const original = chapterSchema.parse(raw), chapter = structuredClone(original);
    for (const stage of ["tts", "audioMastering", "alignment", "subtitles", "video"] as StageName[]) {
      if (chapter.stages[stage].status === "complete") {
        chapter.stages[stage].staleReason = "Entity pronunciation changed";
        delete chapter.stages[stage].manualAcceptance;
      }
    }
    updates.push({ path: paths.chapterMeta, number, original, chapter });
  }
  const written: typeof updates = [];
  try { for (const update of updates) { await atomicWriteJson(update.path, update.chapter); written.push(update); } }
  catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const update of written.reverse()) try { await atomicWriteJson(update.path, update.original); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Pronunciation invalidation failed and some chapter metadata could not be restored");
    throw error;
  }
  return updates.map(update => update.number);
}
