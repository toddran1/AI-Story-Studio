import { StageState } from "../domain/chapter.js";
import { QaException, QaState } from "../domain/qa.js";
import { Story } from "../domain/story.js";
import { CanonicalEntity, emptyStoryBible, hasActivePronunciation, StoryBible, storyBibleSchema } from "../domain/story-bible.js";
import { loadNarrationNamingEntities } from "../story-bible/narration-names.js";
import { loadPronunciationEntities } from "../story-bible/pronunciation.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists, readTextIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { loadAcceptedContinuity, type AcceptedContinuity } from "./deterministic.js";
import { listQaExceptions } from "./exceptions.js";
import { QA_PROMPT_VERSION } from "./prompts.js";
import { QaPrerequisiteError } from "./errors.js";
import { qaFingerprintConfig } from "./policy.js";

/** Naming state QA actually consumes, per entity; unrelated Story Bible fields are excluded. */
export type QaNamingProjection = {
  /** Versioned authority distinguishes old context-based QA from overlay-based QA. */
  authorityVersion?: number;
  id: string;
  type?: CanonicalEntity["type"];
  canonicalName: string;
  originalName: string;
  aliases: string[];
  preferredNarrationName?: string;
  localizedNaming?: CanonicalEntity["localizedNaming"];
  aliasNarrationRules: CanonicalEntity["aliasNarrationRules"];
  canonicalNameLocked: boolean;
};

/**
 * Pronunciation state QA actually consumes: active configurations only.
 * Entities using default TTS, AI suggestions, and enrichment attempts are not
 * QA dependencies and never affect the fingerprint.
 */
export type QaPronunciationProjection = {
  id: string;
  pronunciation: CanonicalEntity["pronunciation"];
};

/** The full set of effective QA dependencies for one chapter QA evaluation. */
export type QaDependencies = {
  /** Ingestion dependency fingerprint. */
  source: string;
  /** Fingerprint of the translation text. */
  translation: string;
  /** Fingerprint of the narration text. */
  narration: string;
  /** Prior story context snapshot (as passed to the QA prompt). */
  context: unknown;
  /** story.pipeline.qa */
  config: unknown;
  narrationSettings: unknown;
  /** QA_PROMPT_VERSION */
  prompt: string;
  mode: "production" | "thorough";
  naming: QaNamingProjection[];
  pronunciation: QaPronunciationProjection[];
  exceptions: QaException[];
  acceptedContinuity: AcceptedContinuity[];
};

