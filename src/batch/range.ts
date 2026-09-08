import { BatchValidationError } from "../pipeline/errors.js";
import { DiscoveredChapter } from "./types.js";

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
