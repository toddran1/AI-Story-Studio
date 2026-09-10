import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Chapter, chapterSchema } from "../../src/domain/chapter.js";
import { QaResult, qaResultSchema } from "../../src/domain/qa.js";
import { Story, storySchema } from "../../src/domain/story.js";
import { StoryBible, emptyStoryBible, storyBibleSchema } from "../../src/domain/story-bible.js";
import { SourceManifest, sourceManifestSchema } from "../../src/source/types.js";
import { atomicWriteJson } from "../../src/storage/atomic-write.js";
import { exportPaths, sceneImagePath, storyPaths, videoExportPaths } from "../../src/storage/paths.js";
import { exists, readJsonIfExists, readTextIfExists } from "../../src/storage/story-files.js";
import { withStoryLock } from "../../src/storage/story-lock.js";
import { loadStory } from "../../src/config/load-config.js";
import { rebuildStoryBibleBeforeChapter } from "../../src/story-bible/rebuild.js";
import { exportManifestSchema } from "../../src/audio/audiobook.js";
import { videoExportManifestSchema } from "../../src/video/video-export.js";
import { SceneManifest, artworkSettingsSchema, sceneManifestSchema, sceneSettingsSchema } from "../../src/scenes/types.js";
import { loadLatestProduction } from "../../src/production/manifest.js";
import { ProductionManifest } from "../../src/production/types.js";
import { applyManualBibleOverlay } from "../../src/studio/workflow.js";
import { getStorageUsage, invalidateStoryForConfigChange, readActivity } from "../../src/studio/projects.js";
import { fingerprint } from "../../src/utils/hash.js";
import { logger } from "../../src/utils/logger.js";

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const chapterFilterSchema = z.enum(["all", "unprocessed", "warn", "fail", "complete"]);
const storageCache = new Map<string, { value: Awaited<ReturnType<typeof getStorageUsage>>; expiresAt: number }>();
const storyCardCache = new Map<string, { value: any; expiresAt: number }>();

export function invalidateCatalogCache(root: string, slug: string) { const key = `${root}\0${slug}`; storyCardCache.delete(key); storageCache.delete(key); }

export type ChapterSummary = {
  chapter: number; originalTitle?: string; translation: string; narration: string; qa?: QaResult["status"];
  qaScore?: number; qaIssues?: QaResult["issues"]; tts: string; audioMastering: string; subtitles: string; scenePlanning: string; artwork: string; video: string; audioAvailable: boolean; videoAvailable: boolean; durationSeconds?: number;
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
      const chapters = await loadChapterSummaries(root, slug); const processed = chapters.filter((item) => item.audioMastering === "complete");
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
  return { story, counts: { chapters: chapters.length, minChapter: chapters[0]?.chapter, maxChapter: chapters.at(-1)?.chapter,
    ...countQa(chapters), complete: chapters.filter((item) => item.audioMastering === "complete").length } };
}

export async function getStoryDashboard(root: string, slug: string) {
  slugSchema.parse(slug); const overview = await getStoryOverview(root, slug); const chapters = await loadChapterSummaries(root, slug); const latest = await loadLatestProduction(root, slug); const sourceRaw = await readJsonIfExists<SourceManifest>(storyPaths(root, slug, 1).sourceManifest); const source = sourceRaw ? sourceManifestSchema.safeParse(sourceRaw) : undefined;
  const completedStages = chapters.reduce((sum, chapter) => sum + [chapter.translation, chapter.narration, chapter.tts, chapter.audioMastering, chapter.subtitles, chapter.scenePlanning, chapter.artwork, chapter.video].filter((status) => status === "complete").length, 0);
  const current = latest?.story === slug && latest.storyFingerprint === fingerprint(overview.story) ? publicProductionManifest(latest, slug) : undefined;
  return { ...overview, source: source?.success ? { type: source.data.type, origin: "url" in source.data.origin ? { url: source.data.origin.url } : { name: source.data.origin.name }, importedAt: source.data.importedAt, chapterCount: source.data.chapters.length } : undefined, progress: { processed: chapters.filter((item) => item.translation === "complete").length, audio: chapters.filter((item) => item.audioMastering === "complete").length, artwork: chapters.filter((item) => item.artwork === "complete").length, video: chapters.filter((item) => item.video === "complete").length }, latestProduction: current, currentProfile: current?.options.profile, estimatedRemainingStages: chapters.length * 8 - completedStages };
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
  else if (options.filter === "complete") chapters = chapters.filter((item) => item.audioMastering === "complete");
  const total = chapters.length; const pages = Math.max(1, Math.ceil(total / pageSize)); const safePage = Math.min(page, pages);
  return { items: chapters.slice((safePage - 1) * pageSize, safePage * pageSize), page: safePage, pageSize, total, pages };
}