export function projectNamingForQa(entities: CanonicalEntity[]): QaNamingProjection[] {
  return entities.map((entity) => ({
    authorityVersion: 1,
    id: entity.id,
    type: entity.type,
    canonicalName: entity.canonicalName,
    originalName: entity.originalName,
    aliases: entity.aliases,
    preferredNarrationName: entity.preferredNarrationName,
    localizedNaming: entity.localizedNaming,
    aliasNarrationRules: entity.aliasNarrationRules,
    canonicalNameLocked: entity.canonicalNameLocked,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

export function projectPronunciationForQa(entities: CanonicalEntity[]): QaPronunciationProjection[] {
  return entities.filter((entity) => hasActivePronunciation(entity.pronunciation))
    .map((entity) => ({ id: entity.id, pronunciation: entity.pronunciation }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export type QaDependencyFingerprints = {
  /** The authoritative QA dependency fingerprint. */
  fingerprint: string;
  naming: string;
  pronunciation: string;
  exceptions: string;
  acceptedContinuity: string;
  source: string;
  text: string;
  context: string;
  config: string;
  narrationSettings: string;
  prompt: string;
  mode: string;
};

/** Authoritative QA dependency fingerprint plus per-concern sub-fingerprints for targeted staleness. */
export function computeQaDependencyFingerprints(deps: QaDependencies): QaDependencyFingerprints {
  const naming = fingerprint(deps.naming);
  const pronunciation = fingerprint(deps.pronunciation);
  const exceptions = fingerprint([...deps.exceptions].sort((a, b) => a.id.localeCompare(b.id)));
  const acceptedContinuity = fingerprint([...deps.acceptedContinuity].sort((a, b) => a.id.localeCompare(b.id)));
  const source = fingerprint(deps.source);
  const text = fingerprint({ translation: deps.translation, narration: deps.narration });
  const context = fingerprint(deps.context);
  const config = fingerprint(deps.config);
  const narrationSettings = fingerprint(deps.narrationSettings);
  const prompt = fingerprint(deps.prompt);
  const mode = fingerprint(deps.mode);
  const combined = fingerprint({
    v: 1,
    source: deps.source,
    translation: deps.translation,
    narration: deps.narration,
    context: deps.context,
    config: deps.config,
    narrationSettings: deps.narrationSettings,
    prompt: deps.prompt,
    mode: deps.mode,
    naming,
    pronunciation,
    exceptions,
    acceptedContinuity,
  });
  return { fingerprint: combined, naming, pronunciation, exceptions, acceptedContinuity, source, text, context, config, narrationSettings, prompt, mode };
}

export function qaDependencySnapshot(value: QaDependencyFingerprints): NonNullable<QaState["dependencySnapshot"]> {
  return { version: 1, combined: value.fingerprint, text: value.text, source: value.source, naming: value.naming,
    pronunciation: value.pronunciation, exceptions: value.exceptions, acceptedContinuity: value.acceptedContinuity,
    context: value.context, config: value.config, narrationSettings: value.narrationSettings, prompt: value.prompt, mode: value.mode };
}

export function computeQaDependencyFingerprint(deps: QaDependencies): string {
  return computeQaDependencyFingerprints(deps).fingerprint;
}

/** Gather the deterministic (story-level, non-chapter-text) QA dependencies. */
export async function loadQaDeterministicDependencies(
  root: string,
  slug: string,
): Promise<Pick<QaDependencies, "naming" | "pronunciation" | "exceptions" | "acceptedContinuity">> {
  const [namingEntities, pronunciationEntities, exceptions, acceptedContinuity] = await Promise.all([
    loadNarrationNamingEntities(root, slug),
    loadPronunciationEntities(root, slug),
    listQaExceptions(root, slug),
    loadAcceptedContinuity(root, slug),
  ]);
  return {
    naming: projectNamingForQa(namingEntities),
    pronunciation: projectPronunciationForQa(pronunciationEntities),
    exceptions,
    acceptedContinuity,
  };
}

export type QaFreshness = "missing" | "current" | "needs_recheck" | "failed";

/**
 * A persisted QA stage is current ONLY when its recorded dependency fingerprint
 * matches the current effective dependency fingerprint.
 */
export function deriveQaFreshness(recordedFingerprint: string | undefined, currentFingerprint: string, stageStatus?: string): QaFreshness {
  if (stageStatus === "failed") return "failed";
  if (!recordedFingerprint) return "missing";
  return recordedFingerprint === currentFingerprint ? "current" : "needs_recheck";
}

export type DeterministicQaDependencies = Pick<QaDependencies, "naming" | "pronunciation" | "exceptions" | "acceptedContinuity">;

export type ResolvedQaContext = {
  raw: unknown;
  parsed: StoryBible;
};

/**
 * Resolves the authoritative chapter context consumed by QA.
 * Reads the stored context artifact from disk when present, falling back to an
 * empty Story Bible if absent. Existing but malformed context blocks QA.
 */
export async function resolveStoredQaContext(target: string | { storyContext: string; chapter?: number }): Promise<ResolvedQaContext> {
  const path = typeof target === "string" ? target : target.storyContext;
  const chapter = typeof target === "string" ? undefined : target.chapter;
  let raw: unknown;
  try { raw = (await readJsonIfExists(path)) ?? emptyStoryBible(); }
  catch { throw new QaPrerequisiteError("QA_CONTEXT_INVALID", `QA could not safely load ${chapter ? `Chapter ${chapter} ` : "the stored "}Story Context because the file is invalid. Rebuild or repair the Story Bible context, then retry QA.`, { path, chapter }); }
  let parsed: StoryBible;
  try {
    parsed = storyBibleSchema.parse(raw);
  } catch {
    throw new QaPrerequisiteError("QA_CONTEXT_INVALID", `QA could not safely load ${chapter ? `Chapter ${chapter} ` : "the stored "}Story Context because it does not match the expected schema. Rebuild or repair the Story Bible context, then retry QA.`, { path, chapter });
  }
  return { raw, parsed };
}

/**
 * Rebuild the exact dependency set the pipeline/recheck records for a stored
 * chapter, from the artifacts on disk. Returns undefined when the chapter lacks
 * the text QA would evaluate, meaning no current fingerprint can be computed.
 */
export async function loadStoredQaDependencies(
  root: string,
  story: Story,
  chapter: number,
  deterministic?: DeterministicQaDependencies,
): Promise<QaDependencies | undefined> {
  const paths = storyPaths(root, story.slug, chapter);
  const [source, translation, narration, qaContext, deterministicDeps] = await Promise.all([
    readTextIfExists(paths.original), readTextIfExists(paths.english), readTextIfExists(paths.narration),
    resolveStoredQaContext({ storyContext: paths.storyContext, chapter }), deterministic ? Promise.resolve(deterministic) : loadQaDeterministicDependencies(root, story.slug),
  ]);
  if (!source?.trim() || !translation?.trim() || !narration?.trim()) return undefined;
  return {
    source: fingerprint({ source, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage }),
    translation: fingerprint(translation),
    narration: fingerprint(narration),
    context: qaContext.raw,
    config: qaFingerprintConfig(story),
    narrationSettings: { profanityMode: story.narrationSettings.profanityMode, includeChapterTitle: story.narrationSettings.includeChapterTitle },
    prompt: QA_PROMPT_VERSION,
    mode: story.qaMode,
    ...deterministicDeps,
  };
}

/** Current effective QA dependency fingerprint for a stored chapter; undefined when not computable. */
export async function computeStoredQaDependencyFingerprint(
  root: string,
  story: Story,
  chapter: number,
  deterministic?: DeterministicQaDependencies,
): Promise<string | undefined> {
  const deps = await loadStoredQaDependencies(root, story, chapter, deterministic);
  return deps ? computeQaDependencyFingerprint(deps) : undefined;
}

export type ChapterQaFreshness = { freshness: QaFreshness; currentFingerprint?: string };

/**
 * Single server/planner freshness entry point: compares the stage's recorded
 * dependency fingerprint against the current effective one. When the current
 * fingerprint cannot be computed (missing chapter text), falls back to the
 * recorded stage status rather than pretending knowledge.
 */
export async function deriveChapterQaFreshness(
  root: string,
  story: Story,
  chapter: number,
  stage?: Pick<StageState, "status" | "fingerprint" | "staleReason">,
  deterministic?: DeterministicQaDependencies,
): Promise<ChapterQaFreshness> {
  let currentFingerprint: string | undefined;
  try { currentFingerprint = await computeStoredQaDependencyFingerprint(root, story, chapter, deterministic); }
  catch (error) {
    // Keep read-only dashboards available while still refusing authoritative QA
    // execution; inspect/recheck call strict loaders and will surface the error.
    if (error instanceof QaPrerequisiteError) return { freshness: "needs_recheck" };
    throw error;
  }
  if (stage?.staleReason && stage.status === "complete") return { freshness: "needs_recheck", currentFingerprint };
  if (!currentFingerprint) {
    const freshness: QaFreshness = stage?.status === "failed" ? "failed" : !stage?.fingerprint ? "missing" : stage.status === "complete" ? "current" : "needs_recheck";
    return { freshness };
  }
  return { freshness: deriveQaFreshness(stage?.fingerprint, currentFingerprint, stage?.status), currentFingerprint };
}
