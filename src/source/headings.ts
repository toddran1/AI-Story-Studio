export type ParsedHeading = { chapter: number; originalTitle: string; title?: string };

export function parseChapterHeading(value: string): ParsedHeading | undefined {
  const originalTitle = value.trim();
  let match = /^chapter\s+0*(\d+)(?:\s*[:.\-–—]\s*|\s+)?(.*)$/i.exec(originalTitle);
  if (match) return parsed(Number(match[1]), originalTitle, match[2]);
  match = /^第\s*0*(\d+)\s*章(?:\s*[:：.\-–—]?\s*)(.*)$/.exec(originalTitle);
  if (match) return parsed(Number(match[1]), originalTitle, match[2]);
  const chinese = /^第\s*([零〇一二两三四五六七八九十百千]+)\s*章(?:\s*[:：.\-–—]?\s*)(.*)$/.exec(originalTitle);
  if (chinese) return parsed(chineseNumber(chinese[1]!), originalTitle, chinese[2]);
  return undefined;
}

function parsed(chapter: number, originalTitle: string, suffix?: string): ParsedHeading | undefined {
  if (!Number.isSafeInteger(chapter) || chapter < 1) return undefined;
  return { chapter, originalTitle, title: suffix?.trim() || undefined };
}

function chineseNumber(value: string): number {
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0; let current = 0;
  for (const char of value) {
    if (char in digits) current = digits[char]!;
    else { const unit = units[char]!; total += (current || 1) * unit; current = 0; }
  }
  return total + current;
}

export function detectTextLanguage(text: string): string | undefined {
  const sample = text.replace(/\s/g, "").slice(0, 5000);
  if (!sample) return undefined;
  const han = (sample.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  if (han >= 10 && han > latin * 0.25) return "zh-CN";
  if (latin >= 20) return "en-US";
  return undefined;
}

