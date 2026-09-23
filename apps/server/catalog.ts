import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Chapter, chapterSchema } from "../../src/domain/chapter.js";
import { isQaIssueActive, QaResult, qaResultSchema, qaStateSchema } from "../../src/domain/qa.js";
import { migrateQaState, openFindings, qaFindingStats } from "../../src/qa/findings.js";
import { deriveChapterQaFreshness, loadQaDeterministicDependencies } from "../../src/qa/freshness.js";
import { Story, storySchema } from "../../src/domain/story.js";
import { StoryBible, CanonicalEntity, canonicalEntitySchema, emptyStoryBible, hasActivePronunciation, storyBibleSchema } from "../../src/domain/story-bible.js";
import { SourceManifest, sourceManifestSchema } from "../../src/source/types.js";
import { atomicWriteJson } from "../../src/storage/atomic-write.js";
import { exportPaths, sceneImagePath, sceneVersionImagePath, storyPaths, videoExportPaths } from "../../src/storage/paths.js";
import { exists, readJsonIfExists, readTextIfExists } from "../../src/storage/story-files.js";
import { withStoryLock } from "../../src/storage/story-lock.js";
import { loadStory } from "../../src/config/load-config.js";
import { loadVisualProfiles, getVisualProfile as loadSingleVisualProfile } from "../../src/visual-canon/profiles.js";
import { loadStoryArtDirection } from "../../src/visual-canon/art-direction.js";
import { rebuildStoryBibleBeforeChapter, computeStaleExtractionChapters } from "../../src/story-bible/rebuild.js";
import { exportManifestSchema } from "../../src/audio/audiobook.js";
import { FfmpegTools } from "../../src/audio/ffmpeg.js";
import { videoExportManifestSchema } from "../../src/video/video-export.js";
import { SceneManifest, artworkSettingsSchema, sceneManifestSchema, sceneSettingsSchema } from "../../src/scenes/types.js";
import { sceneContentFingerprint } from "../../src/scenes/manifest.js";
import { resolveChapterVisualContinuity, ResolvedSceneContinuity } from "../../src/visual-canon/continuity.js";
import { resolveSceneVisualEntity } from "../../src/scenes/identity.js";
import { loadLatestProduction } from "../../src/production/manifest.js";
import { ProductionManifest } from "../../src/production/types.js";
import { applyManualBibleOverlay } from "../../src/studio/workflow.js";
import { getStorageUsage, invalidateStoryForConfigChange, loadGlobalSettings, readActivity } from "../../src/studio/projects.js";
import { loadEnvironment } from "../../src/config/env.js";
import { resolveModelRouting, resolveAllModelRoutings } from "../../src/config/model-routing.js";
import { defaultImageModel, IMAGE_PROVIDER_CATALOG, imageModelCompatible, imageNativeTiers } from "../../src/artwork/providers.js";
import { estimateNativeDimensions, planResolution, qualityTierIndex, resolveTargetDimensions } from "../../src/artwork/resolution.js";
import { videoResolutionSchema } from "../../src/video/config.js";
import { fingerprint } from "../../src/utils/hash.js";
import { fileFingerprint } from "../../src/utils/file-fingerprint.js";
import { logger } from "../../src/utils/logger.js";
import { AlignmentArtifact, alignmentArtifactSchema } from "../../src/alignment/types.js";
import { SubtitleDocument, subtitleDocumentSchema } from "../../src/subtitles/types.js";
import { normalizeSpeechForProvider } from "../../src/tts/speech-normalization.js";
import { continuityReviewSchema } from "../../src/story-bible/continuity.js";
import { applyCanonicalOverlay, CanonicalOverlay, canonicalOverlaySchema, findDuplicateSuggestions, loadStoryBibleWithCanonicalOverlay } from "../../src/story-bible/canonical.js";
import { ttsProviderNameSchema } from "../../src/domain/provider.js";
import { analyzeStoryBible } from "../../src/story-bible/granularity.js";
import { areTypesIncompatible } from "../../src/story-bible/duplicate-detection.js";
import { loadPronunciationSuggestions } from "../../src/story-bible/pronunciation.js";
import { entityReadiness, readinessNeedsAttention, type EntityReadinessRow } from "../../src/story-bible/readiness.js";
import { findNamingCollisions } from "../../src/story-bible/naming-collisions.js";
import { readEntityAudit } from "../../src/story-bible/entity-audit.js";

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const chapterFilterSchema = z.enum(["all", "unprocessed", "warn", "fail", "complete"]);
const storageCache = new Map<string, { value: Awaited<ReturnType<typeof getStorageUsage>>; expiresAt: number }>();
const storyCardCache = new Map<string, { value: any; expiresAt: number }>();

export function invalidateCatalogCache(root: string, slug: string) { const key = `${root}\0${slug}`; storyCardCache.delete(key); storageCache.delete(key); }

export type ChapterSummary = {
  chapter: number; originalTitle?: string; translation: string; narration: string; qa?: QaResult["status"];
  qaScore?: number; qaIssues?: QaResult["issues"]; qaStale: boolean; qaNeedsVerification?: number; qaStage?: string; tts: string; audioMastering: string; continuity: string; alignment: string; subtitles: string; subtitlesAvailable: boolean; subtitlesStale: boolean; scenePlanning: string; artwork: string; video: string; audioAvailable: boolean; audioStale: boolean; videoAvailable: boolean; videoStale: boolean; durationSeconds?: number;
};

