import type { MinorEntityReference } from "../domain/story-bible.js";

const MAX_SOURCE_EVIDENCE = 20;
type Evidence = MinorEntityReference["sourceEvidence"][number];

/** Keep the first sighting and the most recent chapter evidence within the stored schema limit. */
export function boundedMinorReferenceEvidence(evidence: readonly Evidence[]): Evidence[] {
  const byChapter = new Map<number, Evidence>();
  for (const item of evidence) {
    const previous = byChapter.get(item.chapter);
    if (!previous || (!previous.excerpt && item.excerpt)) byChapter.set(item.chapter, item);
  }
  const ordered = [...byChapter.values()].sort((left, right) => left.chapter - right.chapter);
  return ordered.length <= MAX_SOURCE_EVIDENCE ? ordered : [ordered[0]!, ...ordered.slice(-(MAX_SOURCE_EVIDENCE - 1))];
}
