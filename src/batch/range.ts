import { BatchValidationError } from "../pipeline/errors.js";
import { DiscoveredChapter } from "./types.js";

export const MAX_CHAPTER_SELECTION = 2_000;

/** Parse the chapter-set syntax shared by web, API, and CLI boundaries. */
export function parseChapterSelection(value: string, maximum = MAX_CHAPTER_SELECTION): number[] {
  const input = value.trim();
  if (!input) throw new BatchValidationError("Chapter selection cannot be empty");
  const chapters = new Set<number>();
  for (const rawToken of input.split(",")) {
    const token = rawToken.trim();
    if (!token) throw new BatchValidationError("Invalid chapter selection: empty token between commas");
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
    if (!match) throw new BatchValidationError(`Invalid chapter selection: "${token}"`);
    const start = Number(match[1]); const end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < 1) throw new BatchValidationError(`Invalid chapter selection: "${token}"`);
    if (start > end) throw new BatchValidationError(`Invalid range ${token}: start must be <= end`);
    if (end - start + 1 > maximum) throw new BatchValidationError(`Chapter range ${token} exceeds the ${maximum}-chapter limit`);
    for (let chapter = start; chapter <= end; chapter++) {
      chapters.add(chapter);
      if (chapters.size > maximum) throw new BatchValidationError(`Chapter selection exceeds the ${maximum}-chapter limit`);
    }
  }
  return [...chapters].sort((left, right) => left - right);
}

/** Compact a normalized set for the editable chapter selector. */
export function formatChapterSelection(values: readonly number[]): string {
  const chapters = [...new Set(values)].sort((left, right) => left - right);
  const parts: string[] = [];
  for (let index = 0; index < chapters.length;) {
    const start = chapters[index]!; let end = start;
    while (index + 1 < chapters.length && chapters[index + 1] === end + 1) { index++; end = chapters[index]!; }
    parts.push(start === end ? String(start) : `${start}-${end}`); index++;
  }
  return parts.join(", ");
}

/** Resolve normalized numbers against the authoritative imported catalog. */
export function selectChapterNumbers(chapters: DiscoveredChapter[], requested: readonly number[]): DiscoveredChapter[] {
  if (!requested.length) throw new BatchValidationError("Chapter selection cannot be empty");
  const byNumber = new Map(chapters.map((chapter) => [chapter.chapter, chapter]));
  const missing = requested.filter((chapter) => !byNumber.has(chapter));
  if (missing.length) throw new BatchValidationError(`Chapters are not imported: ${formatChapterSelection(missing)}`);
  return [...new Set(requested)].sort((left, right) => left - right).map((chapter) => byNumber.get(chapter)!);
}

export function selectChapterRange(chapters: DiscoveredChapter[], from?: number, to?: number): DiscoveredChapter[] {
  if (!chapters.length) throw new BatchValidationError("Cannot select a range from an empty chapter list");
  const minimum = chapters[0]!.chapter; const maximum = chapters.at(-1)!.chapter;
  const start = from ?? minimum; const end = to ?? maximum;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) throw new BatchValidationError("--from and --to must be positive integers");
  if (start > end) throw new BatchValidationError(`Invalid range: --from ${start} is greater than --to ${end}`);
  if (start < minimum || start > maximum) throw new BatchValidationError(`--from ${start} is outside discovered range ${minimum}-${maximum}`);
  if (end < minimum || end > maximum) throw new BatchValidationError(`--to ${end} is outside discovered range ${minimum}-${maximum}`);
  const selected = chapters.filter((item) => item.chapter >= start && item.chapter <= end);
  if (!selected.length) throw new BatchValidationError(`No discovered chapters fall within ${start}-${end}`);
  return selected;
}