export async function listStories(root: string, warnings: string[] = []) {
  const storiesRoot = join(root, "stories"); let directories: string[] = [];
  try { directories = (await readdir(storiesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const cards = await mapLimit(directories.filter((slug) => slugSchema.safeParse(slug).success), 4, async (slug) => {
    const cacheKey = `${root}\0${slug}`; const cached = storyCardCache.get(cacheKey); if (cached && cached.expiresAt > Date.now()) return cached.value;
    try {
      const paths = storyPaths(root, slug, 1); if (!(await exists(paths.storyConfig))) return undefined;
      const story = await loadStory(paths.storyConfig); const manifestRaw = await readJsonIfExists(paths.sourceManifest); const manifest = manifestRaw ? sourceManifestSchema.safeParse(manifestRaw) : undefined;
      const chapters = await loadChapterSummaries(root, slug); const processed = chapters.filter((item) => item.audioAvailable || item.audioMastering === "complete");
      const activity = await readActivity(root, slug, 1); const storage = await cachedStorageUsage(root, slug); const cover = (await Promise.all(["cover.jpg", "cover.jpeg", "cover.png"].map(async (name) => await exists(join(paths.story, name)) ? name : undefined))).find(Boolean); let exportNames: string[] = [];
      try { exportNames = await readdir(join(paths.story, "exports")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const availableExports = await currentExportBadges(root, slug, exportNames, chapters);
      const card = { slug, title: story.title, author: story.author, sourceType: story.source.type, sourceUrl: story.source.url, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
        importedChapters: manifest?.success ? manifest.data.chapters.length : chapters.length, processedChapters: processed.length, latestProcessedChapter: processed.at(-1)?.chapter,
        qa: countQa(chapters), progress: chapters.length ? Math.round(processed.length / chapters.length * 100) : 0, description: story.description, tags: story.tags,
        coverUrl: cover ? `/api/stories/${slug}/cover` : undefined, updatedAt: activity[0]?.at ?? (await stat(paths.storyConfig)).mtime.toISOString(), recentActivity: activity[0], projectBytes: storage.total,
        hasAudiobook: availableExports.audio, hasVideo: availableExports.video }; storyCardCache.set(cacheKey, { value: card, expiresAt: Date.now() + 5_000 }); return card;
    } catch (error) { const detail = error instanceof Error ? error.message : String(error); warnings.push(`Project '${slug}' could not be loaded: ${detail}`); logger.warn({ event: "library.story_skipped", slug, error: detail }); return undefined; }
  });
  return cards.filter((card): card is NonNullable<typeof card> => Boolean(card)).sort((a, b) => a.title.localeCompare(b.title));
}

export async function getStoryOverview(root: string, slug: string) {
  slugSchema.parse(slug); const story = await loadStory(storyPaths(root, slug, 1).storyConfig);
  const chapters = await loadChapterSummaries(root, slug);
  const env = loadEnvironment();
  const globalDefaults = await loadGlobalSettings(root, env).catch(() => undefined);
  const effectiveRouting = resolveAllModelRoutings(story, globalDefaults, env);
  return { story, effectiveRouting, counts: { chapters: chapters.length, minChapter: chapters[0]?.chapter, maxChapter: chapters.at(-1)?.chapter,
    ...countQa(chapters), complete: chapters.filter((item) => item.audioAvailable || item.audioMastering === "complete").length } };
}

export async function getStoryDashboard(root: string, slug: string) {
  slugSchema.parse(slug); const overview = await getStoryOverview(root, slug); const chapters = await loadChapterSummaries(root, slug); const latest = await loadLatestProduction(root, slug); const sourceRaw = await readJsonIfExists<SourceManifest>(storyPaths(root, slug, 1).sourceManifest); const source = sourceRaw ? sourceManifestSchema.safeParse(sourceRaw) : undefined;
  const completedStages = chapters.reduce((sum, chapter) => sum + [chapter.translation, chapter.narration, chapter.tts, chapter.audioMastering, chapter.continuity, chapter.alignment, chapter.subtitles, chapter.scenePlanning, chapter.artwork, chapter.video].filter((status) => status === "complete").length, 0);
  const current = latest?.story === slug && latest.storyFingerprint === fingerprint(overview.story) ? publicProductionManifest(latest, slug) : undefined;
  return { ...overview, source: source?.success ? { type: source.data.type, origin: "url" in source.data.origin ? { url: source.data.origin.url } : { name: source.data.origin.name }, importedAt: source.data.importedAt, chapterCount: source.data.chapters.length } : undefined, progress: { processed: chapters.filter((item) => item.translation === "complete").length, audio: chapters.filter((item) => item.audioAvailable || item.audioMastering === "complete").length, artwork: chapters.filter((item) => item.artwork === "complete").length, video: chapters.filter((item) => item.video === "complete").length }, latestProduction: current, currentProfile: current?.options.profile, estimatedRemainingStages: Math.max(0, chapters.length * 10 - completedStages) };
}

export async function getChapterPage(root: string, slug: string, options: { page: number; pageSize: number; filter: z.infer<typeof chapterFilterSchema>; query?: string }) {
  slugSchema.parse(slug); const page = Math.max(1, Math.floor(options.page)); const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize)));
  const index = await loadChapterIndex(root, slug); const query = options.query?.trim().toLocaleLowerCase();
  let numbers = index.numbers;
  if (query) numbers = numbers.filter((chapter) => String(chapter).includes(query) || index.titles.get(chapter)?.toLocaleLowerCase().includes(query));
  if (options.filter === "all") {
    const total = numbers.length; const pages = Math.max(1, Math.ceil(total / pageSize)); const safePage = Math.min(page, pages);
    const selected = numbers.slice((safePage - 1) * pageSize, safePage * pageSize);
    return { items: await loadSummaries(root, slug, selected, index), page: safePage, pageSize, total, pages };
  }
  let chapters = await loadSummaries(root, slug, numbers, index);
  if (options.filter === "unprocessed") chapters = chapters.filter((item) => item.translation !== "complete");
  else if (options.filter === "warn" || options.filter === "fail") chapters = chapters.filter((item) => item.qa === options.filter);
  else if (options.filter === "complete") chapters = chapters.filter((item) => item.audioAvailable || item.audioMastering === "complete");
  const total = chapters.length; const pages = Math.max(1, Math.ceil(total / pageSize)); const safePage = Math.min(page, pages);
  return { items: chapters.slice((safePage - 1) * pageSize, safePage * pageSize), page: safePage, pageSize, total, pages };
}

export async function getChapter(root: string, slug: string, chapter: number) {
  slugSchema.parse(slug); if (!Number.isSafeInteger(chapter) || chapter < 1) throw new Error("Chapter must be a positive integer");
  const paths = storyPaths(root, slug, chapter); const story = await loadStory(paths.storyConfig).catch(() => undefined); const metadataRaw = await readJsonIfExists<Chapter>(paths.chapterMeta);
  const metadata = metadataRaw ? chapterSchema.parse(metadataRaw) : undefined; const index = await loadChapterIndex(root, slug);
  if (index.manifest && !index.manifestByChapter.has(chapter)) throw new Error(`Chapter ${chapter} was not found`);
  const position = index.numbers.indexOf(chapter);
  const navigation = {
    previous: position > 0 ? chapterLink(index, index.numbers[position - 1]!) : undefined,
    next: position >= 0 && position < index.numbers.length - 1 ? chapterLink(index, index.numbers[position + 1]!) : undefined,
  };
  const fresh = isCurrent(metadata, index.manifestByChapter.get(chapter), Boolean(index.manifest));
  const qaRaw = await readJsonIfExists<QaResult>(paths.qa);
  // Stale artifacts stay visible: they are loaded whenever the file exists and
  // parsed successfully, and flagged stale instead of being withheld.
  const alignmentRaw = await readJsonIfExists<AlignmentArtifact>(paths.alignment);
  const alignment = alignmentRaw ? alignmentArtifactSchema.safeParse(alignmentRaw) : undefined;
  const subtitleRaw = await readJsonIfExists<SubtitleDocument>(paths.subtitlesDocument);
  const subtitleDocument = subtitleRaw ? subtitleDocumentSchema.safeParse(subtitleRaw) : undefined;
  const storyContext = await readJsonIfExists(paths.storyContext);
  const subtitlesText = await readTextIfExists(paths.subtitlesVtt);
  // A source replacement makes derived audio/video stale, but it must remain
  // playable and recoverable until the user explicitly regenerates it.
  const audioFileExists = await exists(paths.audio);
  const rawAudioExists = await exists(paths.audioRaw);
  const audioAvailable = audioFileExists || rawAudioExists;
  const audioStale = audioAvailable && (!fresh || metadata?.stages.audioMastering.status !== "complete" || !audioFileExists);
  const videoAvailable = await exists(paths.video);
  const videoStale = videoAvailable && (!fresh || metadata?.stages.video.status !== "complete");
  const narration = await readTextIfExists(paths.narration); const ttsScript = (await readTextIfExists(paths.narrationTts)) ?? narration;
  const speech = ttsScript && story ? normalizeSpeechForProvider(ttsScript, story.outputLanguage, story.narrationSettings).normalized : undefined;
  const qaFreshness = story && qaRaw ? await deriveChapterQaFreshness(root, story, chapter, metadata?.stages.qa) : undefined;
  return {
    chapter, navigation, metadata, stale: !fresh || metadata?.stages.ingestion.status !== "complete", original: await readTextIfExists(paths.original),
    translation: await readTextIfExists(paths.english), narration, spokenText: speech?.text, speechTransformations: speech?.transformations ?? [],
    qa: qaRaw ? qaResultSchema.parse(qaRaw) : undefined, qaStale: Boolean(qaRaw) && (qaFreshness ? qaFreshness.freshness !== "current" : !fresh || metadata?.stages.qa.status !== "complete"), qaFingerprint: qaFreshness?.currentFingerprint, storyContext, storyContextStale: storyContext !== undefined && !fresh, audioAvailable, audioStale,
    alignment: alignment?.success ? alignment.data : undefined, alignmentStale: Boolean(alignment?.success) && (!fresh || metadata?.stages.alignment.status !== "complete"),
    subtitleDocument: subtitleDocument?.success ? subtitleDocument.data : undefined,
    audioUrl: audioAvailable ? `/api/stories/${slug}/chapters/${chapter}/audio` : undefined,
    subtitles: subtitlesText ?? undefined,
    subtitlesStale: subtitlesText !== undefined && (!fresh || metadata?.stages.subtitles.status !== "complete"),
    subtitlesUrl: subtitlesText !== undefined ? `/api/stories/${slug}/chapters/${chapter}/subtitles.vtt` : undefined,
    videoUrl: videoAvailable ? `/api/stories/${slug}/chapters/${chapter}/video` : undefined, videoStale,
  };
}

function chapterLink(index: ChapterIndex, chapter: number) { return { chapter, title: index.titles.get(chapter) }; }

export async function getQaDashboard(root: string, slug: string) {
  const chapters = await loadChapterSummaries(root, slug); const issues: Record<string, number> = {}; const items = [];
  for (const chapter of chapters) {
    if (!chapter.qa) continue; const qaIssues = chapter.qaIssues ?? [];
    const activeIssues = qaIssues.filter(isQaIssueActive);
    items.push({
      chapter: chapter.chapter, title: chapter.originalTitle, status: chapter.qa, score: chapter.qaScore,
      // Current gating issues; when stale, needsVerification carries how many
      // previous findings still await verification against current inputs.
      issues: activeIssues, stale: chapter.qaStale, needsVerification: chapter.qaNeedsVerification ?? 0,
    });
    if (!chapter.qaStale) for (const category of new Set(activeIssues.map((issue) => issue.category))) issues[category] = (issues[category] ?? 0) + 1;
  }
  return { counts: { ...countQa(chapters), needsVerification: items.reduce((sum, item) => sum + item.needsVerification, 0) }, categories: issues, chapters: items };
}

export async function getStoryBible(root: string, slug: string, options: { includeCanonicalOverlay?: boolean } = {}): Promise<StoryBible> {
  slugSchema.parse(slug);
  return loadStoryBibleWithCanonicalOverlay(root, slug, options);
}

export async function getStoryBibleView(root: string, slug: string) { const bible = await getStoryBible(root, slug); const view = await applyManualBibleOverlay(root, slug, bible); return { ...view, staleExtractionChapters: await computeStaleExtractionChapters(root, slug) }; }

export async function getSuppressedCanonicalEntities(root: string, slug: string) {
  slugSchema.parse(slug);
  const raw = await readJsonIfExists(storyPaths(root, slug, 1).bibleCanonicalManual);
  return canonicalOverlaySchema.parse(raw ?? { version: 1 }).suppressions;
}

export const entityReadinessFilterSchema = z.enum(["needs-attention", "narration-incomplete", "localization-incomplete", "pronunciation-review", "visual-incomplete", "continuity-issues", "duplicate-candidates", "type-conflicts"]);
export type EntityReadinessFilter = z.infer<typeof entityReadinessFilterSchema>;

/** Canonical overlay fields that replace extracted state with current editorial state. */
const CANONICAL_OVERRIDE_FIELDS = ["canonicalName", "canonicalNameLocked", "type", "aliases", "notes", "status", "preferredNarrationName", "aliasNarrationRules", "localizedNaming", "pronunciation", "visualProfilePolicy"] as const;

/** Which entity fields carry a manual editorial override (current state, no chapter semantics). */
function manualOverrideFields(overlay: CanonicalOverlay | undefined, id: string): string[] {
  const override = overlay?.overrides[id];
  if (!override) return [];
  return CANONICAL_OVERRIDE_FIELDS.filter((field) => override[field] !== undefined);
}

function readinessFilterPredicate(filter: EntityReadinessFilter): (rows: EntityReadinessRow[]) => boolean {
  const row = (rows: EntityReadinessRow[], key: EntityReadinessRow["key"]) => rows.find((item) => item.key === key);
  switch (filter) {
    case "needs-attention": return readinessNeedsAttention;
    case "narration-incomplete": return (rows) => row(rows, "narration")?.state === "optional";
    case "localization-incomplete": return (rows) => row(rows, "localization")?.state === "optional";
    case "pronunciation-review": return (rows) => row(rows, "pronunciation")?.state === "attention";
    case "visual-incomplete": return (rows) => ["attention", "optional"].includes(row(rows, "visualProfile")?.state ?? "");
    case "continuity-issues": return (rows) => row(rows, "continuity")?.state === "attention";
    case "duplicate-candidates": return (rows) => row(rows, "duplicates")?.state === "attention";
    case "type-conflicts": return (rows) => row(rows, "type")?.state === "attention";
  }
}

/**
 * One pass over the derived Story Bible review inputs (continuity findings,
 * duplicate suggestions, Visual Profiles, pronunciation suggestions) shared by
 * the entities page, entity detail, health, and review-queue endpoints. Read
 * only; nothing here makes provider calls.
 */
async function loadBibleReviewContext(root: string, slug: string) {
  const bible = await getStoryBible(root, slug);
  const reviewRaw = await readJsonIfExists(storyPaths(root, slug, 1).continuityReview);
  const review = reviewRaw ? continuityReviewSchema.safeParse(reviewRaw) : undefined;
  const findings = review?.success ? review.data.findings : [];
  const openCounts = new Map<string, number>();
  for (const finding of findings.filter((item) => item.status === "open")) for (const id of finding.entityIds) openCounts.set(id, (openCounts.get(id) ?? 0) + 1);
  const duplicateSuggestions = findDuplicateSuggestions(bible.canonicalEntities, { bible });
  const duplicateCounts = new Map<string, number>();
  const typeConflicts = new Set<string>();
  for (const suggestion of duplicateSuggestions) {
    for (const id of suggestion.entityIds) duplicateCounts.set(id, (duplicateCounts.get(id) ?? 0) + 1);
    const [first, second] = suggestion.entityIds.map((id) => bible.canonicalEntities.find((entity) => entity.id === id));
    if (first && second && areTypesIncompatible(first.type, second.type)) { typeConflicts.add(first.id); typeConflicts.add(second.id); }
  }
  const [visualProfiles, pronunciationSuggestions] = await Promise.all([loadVisualProfiles(root, slug), loadPronunciationSuggestions(root, slug)]);
  // Deterministic exact-name collisions: distinct from fuzzy duplicate
  // suggestions above and never fed into merge automation.
  const namingCollisions = findNamingCollisions(bible.canonicalEntities);
  const overlayRaw = await readJsonIfExists(storyPaths(root, slug, 1).bibleCanonicalManual);
  const parsedOverlay = overlayRaw ? canonicalOverlaySchema.safeParse(overlayRaw) : undefined;
  const readinessOf = (entity: CanonicalEntity) => entityReadiness(entity, {
    continuityOpenCount: openCounts.get(entity.id) ?? 0,
    duplicateCandidates: duplicateCounts.get(entity.id) ?? 0,
    duplicateTypeConflict: typeConflicts.has(entity.id),
    visualProfile: visualProfiles[entity.id] ? { status: visualProfiles[entity.id]!.status, needsReviewConflicts: (visualProfiles[entity.id]!.conflicts ?? []).filter((conflict) => conflict.status === "needs_review").length } : undefined,
    pronunciationSuggestionPending: Boolean(pronunciationSuggestions[entity.id]),
  });
  return { bible, findings, openCounts, duplicateSuggestions, namingCollisions, visualProfiles, pronunciationSuggestions, readinessOf, overlay: parsedOverlay?.success ? parsedOverlay.data : undefined };
}

export async function getCanonicalEntitiesPage(root: string, slug: string, options: { page: number; pageSize: number; type?: string; query?: string; sort?: string; readiness?: EntityReadinessFilter }) {
  const context = await loadBibleReviewContext(root, slug);
  const { bible } = context;
  let entities = bible.canonicalEntities;
  const query = options.query?.trim().toLocaleLowerCase();
  if (options.type && options.type !== "all") entities = entities.filter((item) => item.type === options.type);
  if (query) entities = entities.filter((item) => [item.canonicalName, item.originalName, item.preferredNarrationName ?? "", item.localizedNaming?.fullName ?? "", item.localizedNaming?.shortName ?? "", item.localizedNaming?.notes ?? "", item.description, item.notes, ...item.aliases, ...item.aliasNarrationRules.flatMap((rule) => [rule.alias, rule.replacement ?? ""])].some((value) => value.toLocaleLowerCase().includes(query)));
  const readinessOf = context.readinessOf;
  if (options.readiness) { const predicate = readinessFilterPredicate(options.readiness); entities = entities.filter((item) => predicate(readinessOf(item))); }
  const direction = options.sort === "last" ? (a: typeof entities[number], b: typeof entities[number]) => b.lastKnownAppearance - a.lastKnownAppearance : options.sort === "first" ? (a: typeof entities[number], b: typeof entities[number]) => a.firstAppearance - b.firstAppearance : (a: typeof entities[number], b: typeof entities[number]) => a.canonicalName.localeCompare(b.canonicalName);
  entities = [...entities].sort(direction);
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize)));
  const pages = Math.max(1, Math.ceil(entities.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(options.page)));
  return { items: entities.slice((page - 1) * pageSize, page * pageSize).map((item) => ({ ...item, conflictCount: context.openCounts.get(item.id) ?? 0, readiness: readinessOf(item) })), page, pageSize, pages, total: entities.length, counts: Object.fromEntries(["character", "location", "organization", "ability", "item", "concept", "other"].map((type) => [type, bible.canonicalEntities.filter((item) => item.type === type).length])), duplicateSuggestions: context.duplicateSuggestions.slice(0, 50) };
}

