import { StoryBible, StoryBibleUpdate, storyBibleSchema } from "../domain/story-bible.js";

type Named = { canonicalEnglishName: string; originalName: string; description: string; firstSeenChapter: number; lastSeenChapter: number; aliases?: string[]; gender?: string; pronouns?: string[] };

function mergeNamed(existing: Named[], incoming: Named[]): Named[] {
  const output = structuredClone(existing);
  for (const item of incoming) {
    const match = output.find((old) =>
      (old.originalName && item.originalName && old.originalName === item.originalName) ||
      old.canonicalEnglishName.toLocaleLowerCase() === item.canonicalEnglishName.toLocaleLowerCase(),
    );
    if (!match) { output.push(item); continue; }
    // Existing canonical English is deliberately never overwritten.
    match.firstSeenChapter = Math.min(match.firstSeenChapter, item.firstSeenChapter);
    match.lastSeenChapter = Math.max(match.lastSeenChapter, item.lastSeenChapter);
    if (item.description && !match.description.includes(item.description)) match.description = [match.description, item.description].filter(Boolean).join(" ");
    if (match.aliases || item.aliases) match.aliases = [...new Set([...(match.aliases ?? []), ...(item.aliases ?? []), ...(match.canonicalEnglishName !== item.canonicalEnglishName ? [item.canonicalEnglishName] : [])])];
    if (!match.gender && item.gender) match.gender = item.gender;
    if (match.pronouns || item.pronouns) match.pronouns = [...new Set([...(match.pronouns ?? []), ...(item.pronouns ?? [])])];
  }
  return output;
}

export function mergeStoryBible(existing: StoryBible, update: StoryBibleUpdate, chapter: number): StoryBible {
  const result = structuredClone(existing) as Record<string, unknown>;
  for (const key of ["characters", "locations", "factions", "abilities", "classes", "ranks", "items", "creatures", "systemTerms"] as const) {
    result[key] = mergeNamed(existing[key] as Named[], update[key] as Named[]);
  }
  result.relationships = mergeUnique(existing.relationships, update.relationships, (x) => `${x.subject}\0${x.relationship}\0${x.object}`);
  result.translationTerms = mergeTerms(existing.translationTerms, update.translationTerms);
  result.chapterSummaries = { ...existing.chapterSummaries, [String(chapter)]: update.chapterSummary };
  result.version = existing.version + 1;
  return storyBibleSchema.parse(result);
}

function mergeUnique<T extends { firstSeenChapter: number; lastSeenChapter: number }>(existing: T[], incoming: T[], key: (item: T) => string): T[] {
  const out = structuredClone(existing);
  for (const item of incoming) {
    const match = out.find((old) => key(old).toLowerCase() === key(item).toLowerCase());
    if (!match) out.push(item);
    else { match.firstSeenChapter = Math.min(match.firstSeenChapter, item.firstSeenChapter); match.lastSeenChapter = Math.max(match.lastSeenChapter, item.lastSeenChapter); }
  }
  return out;
}

function mergeTerms(existing: StoryBible["translationTerms"], incoming: StoryBibleUpdate["translationTerms"]) {
  const out = structuredClone(existing);
  for (const item of incoming) {
    const match = out.find((old) => old.original === item.original);
    if (!match) out.push(item);
    else {
      // Original text is the stable key; preserve its established canonical translation.
      match.firstSeenChapter = Math.min(match.firstSeenChapter, item.firstSeenChapter);
      match.lastSeenChapter = Math.max(match.lastSeenChapter, item.lastSeenChapter);
      if (item.notes && !match.notes.includes(item.notes)) match.notes = [match.notes, item.notes].filter(Boolean).join(" ");
    }
  }
  return out;
}

export function contextBeforeChapter(bible: StoryBible, chapter: number): StoryBible {
  const result = structuredClone(bible);
  for (const key of ["characters", "locations", "factions", "abilities", "classes", "ranks", "items", "creatures", "systemTerms", "relationships", "translationTerms"] as const) {
    (result[key] as Array<{ firstSeenChapter: number }>) = result[key].filter((item) => item.firstSeenChapter < chapter) as never;
  }
  result.chapterSummaries = Object.fromEntries(Object.entries(result.chapterSummaries).filter(([number]) => Number(number) < chapter));
  // The cumulative file may include this chapter from an earlier run. Context
  // versioning must describe only prior chapters so reruns remain cache-stable.
  result.version = Object.keys(result.chapterSummaries).length;
  return result;
}
