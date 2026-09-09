import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Chapter, chapterSchema } from "../../src/domain/chapter.js";
import { QaResult, qaResultSchema } from "../../src/domain/qa.js";
import { Story, storySchema } from "../../src/domain/story.js";
import { StoryBible, emptyStoryBible, storyBibleSchema } from "../../src/domain/story-bible.js";
import { sourceManifestSchema } from "../../src/source/types.js";
import { atomicWriteJson } from "../../src/storage/atomic-write.js";
import { storyPaths } from "../../src/storage/paths.js";
import { exists, readJsonIfExists, readTextIfExists } from "../../src/storage/story-files.js";
import { withStoryLock } from "../../src/storage/story-lock.js";
import { loadStory } from "../../src/config/load-config.js";

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const chapterFilterSchema = z.enum(["all", "unprocessed", "warn", "fail", "complete"]);

export type ChapterSummary = {
  chapter: number; originalTitle?: string; translation: string; narration: string; qa?: QaResult["status"];
  qaScore?: number; tts: string; audioAvailable: boolean;
};

export async function listStories(root: string) {
  const storiesRoot = join(root, "stories"); let directories: string[] = [];
  try { directories = (await readdir(storiesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const cards = await Promise.all(directories.filter((slug) => slugSchema.safeParse(slug).success).map(async (slug) => {
    const paths = storyPaths(root, slug, 1); if (!(await exists(paths.storyConfig))) return undefined;
    const story = await loadStory(paths.storyConfig); const manifestRaw = await readJsonIfExists(paths.sourceManifest);
    const manifest = manifestRaw ? sourceManifestSchema.safeParse(manifestRaw) : undefined;
    const chapters = await loadChapterSummaries(root, slug);
    const processed = chapters.filter((item) => item.qa || item.tts === "complete");
    return {
      slug, title: story.title, author: story.author, sourceType: story.source.type, sourceUrl: story.source.url,
      sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
      importedChapters: manifest?.success ? manifest.data.chapters.length : chapters.length,
      processedChapters: processed.length, latestProcessedChapter: processed.at(-1)?.chapter,
      qa: countQa(chapters), progress: chapters.length ? Math.round(processed.length / chapters.length * 100) : 0,
    };
  }));
  return cards.filter((card): card is NonNullable<typeof card> => Boolean(card)).sort((a, b) => a.title.localeCompare(b.title));
}

export async function getStoryOverview(root: string, slug: string) {
  slugSchema.parse(slug); const story = await loadStory(storyPaths(root, slug, 1).storyConfig);
  const chapters = await loadChapterSummaries(root, slug);
  return { story, counts: { chapters: chapters.length, ...countQa(chapters), complete: chapters.filter((item) => item.tts === "complete").length } };
}

export async function getChapterPage(root: string, slug: string, options: { page: number; pageSize: number; filter: z.infer<typeof chapterFilterSchema>; query?: string }) {
  slugSchema.parse(slug); const page = Math.max(1, Math.floor(options.page)); const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize)));
  let chapters = await loadChapterSummaries(root, slug); const query = options.query?.trim().toLocaleLowerCase();
  if (query) chapters = chapters.filter((item) => String(item.chapter).includes(query) || item.originalTitle?.toLocaleLowerCase().includes(query));
  if (options.filter === "unprocessed") chapters = chapters.filter((item) => item.translation !== "complete");
  else if (options.filter === "warn" || options.filter === "fail") chapters = chapters.filter((item) => item.qa === options.filter);
  else if (options.filter === "complete") chapters = chapters.filter((item) => item.tts === "complete");
  const total = chapters.length; const pages = Math.max(1, Math.ceil(total / pageSize)); const safePage = Math.min(page, pages);
  return { items: chapters.slice((safePage - 1) * pageSize, safePage * pageSize), page: safePage, pageSize, total, pages };
}

export async function getChapter(root: string, slug: string, chapter: number) {
  slugSchema.parse(slug); if (!Number.isSafeInteger(chapter) || chapter < 1) throw new Error("Chapter must be a positive integer");
  const paths = storyPaths(root, slug, chapter); const metadataRaw = await readJsonIfExists<Chapter>(paths.chapterMeta);
  const metadata = metadataRaw ? chapterSchema.parse(metadataRaw) : undefined; const qaRaw = await readJsonIfExists<QaResult>(paths.qa);
  return {
    chapter, metadata, original: await readTextIfExists(paths.original), translation: await readTextIfExists(paths.english),
    narration: await readTextIfExists(paths.narration), qa: qaRaw ? qaResultSchema.parse(qaRaw) : undefined,
    audioAvailable: await exists(paths.audio), audioUrl: await exists(paths.audio) ? `/api/stories/${slug}/chapters/${chapter}/audio` : undefined,
  };
}