export async function getCanonicalEntityDetail(root: string, slug: string, id: string) {
  const context = await loadBibleReviewContext(root, slug);
  const bible = context.bible;
  const entity = bible.canonicalEntities.find((item) => item.id === id);
  if (!entity) throw new Error("Canonical entity was not found");
  const related = bible.canonicalRelationships.filter((item) => item.sourceEntityId === id || item.targetEntityId === id);
  const relatedIds = new Set(related.flatMap((item) => [item.sourceEntityId, item.targetEntityId]));
  const names = Object.fromEntries(bible.canonicalEntities.filter((item) => relatedIds.has(item.id)).map((item) => [item.id, item.canonicalName]));
  const relatedReferences = (bible.minorReferences ?? []).filter((ref) => ref.parentEntityId === id);
  const duplicateSuggestions = context.duplicateSuggestions.filter((item) => item.entityIds.includes(id)).slice(0, 20);
  return {
    entity,
    timeline: bible.entityTimeline.filter((item) => item.entityId === id).sort((a, b) => a.chapter - b.chapter),
    relationships: related,
    relatedNames: names,
    relatedReferences,
    issues: context.findings.filter((item) => item.entityIds.includes(id)),
    merges: bible.merges.filter((item) => item.targetEntityId === id || item.sourceEntityIds.includes(id)),
    duplicateSuggestions,
    namingCollisions: context.namingCollisions.filter((item) => item.entities.some((candidate) => candidate.id === id)),
    visualProfileExists: Boolean(context.visualProfiles[id]),
    readiness: context.readinessOf(entity),
    manualFields: manualOverrideFields(context.overlay, id),
  };
}

/**
 * Read-only "entity as of chapter N" view (Phase D). The historical state is
 * reconstructed solely from chronological per-chapter Story Bible updates via
 * rebuildStoryBibleBeforeChapter with the canonical overlay EXCLUDED, so manual
 * edits never masquerade as historical facts. Manual overlay fields have no
 * chapter semantics: they are reported separately in `currentOverrides` (and
 * merge/suppression caveats in `warnings`) instead of being projected backward.
 * No provider calls, no writes.
 */
export async function getCanonicalEntityHistory(root: string, slug: string, id: string, chapter: number) {
  slugSchema.parse(slug); canonicalEntitySchema.shape.id.parse(id);
  if (!Number.isSafeInteger(chapter) || chapter < 1) throw new Error("Chapter must be a positive integer");
  const context = await loadBibleReviewContext(root, slug);
  const current = context.bible.canonicalEntities.find((item) => item.id === id);
  if (!current) throw new Error("Canonical entity was not found");
  const index = await loadChapterIndex(root, slug);
  const maxChapter = index.numbers.at(-1);
  const effective = maxChapter ? Math.min(chapter, maxChapter) : chapter;
  // State before chapter N+1 == state as of chapter N, without the canonical overlay.
  const rebuilt = await rebuildStoryBibleBeforeChapter(root, slug, effective + 1, { includeCanonicalOverlay: false });
  const historical = rebuilt.canonicalEntities.find((item) => item.id === id);
  const provenance = (historical?.provenance ?? []).filter((item) => item.chapter <= effective);
  const relationships = rebuilt.canonicalRelationships
    .filter((item) => (item.sourceEntityId === id || item.targetEntityId === id) && item.startChapter <= effective && (item.endChapter === undefined || item.endChapter >= effective));
  const relatedIds = new Set(relationships.flatMap((item) => [item.sourceEntityId, item.targetEntityId]));
  const warnings: string[] = [];
  const overlay = context.overlay;
  if (overlay) {
    if (overlay.merges.some((merge) => !merge.undoneAt && (merge.targetEntityId === id || merge.sourceEntityIds.includes(id)))) warnings.push("Manual merges carry no chapter information and are applied as current state; this historical view shows the pre-merge extracted records only.");
    if (overlay.suppressions.some((item) => item.entityId === id)) warnings.push("A manual suppression record exists for this entity; suppressions are current editorial state and are not reflected historically.");
    if (overlay.demotions.some((item) => item.entityId === id)) warnings.push("A manual demotion record exists for this entity; demotions are current editorial state and are not reflected historically.");
  }
  return {
    chapter: effective,
    requestedChapter: chapter !== effective ? chapter : undefined,
    exists: Boolean(historical),
    entity: historical ? { ...historical, provenance } : undefined,
    timeline: rebuilt.entityTimeline.filter((item) => item.entityId === id && item.chapter <= effective).sort((a, b) => a.chapter - b.chapter),
    relationships,
    relatedNames: Object.fromEntries(rebuilt.canonicalEntities.filter((item) => relatedIds.has(item.id)).map((item) => [item.id, item.canonicalName])),
    provenance,
    currentOverrides: manualOverrideFields(overlay, id),
    overrideUpdatedAt: overlay?.overrides[id]?.updatedAt,
    warnings,
    firstAppearanceKnown: Boolean(historical) || current.provenance.length > 0,
    earliestKnownChapter: historical ? undefined : current.firstAppearance,
  };
}

// ---------------------------------------------------------------------------
// Entity "where used" aggregation (Phase C)
//
// QA findings and scene manifests only exist as per-chapter artifacts, so a
// per-story index is built lazily and cached in memory. Revalidation stats the
// chapter artifacts (cheap) and re-reads only chapters whose chapter.json /
// qa.json / scenes.json mtimes changed — a 1,600-chapter story pays the full
// parse once, then ~3 stats per chapter per request.
// ---------------------------------------------------------------------------

type ChapterUsageSnapshot = {
  stamp: string;
  translationComplete: boolean;
  narrationComplete: boolean;
  qaFindings: Array<{ id: string; entityIds: string[]; category: string; severity: string; status: string; message: string; evidence?: string }>;
  sceneRefs: Array<{ sceneId: string; entityIds: string[]; summary: string }>;
};

const chapterUsageCache = new Map<string, Map<number, ChapterUsageSnapshot>>();

async function mtimeStamp(path: string) { try { return String((await stat(path)).mtimeMs); } catch { return "-"; } }

async function loadChapterUsageIndex(root: string, slug: string): Promise<Map<number, ChapterUsageSnapshot>> {
  const key = `${root}\0${slug}`;
  const cache = chapterUsageCache.get(key) ?? new Map<number, ChapterUsageSnapshot>();
  const index = await loadChapterIndex(root, slug);
  await mapLimit(index.numbers, 16, async (chapter) => {
    const paths = storyPaths(root, slug, chapter);
    const stamp = `${await mtimeStamp(paths.chapterMeta)}|${await mtimeStamp(paths.qa)}|${await mtimeStamp(paths.scenesManifest)}`;
    if (cache.get(chapter)?.stamp === stamp) return;
    const [metaRaw, qaRaw, scenesRaw] = await Promise.all([readJsonIfExists(paths.chapterMeta), readJsonIfExists(paths.qa), readJsonIfExists(paths.scenesManifest)]);
    const meta = metaRaw ? chapterSchema.safeParse(metaRaw) : undefined;
    const qa = qaRaw ? qaStateSchema.safeParse(qaRaw) : undefined;
    const scenes = scenesRaw ? sceneManifestSchema.safeParse(scenesRaw) : undefined;
    cache.set(chapter, {
      stamp,
      translationComplete: meta?.success === true && meta.data.stages.translation.status === "complete",
      narrationComplete: meta?.success === true && meta.data.stages.narration.status === "complete",
      qaFindings: qa?.success ? qa.data.findings.filter((finding) => finding.provenance?.entityIds?.length).map((finding) => ({ id: finding.id, entityIds: finding.provenance!.entityIds!, category: finding.category, severity: finding.severity, status: finding.status, message: finding.message, evidence: finding.evidence })) : [],
      sceneRefs: scenes?.success ? scenes.data.scenes.filter((scene) => scene.entityIds?.length).map((scene) => ({ sceneId: scene.id, entityIds: scene.entityIds!, summary: scene.summary })) : [],
    });
  });
  for (const chapter of [...cache.keys()]) if (!index.numbers.includes(chapter)) cache.delete(chapter);
  chapterUsageCache.set(key, cache);
  return cache;
}