export async function getChapter(root: string, slug: string, chapter: number) {
  slugSchema.parse(slug); if (!Number.isSafeInteger(chapter) || chapter < 1) throw new Error("Chapter must be a positive integer");
  const paths = storyPaths(root, slug, chapter); const metadataRaw = await readJsonIfExists<Chapter>(paths.chapterMeta);
  const metadata = metadataRaw ? chapterSchema.parse(metadataRaw) : undefined; const index = await loadChapterIndex(root, slug);
  if (index.manifest && !index.manifestByChapter.has(chapter)) throw new Error(`Chapter ${chapter} was not found`);
  const fresh = isCurrent(metadata, index.manifestByChapter.get(chapter), Boolean(index.manifest));
  const qaRaw = fresh && metadata?.stages.qa.status === "complete" ? await readJsonIfExists<QaResult>(paths.qa) : undefined;
  const audioAvailable = fresh && metadata?.stages.audioMastering.status === "complete" && await exists(paths.audio);
  return {
    chapter, metadata, stale: !fresh, original: fresh ? await readTextIfExists(paths.original) : undefined,
    translation: fresh ? await readTextIfExists(paths.english) : undefined, narration: fresh ? await readTextIfExists(paths.narration) : undefined,
    qa: qaRaw ? qaResultSchema.parse(qaRaw) : undefined, audioAvailable,
    audioUrl: audioAvailable ? `/api/stories/${slug}/chapters/${chapter}/audio` : undefined,
    subtitles: fresh && metadata?.stages.subtitles.status === "complete" ? await readTextIfExists(paths.subtitlesVtt) : undefined,
    subtitlesUrl: fresh && metadata?.stages.subtitles.status === "complete" ? `/api/stories/${slug}/chapters/${chapter}/subtitles.vtt` : undefined,
    videoUrl: fresh && metadata?.stages.video.status === "complete" && await exists(paths.video) ? `/api/stories/${slug}/chapters/${chapter}/video` : undefined,
  };
}

export async function getQaDashboard(root: string, slug: string) {
  const chapters = await loadChapterSummaries(root, slug); const issues: Record<string, number> = {}; const items = [];
  for (const chapter of chapters) {
    if (!chapter.qa) continue; const qaIssues = chapter.qaIssues ?? [];
    items.push({ chapter: chapter.chapter, title: chapter.originalTitle, status: chapter.qa, score: chapter.qaScore, issues: qaIssues });
    for (const category of new Set(qaIssues.map((issue) => issue.category))) issues[category] = (issues[category] ?? 0) + 1;
  }
  return { counts: countQa(chapters), categories: issues, chapters: items };
}

export async function getStoryBible(root: string, slug: string): Promise<StoryBible> {
  slugSchema.parse(slug); const index = await loadChapterIndex(root, slug);
  if (index.manifest) return rebuildStoryBibleBeforeChapter(root, slug, (index.numbers.at(-1) ?? 0) + 1);
  const raw = await readJsonIfExists<StoryBible>(storyPaths(root, slug, 1).bible); return raw ? storyBibleSchema.parse(raw) : emptyStoryBible();
}

export async function getStoryBibleView(root: string, slug: string) { const bible = await getStoryBible(root, slug); return applyManualBibleOverlay(root, slug, bible); }

