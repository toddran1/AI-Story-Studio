import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Chapter, chapterSchema } from "../../src/domain/chapter.js";
import { QaResult, qaResultSchema } from "../../src/domain/qa.js";
import { Story, storySchema } from "../../src/domain/story.js";
import { StoryBible, emptyStoryBible, storyBibleSchema } from "../../src/domain/story-bible.js";
import { SourceManifest, sourceManifestSchema } from "../../src/source/types.js";
import { atomicWriteJson } from "../../src/storage/atomic-write.js";
import { sceneImagePath, storyPaths } from "../../src/storage/paths.js";
import { exists, readJsonIfExists, readTextIfExists } from "../../src/storage/story-files.js";
import { withStoryLock } from "../../src/storage/story-lock.js";
import { loadStory } from "../../src/config/load-config.js";
import { rebuildStoryBibleBeforeChapter } from "../../src/story-bible/rebuild.js";
import { exportManifestSchema } from "../../src/audio/audiobook.js";
import { videoExportManifestSchema } from "../../src/video/video-export.js";
import { SceneManifest, artworkSettingsSchema, sceneManifestSchema, sceneSettingsSchema } from "../../src/scenes/types.js";

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const chapterFilterSchema = z.enum(["all", "unprocessed", "warn", "fail", "complete"]);

export type ChapterSummary = {
  chapter: number; originalTitle?: string; translation: string; narration: string; qa?: QaResult["status"];
  qaScore?: number; qaIssues?: QaResult["issues"]; tts: string; audioMastering: string; subtitles: string; scenePlanning: string; artwork: string; video: string; audioAvailable: boolean; videoAvailable: boolean; durationSeconds?: number;
};