export type EntityUsageKind = "provenance" | "qa" | "continuity" | "scene" | "visual-profile";

/** Where a canonical entity is used, derived on read from existing artifacts. No provider calls. */
export async function getCanonicalEntityUsage(root: string, slug: string, id: string, options: { page: number; pageSize: number }) {
  slugSchema.parse(slug); canonicalEntitySchema.shape.id.parse(id);
  const context = await loadBibleReviewContext(root, slug);
  const entity = context.bible.canonicalEntities.find((item) => item.id === id);
  if (!entity) throw new Error("Canonical entity was not found");
  const chapters = await loadChapterUsageIndex(root, slug);
  const uses: Array<{ kind: EntityUsageKind; chapter?: number; sceneId?: string; label: string; excerpt?: string; href: string }> = [];

  const provenanceChapters = [...new Set(entity.provenance.map((item) => item.chapter))].sort((a, b) => a - b);
  for (const item of entity.provenance) uses.push({
    kind: "provenance", chapter: item.chapter,
    label: `Story Bible ${item.kind} record · Chapter ${item.chapter}`,
    href: `/stories/${slug}/chapters/${item.chapter}`,
  });

  let qaFindings = 0; let scenes = 0;
  for (const [chapter, snapshot] of [...chapters.entries()].sort((a, b) => a[0] - b[0])) {
    for (const finding of snapshot.qaFindings.filter((item) => item.entityIds.includes(id))) {
      qaFindings++;
      uses.push({ kind: "qa", chapter, label: finding.message, excerpt: finding.evidence || undefined, href: `/stories/${slug}/chapters/${chapter}?tab=quality` });
    }
    for (const scene of snapshot.sceneRefs.filter((item) => item.entityIds.includes(id))) {
      scenes++;
      uses.push({ kind: "scene", chapter, sceneId: scene.sceneId, label: `Scene ${scene.sceneId}: ${scene.summary}`, href: `/stories/${slug}/scenes?chapter=${chapter}` });
    }
  }

  const continuityFindings = context.findings.filter((item) => item.entityIds.includes(id));
  for (const finding of continuityFindings) uses.push({
    kind: "continuity", chapter: Math.min(...finding.chapters),
    label: finding.explanation, excerpt: finding.supportingFacts[0]?.summary || undefined,
    href: `/stories/${slug}/continuity?entity=${id}`,
  });

  const visualProfile = context.visualProfiles[id];
  if (visualProfile) uses.push({ kind: "visual-profile", label: `Visual Profile (${visualProfile.status})`, href: `/stories/${slug}/bible?entity=${id}` });

  uses.sort((a, b) => (a.chapter ?? 0) - (b.chapter ?? 0) || a.kind.localeCompare(b.kind));
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize)));
  const pages = Math.max(1, Math.ceil(uses.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(options.page)));
  const summary = {
    sourceChapters: [entity.firstAppearance, entity.lastKnownAppearance] as [number, number],
    translationChapters: provenanceChapters.filter((chapter) => chapters.get(chapter)?.translationComplete).length,
    narrationChapters: provenanceChapters.filter((chapter) => chapters.get(chapter)?.narrationComplete).length,
    qaFindings, continuityFindings: continuityFindings.length, scenes,
    visualProfile: Boolean(visualProfile),
  };
  return { summary, uses: uses.slice((page - 1) * pageSize, page * pageSize), total: uses.length, page, pageSize };
}

/**
 * Paginated entity audit entries (newest first) plus the pre-existing
 * historical record (merges, granularity audits, first appearance) so the
 * sheet can render one continuous timeline without fabricating before/after
 * deltas for events that never recorded them.
 */
export async function getCanonicalEntityAudit(root: string, slug: string, id: string, options: { page: number; pageSize: number }) {
  slugSchema.parse(slug); canonicalEntitySchema.shape.id.parse(id);
  const bible = await getStoryBible(root, slug);
  const entity = bible.canonicalEntities.find((item) => item.id === id);
  if (!entity) throw new Error("Canonical entity was not found");
  const entries = await readEntityAudit(root, slug, id);
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize)));
  const pages = Math.max(1, Math.ceil(entries.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(options.page)));
  const names = new Map(bible.canonicalEntities.map((item) => [item.id, item.canonicalName]));
  const historical: Array<{ kind: string; label: string; source?: string; timestamp?: string; chapter?: number }> = [];
  const firstRecord = entity.provenance.find((item) => item.chapter === entity.firstAppearance);
  if (firstRecord) historical.push({
    kind: "provenance", chapter: entity.firstAppearance, source: firstRecord.origin,
    label: `${firstRecord.origin === "manual" ? "Manually recorded" : "Automatically extracted"} as ${entity.type} · Ch. ${entity.firstAppearance}`,
  });
  for (const merge of bible.merges.filter((item) => item.targetEntityId === id || item.sourceEntityIds.includes(id))) {
    const direction = merge.targetEntityId === id
      ? `Merged ${merge.sourceEntityIds.map((source) => names.get(source) ?? source).join(", ")} into this entity`
      : `Merged into ${names.get(merge.targetEntityId) ?? merge.targetEntityId}`;
    historical.push({ kind: "merge", label: `${direction}: ${merge.reason}`, source: "manual", timestamp: merge.createdAt });
    if (merge.undoneAt) historical.push({ kind: "merge", label: `Merge undone (${direction})`, source: "manual", timestamp: merge.undoneAt });
  }
  for (const audit of bible.granularityAudits.filter((item) => item.fromEntityId === id || item.toEntityId === id)) {
    historical.push({ kind: "granularity", label: `${audit.action === "kept" ? "Kept" : audit.action === "promoted" ? "Promoted" : audit.action === "demoted" ? "Demoted" : "Merged"} ${audit.name}${audit.reason ? `: ${audit.reason}` : ""}`, source: audit.source, timestamp: audit.timestamp });
  }
  return { entries: entries.slice((page - 1) * pageSize, page * pageSize), historical, total: entries.length, page, pageSize };
}


/**
 * Aggregated Story Bible health summary. Every count is derived on read from
 * existing artifacts (duplicate detection, continuity review, stale extraction
 * walk, pronunciation records, Visual Profile conflicts, deterministic cleanup
 * analysis) — no provider calls, no persistence.
 */
export async function getStoryBibleHealth(root: string, slug: string) {
  const context = await loadBibleReviewContext(root, slug);
  const { bible } = context;
  const staleExtractionChapters = await computeStaleExtractionChapters(root, slug);
  // No provider is passed: classifyEntityPersistence falls back to its
  // deterministic result, so this analysis is free and reproducible.
  const analysis = await analyzeStoryBible(root, slug);
  const cleanupRecommendations = analysis.recommendations.filter((item) => item.recommendation !== "keep_canonical").length;
  const visualProfileIssues = Object.values(context.visualProfiles).filter((profile) => (profile.conflicts ?? []).some((conflict) => conflict.status === "needs_review")).length;
  const pronunciationNeedsReview = bible.canonicalEntities.filter((entity) => hasActivePronunciation(entity.pronunciation) && entity.pronunciation?.needsReview).length;
  const needsAttention = bible.canonicalEntities.filter((entity) => readinessNeedsAttention(context.readinessOf(entity))).length;
  return {
    totals: { canonicalEntities: bible.canonicalEntities.length, minorReferences: (bible.minorReferences ?? []).length, needsAttention },
    issues: {
      duplicateCandidates: context.duplicateSuggestions.length,
      continuityOpen: context.findings.filter((item) => item.status === "open").length,
      visualProfileIssues,
      pronunciationNeedsReview,
      staleExtractionChapters: staleExtractionChapters.length,
      cleanupRecommendations,
      namingCollisions: context.namingCollisions.filter((item) => !item.hasMergeRelationship).length,
    },
  };
}

export const bibleReviewKindSchema = z.enum(["duplicate", "pronunciation", "continuity", "visual-profile", "stale-extraction", "cleanup", "naming"]);
export const bibleReviewStatusSchema = z.enum(["open", "resolved", "all"]);
export type BibleReviewItem = {
  id: string;
  kind: z.infer<typeof bibleReviewKindSchema>;
  entityIds?: string[];
  title: string;
  detail: string;
  severity?: "info" | "warn" | "critical";
  chapters?: number[];
  source: string;
  lifecycle: "derived" | "stateful";
  status: "open" | "resolved";
  action: { label: string; href: string };
};

/**
 * Unified derived review queue: aggregates existing issue sources into one
 * paginated list without copying anything into a second store. Only sources
 * with real resolution state (continuity) respond to the status filter.
 */
