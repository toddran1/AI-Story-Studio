import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonicalEntitySchema, emptyStoryBible, storyBibleSchema, type CanonicalEntity, type StoryBible } from "../domain/story-bible.js";
import { chapterSchema, type StageName } from "../domain/chapter.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { applyCanonicalOverlay, updateCanonicalEntity } from "./canonical.js";
import { enrichPronunciation, enrichPronunciationBatch, pronunciationFingerprint, resolvePronunciations, PRONUNCIATION_VERSION, type PronunciationSourceEvidence } from "../tts/pronunciation.js";
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
async function collectSourceEvidence(root: string, slug: string, entity: CanonicalEntity): Promise<PronunciationSourceEvidence[]> {
  const chapters = [...new Set([...entity.provenance.map(item => item.chapter), entity.firstAppearance, entity.lastKnownAppearance])].slice(0, 4);
  const anchors = [entity.originalName, entity.canonicalName, ...entity.aliases].filter(Boolean);
  const evidence: PronunciationSourceEvidence[] = [];
  for (const chapter of chapters) {
    const text = await readFile(storyPaths(root, slug, chapter).original, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (!text) continue;
    const position = anchors.map(anchor => text.indexOf(anchor)).find(index => index >= 0);
    if (position === undefined) continue;
    evidence.push({ chapter, sourceText: text.slice(Math.max(0, position - 260), position + 520).trim(), reason: `Original chapter evidence for ${entity.canonicalName}` });
  }
  return evidence;
}

function unresolvedPronunciation(language: string, evidence: PronunciationSourceEvidence[]) {
  return { mode: "automatic" as const, sourceLanguage: language, confidence: 0, needsReview: true, evidence, source: "ai" as const, locked: false, updatedAt: new Date().toISOString() };
}

/** Caller holds the story lock. Cache automatic and unresolved outcomes by canonical identity. */
export async function enrichStoryPronunciations(root: string, slug: string, base: StoryBible, provider: LLMProvider, config: StageModelConfig, language: string, ids?: string[], force = Boolean(ids), dryRun = false) {
  const startedAt = Date.now();
  const path = join(storyPaths(root, slug, 1).story, "pronunciation-enrichment.json");
  const pendingPath = join(storyPaths(root, slug, 1).story, "pronunciation-invalidation-pending.json");
  const recovery = pendingSchema.parse(await readJsonIfExists(pendingPath) ?? []);
  if (recovery.length) { await invalidatePronunciationChanges(root, slug, recovery); await atomicWriteJson(pendingPath, []); }
  const pending: z.infer<typeof pendingSchema> = [];
  const attempts = attemptsSchema.parse(await readJsonIfExists(path) ?? {});
  const entities = await loadPronunciationEntities(root, slug, base), enriched: string[] = [], unresolved: string[] = [];
  const summary = { total: entities.length, alreadyEnriched: 0, protected: 0, notNeeded: 0, eligible: 0, batches: 0, provider: provider.name, model: config.model };
  const candidates: Array<{ entity: CanonicalEntity; evidence: PronunciationSourceEvidence[]; input: string }> = [];
  for (const entity of entities) {
    if (ids && !ids.includes(entity.id)) continue;
    const pronunciation = entity.pronunciation;
    if (pronunciation?.locked || pronunciation?.source === "manual") { summary.protected++; continue; }
    if (!force && pronunciation && !pronunciation.needsReview) { summary.alreadyEnriched++; continue; }
    const input = fingerprint({ version: PRONUNCIATION_VERSION, id: entity.id, name: entity.canonicalName, original: entity.originalName, aliases: entity.aliases, language, type: entity.type });
    if (!force && attempts[entity.id] === input) { summary.alreadyEnriched++; continue; }
    if (!entity.originalName && /^en(?:-|$)|^english$/i.test(language)) { summary.notNeeded++; continue; }
    const evidence = await collectSourceEvidence(root, slug, entity);
    if (!entity.originalName && !evidence.length) {
      summary.notNeeded++;
      continue;
    }
    candidates.push({ entity, evidence, input }); summary.eligible++;
  }
  summary.batches = Math.ceil(candidates.length / 8);
  if (dryRun) return { enriched, unresolved, entities, summary: { ...summary, successful: 0, needsReview: 0, durationMs: Date.now() - startedAt }, dryRun: true };
  const persist = async (entity: CanonicalEntity, input: string, value: CanonicalEntity["pronunciation"] | undefined) => {
    const next = value ? { ...value, sourceLanguage: value.sourceLanguage ?? language, needsReview: value.needsReview ?? (value.confidence ?? 1) < .7, source: "ai" as const, locked: false, updatedAt: new Date().toISOString() } : undefined;
    if (next) {
      pending.push({ before: entity, after: { ...entity, pronunciation: next } });
      await atomicWriteJson(pendingPath, pending);
      await updateCanonicalEntity(root, slug, base, entity.id, { pronunciation: next }); enriched.push(entity.id);
      if (next.needsReview || (next.confidence ?? 1) < .7) unresolved.push(entity.id);
    } else if (force && entity.pronunciation) {
      pending.push({ before: entity, after: { ...entity, pronunciation: undefined } });
      await atomicWriteJson(pendingPath, pending);
      await updateCanonicalEntity(root, slug, base, entity.id, { pronunciation: null }); enriched.push(entity.id);
    }
    attempts[entity.id] = input; await atomicWriteJson(path, attempts);
  };
  try {
    for (let start = 0; start < candidates.length; start += 8) {
      const batch = candidates.slice(start, start + 8);
      if (batch.length === 1) {
        const item = batch[0]!, result = await enrichPronunciation(provider, config, item.entity, language, item.evidence);
        await persist(item.entity, item.input, result.pronunciation ?? (item.evidence.length ? undefined : unresolvedPronunciation(language, item.evidence)));
      } else {
        const result = await enrichPronunciationBatch(provider, config, batch.map(item => ({ entity: item.entity, evidence: item.evidence })), language);
        for (const item of batch) await persist(item.entity, item.input, result.pronunciations.get(item.entity.id) ?? unresolvedPronunciation(language, item.evidence));
      }
    }
  } finally {
    if (pending.length) { await invalidatePronunciationChanges(root, slug, pending); await atomicWriteJson(pendingPath, []); }
  }
  return { enriched, unresolved, entities: await loadPronunciationEntities(root, slug, base), summary: { ...summary, successful: enriched.length, needsReview: unresolved.length, durationMs: Date.now() - startedAt } };
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