export async function getOutputsLibrary(root: string, slug: string) {
  slugSchema.parse(slug); const [audio, video] = await Promise.all([getAudioDashboard(root, slug), getVideoDashboard(root, slug)]); const items: Array<Record<string, unknown>> = [];
  for (const chapter of audio.chapters) if (chapter.audioAvailable) items.push(await outputItem(storyPaths(root, slug, chapter.chapter).audio, { id: `chapter-audio-${chapter.chapter}`, group: "chapterAudio", chapter: chapter.chapter, format: "mp3", url: `/api/stories/${slug}/chapters/${chapter.chapter}/audio` }));
  for (const item of audio.exports) items.push(await outputItem(exportPaths(root, slug, item.from, item.to, item.format).output, { id: `audiobook-${item.fingerprint}`, group: "audiobooks", from: item.from, to: item.to, format: item.format, createdAt: item.createdAt, durationSeconds: item.durationSeconds, url: item.downloadUrl }));
  for (const chapter of video.chapters) if (chapter.videoAvailable) items.push(await outputItem(storyPaths(root, slug, chapter.chapter).video, { id: `chapter-video-${chapter.chapter}`, group: "chapterVideos", chapter: chapter.chapter, format: "mp4", url: `/api/stories/${slug}/chapters/${chapter.chapter}/video` }));
  for (const item of video.exports) items.push(await outputItem(videoExportPaths(root, slug, item.from, item.to).output, { id: `video-${item.fingerprint}`, group: "combinedVideos", from: item.from, to: item.to, format: "mp4", createdAt: item.createdAt, durationSeconds: item.durationSeconds, url: item.downloadUrl }));
  for (const chapter of video.chapters) if (chapter.subtitleStatus === "complete") for (const format of ["srt", "vtt"] as const) items.push(await outputItem(format === "srt" ? storyPaths(root, slug, chapter.chapter).subtitlesSrt : storyPaths(root, slug, chapter.chapter).subtitlesVtt, { id: `subtitle-${format}-${chapter.chapter}`, group: "subtitles", chapter: chapter.chapter, format, url: `/api/stories/${slug}/chapters/${chapter.chapter}/subtitles.${format}` }));
  for (const chapter of video.chapters) { const raw = await readJsonIfExists<SceneManifest>(storyPaths(root, slug, chapter.chapter).scenesManifest); const manifest = raw ? sceneManifestSchema.safeParse(raw) : undefined; if (!manifest?.success) continue; for (const scene of manifest.data.scenes) { const path = sceneImagePath(root, slug, chapter.chapter, scene.id); if (scene.artwork.status === "complete" && await exists(path)) items.push(await outputItem(path, { id: `artwork-${chapter.chapter}-${scene.id}`, group: "artwork", chapter: chapter.chapter, format: "png", url: `/api/stories/${slug}/chapters/${chapter.chapter}/scenes/${scene.id}.png` })); } }
  return { items: items.filter((item) => !item.missing) };
}

async function outputItem(path: string, value: Record<string, unknown>) { try { const info = await stat(path); return { ...value, bytes: info.size, createdAt: value.createdAt ?? info.mtime.toISOString() }; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...value, bytes: 0, missing: true }; throw error; } }

export const settingsUpdateSchema = z.object({
  title: z.string().trim().min(1), author: z.string().trim().optional(), description: z.string().max(10_000).default(""), tags: z.array(z.string()).max(30).default([]), notes: z.string().max(20_000).default(""), sourceLanguage: z.string().trim().min(2), outputLanguage: z.string().trim().min(2),
  recentChapterSummaries: z.number().int().min(0).max(100),
  translation: z.object({ provider: z.enum(["openai", "gemini"]), model: z.string().trim().min(1) }),
  narration: z.object({ provider: z.enum(["openai", "gemini"]), model: z.string().trim().min(1) }),
  qa: z.object({ provider: z.enum(["openai", "gemini"]), model: z.string().trim().min(1) }),
  scenePlanner: z.object({ provider: z.enum(["openai", "gemini"]), model: z.string().trim().min(1) }).optional(),
  tts: z.object({ referenceId: z.string().trim().optional(), speed: z.number().min(0.5).max(2) }),
  audio: z.object({ loudnessTarget: z.number().min(-24).max(-12), truePeak: z.number().min(-6).max(-0.1), segmentGapSeconds: z.number().min(0).max(5),
    chapterGapSeconds: z.number().min(0).max(10), bitrate: z.enum(["64k", "96k", "128k", "160k", "192k", "256k", "320k"]), sampleRate: z.union([z.literal(32000), z.literal(44100), z.literal(48000)]) }).optional(),
  subtitles: z.object({ maxCharactersPerLine: z.number().int().min(20).max(80), maxLines: z.number().int().min(1).max(3), minimumDurationSeconds: z.number().min(.4).max(5), maximumDurationSeconds: z.number().min(2).max(12) }).optional(),
  video: z.object({ width: z.number().int().min(640).max(3840), height: z.number().int().min(360).max(2160), fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]), codec: z.literal("libx264"), quality: z.number().int().min(0).max(40), subtitleMode: z.enum(["none", "burn", "soft", "both"]), subtitleStyle: z.enum(["default", "large", "minimal"]), backgroundMode: z.enum(["cover", "gradient", "kenBurns"]), introDurationSeconds: z.number().min(0).max(10) }).optional(),
  scenes: sceneSettingsSchema.optional(), artwork: artworkSettingsSchema.optional(),
}).strict();

