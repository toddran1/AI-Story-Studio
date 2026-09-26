import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { errorDiagnosticSchema, type ErrorDiagnostic } from "../../src/errors/diagnostic.js";
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
  return records.filter((record): record is JobErrorRecord => Boolean(record))
    .filter((record) => !needle || [record.jobId, record.diagnostic.id, ...record.failures.map((failure) => failure.diagnostic.id)].some((id) => id.toLowerCase().includes(needle)))
    .sort((a, b) => b.failedAt.localeCompare(a.failedAt)).slice(0, Math.min(Math.max(limit, 1), 500));
}

export function failedResultDiagnostics(result: unknown): Array<{ chapter?: number; diagnostic: ErrorDiagnostic }> {
  if (!result || typeof result !== "object" || !Array.isArray((result as { results?: unknown }).results)) return [];
  return (result as { results: unknown[] }).results.flatMap((item) => {
    if (!item || typeof item !== "object" || (item as { status?: unknown }).status !== "failed") return [];
    const value = item as { chapter?: unknown; diagnostic?: unknown; error?: unknown };
    const parsed = errorDiagnosticSchema.safeParse(value.diagnostic);
    return parsed.success ? [{ chapter: typeof value.chapter === "number" ? value.chapter : undefined, diagnostic: parsed.data }] : [];
  });
}
