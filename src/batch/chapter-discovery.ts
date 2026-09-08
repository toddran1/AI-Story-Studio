import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BatchValidationError } from "../pipeline/errors.js";
import { DiscoveredChapter } from "./types.js";

export type DiscoveryReport = {
  chapters: DiscoveredChapter[];
  invalidFiles: string[];
  duplicateChapters: Array<{ chapter: number; filenames: string[] }>;
  emptyFiles: string[];
  missingChapters: number[];
};

export async function inspectChapterDirectory(directory: string): Promise<DiscoveryReport> {
  const absolute = resolve(directory);
  let entries;
  try { entries = await readdir(absolute, { withFileTypes: true }); }
  catch (error) { throw new BatchValidationError(`Cannot read chapter directory: ${absolute}`, { cause: error }); }

  const candidates: DiscoveredChapter[] = []; const invalidFiles: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".txt")) continue;
    const match = /^(?:chapter[\s_-]*)?0*(\d+)\.txt$/i.exec(entry.name);
    const chapter = match ? Number(match[1]) : 0;
    if (!match || !Number.isSafeInteger(chapter) || chapter < 1) { invalidFiles.push(entry.name); continue; }
    candidates.push({ chapter, filename: entry.name, path: resolve(absolute, entry.name) });
  }

  candidates.sort((a, b) => a.chapter - b.chapter || a.filename.localeCompare(b.filename));
  const grouped = new Map<number, DiscoveredChapter[]>();
  for (const item of candidates) grouped.set(item.chapter, [...(grouped.get(item.chapter) ?? []), item]);
  const duplicateChapters = [...grouped.entries()].filter(([, items]) => items.length > 1)
    .map(([chapter, items]) => ({ chapter, filenames: items.map((item) => item.filename) }));
  const chapters = candidates.filter((item) => grouped.get(item.chapter)?.[0] === item);
  const emptyFiles: string[] = [];
  await Promise.all(chapters.map(async (item) => { if (!(await readFile(item.path, "utf8")).trim()) emptyFiles.push(item.filename); }));
  emptyFiles.sort();
  const missingChapters: number[] = [];
  if (chapters.length) {
    const found = new Set(chapters.map((item) => item.chapter));
    for (let chapter = chapters[0]!.chapter; chapter <= chapters.at(-1)!.chapter; chapter++) if (!found.has(chapter)) missingChapters.push(chapter);
  }
  return { chapters, invalidFiles, duplicateChapters, emptyFiles, missingChapters };
}

export async function discoverChapters(directory: string, allowGaps = false): Promise<DiscoveredChapter[]> {
  const report = await inspectChapterDirectory(directory);
  const issues = discoveryIssues(report, allowGaps);
  if (issues.length) throw new BatchValidationError(`Invalid chapter batch:\n- ${issues.join("\n- ")}`);
  return report.chapters;
}

export function discoveryIssues(report: DiscoveryReport, allowGaps: boolean): string[] {
  const issues: string[] = [];
  if (!report.chapters.length) issues.push("No supported chapter .txt files were discovered");
  if (report.invalidFiles.length) issues.push(`Unrecognized chapter filenames: ${report.invalidFiles.join(", ")}`);
  for (const duplicate of report.duplicateChapters) issues.push(`Duplicate Chapter ${duplicate.chapter}: ${duplicate.filenames.join(", ")}`);
  if (report.emptyFiles.length) issues.push(`Empty chapter files: ${report.emptyFiles.join(", ")}`);
  if (!allowGaps && report.missingChapters.length) issues.push(`Missing chapters: ${report.missingChapters.join(", ")}`);
  return issues;
}