export async function getStoryBibleReview(root: string, slug: string, options: { kind?: z.infer<typeof bibleReviewKindSchema>; status?: z.infer<typeof bibleReviewStatusSchema>; entityId?: string; page: number; pageSize: number }) {
  const context = await loadBibleReviewContext(root, slug);
  const { bible } = context;
  const names = new Map(bible.canonicalEntities.map((entity) => [entity.id, entity.canonicalName]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const items: BibleReviewItem[] = [];
  const entityHref = (id: string) => `/stories/${slug}/bible?entity=${id}`;

  for (const suggestion of context.duplicateSuggestions) items.push({
    id: `duplicate:${suggestion.id}`, kind: "duplicate", entityIds: [...suggestion.entityIds],
    title: `Possible duplicate: ${suggestion.entities[0].name} ↔ ${suggestion.entities[1].name}`,
    detail: `${Math.round(suggestion.confidence * 100)}% confidence · ${suggestion.reason}`,
    severity: suggestion.confidence >= 0.85 ? "warn" : "info",
    chapters: suggestion.supportingChapters, source: "duplicate-detection", lifecycle: "derived", status: "open",
    action: { label: "Compare & merge", href: entityHref(suggestion.entityIds[0]) },
  });

  for (const collision of context.namingCollisions) items.push({
    id: `naming:${collision.id}`, kind: "naming", entityIds: collision.entities.map((entity) => entity.id),
    title: `Naming collision: ${collision.name}`,
    detail: collision.hasMergeRelationship ? `${collision.reason} The colliding records already share a merge relationship.` : collision.reason,
    severity: collision.hasMergeRelationship ? "info" : "warn",
    chapters: collision.chapters, source: "naming-collision-detection", lifecycle: "derived", status: "open",
    action: { label: "Compare entities", href: entityHref(collision.entities[0]!.id) },
  });

  for (const finding of context.findings) {
    items.push({
      id: `continuity:${finding.id}`, kind: "continuity", entityIds: finding.entityIds,
      title: finding.entityIds.map(nameOf).join(" · "),
      detail: finding.explanation,
      severity: finding.severity === "critical" ? "critical" : finding.severity === "warning" ? "warn" : "info",
      chapters: finding.chapters, source: "continuity", lifecycle: "stateful", status: finding.status === "open" ? "open" : "resolved",
      action: { label: "Review continuity", href: `/stories/${slug}/continuity?entity=${finding.entityIds[0]}` },
    });
  }

  for (const entity of bible.canonicalEntities) {
    if (hasActivePronunciation(entity.pronunciation) && entity.pronunciation?.needsReview) items.push({
      id: `pronunciation:${entity.id}`, kind: "pronunciation", entityIds: [entity.id],
      title: `Pronunciation review: ${entity.canonicalName}`,
      detail: "The active pronunciation configuration is marked for review.",
      severity: "warn", source: "pronunciation", lifecycle: "derived", status: "open",
      action: { label: "Open entity", href: entityHref(entity.id) },
    });
    if (context.pronunciationSuggestions[entity.id]) items.push({
      id: `pronunciation-suggestion:${entity.id}`, kind: "pronunciation", entityIds: [entity.id],
      title: `Pronunciation suggestion: ${entity.canonicalName}`,
      detail: "An AI pronunciation suggestion is awaiting an explicit decision; default provider pronunciation is in effect.",
      severity: "info", source: "pronunciation", lifecycle: "derived", status: "open",
      action: { label: "Review suggestion", href: entityHref(entity.id) },
    });
  }

  for (const [entityId, profile] of Object.entries(context.visualProfiles)) {
    const conflicts = (profile.conflicts ?? []).filter((conflict) => conflict.status === "needs_review");
    if (!conflicts.length) continue;
    items.push({
      id: `visual-profile:${entityId}`, kind: "visual-profile", entityIds: [entityId],
      title: `Visual Profile conflicts: ${nameOf(entityId)}`,
      detail: `${conflicts.length} field conflict${conflicts.length === 1 ? "" : "s"} between canonical text and visual canon need${conflicts.length === 1 ? "s" : ""} review.`,
      severity: "warn", source: "visual-canon", lifecycle: "derived", status: "open",
      action: { label: "Open entity", href: entityHref(entityId) },
    });
  }

  const staleExtractionChapters = await computeStaleExtractionChapters(root, slug);
  if (staleExtractionChapters.length) items.push({
    id: "stale-extraction", kind: "stale-extraction",
    title: `${staleExtractionChapters.length} chapter${staleExtractionChapters.length === 1 ? " has" : "s have"} stale Story Bible extraction`,
    detail: "Extraction output no longer matches the current source. Canonical records remain available; regeneration is never started automatically.",
    severity: "warn", chapters: staleExtractionChapters, source: "extraction", lifecycle: "derived", status: "open",
    action: { label: "Open cleanup", href: `/stories/${slug}/bible?tab=cleanup` },
  });

  const analysis = await analyzeStoryBible(root, slug);
  for (const recommendation of analysis.recommendations) {
    if (recommendation.recommendation === "keep_canonical") continue;
    items.push({
      id: `cleanup:${recommendation.id}`, kind: "cleanup", entityIds: [recommendation.entityId],
      title: `${recommendation.recommendation === "minor_reference" ? "Demote candidate" : recommendation.recommendation === "merge" ? "Merge candidate" : "Cleanup review"}: ${recommendation.canonicalName}`,
      detail: `${Math.round(recommendation.confidence * 100)}% confidence · ${recommendation.reason}${recommendation.protected ? ` Protected: ${recommendation.protectedReasons.join("; ")}` : ""}`,
      severity: recommendation.protected ? "info" : "warn",
      chapters: recommendation.supportingChapters, source: "analyzer", lifecycle: "derived", status: "open",
      action: { label: "Open cleanup", href: `/stories/${slug}/bible?tab=cleanup` },
    });
  }

  const openTotal = items.filter((item) => item.status === "open").length;
  const status = options.status ?? "open";
  const statusItems = status === "all" ? items : items.filter((item) => item.status === status);
  const counts: Record<string, number> = {};
  for (const item of statusItems) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  let filtered = statusItems;
  if (options.kind) filtered = filtered.filter((item) => item.kind === options.kind);
  if (options.entityId) filtered = filtered.filter((item) => item.entityIds?.includes(options.entityId!));
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize)));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(options.page)));
  return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, openTotal, page, pageSize, pages, counts };
}

export async function getMinorReferencesPage(
  root: string,
  slug: string,
  options: { page: number; pageSize: number; parentEntityId?: string; type?: string; query?: string },
) {
  const bible = await getStoryBible(root, slug);
  let refs = bible.minorReferences ?? [];
  if (options.parentEntityId) refs = refs.filter((item) => item.parentEntityId === options.parentEntityId);
  if (options.type && options.type !== "all") refs = refs.filter((item) => item.type === options.type);
  const query = options.query?.trim().toLowerCase();
  if (query) {
    refs = refs.filter((item) =>
      item.name.toLowerCase().includes(query) ||
      (item.originalName && item.originalName.toLowerCase().includes(query)) ||
      item.aliases.some((a) => a.toLowerCase().includes(query)),
    );
  }
  refs = [...refs].sort((a, b) => (b.lastSeenChapter ?? 0) - (a.lastSeenChapter ?? 0) || (b.occurrenceCount ?? 1) - (a.occurrenceCount ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize)));
  const pages = Math.max(1, Math.ceil(refs.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(options.page)));
  const parentNames = Object.fromEntries(bible.canonicalEntities.map((e) => [e.id, e.canonicalName]));
  return {
    items: refs.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
      ...r,
      parentEntityName: r.parentEntityId ? parentNames[r.parentEntityId] : undefined,
    })),
    page,
    pageSize,
    pages,
    total: refs.length,
    counts: Object.fromEntries(["location", "item", "character", "organization", "ability", "concept", "other"].map((type) => [type, (bible.minorReferences ?? []).filter((item) => item.type === type).length])),
  };
}

export async function getStoryBibleAnalysis(root: string, slug: string) {
  return analyzeStoryBible(root, slug);
}

export async function getContinuityReview(root: string, slug: string, status?: string) { const raw = await readJsonIfExists(storyPaths(root, slug, 1).continuityReview); const parsed = raw ? continuityReviewSchema.parse(raw) : continuityReviewSchema.parse({ version: 1, analyzedThroughChapter: 0, inputFingerprint: "none", updatedAt: new Date(0).toISOString(), findings: [] }); const bible = await getStoryBible(root, slug); const activeIds = new Set(bible.canonicalEntities.map((item) => item.id)); const activeFindings = parsed.findings.filter((item) => item.entityIds.every((id) => activeIds.has(id))); const findings = status && status !== "all" ? activeFindings.filter((item) => item.status === status) : activeFindings; const names = Object.fromEntries(bible.canonicalEntities.map((item) => [item.id, item.canonicalName])); const needsReanalysis = parsed.inputFingerprint !== fingerprint({ version: 1, entities: bible.canonicalEntities, timeline: bible.entityTimeline, relationships: bible.canonicalRelationships }); return { ...parsed, needsReanalysis, findings, names, counts: { open: activeFindings.filter((item) => item.status === "open").length, resolved: activeFindings.filter((item) => item.status !== "open").length } }; }

export async function getOutputsLibrary(root: string, slug: string) {
  slugSchema.parse(slug); const [audio, video] = await Promise.all([getAudioDashboard(root, slug), getVideoDashboard(root, slug)]); const items: Array<Record<string, unknown>> = [];
  for (const chapter of audio.chapters) if (chapter.audioAvailable) {
    const paths = storyPaths(root, slug, chapter.chapter);
    const audioPath = (await exists(paths.audio)) ? paths.audio : paths.audioRaw;
    items.push(await outputItem(audioPath, { id: `chapter-audio-${chapter.chapter}`, group: "chapterAudio", chapter: chapter.chapter, format: "mp3", url: `/api/stories/${slug}/chapters/${chapter.chapter}/audio`, downloadUrl: `/api/stories/${slug}/chapters/${chapter.chapter}/audio?download=1` }));
  }
  for (const item of audio.exports) items.push(await outputItem(exportPaths(root, slug, item.from, item.to, item.format).output, { id: `audiobook-${item.fingerprint}`, group: "audiobooks", from: item.from, to: item.to, format: item.format, createdAt: item.createdAt, durationSeconds: item.durationSeconds, url: item.downloadUrl, downloadUrl: item.downloadUrl }));
  for (const chapter of video.chapters) if (chapter.videoAvailable) items.push(await outputItem(storyPaths(root, slug, chapter.chapter).video, { id: `chapter-video-${chapter.chapter}`, group: "chapterVideos", chapter: chapter.chapter, format: "mp4", url: `/api/stories/${slug}/chapters/${chapter.chapter}/video`, downloadUrl: `/api/stories/${slug}/chapters/${chapter.chapter}/video?download=1` }));
  for (const item of video.exports) items.push(await outputItem(videoExportPaths(root, slug, item.from, item.to).output, { id: `video-${item.fingerprint}`, group: "combinedVideos", from: item.from, to: item.to, format: "mp4", createdAt: item.createdAt, durationSeconds: item.durationSeconds, url: item.downloadUrl, downloadUrl: item.downloadUrl }));
  for (const chapter of video.chapters) if (chapter.subtitleStatus === "complete") for (const format of ["srt", "vtt"] as const) items.push(await outputItem(format === "srt" ? storyPaths(root, slug, chapter.chapter).subtitlesSrt : storyPaths(root, slug, chapter.chapter).subtitlesVtt, { id: `subtitle-${format}-${chapter.chapter}`, group: "subtitles", chapter: chapter.chapter, format, url: `/api/stories/${slug}/chapters/${chapter.chapter}/subtitles.${format}`, downloadUrl: `/api/stories/${slug}/chapters/${chapter.chapter}/subtitles.${format}?download=1` }));
  for (const chapter of video.chapters) { const raw = await readJsonIfExists<SceneManifest>(storyPaths(root, slug, chapter.chapter).scenesManifest); const manifest = raw ? sceneManifestSchema.safeParse(raw) : undefined; if (!manifest?.success) continue; for (const scene of manifest.data.scenes) { const path = sceneImagePath(root, slug, chapter.chapter, scene.id); if (scene.artwork.status === "complete" && await exists(path)) items.push(await outputItem(path, { id: `artwork-${chapter.chapter}-${scene.id}`, group: "artwork", chapter: chapter.chapter, format: "png", url: `/api/stories/${slug}/chapters/${chapter.chapter}/scenes/${scene.id}.png` })); } }
  return { items: items.filter((item) => !item.missing) };
}

