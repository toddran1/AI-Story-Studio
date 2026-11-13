import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CanonicalEntity, StoryBible } from "../domain/story-bible.js";
import { storyPaths } from "../storage/paths.js";
import { readTextIfExists } from "../storage/story-files.js";

export const profileEvidenceRangeSchema = z.object({
  fromChapter: z.number().int().positive(),
  toChapter: z.number().int().positive(),
}).strict().refine(range => range.fromChapter <= range.toChapter, "Last chapter must be on or after first chapter");

type EvidenceRange = z.infer<typeof profileEvidenceRangeSchema>;
type SourceEvidence = { chapter: number; text: string; visualSignalScore: number; artifact: "original" | "translation" };
const wardrobe = /\b(?:j[-\s]?k|uniform|shirt|skirt|trousers|boots?|jacket|coat|robe|clothing|outfit|dressed|wore|wears?|wearing)\b|制服|衣|裙|袍|靴|身穿/giu;
const identity = /\b(?:hair|eyes?|face|skin|complexion|height|build|body|scar|tattoo|petite|physique)\b|頭髮|头发|眼睛|面容|皮膚|皮肤|身高|身材|體格|体格|傷疤|伤疤|容貌/giu;
const gear = /\b(?:weapon|armor|armour|gauntlets?|accessor(?:y|ies)|sword|blade)\b|甲|武器|佩戴|刀|劍|剑/giu;
const score = (text: string) => 3 * Math.min(3, [...text.matchAll(wardrobe)].length)
  + 2 * Math.min(4, [...text.matchAll(identity)].length) + Math.min(2, [...text.matchAll(gear)].length);
const compact = (value: string) => value.trim().replace(/\s+/g, " ");
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function profileEvidenceAnchors(entity: CanonicalEntity) {
  return [...new Set([entity.canonicalName, entity.originalName, entity.preferredNarrationName, entity.localizedNaming?.fullName, ...entity.aliases]
    .filter((value): value is string => Boolean(value?.trim())).map(value => value.trim()))].sort((a, b) => b.length - a.length);
}

export async function collectProfileSourceEvidence(root: string, slug: string, bible: StoryBible, entity: CanonicalEntity, range?: EvidenceRange): Promise<SourceEvidence[]> {
  const anchors = profileEvidenceAnchors(entity);
  if (!anchors.length) return [];
  const names = new RegExp(anchors.map(anchor => {
    const escaped = escapeRegex(anchor);
    return /^[\w\s'.-]+$/.test(anchor) ? `\\b${escaped}\\b` : escaped;
  }).join("|"), "giu");
  const chapters = new Set([
    entity.firstAppearance, entity.lastKnownAppearance,
    ...entity.provenance.map(item => item.chapter),
    ...(entity.visualEvidence ?? []).flatMap(item => [item.chapter, item.lastObservedChapter, ...item.provenance.map(source => source.chapter)]),
    ...bible.entityTimeline.filter(item => item.entityId === entity.id).map(item => item.chapter),
    ...Object.entries(bible.chapterSummaries).filter(([, summary]) => summary.search(names) >= 0).map(([chapter]) => Number(chapter)),
  ]);
  if (range) {
    const entries = await readdir(join(storyPaths(root, slug, 1).story, "chapters")).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) if (/^\d+$/.test(entry)) chapters.add(Number(entry));
  }
  const selected = [...chapters].filter(chapter => Number.isSafeInteger(chapter) && chapter > 0 && (!range || chapter >= range.fromChapter && chapter <= range.toChapter));
  const evidence: SourceEvidence[] = [];
  for (let offset = 0; offset < selected.length; offset += 12) {
    const results = await Promise.all(selected.slice(offset, offset + 12).map(async chapter => {
      const paths = storyPaths(root, slug, chapter);
      const [english, original] = await Promise.all([readTextIfExists(paths.english), readTextIfExists(paths.original)]);
      const passages: SourceEvidence[] = [];
      for (const [artifact, text] of [["translation", english], ["original", original]] as const) {
        if (!text) continue;
        for (const match of text.matchAll(names)) {
          const start = match.index ?? 0;
          const excerpt = compact(text.slice(Math.max(0, start - 200), start + match[0].length + 420));
          const visualSignalScore = score(excerpt) + 2 * score(text.slice(Math.max(0, start - 170), start + match[0].length + 145));
          if (visualSignalScore && !passages.some(item => item.text === excerpt)) passages.push({ chapter, text: excerpt, visualSignalScore, artifact });
        }
      }
      return passages.sort((left, right) => right.visualSignalScore - left.visualSignalScore).slice(0, 2);
    }));
    evidence.push(...results.flat());
  }
  const ranked = evidence.sort((left, right) => right.visualSignalScore - left.visualSignalScore || left.chapter - right.chapter);
  const chaptersSeen = new Set<number>();
  const distinct = ranked.filter(item => {
    if (chaptersSeen.has(item.chapter)) return false;
    chaptersSeen.add(item.chapter);
    return true;
  });
  const diverse = [...new Set([wardrobe, identity, gear].map(signal => ranked.find(item => [...item.text.matchAll(signal)].length)).filter(item => item !== undefined))];
  return [...new Set([...diverse, ...distinct, ...ranked])].slice(0, 8);
}