export async function listStories(root: string) {
  const storiesRoot = join(root, "stories"); let directories: string[] = [];
  try { directories = (await readdir(storiesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const cards = await mapLimit(directories.filter((slug) => slugSchema.safeParse(slug).success), 4, async (slug) => {
    const paths = storyPaths(root, slug, 1); if (!(await exists(paths.storyConfig))) return undefined;
    const story = await loadStory(paths.storyConfig); const manifestRaw = await readJsonIfExists(paths.sourceManifest);
    const manifest = manifestRaw ? sourceManifestSchema.safeParse(manifestRaw) : undefined;
    const chapters = await loadChapterSummaries(root, slug);
    const processed = chapters.filter((item) => item.audioMastering === "complete");
    return {
      slug, title: story.title, author: story.author, sourceType: story.source.type, sourceUrl: story.source.url,
      sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
      importedChapters: manifest?.success ? manifest.data.chapters.length : chapters.length,
      processedChapters: processed.length, latestProcessedChapter: processed.at(-1)?.chapter,
      qa: countQa(chapters), progress: chapters.length ? Math.round(processed.length / chapters.length * 100) : 0,
    };
  });
  return cards.filter((card): card is NonNullable<typeof card> => Boolean(card)).sort((a, b) => a.title.localeCompare(b.title));
}

export async function getStoryOverview(root: string, slug: string) {
  slugSchema.parse(slug); const story = await loadStory(storyPaths(root, slug, 1).storyConfig);
  const chapters = await loadChapterSummaries(root, slug);
  return { story, counts: { chapters: chapters.length, minChapter: chapters[0]?.chapter, maxChapter: chapters.at(-1)?.chapter,
    ...countQa(chapters), complete: chapters.filter((item) => item.audioMastering === "complete").length } };
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

export const settingsUpdateSchema = z.object({
  title: z.string().trim().min(1), sourceLanguage: z.string().trim().min(2), outputLanguage: z.string().trim().min(2),
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
    const story = storySchema.parse({ ...current, title: update.title, sourceLanguage: update.sourceLanguage, outputLanguage: update.outputLanguage,
      context: { ...current.context, recentChapterSummaries: update.recentChapterSummaries },
      audio: { ...current.audio, ...update.audio }, subtitles: { ...current.subtitles, ...update.subtitles }, video: { ...current.video, ...update.video }, scenes: { ...current.scenes, ...update.scenes }, artwork: { ...current.artwork, ...update.artwork }, pipeline: { ...current.pipeline, translation: update.translation, narration: update.narration, qa: update.qa, scenePlanner: update.scenePlanner ?? current.pipeline.scenePlanner,
        tts: { ...current.pipeline.tts, referenceId: update.tts.referenceId || undefined, speed: update.tts.speed } } });
    await atomicWriteJson(paths.storyConfig, story); await atomicWriteJson(paths.pipelineConfig, story.pipeline); return story;
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
  const exports = (await mapLimit(names, 8, async (name) => { const raw = await readJsonIfExists(join(exportsDirectory, name)); const parsed = raw ? exportManifestSchema.safeParse(raw) : undefined; return parsed?.success ? { ...parsed.data, downloadUrl: `/api/stories/${slug}/exports/${parsed.data.from}-${parsed.data.to}.${parsed.data.format}` } : undefined; }))
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
  const exports = (await mapLimit(names, 8, async (name) => { const raw = await readJsonIfExists(join(storyRoot, "exports", name)); const parsed = raw ? videoExportManifestSchema.safeParse(raw) : undefined; return parsed?.success ? { ...parsed.data, downloadUrl: `/api/stories/${slug}/video-exports/${parsed.data.from}-${parsed.data.to}.mp4` } : undefined; })).filter((item): item is NonNullable<typeof item> => Boolean(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { settings: story.video, subtitleSettings: story.subtitles, background: { coverAvailable: Boolean(cover), coverName: cover, effectiveMode: story.video.backgroundMode === "gradient" || !cover ? "fallback" : story.video.backgroundMode }, counts: { total: chapters.length, mastered: chapters.filter((item) => item.audioMastering === "complete").length, subtitles: chapters.filter((item) => item.subtitles === "complete").length, videos: chapters.filter((item) => item.video === "complete").length }, chapters: chapters.map((item) => ({ chapter: item.chapter, title: item.originalTitle, durationSeconds: item.durationSeconds, subtitleStatus: item.subtitles, videoStatus: item.video, videoAvailable: item.videoAvailable })), exports };
}

export async function getScenesDashboard(root: string, slug: string, selectedChapter?: number) {
  slugSchema.parse(slug); const story = await loadStory(storyPaths(root, slug, 1).storyConfig); const chapters = await loadChapterSummaries(root, slug); const chapterNumber = selectedChapter ?? chapters[0]?.chapter;
  if (chapterNumber !== undefined && !chapters.some((item) => item.chapter === chapterNumber)) throw new Error(`Chapter ${chapterNumber} was not found`);
  let manifest: (SceneManifest & { scenes: Array<SceneManifest["scenes"][number] & { imageUrl?: string }> }) | undefined;
  if (chapterNumber !== undefined) { const raw = await readJsonIfExists<SceneManifest>(storyPaths(root, slug, chapterNumber).scenesManifest); const parsed = raw ? sceneManifestSchema.safeParse(raw) : undefined; if (parsed?.success) { const scenes = await mapLimit(parsed.data.scenes, 8, async (scene) => ({ ...scene, imageUrl: scene.artwork.status === "complete" && await exists(sceneImagePath(root, slug, chapterNumber, scene.id)) ? `/api/stories/${slug}/chapters/${chapterNumber}/scenes/${scene.id}.png` : undefined })); manifest = { ...parsed.data, scenes }; } }
  return { settings: story.scenes, artwork: story.artwork, planner: story.pipeline.scenePlanner, selectedChapter: chapterNumber, chapters: chapters.map((item) => ({ chapter: item.chapter, title: item.originalTitle, durationSeconds: item.durationSeconds, sceneStatus: item.scenePlanning, artworkStatus: item.artwork })), counts: { chapters: chapters.length, planned: chapters.filter((item) => item.scenePlanning === "complete").length, artworkReady: chapters.filter((item) => item.artwork === "complete").length }, manifest };
}

function isCurrent(metadata: Chapter | undefined, source: SourceManifest["chapters"][number] | undefined, hasManifest: boolean) {
  return !hasManifest || Boolean(metadata?.source?.fingerprint && source && metadata.source.fingerprint === source.fingerprint);
}

async function mapLimit<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length); let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) { const index = next++; result[index] = await mapper(values[index]!); }
  });
  await Promise.all(workers); return result;
}