async function outputItem(path: string, value: Record<string, unknown>) { try { const info = await stat(path); return { ...value, bytes: info.size, createdAt: value.createdAt ?? info.mtime.toISOString() }; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...value, bytes: 0, missing: true }; throw error; } }

export const settingsUpdateSchema = z.object({
  title: z.string().trim().min(1), author: z.string().trim().optional(), description: z.string().max(10_000).default(""), tags: z.array(z.string()).max(30).default([]), notes: z.string().max(20_000).default(""), sourceLanguage: z.string().trim().min(2), outputLanguage: z.string().trim().min(2),
  recentChapterSummaries: z.number().int().min(0).max(100),
  qaMode: z.enum(["production", "thorough"]).optional(),
  narrationSettings: z.object({ profanityMode: z.enum(["preserve", "soften-strong"]), bleepStrongProfanity: z.boolean().default(false), includeChapterTitle: z.boolean().optional(), speechNormalization: z.enum(["automatic", "enabled", "disabled"]).default("automatic"), timeSpeechMode: z.enum(["natural_12h", "natural_24h", "preserve"]).default("natural_12h"), speechAbbreviations: z.record(z.string().trim().regex(/^[A-Za-z][A-Za-z0-9-]{0,29}$/), z.string().trim().min(1).max(120)).default({}), speechVocalizations: z.object({ mode: z.enum(["automatic", "preserve", "disabled"]).default("automatic"), fallback: z.enum(["safe_normalize", "omit_unsupported", "preserve"]).default("safe_normalize") }).default({ mode: "automatic", fallback: "safe_normalize" }) }).optional(),
  translation: z.object({ provider: z.enum(["openai", "gemini", "kimi"]), model: z.string().trim().min(1) }),
  narration: z.object({ provider: z.enum(["openai", "gemini", "kimi"]), model: z.string().trim().min(1) }),
  qa: z.object({ provider: z.enum(["openai", "gemini", "kimi"]), model: z.string().trim().min(1) }),
  storyBible: z.object({ provider: z.enum(["openai", "gemini", "kimi"]), model: z.string().trim().min(1) }).optional(),
  scenePlanner: z.object({ provider: z.enum(["openai", "gemini", "kimi"]), model: z.string().trim().min(1) }).optional(),
  pipelineOverrides: z.record(z.string(), z.boolean()).optional(),
  tts: z.object({ provider: ttsProviderNameSchema.optional(), model: z.string().trim().min(1).optional(), referenceId: z.string().trim().optional(), secondaryReferenceId: z.string().trim().optional(),
    voiceMode: z.enum(["narrator-only", "same-voice-dialogue", "narrator-dialogue"]).optional(), deliveryIntensity: z.enum(["none", "restrained", "expressive"]).optional(), qualityGuard: z.boolean().optional(), providerQualityGuard: z.boolean().optional(), speed: z.number().min(0.5).max(2),
    maxCharsPerRequest: z.number().int().min(500).max(20_000).optional(), maxQualityRetries: z.number().int().min(0).max(5).optional(), normalize: z.boolean().optional() }),
  audio: z.object({ loudnessTarget: z.number().min(-24).max(-12), truePeak: z.number().min(-6).max(-0.1), segmentGapSeconds: z.number().min(0).max(5),
    chapterGapSeconds: z.number().min(0).max(10), bitrate: z.enum(["64k", "96k", "128k", "160k", "192k", "256k", "320k"]), sampleRate: z.union([z.literal(32000), z.literal(44100), z.literal(48000)]) }).optional(),
  subtitles: z.object({ maxCharactersPerLine: z.number().int().min(20).max(80), maxLines: z.number().int().min(1).max(3), minimumDurationSeconds: z.number().min(.4).max(5), maximumDurationSeconds: z.number().min(2).max(12) }).optional(),
  video: z.object({ width: z.number().int().min(640).max(3840), height: z.number().int().min(360).max(2160), fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]), codec: z.literal("libx264"), quality: z.number().int().min(0).max(40), subtitleMode: z.enum(["none", "burn", "soft", "both"]), subtitleStyle: z.enum(["default", "large", "minimal"]), backgroundMode: z.enum(["cover", "gradient", "kenBurns"]), introDurationSeconds: z.number().min(0).max(10), resolution: videoResolutionSchema.optional() }).optional(),
  scenes: sceneSettingsSchema.optional(), artwork: artworkSettingsSchema.optional(),
}).strict();

export async function updateStorySettings(root: string, slug: string, input: unknown): Promise<Story> {
  slugSchema.parse(slug); const update = settingsUpdateSchema.parse(input); const paths = storyPaths(root, slug, 1);
  return withStoryLock(root, slug, "web settings update", async () => {
    const current = await loadStory(paths.storyConfig);
    const artwork = { ...current.artwork, ...update.artwork };
    if (!imageModelCompatible(artwork.provider, artwork.model)) artwork.model = defaultImageModel(artwork.provider);
    const story = storySchema.parse({ ...current, title: update.title, author: update.author || undefined, description: update.description, tags: update.tags, notes: update.notes, sourceLanguage: update.sourceLanguage, outputLanguage: update.outputLanguage,
      context: { ...current.context, recentChapterSummaries: update.recentChapterSummaries },
      qaMode: update.qaMode ?? current.qaMode,
      narrationSettings: update.narrationSettings ?? current.narrationSettings,
      audio: { ...current.audio, ...update.audio }, subtitles: { ...current.subtitles, ...update.subtitles }, video: { ...current.video, ...update.video }, scenes: { ...current.scenes, ...update.scenes }, artwork,
      pipeline: {
        ...current.pipeline,
        translation: update.translation,
        narration: update.narration,
        qa: update.qa,
        storyBible: update.storyBible ?? current.pipeline.storyBible,
        scenePlanner: update.scenePlanner ?? current.pipeline.scenePlanner,
        tts: {
          ...current.pipeline.tts,
          provider: update.tts.provider ?? current.pipeline.tts.provider,
          model: update.tts.model ?? current.pipeline.tts.model,
          referenceId: update.tts.referenceId || undefined,
          secondaryReferenceId: update.tts.secondaryReferenceId || undefined,
          voiceMode: update.tts.voiceMode ?? current.pipeline.tts.voiceMode,
          deliveryIntensity: update.tts.deliveryIntensity ?? current.pipeline.tts.deliveryIntensity,
          qualityGuard: update.tts.qualityGuard ?? current.pipeline.tts.qualityGuard,
          providerQualityGuard: update.tts.providerQualityGuard ?? current.pipeline.tts.providerQualityGuard,
          speed: update.tts.speed,
          maxCharsPerRequest: update.tts.maxCharsPerRequest ?? current.pipeline.tts.maxCharsPerRequest,
          maxQualityRetries: update.tts.maxQualityRetries ?? current.pipeline.tts.maxQualityRetries,
          normalize: update.tts.normalize ?? current.pipeline.tts.normalize,
        },
      },
      pipelineOverrides: { ...(current.pipelineOverrides ?? {}), ...(update.pipelineOverrides ?? {}) },
    });
    await invalidateStoryForConfigChange(root, slug, current, story); await atomicWriteJson(paths.storyConfig, story); await atomicWriteJson(paths.pipelineConfig, story.pipeline); return story;
  });
}

export async function loadChapterSummaries(root: string, slug: string): Promise<ChapterSummary[]> {
  const index = await loadChapterIndex(root, slug); return loadSummaries(root, slug, index.numbers, index);
}

function countQa(chapters: ChapterSummary[]) {
  return { pass: chapters.filter((item) => item.qa === "pass").length, warn: chapters.filter((item) => item.qa === "warn").length, fail: chapters.filter((item) => item.qa === "fail").length };
}

type ChapterIndex = { numbers: number[]; titles: Map<number, string | undefined>; manifest?: SourceManifest; manifestByChapter: Map<number, SourceManifest["chapters"][number]> };

