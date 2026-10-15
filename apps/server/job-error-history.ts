import { storyPaths } from "../../src/storage/paths.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createErrorDiagnostic, errorDiagnosticSchema, type ErrorDiagnostic } from "../../src/errors/diagnostic.js";
import { atomicWriteJson } from "../../src/storage/atomic-write.js";
import { readJsonIfExists } from "../../src/storage/story-files.js";

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const recordSchema = z.object({
  jobId: z.string().uuid(), story: slug, type: z.string(), createdAt: z.string(), failedAt: z.string(),
  diagnostic: errorDiagnosticSchema,
  failures: z.array(z.object({ chapter: z.number().int().positive().optional(), diagnostic: errorDiagnosticSchema })).default([]),
}).strict();
export type JobErrorRecord = z.infer<typeof recordSchema>;

function directory(root: string, story: string) { return join(root, "job-errors", slug.parse(story)); }

export async function saveJobError(root: string, record: JobErrorRecord): Promise<void> {
  const parsed = recordSchema.parse(record);
  await atomicWriteJson(join(directory(root, parsed.story), `${parsed.jobId}.json`), parsed);
}

export async function listJobErrors(root: string, story: string, query = "", limit = 100): Promise<JobErrorRecord[]> {
  const dir = directory(root, story);
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const records = await Promise.all(names.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).map(async (name) => {
    const parsed = recordSchema.safeParse(await readJsonIfExists(join(dir, name)).catch(() => undefined));
    return parsed.success && `${parsed.data.jobId}.json` === name ? parsed.data : undefined;
  }));
  const needle = query.trim().toLowerCase();
  const selected = records.filter((record): record is JobErrorRecord => Boolean(record))
    .filter((record) => !needle || [record.jobId, record.diagnostic.id, ...record.failures.map((failure) => failure.diagnostic.id)].some((id) => id.toLowerCase().includes(needle)))
    .sort((a, b) => b.failedAt.localeCompare(a.failedAt)).slice(0, Math.min(Math.max(limit, 1), 500));
  const titles = new Map<number, Promise<string | undefined>>();
  const enrich = async (diagnostic: ErrorDiagnostic, explicitChapter?: number): Promise<ErrorDiagnostic> => {
    const matches = [...new Set([...`${diagnostic.summary} ${diagnostic.technicalDetails ?? ""}`.matchAll(/\bChapter(?:=|\s+)(\d+)\b/gi)].map(match => Number(match[1])).filter(chapter => Number.isSafeInteger(chapter) && chapter > 0))];
    const chapter = diagnostic.chapter ?? explicitChapter ?? (matches.length === 1 ? matches[0] : undefined);
    if (!chapter) return diagnostic;
    if (!titles.has(chapter)) titles.set(chapter, readJsonIfExists(storyPaths(root, story, chapter).chapterMeta).then(raw => {
      const parsed = z.object({ chapter: z.number().int().positive(), translatedTitle: z.string().max(2000).optional(), originalTitle: z.string().max(2000).optional() }).safeParse(raw);
      return parsed.success && parsed.data.chapter === chapter ? parsed.data.translatedTitle?.trim() || parsed.data.originalTitle?.trim() || undefined : undefined;
    }).catch(() => undefined));
    return { ...diagnostic, chapter, chapterTitle: diagnostic.chapterTitle ?? await titles.get(chapter) };
  };
  return Promise.all(selected.map(async record => ({ ...record, diagnostic: await enrich(record.diagnostic), failures: await Promise.all(record.failures.map(async failure => ({ ...failure, diagnostic: await enrich(failure.diagnostic, failure.chapter) }))) })));

}

export function failedResultDiagnostics(result: unknown): Array<{ chapter?: number; diagnostic: ErrorDiagnostic }> {
  if (!result || typeof result !== "object") return [];
  const root = result as Record<string, unknown>;
  const items: unknown[] = Array.isArray(root.results) ? root.results : Array.isArray(root.failures) ? root.failures : root.chapters && typeof root.chapters === "object" ? Object.values(root.chapters) : [];
  return items.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    if (value.status !== "failed" && !(Array.isArray(root.failures) && typeof value.message === "string")) return [];
    const chapter = typeof value.chapter === "number" && Number.isInteger(value.chapter) && value.chapter > 0 ? value.chapter : undefined;
    const parsed = errorDiagnosticSchema.safeParse(value.diagnostic);
    const message = typeof value.error === "string" ? value.error : typeof value.message === "string" ? value.message : undefined;
    return parsed.success ? [{ chapter, diagnostic: parsed.data }] : message ? [{ chapter, diagnostic: createErrorDiagnostic(new Error(typeof value.segment === "number" ? `Segment ${value.segment}: ${message}` : message), { chapter }) }] : [];
  });
}
