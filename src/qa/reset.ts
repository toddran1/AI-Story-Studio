import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Chapter, chapterSchema } from "../domain/chapter.js";
import { sourceManifestSchema } from "../source/types.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { exists, readJsonIfExists } from "../storage/story-files.js";
import { withStoryLock } from "../storage/story-lock.js";

export interface ResetChapterQaResult {
  chapter: number;
  reset: boolean;
  skipped: boolean;
  reason?: "no_qa_data" | "already_clean";
  deletedArtifacts: string[];
  previousQaStatus?: string;
  newQaStatus: "pending" | "not_run";
}

export type QaResetScope =
  | { type: "book" }
  | { type: "range"; fromChapter: number; toChapter: number }
  | { type: "chapter"; chapterNumber: number };

export interface ResetQaBatchResult {
  scope: QaResetScope;
  affectedChapterNumbers: number[];
  affectedCount: number;
  requested: number;
  reset: number;
  alreadyClean: number;
  skipped: number;
  failed: number;
  failures: Array<{ chapter: number; reason: string }>;
  chapters: number[];
  resetChapters: number[];
  skippedChapters: number[];
}

export const qaResetScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("book") }).strict(),
  z.object({ type: z.literal("range"), fromChapter: z.number().int().positive(), toChapter: z.number().int().positive() }).strict().refine((data) => data.fromChapter <= data.toChapter, {
    message: "Starting chapter must be less than or equal to ending chapter.", path: ["toChapter"],
  }),
  z.object({ type: z.literal("chapter"), chapterNumber: z.number().int().positive() }).strict(),
]);

/**
 * Enumerate all existing chapter numbers for a story by checking both
 * the source manifest and the story's chapters directory.
 */
