/** Shared UI parser. Reject unsafe integers before entering an increment loop. */
export function parseImageChapterSelection(text: string): number[] {
  const chapters = new Set<number>();
  for (const part of text.split(",").map(s => s.trim()).filter(Boolean)) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) throw new Error("Use chapter numbers or ranges, such as 1-5,8.");
    const from = Number(match[1]); const to = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to - from > 99) throw new Error("Choose up to 100 chapters using safe positive whole numbers.");
    for (let chapter = from; chapter <= to; chapter++) {
      chapters.add(chapter);
      if (chapters.size > 100) throw new Error("Choose 1–100 chapters.");
    }
  }
  if (!chapters.size) throw new Error("Choose 1–100 chapters.");
  return [...chapters].sort((a,b) => a-b);
}