export async function getQaDashboard(root: string, slug: string) {
  const chapters = await loadChapterSummaries(root, slug); const issues: Record<string, number> = {}; const items = [];
  for (const chapter of chapters) {
    if (!chapter.qa) continue; const raw = await readJsonIfExists<QaResult>(storyPaths(root, slug, chapter.chapter).qa); if (!raw) continue;
    const qa = qaResultSchema.parse(raw); items.push({ chapter: chapter.chapter, title: chapter.originalTitle, status: qa.status, score: qa.score, issues: qa.issues });
    for (const category of new Set(qa.issues.map((issue) => issue.category))) issues[category] = (issues[category] ?? 0) + 1;
  }
  return { counts: countQa(chapters), categories: issues, chapters: items };
}

export async function getStoryBible(root: string, slug: string): Promise<StoryBible> {
  slugSchema.parse(slug); const raw = await readJsonIfExists<StoryBible>(storyPaths(root, slug, 1).bible);
  return raw ? storyBibleSchema.parse(raw) : emptyStoryBible();
}

export const settingsUpdateSchema = z.object({
  title: z.string().trim().min(1), sourceLanguage: z.string().trim().min(2), outputLanguage: z.string().trim().min(2),
  recentChapterSummaries: z.number().int().min(0).max(100),
  translation: z.object({ provider: z.enum(["openai", "gemini"]), model: z.string().trim().min(1) }),
  narration: z.object({ provider: z.enum(["openai", "gemini"]), model: z.string().trim().min(1) }),
  qa: z.object({ provider: z.enum(["openai", "gemini"]), model: z.string().trim().min(1) }),
  tts: z.object({ referenceId: z.string().trim().optional(), speed: z.number().min(0.5).max(2) }),
}).strict();

export async function updateStorySettings(root: string, slug: string, input: unknown): Promise<Story> {
  slugSchema.parse(slug); const update = settingsUpdateSchema.parse(input); const paths = storyPaths(root, slug, 1);
  return withStoryLock(root, slug, "web settings update", async () => {
    const current = await loadStory(paths.storyConfig);
    const story = storySchema.parse({ ...current, title: update.title, sourceLanguage: update.sourceLanguage, outputLanguage: update.outputLanguage,
      context: { ...current.context, recentChapterSummaries: update.recentChapterSummaries },
      pipeline: { ...current.pipeline, translation: update.translation, narration: update.narration, qa: update.qa,
        tts: { ...current.pipeline.tts, referenceId: update.tts.referenceId || undefined, speed: update.tts.speed } } });
    await atomicWriteJson(paths.storyConfig, story); await atomicWriteJson(paths.pipelineConfig, story.pipeline); return story;
  });
}

export async function loadChapterSummaries(root: string, slug: string): Promise<ChapterSummary[]> {
  const paths = storyPaths(root, slug, 1); const numbers = new Set<number>();
  const manifestRaw = await readJsonIfExists(paths.sourceManifest); const manifest = manifestRaw ? sourceManifestSchema.safeParse(manifestRaw) : undefined;
  const titles = new Map<number, string | undefined>();
  if (manifest?.success) for (const item of manifest.data.chapters) { numbers.add(item.chapter); titles.set(item.chapter, item.ref.originalTitle); }
  try { for (const entry of await readdir(join(paths.story, "chapters"), { withFileTypes: true })) if (entry.isDirectory() && /^\d+$/.test(entry.name)) numbers.add(Number(entry.name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return Promise.all([...numbers].sort((a, b) => a - b).map(async (chapter) => {
    const chapterPaths = storyPaths(root, slug, chapter); const raw = await readJsonIfExists<Chapter>(chapterPaths.chapterMeta); const parsed = raw ? chapterSchema.safeParse(raw) : undefined;
    const metadata = parsed?.success ? parsed.data : undefined; const qaRaw = await readJsonIfExists<QaResult>(chapterPaths.qa); const qa = qaRaw ? qaResultSchema.safeParse(qaRaw) : undefined;
    return { chapter, originalTitle: metadata?.originalTitle ?? titles.get(chapter), translation: metadata?.stages.translation.status ?? "pending",
      narration: metadata?.stages.narration.status ?? "pending", qa: qa?.success ? qa.data.status : undefined, qaScore: qa?.success ? qa.data.score : undefined,
      tts: metadata?.stages.tts.status ?? "pending", audioAvailable: await exists(chapterPaths.audio) };
  }));
}

function countQa(chapters: ChapterSummary[]) {
  return { pass: chapters.filter((item) => item.qa === "pass").length, warn: chapters.filter((item) => item.qa === "warn").length, fail: chapters.filter((item) => item.qa === "fail").length };
}