export async function updateStorySettings(root: string, slug: string, input: unknown): Promise<Story> {
  slugSchema.parse(slug); const update = settingsUpdateSchema.parse(input); const paths = storyPaths(root, slug, 1);
  return withStoryLock(root, slug, "web settings update", async () => {
    const current = await loadStory(paths.storyConfig);
    const story = storySchema.parse({ ...current, title: update.title, author: update.author || undefined, description: update.description, tags: update.tags, notes: update.notes, sourceLanguage: update.sourceLanguage, outputLanguage: update.outputLanguage,
      context: { ...current.context, recentChapterSummaries: update.recentChapterSummaries },
      audio: { ...current.audio, ...update.audio }, subtitles: { ...current.subtitles, ...update.subtitles }, video: { ...current.video, ...update.video }, scenes: { ...current.scenes, ...update.scenes }, artwork: { ...current.artwork, ...update.artwork }, pipeline: { ...current.pipeline, translation: update.translation, narration: update.narration, qa: update.qa, scenePlanner: update.scenePlanner ?? current.pipeline.scenePlanner,
        tts: { ...current.pipeline.tts, referenceId: update.tts.referenceId || undefined, speed: update.tts.speed } } });
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
  return mapLimit(numbers, 16, async (chapter) => {
    const chapterPaths = storyPaths(root, slug, chapter); const raw = await readJsonIfExists<Chapter>(chapterPaths.chapterMeta); const parsed = raw ? chapterSchema.safeParse(raw) : undefined;
    const metadata = parsed?.success ? parsed.data : undefined; const fresh = isCurrent(metadata, index.manifestByChapter.get(chapter), Boolean(index.manifest));
    const qaRaw = fresh && metadata?.stages.qa.status === "complete" ? await readJsonIfExists<QaResult>(chapterPaths.qa) : undefined;
    const qa = qaRaw ? qaResultSchema.safeParse(qaRaw) : undefined; const tts = fresh ? metadata?.stages.tts.status ?? "pending" : "pending";
    const audioMastering = fresh ? metadata?.stages.audioMastering.status ?? "pending" : "pending"; const subtitles = fresh ? metadata?.stages.subtitles.status ?? "pending" : "pending"; const scenePlanning = fresh ? metadata?.stages.scenePlanning.status ?? "pending" : "pending"; const artwork = fresh ? metadata?.stages.artwork.status ?? "pending" : "pending"; const video = fresh ? metadata?.stages.video.status ?? "pending" : "pending";
    return { chapter, originalTitle: metadata?.originalTitle ?? index.titles.get(chapter), translation: fresh ? metadata?.stages.translation.status ?? "pending" : "pending",
      narration: fresh ? metadata?.stages.narration.status ?? "pending" : "pending", qa: qa?.success ? qa.data.status : undefined,
      qaScore: qa?.success ? qa.data.score : undefined, qaIssues: qa?.success ? qa.data.issues : undefined, tts, audioMastering, subtitles, scenePlanning, artwork, video,
      durationSeconds: audioMastering === "complete" ? metadata?.audio?.durationSeconds : undefined,
      audioAvailable: audioMastering === "complete" && await exists(chapterPaths.audio), videoAvailable: video === "complete" && await exists(chapterPaths.video) };
  });
}

export async function getAudioDashboard(root: string, slug: string) {
  slugSchema.parse(slug); const story = await loadStory(storyPaths(root, slug, 1).storyConfig); const chapters = await loadChapterSummaries(root, slug);
  const exportsDirectory = join(storyPaths(root, slug, 1).story, "exports"); let names: string[] = [];
  try { names = (await readdir(exportsDirectory)).filter((name) => name.endsWith(".json")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const exports = (await mapLimit(names, 8, async (name) => { const raw = await readJsonIfExists(join(exportsDirectory, name)); const parsed = raw ? exportManifestSchema.safeParse(raw) : undefined; if (!parsed?.success || parsed.data.story !== slug || !(await currentAudioExport(root, slug, parsed.data))) return undefined; const { output: _output, ...manifest } = parsed.data; return { ...manifest, downloadUrl: `/api/stories/${slug}/exports/${parsed.data.from}-${parsed.data.to}.${parsed.data.format}` }; }))
    .filter((item): item is NonNullable<typeof item> => Boolean(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const mastered = chapters.filter((item) => item.audioMastering === "complete" && item.durationSeconds);
  return { settings: story.audio, chapters: chapters.map(({ chapter, originalTitle, audioMastering, durationSeconds, audioAvailable }) => ({ chapter, title: originalTitle, status: audioMastering, durationSeconds, audioAvailable })),
    counts: { total: chapters.length, mastered: mastered.length },
    totalDurationSeconds: mastered.reduce((sum, item) => sum + (item.durationSeconds ?? 0), 0) + story.audio.chapterGapSeconds * Math.max(0, mastered.length - 1), exports };
}

export async function getVideoDashboard(root: string, slug: string) {
  slugSchema.parse(slug); const story = await loadStory(storyPaths(root, slug, 1).storyConfig); const chapters = await loadChapterSummaries(root, slug); const storyRoot = storyPaths(root, slug, 1).story;
  const cover = (await Promise.all(["cover.jpg", "cover.jpeg", "cover.png"].map(async (name) => await exists(join(storyRoot, name)) ? name : undefined))).find(Boolean); let names: string[] = [];
  try { names = (await readdir(join(storyRoot, "exports"))).filter((name) => name.endsWith(".mp4.json")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const exports = (await mapLimit(names, 8, async (name) => { const raw = await readJsonIfExists(join(storyRoot, "exports", name)); const parsed = raw ? videoExportManifestSchema.safeParse(raw) : undefined; if (!parsed?.success || parsed.data.story !== slug || !(await currentVideoExport(root, slug, parsed.data))) return undefined; const { output: _output, ...manifest } = parsed.data; return { ...manifest, downloadUrl: `/api/stories/${slug}/video-exports/${parsed.data.from}-${parsed.data.to}.mp4` }; })).filter((item): item is NonNullable<typeof item> => Boolean(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { settings: story.video, subtitleSettings: story.subtitles, background: { coverAvailable: Boolean(cover), coverName: cover, effectiveMode: story.video.backgroundMode === "gradient" || !cover ? "fallback" : story.video.backgroundMode }, counts: { total: chapters.length, mastered: chapters.filter((item) => item.audioMastering === "complete").length, subtitles: chapters.filter((item) => item.subtitles === "complete").length, videos: chapters.filter((item) => item.video === "complete").length }, chapters: chapters.map((item) => ({ chapter: item.chapter, title: item.originalTitle, durationSeconds: item.durationSeconds, subtitleStatus: item.subtitles, videoStatus: item.video, videoAvailable: item.videoAvailable })), exports };
}

export async function getScenesDashboard(root: string, slug: string, selectedChapter?: number) {
  slugSchema.parse(slug); const story = await loadStory(storyPaths(root, slug, 1).storyConfig); const chapters = await loadChapterSummaries(root, slug); const chapterNumber = selectedChapter ?? chapters[0]?.chapter;
  if (chapterNumber !== undefined && !chapters.some((item) => item.chapter === chapterNumber)) throw new Error(`Chapter ${chapterNumber} was not found`);
  let manifest: (SceneManifest & { scenes: Array<SceneManifest["scenes"][number] & { imageUrl?: string }> }) | undefined;
  if (chapterNumber !== undefined) { const raw = await readJsonIfExists<SceneManifest>(storyPaths(root, slug, chapterNumber).scenesManifest); const parsed = raw ? sceneManifestSchema.safeParse(raw) : undefined; if (parsed?.success) { const scenes = await mapLimit(parsed.data.scenes, 8, async (scene) => ({ ...scene, imageUrl: scene.artwork.status === "complete" && await exists(sceneImagePath(root, slug, chapterNumber, scene.id)) ? `/api/stories/${slug}/chapters/${chapterNumber}/scenes/${scene.id}.png` : undefined })); manifest = { ...parsed.data, scenes }; } }
  return { settings: story.scenes, artwork: story.artwork, planner: story.pipeline.scenePlanner, selectedChapter: chapterNumber, chapters: chapters.map((item) => ({ chapter: item.chapter, title: item.originalTitle, durationSeconds: item.durationSeconds, sceneStatus: item.scenePlanning, artworkStatus: item.artwork })), counts: { chapters: chapters.length, planned: chapters.filter((item) => item.scenePlanning === "complete").length, artworkReady: chapters.filter((item) => item.artwork === "complete").length }, manifest };
}

export function publicProductionManifest(manifest: ProductionManifest, slug: string): ProductionManifest {
  const exports: Record<string, string> = {};
  if (manifest.summary.exports.audiobook) exports.audiobook = `/api/stories/${slug}/exports/${manifest.selection.from}-${manifest.selection.to}.${manifest.options.audiobookFormat}`;
  if (manifest.summary.exports.video) exports.video = `/api/stories/${slug}/video-exports/${manifest.selection.from}-${manifest.selection.to}.mp4`;
  return { ...manifest, summary: { ...manifest.summary, exports } };
}

async function currentAudioExport(root: string, slug: string, manifest: z.infer<typeof exportManifestSchema>) {
  if (await fileFingerprint(exportPaths(root, slug, manifest.from, manifest.to, manifest.format).output) !== manifest.outputFingerprint) return false;
  for (const chapter of manifest.chapters) { const paths = storyPaths(root, slug, chapter.chapter); const raw = await readJsonIfExists<Chapter>(paths.chapterMeta); const parsed = raw ? chapterSchema.safeParse(raw) : undefined; if (!parsed?.success || parsed.data.stages.audioMastering.status !== "complete" || await fileFingerprint(paths.audio) !== chapter.fingerprint) return false; }
  return true;
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
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const raw = await readJsonIfExists(join(directory, name)); const audioManifest = raw ? exportManifestSchema.safeParse(raw) : undefined;
    if (audioManifest?.success && audioManifest.data.story === slug && audioManifest.data.chapters.every((item) => byChapter.get(item.chapter)?.audioMastering === "complete") && await exists(exportPaths(root, slug, audioManifest.data.from, audioManifest.data.to, audioManifest.data.format).output)) audio = true;
    const videoManifest = raw ? videoExportManifestSchema.safeParse(raw) : undefined;
    if (videoManifest?.success && videoManifest.data.story === slug && videoManifest.data.chapters.every((item) => byChapter.get(item.chapter)?.video === "complete") && await exists(videoExportPaths(root, slug, videoManifest.data.from, videoManifest.data.to).output)) video = true;
    if (audio && video) break;
  }
  return { audio, video };
}

function isCurrent(metadata: Chapter | undefined, source: SourceManifest["chapters"][number] | undefined, hasManifest: boolean) {
  return !hasManifest || Boolean(metadata?.source?.fingerprint && source && metadata.source.fingerprint === source.fingerprint);
}

async function fileFingerprint(path: string) { try { const data = await readFile(path); return data.length ? fingerprint(data.toString("base64")) : undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }

async function mapLimit<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length); let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) { const index = next++; result[index] = await mapper(values[index]!); }
  });
  await Promise.all(workers); return result;
}
