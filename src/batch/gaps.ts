export type ChapterGapReport = { missing: number[]; total: number; summary?: string };

export function findChapterGaps(values: number[], limit = 1000): ChapterGapReport {
  const numbers = [...new Set(values)].sort((a, b) => a - b); const missing: number[] = []; const ranges: string[] = [];
  const sampleLimit = Math.max(0, Math.floor(limit)); let total = 0; let rangeCount = 0;
  for (let index = 1; index < numbers.length; index++) {
    const start = numbers[index - 1]! + 1; const end = numbers[index]! - 1;
    if (start > end) continue;
    const count = end - start + 1; total += count; rangeCount++;
    if (ranges.length < 20) ranges.push(start === end ? String(start) : `${start}-${end}`);
    for (let number = start; number <= end && missing.length < sampleLimit; number++) missing.push(number);
  }
  const rangeSummary = ranges.slice(0, 20).join(", ");
  return { missing, total, summary: total ? `${rangeSummary}${rangeCount > 20 ? `, … (${rangeCount} gaps)` : ""} (${total} missing)` : undefined };
}