export async function listStoryChapterNumbers(root: string, slug: string): Promise<number[]> {
  const paths = storyPaths(root, slug, 1);
  const manifestRaw = await readJsonIfExists(paths.sourceManifest);
  const parsed = manifestRaw ? sourceManifestSchema.safeParse(manifestRaw) : undefined;
  const numbers = new Set<number>();
  if (parsed?.success) {
    for (const item of parsed.data.chapters) numbers.add(item.chapter);
  }
  try {
    const entries = await readdir(join(paths.story, "chapters"), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /^\d+$/.test(entry.name)) {
        numbers.add(Number(entry.name));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [...numbers].sort((a, b) => a - b);
}

/**
 * Authoritative single-chapter QA data reset.
 *
 * Fundamental invariant:
 * Deletes ONLY QA-owned evaluation data (`qa.json`), resets ONLY `metadata.stages.qa`
 * to canonical `{ status: "pending" }`, and clears `metadata.quality`.
 *
 * If a chapter exists in the source/story catalog but has no production metadata,
 * it is treated as already clean (skipped) with zero writes.
 *
 * NEVER triggers downstream invalidation. Translation, Narration, Story Bible,
 * Continuity, TTS, Audio Mastering, Alignment, Subtitles, Scene Planning,
 * Artwork, and Video remain byte-for-byte and structurally untouched.
 */
export async function resetChapterQa(
  root: string,
  slug: string,
  chapter: number,
  options: { skipLock?: boolean; availableChapters?: number[] } = {},
): Promise<ResetChapterQaResult> {
  if (!Number.isSafeInteger(chapter) || chapter < 1) {
    throw new Error("Chapter must be a positive integer");
  }

  const execute = async (): Promise<ResetChapterQaResult> => {
    const availableChapters = options.availableChapters ?? (await listStoryChapterNumbers(root, slug));
    if (!availableChapters.includes(chapter)) {
      throw new Error(`Chapter ${chapter} does not exist in story '${slug}'`);
    }

    const paths = storyPaths(root, slug, chapter);
    const chapterRaw = await readJsonIfExists<Chapter>(paths.chapterMeta);
    const qaRaw = await readJsonIfExists(paths.qa);
    const qaFileExists = Boolean(qaRaw) || (await exists(paths.qa));

    if (!chapterRaw) {
      if (!qaFileExists) {
        return {
          chapter,
          reset: false,
          skipped: true,
          reason: "no_qa_data",
          deletedArtifacts: [],
          newQaStatus: "not_run",
        };
      }

      await rm(paths.qa, { force: true });
      return {
        chapter,
        reset: true,
        skipped: false,
        deletedArtifacts: ["qa.json"],
        newQaStatus: "not_run",
      };
    }

    const metadata = chapterSchema.parse(chapterRaw);
    const previousQaStatus = metadata.stages.qa?.status ?? (qaFileExists ? "complete" : undefined);
    const isAlreadyClean = !qaFileExists && metadata.stages.qa?.status === "pending" && !metadata.quality;

    if (isAlreadyClean) {
      return {
        chapter,
        reset: false,
        skipped: true,
        reason: "already_clean",
        deletedArtifacts: [],
        previousQaStatus: "pending",
        newQaStatus: "pending",
      };
    }

    // Stage atomic deletion of QA artifact and metadata reset
    if (qaFileExists) {
      await rm(paths.qa, { force: true });
    }

    // Reset QA stage state to canonical pending, clearing all QA run metadata
    metadata.stages.qa = { status: "pending" };
    delete (metadata as Record<string, unknown>).quality;
    metadata.updatedAt = new Date().toISOString();

    try {
      await atomicWriteJson(paths.chapterMeta, metadata);
    } catch (writeError) {
      // Transaction rollback: if qa.json existed, restore it so metadata and filesystem stay synchronized
      if (qaRaw) {
        try {
          await atomicWriteJson(paths.qa, qaRaw);
        } catch {
          // Preserve writeError as primary failure
        }
      }
      throw writeError;
    }

    return {
      chapter,
      reset: true,
      skipped: false,
      deletedArtifacts: qaFileExists ? ["qa.json"] : [],
      previousQaStatus,
      newQaStatus: "pending",
    };
  };

  if (options.skipLock) {
    return execute();
  }

  return withStoryLock(root, slug, `reset QA chapter ${chapter}`, execute);
}

/**
 * Authoritative batch QA data reset for multiple chapters, a range, or the entire book.
 */
export async function resetChapterQaBatch(
  root: string,
  slug: string,
  scope: QaResetScope,
): Promise<ResetQaBatchResult> {
  const parsed = qaResetScopeSchema.parse(scope);

  const availableChapters = await listStoryChapterNumbers(root, slug);
  let targetChapters: number[] = [];

  if (parsed.type === "book") {
    targetChapters = availableChapters;
  } else if (parsed.type === "range") {
    targetChapters = availableChapters.filter((ch) => ch >= parsed.fromChapter && ch <= parsed.toChapter);
  } else {
    targetChapters = availableChapters.includes(parsed.chapterNumber) ? [parsed.chapterNumber] : [];
  }

  if (!targetChapters.length) {
    if (parsed.type === "range") throw new Error(`No existing chapters fall within range ${parsed.fromChapter}–${parsed.toChapter}`);
    if (parsed.type === "chapter") throw new Error(`Chapter ${parsed.chapterNumber} does not exist in story '${slug}'`);
    throw new Error(`Story '${slug}' has no chapters to reset`);
  }

  return withStoryLock(root, slug, `reset QA batch (${targetChapters.length} chapters)`, async () => {
    let resetCount = 0;
    let alreadyCleanCount = 0;
    const failures: Array<{ chapter: number; reason: string }> = [];
    const resetChapters: number[] = [];
    const skippedChapters: number[] = [];

    for (const chapter of targetChapters) {
      try {
        const result = await resetChapterQa(root, slug, chapter, { skipLock: true, availableChapters });
        if (result.reset) {
          resetCount++;
          resetChapters.push(chapter);
        } else {
          alreadyCleanCount++;
          skippedChapters.push(chapter);
        }
      } catch (err) {
        failures.push({
          chapter,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      scope: parsed,
      affectedChapterNumbers: targetChapters,
      affectedCount: targetChapters.length,
      requested: targetChapters.length,
      reset: resetCount,
      alreadyClean: alreadyCleanCount,
      skipped: alreadyCleanCount,
      failed: failures.length,
      failures,
      chapters: resetChapters,
      resetChapters,
      skippedChapters,
    };
  });
}
