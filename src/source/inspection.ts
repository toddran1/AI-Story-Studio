import { SourceWarning, RawChapter } from "./types.js";
import { findChapterGaps } from "../batch/gaps.js";

export function chapterWarnings(chapters: RawChapter[], allowGaps = false): SourceWarning[] {
  const warnings: SourceWarning[] = [];
  const grouped = new Map<number, RawChapter[]>();
  for (const chapter of chapters) grouped.set(chapter.ref.chapter, [...(grouped.get(chapter.ref.chapter) ?? []), chapter]);
  for (const [number, matches] of grouped) if (matches.length > 1) warnings.push({
    code: "duplicate_chapter_number", message: `Chapter ${number} appears ${matches.length} times`, sourceId: matches[0]!.ref.sourceId,
  });
  if (!allowGaps && chapters.length) {
    const gaps = findChapterGaps(chapters.map((item) => item.ref.chapter));
    if (gaps.total) warnings.push({ code: "chapter_number_gap", message: `Missing chapters: ${gaps.summary}` });
  }
  return warnings;
}

export function validateImportable(chapters: RawChapter[], warnings: SourceWarning[], allowGaps = false): void {
  if (!chapters.length) throw new Error("No numbered chapters were detected in the source");
  const blocking = warnings.filter((warning) => warning.code === "duplicate_chapter_number" || warning.code === "empty_section" || warning.code === "invalid_filename" || (!allowGaps && warning.code === "chapter_number_gap"));
  if (blocking.length) throw new Error(`Source validation failed:\n- ${blocking.map((item) => item.message).join("\n- ")}`);
}
