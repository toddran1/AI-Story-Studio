import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CanonicalEntity, StoryBible, storyBibleSchema } from "../domain/story-bible.js";
import { Chapter, StageName, chapterSchema } from "../domain/chapter.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { applyCanonicalOverlay } from "./canonical.js";

const downstream: StageName[] = ["qa", "tts", "audioMastering", "alignment", "subtitles", "scenePlanning", "artwork", "video"];

export function narrationNamingChanged(before: CanonicalEntity, after: CanonicalEntity) {
  return before.preferredNarrationName !== after.preferredNarrationName || JSON.stringify(before.aliasNarrationRules) !== JSON.stringify(after.aliasNarrationRules);
}

export async function loadNarrationNamingEntities(root: string, slug: string) {
  const raw = await readJsonIfExists<StoryBible>(storyPaths(root, slug, 1).bible); if (!raw) return [];
  return (await applyCanonicalOverlay(root, slug, storyBibleSchema.parse(raw))).bible.canonicalEntities.filter((entity) => entity.preferredNarrationName || entity.aliasNarrationRules.length);
}

export async function invalidateNarrationNamingChange(root: string, slug: string, before: CanonicalEntity, after: CanonicalEntity) {
  if (!narrationNamingChanged(before, after)) return { affectedChapters: [] as number[], manualNarrationChapters: [] as number[] };
  const story = storyPaths(root, slug, 1).story;
  const chapterRoot = join(story, "chapters");
  const entries = await readdir(chapterRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const available = entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map((entry) => Number(entry.name)).filter(Number.isSafeInteger).sort((a, b) => a - b);
  const affected = new Set([...before.provenance, ...after.provenance].map((item) => item.chapter));
  const names = [...new Set([before.canonicalName, before.originalName, ...before.aliases, after.canonicalName, after.originalName, ...after.aliases].map((value) => value.trim().toLocaleLowerCase()).filter(Boolean))];

  for (const chapter of available) {
    const paths = storyPaths(root, slug, chapter);
    const artifacts = await Promise.all([paths.original, paths.english, paths.storyContext].map((path) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; })));
    const text = artifacts.join("\n").toLocaleLowerCase();
    if (text.includes(before.id.toLocaleLowerCase()) || names.some((name) => text.includes(name))) affected.add(chapter);
  }
  if (!affected.size && available.length) for (const chapter of available) if (chapter >= Math.min(before.firstAppearance, after.firstAppearance) && chapter <= Math.max(before.lastKnownAppearance, after.lastKnownAppearance)) affected.add(chapter);

  const reason = `Narration naming preferences changed for ${after.canonicalName}`;
  const manualNarrationChapters: number[] = [];
  for (const chapterNumber of [...affected].sort((a, b) => a - b)) {
    const path = storyPaths(root, slug, chapterNumber).chapterMeta;
    const raw = await readJsonIfExists<Chapter>(path); if (!raw) continue;
    const chapter = chapterSchema.parse(raw); const narration = chapter.stages.narration;
    if (narration.provider === "manual" && narration.status === "complete") {
      chapter.stages.narration = { ...narration, staleReason: reason, manualReviewRequired: true };
      manualNarrationChapters.push(chapterNumber);
    } else chapter.stages.narration = { status: "pending", staleReason: reason };
    for (const stage of downstream) chapter.stages[stage] = { status: "pending", staleReason: reason };
    chapter.updatedAt = new Date().toISOString(); await atomicWriteJson(path, chapter);
  }
  const exportsDirectory = join(story, "exports");
  const exportNames = await readdir(exportsDirectory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  for (const name of exportNames) if (name.endsWith(".json")) await rm(join(exportsDirectory, name), { force: true });
  return { affectedChapters: [...affected].filter((chapter) => available.includes(chapter)).sort((a, b) => a - b), manualNarrationChapters };
}