async function loadChapterIndex(root: string, slug: string): Promise<ChapterIndex> {
  const paths = storyPaths(root, slug, 1); const manifestRaw = await readJsonIfExists(paths.sourceManifest);
  const parsed = manifestRaw ? sourceManifestSchema.safeParse(manifestRaw) : undefined;
  const manifest = parsed?.success ? parsed.data : undefined; const numbers = new Set<number>(); const titles = new Map<number, string | undefined>();
  if (manifest) for (const item of manifest.chapters) { numbers.add(item.chapter); titles.set(item.chapter, item.ref.originalTitle); }
  else {
    try { for (const entry of await readdir(join(paths.story, "chapters"), { withFileTypes: true })) if (entry.isDirectory() && /^\d+$/.test(entry.name)) numbers.add(Number(entry.name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { numbers: [...numbers].sort((a, b) => a - b), titles, manifest, manifestByChapter: new Map(manifest?.chapters.map((item) => [item.chapter, item]) ?? []) };
}

async function loadSummaries(root: string, slug: string, numbers: number[], index: ChapterIndex): Promise<ChapterSummary[]> {
  const story = await loadStory(storyPaths(root, slug, 1).storyConfig).catch(() => undefined);
  const qaDeterministicDeps = story ? await loadQaDeterministicDependencies(root, slug) : undefined;
  return mapLimit(numbers, 16, async (chapter) => {
    const chapterPaths = storyPaths(root, slug, chapter); const raw = await readJsonIfExists<Chapter>(chapterPaths.chapterMeta); const parsed = raw ? chapterSchema.safeParse(raw) : undefined;
    const metadata = parsed?.success ? parsed.data : undefined; const fresh = isCurrent(metadata, index.manifestByChapter.get(chapter), Boolean(index.manifest));
    const qaRaw = await readJsonIfExists<QaResult>(chapterPaths.qa);
    const qaParsed = qaRaw ? qaStateSchema.safeParse(qaRaw) : undefined;
    const qa = qaParsed?.success ? migrateQaState(qaParsed.data, { chapter }) : undefined;
    // Issue lists are open findings only: resolved (fixed/dismissed) and
    // obsolete findings keep their evidence in qa.json but never count here.
    const qaIssues: QaResult["issues"] | undefined = qa ? openFindings(qa).map(({ category, severity, message, evidence }) => ({ category, severity, message, evidence })) : undefined;
    // Authoritative QA freshness: the recorded dependency fingerprint must
    // match the current effective one; anything else needs a recheck.
    const qaFreshness = story && qa ? await deriveChapterQaFreshness(root, story, chapter, metadata?.stages.qa, qaDeterministicDeps) : undefined;
    const qaStats = qa ? qaFindingStats(qa, qaFreshness?.currentFingerprint) : undefined;
    const qaStage = metadata?.stages.qa.status ?? "pending";
    const tts = fresh ? metadata?.stages.tts.status ?? "pending" : "pending";
    const audioMastering = fresh ? metadata?.stages.audioMastering.status ?? "pending" : "pending"; const continuity = fresh ? metadata?.stages.continuity.status ?? "pending" : "pending"; const alignment = fresh ? metadata?.stages.alignment.status ?? "pending" : "pending"; const subtitles = fresh ? metadata?.stages.subtitles.status ?? "pending" : "pending"; const scenePlanning = fresh ? metadata?.stages.scenePlanning.status ?? "pending" : "pending"; const artwork = fresh ? metadata?.stages.artwork.status ?? "pending" : "pending"; const video = fresh ? metadata?.stages.video.status ?? "pending" : "pending";
    const [audioFileExists, rawAudioFileExists, translationFileExists, narrationFileExists, videoFileExists, subtitleFileExists] = await Promise.all([exists(chapterPaths.audio), exists(chapterPaths.audioRaw), exists(chapterPaths.english), exists(chapterPaths.narration), exists(chapterPaths.video), exists(chapterPaths.subtitlesSrt)]);
    const audioAvailable = audioFileExists || rawAudioFileExists;
    const audioStale = audioAvailable && (audioMastering !== "complete" || !audioFileExists);
    const videoStale = videoFileExists && video !== "complete";
    const translationStatus = fresh && metadata?.stages.translation.status === "complete" ? "complete" : translationFileExists ? "stale" : "pending";
    const narrationStatus = fresh && metadata?.stages.narration.status === "complete" ? "complete" : narrationFileExists ? "stale" : "pending";
    const audioMasteringStatus = fresh && metadata?.stages.audioMastering.status === "complete" ? "complete" : audioAvailable ? "stale" : metadata?.stages.audioMastering.status ?? "pending";
    const videoStatus = fresh && metadata?.stages.video.status === "complete" ? "complete" : videoFileExists ? "stale" : metadata?.stages.video.status ?? "pending";
    return { chapter, originalTitle: metadata?.originalTitle ?? index.titles.get(chapter), translation: translationStatus,
      narration: narrationStatus, qa: qa?.status,
      qaScore: qa?.score, qaIssues, qaStale: Boolean(qa) && (qaFreshness ? qaFreshness.freshness !== "current" : !fresh || metadata?.stages.qa.status !== "complete"), qaNeedsVerification: qaStats?.needsVerification, qaStage, tts, audioMastering: audioMasteringStatus, continuity, alignment, subtitles, subtitlesAvailable: subtitleFileExists, subtitlesStale: subtitleFileExists && (!fresh || subtitles !== "complete"), scenePlanning, artwork, video: videoStatus,
      durationSeconds: audioAvailable ? metadata?.audio?.durationSeconds : undefined,
      audioAvailable, audioStale, videoAvailable: videoFileExists, videoStale };
  });
}

export async function getAudioDashboard(root: string, slug: string) {
  slugSchema.parse(slug); const story = await loadStory(storyPaths(root, slug, 1).storyConfig); const chapters = await loadChapterSummaries(root, slug);
  const exportsDirectory = join(storyPaths(root, slug, 1).story, "exports"); let names: string[] = [];
  try { names = (await readdir(exportsDirectory)).filter((name) => isVisibleManifest(name, ".json")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const exports = (await mapLimit(names, 8, async (name) => {
    const path = join(exportsDirectory, name);
    // An interrupted external tool or a manually copied media file can leave a
    // binary/non-JSON file with a manifest extension. One bad export must not
    // prevent the Audio workspace from listing every healthy chapter and export.
    const raw = await readJsonIfExists(path).catch((error) => {
      logger.warn({ event: "audio.export_manifest_ignored", story: slug, manifest: name, error: error instanceof Error ? error.message : String(error) }, "Ignoring unreadable audiobook export manifest");
      return undefined;
    });
    const parsed = raw ? exportManifestSchema.safeParse(raw) : undefined;
    if (!parsed?.success || parsed.data.story !== slug || !(await intactAudioExport(root, slug, parsed.data))) return undefined;
    const { output: _output, ...manifest } = parsed.data;
    return { ...manifest, downloadUrl: `/api/stories/${slug}/exports/${parsed.data.from}-${parsed.data.to}.${parsed.data.format}` };
  }))
    .filter((item): item is NonNullable<typeof item> => Boolean(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const unprobed = chapters.filter((item) => item.audioAvailable && !item.durationSeconds);
  if (unprobed.length > 0) {
    const tools = new FfmpegTools();
    await mapLimit(unprobed, 4, async (item) => {
      try {
        const paths = storyPaths(root, slug, item.chapter);
        const filePath = (await exists(paths.audio)) ? paths.audio : paths.audioRaw;
        const probe = await tools.probe(filePath);
        item.durationSeconds = probe.durationSeconds;
        const raw = await readJsonIfExists<Chapter>(paths.chapterMeta);
        if (raw) {
          const meta = chapterSchema.parse(raw);
          meta.audio = probe;
          await atomicWriteJson(paths.chapterMeta, meta).catch(() => {});
        }
      } catch {
        // ignore probe failure for dashboard listing
      }
    });
  }
  const available = chapters.filter((item) => item.audioAvailable);
  const current = available.filter((item) => !item.audioStale);
  return { settings: story.audio, chapters: chapters.map(({ chapter, originalTitle, audioMastering, durationSeconds, audioAvailable, audioStale }) => ({ chapter, title: originalTitle, status: audioStale ? "stale" : audioMastering, durationSeconds, audioAvailable, audioStale })),
    counts: { total: chapters.length, mastered: available.length, current: current.length, stale: available.length - current.length },
    totalDurationSeconds: available.reduce((sum, item) => sum + (item.durationSeconds ?? 0), 0) + story.audio.chapterGapSeconds * Math.max(0, available.filter((item) => (item.durationSeconds ?? 0) > 0).length - 1), exports };
}

export async function getVideoDashboard(root: string, slug: string) {
  slugSchema.parse(slug); const story = await loadStory(storyPaths(root, slug, 1).storyConfig); const chapters = await loadChapterSummaries(root, slug); const storyRoot = storyPaths(root, slug, 1).story;
  const cover = (await Promise.all(["cover.jpg", "cover.jpeg", "cover.png"].map(async (name) => await exists(join(storyRoot, name)) ? name : undefined))).find(Boolean); let names: string[] = [];
  try { names = (await readdir(join(storyRoot, "exports"))).filter((name) => isVisibleManifest(name, ".mp4.json")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const exports = (await mapLimit(names, 8, async (name) => { const raw = await readJsonIfExists(join(storyRoot, "exports", name)).catch((error) => { logger.warn({ event: "video.export_manifest_ignored", story: slug, manifest: name, error: error instanceof Error ? error.message : String(error) }, "Ignoring unreadable video export manifest"); return undefined; }); const parsed = raw ? videoExportManifestSchema.safeParse(raw) : undefined; if (!parsed?.success || parsed.data.story !== slug || !(await currentVideoExport(root, slug, parsed.data))) return undefined; const { output: _output, ...manifest } = parsed.data; return { ...manifest, downloadUrl: `/api/stories/${slug}/video-exports/${parsed.data.from}-${parsed.data.to}.mp4` }; })).filter((item): item is NonNullable<typeof item> => Boolean(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { settings: story.video, subtitleSettings: story.subtitles, background: { coverAvailable: Boolean(cover), coverName: cover, effectiveMode: story.video.backgroundMode === "gradient" || !cover ? "fallback" : story.video.backgroundMode }, counts: { total: chapters.length, mastered: chapters.filter((item) => item.audioAvailable || item.audioMastering === "complete").length, subtitles: chapters.filter((item) => item.subtitles === "complete").length, videos: chapters.filter((item) => item.video === "complete").length }, chapters: chapters.map((item) => ({ chapter: item.chapter, title: item.originalTitle, durationSeconds: item.durationSeconds, subtitleStatus: item.subtitles, videoStatus: item.video, videoAvailable: item.videoAvailable })), exports };
}

export async function getVisualProfiles(root: string, slug: string) {
  slugSchema.parse(slug);
  const profiles = await loadVisualProfiles(root, slug);
  return Object.values(profiles);
}

export async function getVisualProfile(root: string, slug: string, entityId: string) {
  slugSchema.parse(slug);
  return await loadSingleVisualProfile(root, slug, entityId);
}

export async function getArtDirection(root: string, slug: string) {
  slugSchema.parse(slug);
  return await loadStoryArtDirection(root, slug);
}

export async function getScenesDashboard(root: string, slug: string, selectedChapter?: number) {
  slugSchema.parse(slug);
  const story = await loadStory(storyPaths(root, slug, 1).storyConfig);
  const chapters = await loadChapterSummaries(root, slug);
  const chapterNumber = selectedChapter ?? chapters[0]?.chapter;
  if (chapterNumber !== undefined && !chapters.some((item) => item.chapter === chapterNumber))
    throw new Error(`Chapter ${chapterNumber} was not found`);
  const env = loadEnvironment();
  const globalDefaults = await loadGlobalSettings(root, env).catch(() => undefined);
  const scenePlannerRouting = resolveModelRouting({
    stage: "scenePlanner",
    story,
    globalSettings: globalDefaults,
    env,
    requiredCapability: "structured_output",
  });
  const artDirection = await loadStoryArtDirection(root, slug);
  const visualProfiles = await loadVisualProfiles(root, slug);

  let manifest:
    | (Omit<SceneManifest, "scenes"> & {
        scenes: Array<
          Omit<SceneManifest["scenes"][number], "artwork"> & {
            imageUrl?: string;
            continuity?: {
              startState: ResolvedSceneContinuity["startState"];
              changes?: ResolvedSceneContinuity["changes"];
              endState: ResolvedSceneContinuity["endState"];
              referenceDecision?: ResolvedSceneContinuity["referenceDecision"];
              manualOverride?: ResolvedSceneContinuity["manualOverride"];
            };
            artwork: Omit<SceneManifest["scenes"][number]["artwork"], "versions"> & {
              versions: Array<
                Omit<SceneManifest["scenes"][number]["artwork"]["versions"][number], "original"> & {
                  imageUrl?: string;
                  original?: { width: number; height: number };
                  production?: { width: number; height: number; upscaled: boolean; engine?: string };
                }
              >;
            };
          }
        >;
      })
    | undefined;

  let previousHandoff:
    | { chapter: number; sceneId: string; stateFingerprint: string; hasApprovedArtwork: boolean; usedAsReference: boolean; origin: string }
    | undefined;

  if (chapterNumber !== undefined) {
    const raw = await readJsonIfExists<SceneManifest>(storyPaths(root, slug, chapterNumber).scenesManifest);
    const parsed = raw ? sceneManifestSchema.safeParse(raw) : undefined;
    if (parsed?.success) {
      const bible = await getStoryBible(root, slug).catch(() => undefined);
      // Recompute-on-read visual continuity for the loaded chapter (bounded:
      // manifest deltas + previous handoff + manual overlay).
      const continuity = await resolveChapterVisualContinuity({
        root,
        slug,
        chapter: chapterNumber,
        manifest: parsed.data,
        contentFingerprints: Object.fromEntries(parsed.data.scenes.map((scene) => [scene.id, sceneContentFingerprint(scene)])),
      });
      const continuityByScene = new Map(continuity.resolved.perScene.map((entry) => [entry.sceneId, entry]));
      const scenes = await mapLimit(parsed.data.scenes, 8, async (scene) => {
        const hasMain =
          scene.artwork.status === "complete" &&
          (await exists(sceneImagePath(root, slug, chapterNumber, scene.id)));
        const versions = await mapLimit(scene.artwork.versions ?? [], 8, async (v) => {
          const vPath = sceneVersionImagePath(root, slug, chapterNumber, scene.id, v.versionNumber);
          const vExists = await exists(vPath);
          return {
            ...v,
            original: v.original ? { width: v.original.width, height: v.original.height } : undefined,
            production:
              v.upscale?.status === "applied" && v.upscale.finalDimensions
                ? { width: v.upscale.finalDimensions.width, height: v.upscale.finalDimensions.height, upscaled: true, engine: v.upscale.engine }
                : v.original
                  ? { width: v.original.width, height: v.original.height, upscaled: false }
                  : undefined,
            imageUrl:
              vExists || hasMain
                ? `/api/stories/${slug}/chapters/${chapterNumber}/scenes/${scene.id}/versions/${v.id}.png`
                : undefined,
          };
        });
        const resolvedCharacters = (scene.characters ?? []).map((charName) =>
          resolveSceneVisualEntity(charName, bible?.canonicalEntities ?? [], visualProfiles)
        );
        const continuityEntry = continuityByScene.get(scene.id);
        return {
          ...scene,
          contentFingerprint: sceneContentFingerprint(scene),
          resolvedCharacters,
          imageUrl: hasMain
            ? `/api/stories/${slug}/chapters/${chapterNumber}/scenes/${scene.id}.png`
            : undefined,
          continuity: continuityEntry
            ? {
                startState: continuityEntry.startState,
                changes: continuityEntry.changes,
                endState: continuityEntry.endState,
                referenceDecision: continuityEntry.referenceDecision,
                manualOverride: continuityEntry.manualOverride,
              }
            : undefined,
          artwork: {
            ...scene.artwork,
            versions,
          },
        };
      });
      if (continuity.previous) {
        const firstDecision = continuity.resolved.perScene[0]?.referenceDecision;
        previousHandoff = {
          chapter: continuity.previous.chapter,
          sceneId: continuity.previous.sceneId,
          stateFingerprint: continuity.previous.stateFingerprint,
          hasApprovedArtwork: Boolean(continuity.previous.referenceArtwork),
          usedAsReference: firstDecision?.kind === "previous-chapter" && firstDecision.used,
          origin: continuity.previous.origin,
        };
      }
      manifest = { ...parsed.data, scenes };
    }
  }

  return {
    settings: story.scenes,
    artwork: story.artwork,
    artworkRouting: {
      provider: story.artwork.provider,
      model: story.artwork.model,
      availableProviders: Object.entries(IMAGE_PROVIDER_CATALOG).map(([name, entry]) => ({
        name,
        models: entry.models,
        defaultModel: entry.defaultModel,
      })),
    },
    resolvedBehavior: resolvedArtworkBehavior(story),
    planner: story.pipeline.scenePlanner,
    scenePlannerRouting,
    selectedChapter: chapterNumber,
    videoSubtitleMode: story.video.subtitleMode,
    chapters: chapters.map((item) => ({
      chapter: item.chapter,
      title: item.originalTitle,
      durationSeconds: item.durationSeconds,
      audioMastering: item.audioMastering,
      audioAvailable: item.audioAvailable,
      audioStale: item.audioStale,
      subtitleStatus: item.subtitles,
      subtitlesAvailable: item.subtitlesAvailable,
      subtitlesStale: item.subtitlesStale,
      videoStatus: item.video,
      videoAvailable: item.videoAvailable,
      videoStale: item.videoStale,
      sceneStatus: item.scenePlanning,
      artworkStatus: item.artwork,
    })),
    counts: {
      chapters: chapters.length,
      planned: chapters.filter((item) => item.scenePlanning === "complete").length,
      artworkReady: chapters.filter((item) => item.artwork === "complete").length,
    },
    manifest,
    previousHandoff,
    artDirection,
    visualProfiles: Object.values(visualProfiles),
  };
}

/** Pre-generation resolution behavior estimate, derived only from catalog
 * native tiers for the current provider/model/aspect — never a promise of
 * exact dimensions before generation. */
function resolvedArtworkBehavior(story: Story) {
  const settings = story.artwork;
  const target = resolveTargetDimensions(settings.outputResolution, settings.aspectRatio);
  const estimate = estimateNativeDimensions(
    imageNativeTiers(settings.provider, settings.aspectRatio, settings.model),
    qualityTierIndex(settings.quality)
  );
  const nativeEstimate = estimate ? `${estimate.width}x${estimate.height} (${estimate.label})` : undefined;
  if (settings.upscaling === "off") return { nativeEstimate, target, upscaling: "off" as const };
  if (!target || !estimate) return { nativeEstimate, target, upscaling: "unknown" as const };
  const plan = planResolution({
    requested: settings.outputResolution,
    aspectRatio: settings.aspectRatio,
    upscaling: settings.upscaling,
    nativeEstimate: estimate,
  });
  return { nativeEstimate, target, upscaling: plan.upscaleRequired ? ("required" as const) : ("not-required" as const) };
}

export function publicProductionManifest(manifest: ProductionManifest, slug: string): ProductionManifest {
  const exports: Record<string, string> = {};
  if (manifest.summary.exports.audiobook) exports.audiobook = `/api/stories/${slug}/exports/${manifest.selection.from}-${manifest.selection.to}.${manifest.options.audiobookFormat}`;
  if (manifest.summary.exports.video) exports.video = `/api/stories/${slug}/video-exports/${manifest.selection.from}-${manifest.selection.to}.mp4`;
  return { ...manifest, summary: { ...manifest.summary, exports } };
}

async function intactAudioExport(root: string, slug: string, manifest: z.infer<typeof exportManifestSchema>) {
  // An audiobook is a standalone retained artifact. Source chapters becoming
  // stale should invite a rebuild, but must not hide an intact existing export.
  return await fileFingerprint(exportPaths(root, slug, manifest.from, manifest.to, manifest.format).output) === manifest.outputFingerprint;
}

async function currentVideoExport(root: string, slug: string, manifest: z.infer<typeof videoExportManifestSchema>) {
  if (await fileFingerprint(videoExportPaths(root, slug, manifest.from, manifest.to).output) !== manifest.outputFingerprint) return false;
  for (const chapter of manifest.chapters) { const paths = storyPaths(root, slug, chapter.chapter); const raw = await readJsonIfExists<Chapter>(paths.chapterMeta); const parsed = raw ? chapterSchema.safeParse(raw) : undefined; if (!parsed?.success || parsed.data.stages.video.status !== "complete" || await fileFingerprint(paths.video) !== chapter.fingerprint) return false; }
  return true;
}

async function cachedStorageUsage(root: string, slug: string) {
  const key = `${root}\0${slug}`; const cached = storageCache.get(key); if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await getStorageUsage(root, slug); storageCache.set(key, { value, expiresAt: Date.now() + 5_000 }); return value;
}

async function currentExportBadges(root: string, slug: string, names: string[], chapters: ChapterSummary[]) {
  const byChapter = new Map(chapters.map((chapter) => [chapter.chapter, chapter])); let audio = false; let video = false; const directory = join(storyPaths(root, slug, 1).story, "exports");
  for (const name of names.filter((item) => isVisibleManifest(item, ".json"))) {
    const raw = await readJsonIfExists(join(directory, name)).catch((error) => { logger.warn({ event: "library.export_manifest_ignored", story: slug, manifest: name, error: error instanceof Error ? error.message : String(error) }, "Ignoring unreadable export manifest while building the story card"); return undefined; }); const audioManifest = raw ? exportManifestSchema.safeParse(raw) : undefined;
    if (audioManifest?.success && audioManifest.data.story === slug && await intactAudioExport(root, slug, audioManifest.data)) audio = true;
    const videoManifest = raw ? videoExportManifestSchema.safeParse(raw) : undefined;
    if (videoManifest?.success && videoManifest.data.story === slug && videoManifest.data.chapters.every((item) => byChapter.get(item.chapter)?.video === "complete") && await exists(videoExportPaths(root, slug, videoManifest.data.from, videoManifest.data.to).output)) video = true;
    if (audio && video) break;
  }
  return { audio, video };
}

// macOS writes AppleDouble resource-fork sidecars (._name) on non-Apple
// volumes. They mirror the real filename but contain binary Finder metadata,
// so they must never participate in application manifest discovery.
function isVisibleManifest(name: string, suffix: string) { return !name.startsWith(".") && name.endsWith(suffix); }

function isCurrent(metadata: Chapter | undefined, source: SourceManifest["chapters"][number] | undefined, hasManifest: boolean) {
  // Pipeline metadata records the materialized text fingerprint supplied by
  // loadImportedChapters. The manifest's broader fingerprint also contains
  // mutable source-reference metadata, so comparing against it makes a freshly
  // processed chapter look stale even when its text is exactly current.
  const sourceFingerprint = source?.contentFingerprint ?? source?.fingerprint;
  return !hasManifest || Boolean(metadata?.source?.fingerprint && sourceFingerprint && metadata.source.fingerprint === sourceFingerprint);
}

export async function mapLimit<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length); let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) { const index = next++; result[index] = await mapper(values[index]!); }
  });
  await Promise.all(workers); return result;
}
