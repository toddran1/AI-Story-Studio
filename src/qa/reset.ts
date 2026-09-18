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
  deletedArtifacts: string[];
  previousQaStatus?: string;
  newQaStatus: "pending";
}

export interface ResetQaBatchOptions {
  chapters?: number[];
  from?: number;
  to?: number;
  all?: boolean;
}

export interface ResetQaBatchResult {
  requested: number;
  reset: number;
  failed: number;
  failures: Array<{ chapter: number; reason: string }>;
  chapters: number[];
}

export const resetQaBatchOptionsSchema = z.union([
  z.object({
    chapters: z.array(z.number().int().positive()).min(1),
  }),
  z.object({
    from: z.number().int().positive(),
    to: z.number().int().positive(),
  }).refine((data) => data.to >= data.from, {
    message: "Range end chapter must be greater than or equal to start chapter",
  }),
  z.object({
    all: z.literal(true),
  }),
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
 * NEVER triggers downstream invalidation. Translation, Narration, Story Bible,
 * Continuity, TTS, Audio Mastering, Alignment, Subtitles, Scene Planning,
 * Artwork, and Video remain byte-for-byte and structurally untouched.
 */
export async function resetChapterQa(
  root: string,
  slug: string,
  chapter: number,
  options: { skipLock?: boolean } = {},
): Promise<ResetChapterQaResult> {
  if (!Number.isSafeInteger(chapter) || chapter < 1) {
    throw new Error("Chapter must be a positive integer");
  }

  const execute = async (): Promise<ResetChapterQaResult> => {
    const paths = storyPaths(root, slug, chapter);
    const chapterRaw = await readJsonIfExists<Chapter>(paths.chapterMeta);
    if (!chapterRaw) {
      throw new Error(`Chapter ${chapter} has no production metadata`);
    }

    const metadata = chapterSchema.parse(chapterRaw);
    const qaRaw = await readJsonIfExists(paths.qa);
    const qaFileExists = Boolean(qaRaw) || (await exists(paths.qa));

    const previousQaStatus = metadata.stages.qa?.status ?? (qaFileExists ? "complete" : undefined);
    const isAlreadyClean = !qaFileExists && metadata.stages.qa?.status === "pending" && !metadata.quality;

    if (isAlreadyClean) {
      return {
        chapter,
        reset: false,
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
  options: ResetQaBatchOptions,
): Promise<ResetQaBatchResult> {
  const parsed = resetQaBatchOptionsSchema.parse(options);

  const availableChapters = await listStoryChapterNumbers(root, slug);
  let targetChapters: number[] = [];

  if ("all" in parsed && parsed.all) {
    targetChapters = availableChapters;
  } else if ("from" in parsed && "to" in parsed) {
    targetChapters = availableChapters.filter((ch) => ch >= parsed.from && ch <= parsed.to);
  } else if ("chapters" in parsed && parsed.chapters) {
    const requested = new Set(parsed.chapters);
    targetChapters = availableChapters.filter((ch) => requested.has(ch));
    // If requested chapters were not in availableChapters, include them so error is reported accurately per chapter
    for (const ch of parsed.chapters) {
      if (!targetChapters.includes(ch)) {
        targetChapters.push(ch);
      }
    }
    targetChapters.sort((a, b) => a - b);
  }

  if (!targetChapters.length) {
    return {
      requested: 0,
      reset: 0,
      failed: 0,
      failures: [],
      chapters: [],
    };
  }

  return withStoryLock(root, slug, `reset QA batch (${targetChapters.length} chapters)`, async () => {
    let resetCount = 0;
    const failures: Array<{ chapter: number; reason: string }> = [];
    const successfulChapters: number[] = [];

    for (const chapter of targetChapters) {
      try {
        const result = await resetChapterQa(root, slug, chapter, { skipLock: true });
        if (result.reset) {
          resetCount++;
          successfulChapters.push(chapter);
        }
      } catch (err) {
        failures.push({
          chapter,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      requested: targetChapters.length,
      reset: resetCount,
      failed: failures.length,
      failures,
      chapters: successfulChapters,
    };
  });
}
