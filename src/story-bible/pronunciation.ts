import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonicalEntitySchema, emptyStoryBible, hasActivePronunciation, pronunciationSchema, storyBibleSchema, type CanonicalEntity, type EntityPronunciation, type StoryBible } from "../domain/story-bible.js";
import { chapterSchema, type StageName } from "../domain/chapter.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { applyCanonicalOverlay } from "./canonical.js";
import { enrichPronunciation, enrichPronunciationBatch, pronunciationFingerprint, resolvePronunciations, PRONUNCIATION_VERSION, type PronunciationSourceEvidence } from "../tts/pronunciation.js";
import type { LLMProvider } from "../llm/provider.js";
import type { StageModelConfig } from "../domain/provider.js";
import { fingerprint } from "../utils/hash.js";

export async function loadPronunciationEntities(root: string, slug: string, base?: StoryBible) {
  const raw = base ?? await readJsonIfExists(storyPaths(root, slug, 1).bible);
  return (await applyCanonicalOverlay(root, slug, raw ? storyBibleSchema.parse(raw) : emptyStoryBible())).bible.canonicalEntities;
}

const enrichmentEntrySchema = z.object({ attempt: z.string(), suggestion: pronunciationSchema.optional() });
const enrichmentCacheSchema = z.record(z.string(), z.union([z.string(), enrichmentEntrySchema]).transform(value => typeof value === "string" ? { attempt: value } : value));
const pendingSchema = z.array(z.object({ before: canonicalEntitySchema, after: canonicalEntitySchema }));

export type PronunciationEnrichmentEntry = z.infer<typeof enrichmentEntrySchema>;

function enrichmentCachePath(root: string, slug: string) {
  return join(storyPaths(root, slug, 1).story, "pronunciation-enrichment.json");
}

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

/** An uncertain AI outcome is a suggestion, never an active pronunciation record. */
function unresolvedPronunciation(language: string, evidence: PronunciationSourceEvidence[]) {
  return { mode: "automatic" as const, sourceLanguage: language, confidence: 0, needsReview: true, evidence, source: "ai" as const, locked: false, updatedAt: new Date().toISOString() };
}

/** Canonical-identity cache key recorded for every completed enrichment attempt. */
export function pronunciationAttemptInput(entity: CanonicalEntity, language: string) {
  return fingerprint({ version: PRONUNCIATION_VERSION, id: entity.id, name: entity.canonicalName, original: entity.originalName, aliases: entity.aliases, language, type: entity.type });
}

/** Completed enrichment attempts plus any AI suggestion per entity; suggestions are inert until accepted. */
export async function loadPronunciationEnrichment(root: string, slug: string): Promise<Record<string, PronunciationEnrichmentEntry>> {
  return enrichmentCacheSchema.parse(await readJsonIfExists(enrichmentCachePath(root, slug)) ?? {});
}

export async function loadPronunciationSuggestions(root: string, slug: string): Promise<Record<string, EntityPronunciation>> {
  const cache = await loadPronunciationEnrichment(root, slug);
  return Object.fromEntries(Object.entries(cache).flatMap(([id, entry]) => entry.suggestion ? [[id, entry.suggestion]] : []));
}

/** Ignore a suggestion without re-querying the provider: the attempt stays cached. */
export async function dismissPronunciationSuggestion(root: string, slug: string, id: string) {
  const path = enrichmentCachePath(root, slug);
  const cache = await loadPronunciationEnrichment(root, slug);
  if (cache[id]?.suggestion) { cache[id] = { attempt: cache[id]!.attempt }; await atomicWriteJson(path, cache); }
}

/**
 * Caller holds the story lock. AI enrichment never writes pronunciation onto
 * canonical entities: outcomes are cached as optional suggestions (or a bare
 * attempt when no guidance is needed). Only an explicit user accept/configure
 * action activates pronunciation.
 */
