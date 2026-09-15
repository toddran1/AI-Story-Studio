import { z } from "zod";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { withStoryLock } from "../storage/story-lock.js";
import { Chapter, StageName, chapterSchema } from "../domain/chapter.js";
import { fingerprint } from "../utils/hash.js";
import { fileFingerprint, filesFingerprint } from "../utils/file-fingerprint.js";
import { recordActivity } from "./projects.js";
import { sceneManifestSchema } from "../scenes/types.js";

export const markCurrentStageSchema = z.enum(["translation", "narration", "qa", "storyBible", "continuity", "tts", "audioMastering", "alignment", "subtitles", "scenePlanning", "artwork", "video"]);
export type MarkCurrentStage = z.infer<typeof markCurrentStageSchema>;
export const markCurrentInputSchema = z.object({
  chapters: z.array(z.number().int().positive()).min(1).max(2_000),
  stages: z.array(markCurrentStageSchema).min(1),
  reason: z.string().trim().max(500).optional(),
}).strict();

type Inspection = { chapter: number; stage: MarkCurrentStage; state: "eligible" | "current" | "missing" | "ineligible"; reason?: string };
export async function inspectStagesForCurrent(root: string, slug: string, chapters: number[]) {
  if (!(await readJsonIfExists(storyPaths(root, slug, 1).storyConfig))) throw new Error(`Story '${slug}' was not found`);
  const items: Inspection[] = [];
  for (const chapter of [...new Set(chapters)].sort((a, b) => a - b)) for (const stage of markCurrentStageSchema.options) items.push(await inspectStage(root, slug, chapter, stage));
  return { items, stages: markCurrentStageSchema.options.map((stage) => ({ stage, eligible: items.filter((item) => item.stage === stage && item.state === "eligible").length, current: items.filter((item) => item.stage === stage && item.state === "current").length, missing: items.filter((item) => item.stage === stage && item.state === "missing").length, ineligible: items.filter((item) => item.stage === stage && item.state === "ineligible").length })) };
}

export async function markStagesCurrent(root: string, slug: string, raw: unknown) {
  const input = markCurrentInputSchema.parse(raw);
  if (!(await readJsonIfExists(storyPaths(root, slug, 1).storyConfig))) throw new Error(`Story '${slug}' was not found`);
  return withStoryLock(root, slug, "mark stages current", async () => {
    const changed: Array<{ chapter: number; stage: MarkCurrentStage }> = []; const current: Array<{ chapter: number; stage: MarkCurrentStage }> = []; const missing: Inspection[] = []; const ineligible: Inspection[] = [];
    for (const chapterNumber of [...new Set(input.chapters)].sort((a, b) => a - b)) {
      const paths = storyPaths(root, slug, chapterNumber); const rawChapter = await readJsonIfExists<Chapter>(paths.chapterMeta);
      if (!rawChapter) { for (const stage of input.stages) missing.push({ chapter: chapterNumber, stage, state: "missing", reason: "Chapter metadata is missing" }); continue; }
      const chapter = chapterSchema.parse(rawChapter); let dirty = false;
      for (const stage of input.stages) {
        const inspected = await inspectStage(root, slug, chapterNumber, stage, chapter);
        if (inspected.state === "current") { current.push({ chapter: chapterNumber, stage }); continue; }
        if (inspected.state === "missing") { missing.push(inspected); continue; }
        if (inspected.state === "ineligible") { ineligible.push(inspected); continue; }
        const outputFingerprint = await artifactFingerprint(paths, stage);
        if (!outputFingerprint) { missing.push({ chapter: chapterNumber, stage, state: "missing", reason: "Artifact is missing or empty" }); continue; }
        const previous = chapter.stages[stage]; const acceptedFingerprint = fingerprint({ version: "manual-stage-acceptance-v1", stage, outputFingerprint, reason: input.reason });
        chapter.stages[stage] = { ...previous, status: "complete", fingerprint: `manual-accept:${acceptedFingerprint}`, outputFingerprint, error: undefined, staleReason: undefined, manualReviewRequired: undefined, completedAt: new Date().toISOString(), manualAcceptance: { acceptedAt: new Date().toISOString(), acceptedReason: input.reason || undefined, previousFingerprint: previous.fingerprint, acceptedFingerprint } };
        changed.push({ chapter: chapterNumber, stage }); dirty = true;
      }
      if (dirty) { chapter.updatedAt = new Date().toISOString(); await atomicWriteJson(paths.chapterMeta, chapterSchema.parse(chapter)); }
    }
    if (changed.length) await recordActivity(root, slug, "stages.mark-current", `Marked ${changed.length} existing stage artifact${changed.length === 1 ? "" : "s"} current without regeneration`);
    return { changed, current, missing, ineligible };
  });
}

async function inspectStage(root: string, slug: string, chapterNumber: number, stage: MarkCurrentStage, loaded?: Chapter): Promise<Inspection> {
  const paths = storyPaths(root, slug, chapterNumber); const raw = loaded ?? await readJsonIfExists<Chapter>(paths.chapterMeta);
  if (!raw) return { chapter: chapterNumber, stage, state: "missing", reason: "Chapter metadata is missing" };
  const chapter = loaded ?? chapterSchema.parse(raw); const state = chapter.stages[stage];
  if (state.status === "failed") return { chapter: chapterNumber, stage, state: "ineligible", reason: "The stage failed and must be regenerated or repaired" };
  if (state.status === "running") return { chapter: chapterNumber, stage, state: "ineligible", reason: "The stage is currently running" };
  const actual = await artifactFingerprint(paths, stage);
  if (!actual) return { chapter: chapterNumber, stage, state: "missing", reason: "No complete artifact is available" };
  if (state.outputFingerprint && state.outputFingerprint !== actual) return { chapter: chapterNumber, stage, state: "ineligible", reason: "The artifact changed after it was generated" };
  if (state.status === "complete") return { chapter: chapterNumber, stage, state: "current" };
  return { chapter: chapterNumber, stage, state: "eligible", reason: state.staleReason };
}

async function artifactFingerprint(paths: ReturnType<typeof storyPaths>, stage: MarkCurrentStage) {
  if (stage === "subtitles") return filesFingerprint([paths.subtitlesSrt, paths.subtitlesVtt, paths.subtitlesDocument]);
  if (stage === "artwork") {
    const raw = await readJsonIfExists(paths.scenesManifest); const parsed = raw ? sceneManifestSchema.safeParse(raw) : undefined;
    return parsed?.success ? fingerprint(parsed.data.scenes.map((scene) => ({ id: scene.id, fingerprint: scene.artwork.fingerprint, imageFingerprint: scene.artwork.imageFingerprint, review: scene.artwork.review }))) : undefined;
  }
  const path: Record<Exclude<MarkCurrentStage, "subtitles" | "artwork">, string> = { translation: paths.english, narration: paths.narration, qa: paths.qa, storyBible: paths.bibleUpdate, continuity: paths.continuityAnalysis, tts: paths.audioRaw, audioMastering: paths.audio, alignment: paths.alignment, scenePlanning: paths.scenesManifest, video: paths.video };
  return fileFingerprint(path[stage as Exclude<MarkCurrentStage, "subtitles" | "artwork">]);
}