export async function enrichStoryPronunciations(root: string, slug: string, base: StoryBible, provider: LLMProvider, config: StageModelConfig, language: string, ids?: string[], force = Boolean(ids), dryRun = false,
  onProgress?: (progress: { processed: number; total: number }) => void) {
  const startedAt = Date.now();
  const path = enrichmentCachePath(root, slug);
  const cache = await loadPronunciationEnrichment(root, slug);
  const entities = await loadPronunciationEntities(root, slug, base), suggested: string[] = [], uncertain: string[] = [];
  const summary = { total: entities.length, alreadyEnriched: 0, protected: 0, notNeeded: 0, eligible: 0, batches: 0, provider: provider.name, model: config.model };
  const candidates: Array<{ entity: CanonicalEntity; evidence: PronunciationSourceEvidence[]; input: string }> = [];
  for (const entity of entities) {
    if (ids && !ids.includes(entity.id)) continue;
    const pronunciation = entity.pronunciation;
    if (pronunciation?.locked || pronunciation?.source === "manual") { summary.protected++; continue; }
    if (!force && hasActivePronunciation(pronunciation)) { summary.alreadyEnriched++; continue; }
    const input = pronunciationAttemptInput(entity, language);
    if (!force && cache[entity.id]?.attempt === input) { summary.alreadyEnriched++; continue; }
    if (!entity.originalName && /^en(?:-|$)|^english$/i.test(language)) { summary.notNeeded++; continue; }
    const evidence = await collectSourceEvidence(root, slug, entity);
    if (!entity.originalName && !evidence.length) {
      summary.notNeeded++;
      continue;
    }
    candidates.push({ entity, evidence, input }); summary.eligible++;
  }
  summary.batches = Math.ceil(candidates.length / 8);
  onProgress?.({ processed: 0, total: candidates.length });
  if (dryRun) return { enriched: suggested, unresolved: uncertain, entities, suggestions: {} as Record<string, EntityPronunciation>, summary: { ...summary, successful: 0, needsReview: 0, durationMs: Date.now() - startedAt }, dryRun: true };
  const persist = async (entity: CanonicalEntity, input: string, value: CanonicalEntity["pronunciation"] | undefined) => {
    const suggestion = value ? { ...value, sourceLanguage: value.sourceLanguage ?? language, needsReview: value.needsReview ?? (value.confidence ?? 1) < .7, source: "ai" as const, locked: false, updatedAt: new Date().toISOString() } : undefined;
    cache[entity.id] = suggestion ? { attempt: input, suggestion } : { attempt: input };
    await atomicWriteJson(path, cache);
    if (suggestion) {
      suggested.push(entity.id);
      if (suggestion.needsReview || (suggestion.confidence ?? 1) < .7) uncertain.push(entity.id);
    }
  };
  for (let start = 0; start < candidates.length; start += 8) {
    const batch = candidates.slice(start, start + 8);
    if (batch.length === 1) {
      const item = batch[0]!, result = await enrichPronunciation(provider, config, item.entity, language, item.evidence);
      await persist(item.entity, item.input, result.pronunciation ?? (item.evidence.length ? undefined : unresolvedPronunciation(language, item.evidence)));
    } else {
      const result = await enrichPronunciationBatch(provider, config, batch.map(item => ({ entity: item.entity, evidence: item.evidence })), language);
      for (const item of batch) {
        const value = result.pronunciations.get(item.entity.id);
        // null = the provider explicitly identified an ordinary translated term
        // that needs no guidance (attempt is still cached); only an entity
        // missing from the batch results gets an uncertain suggestion.
        await persist(item.entity, item.input, value === null ? undefined : value ?? unresolvedPronunciation(language, item.evidence));
      }
    }
    onProgress?.({ processed: Math.min(start + batch.length, candidates.length), total: candidates.length });
  }
  return { enriched: suggested, unresolved: uncertain, entities, suggestions: Object.fromEntries(Object.entries(cache).flatMap(([id, entry]) => entry.suggestion ? [[id, entry.suggestion]] : [])), summary: { ...summary, successful: suggested.length, needsReview: uncertain.length, durationMs: Date.now() - startedAt } };
}

export async function clearPronunciationAttempt(root: string, slug: string, id: string) {
  const path = enrichmentCachePath(root, slug);
  const cache = await loadPronunciationEnrichment(root, slug);
  delete cache[id]; await atomicWriteJson(path, cache);
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
