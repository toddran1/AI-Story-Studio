import { z } from "zod";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { withStoryLock } from "../storage/story-lock.js";
import { Chapter, StageName, chapterSchema } from "../domain/chapter.js";
import { Story } from "../domain/story.js";
import { loadStory } from "../config/load-config.js";
import { fingerprint } from "../utils/hash.js";
import { fileFingerprint, filesFingerprint } from "../utils/file-fingerprint.js";
import { recordActivity } from "./projects.js";
import { sceneManifestSchema } from "../scenes/types.js";
import { enabledProductionScenes } from "../scenes/production.js";
import { qaResultSchema } from "../domain/qa.js";
import { storyBibleUpdateSchema } from "../domain/story-bible.js";
import { alignmentArtifactSchema } from "../alignment/types.js";
import { subtitleDocumentSchema } from "../subtitles/types.js";

export const markCurrentStageSchema = z.enum(["translation", "narration", "qa", "storyBible", "continuity", "tts", "audioMastering", "alignment", "subtitles", "scenePlanning", "artwork", "video"]);
export type MarkCurrentStage = z.infer<typeof markCurrentStageSchema>;
export const markCurrentInputSchema = z.object({
  chapters: z.array(z.number().int().positive()).min(1).max(2_000),
  stages: z.array(markCurrentStageSchema).min(1),
  reason: z.string().trim().max(500).optional(),
}).strict();

/**
 * A manual approval belongs to both the exact artifact and the story
 * configuration the reviewer saw. It is deliberately not a permanent bypass.
 */
export function manualAcceptanceFingerprint(stage: StageName, outputFingerprint: string, story: Story) {
  return fingerprint({ version: "manual-stage-acceptance-v2", stage, outputFingerprint, configuration: story });
}

type Inspection = { chapter: number; stage: MarkCurrentStage; state: "eligible" | "current" | "missing" | "ineligible"; reason?: string; manuallyAccepted?: boolean };
export async function inspectStagesForCurrent(root: string, slug: string, chapters: number[]) {
  const story = await storyForAcceptance(root, slug);
  const items: Inspection[] = [];
  for (const chapter of [...new Set(chapters)].sort((a, b) => a - b)) for (const stage of markCurrentStageSchema.options) items.push(await inspectStage(root, slug, chapter, stage));
  return { items, stages: markCurrentStageSchema.options.map((stage) => ({ stage, eligible: items.filter((item) => item.stage === stage && item.state === "eligible").length, current: items.filter((item) => item.stage === stage && item.state === "current").length, manuallyAccepted: items.filter((item) => item.stage === stage && item.manuallyAccepted).length, missing: items.filter((item) => item.stage === stage && item.state === "missing").length, ineligible: items.filter((item) => item.stage === stage && item.state === "ineligible").length })), configurationFingerprint: fingerprint(story) };
}

export async function markStagesCurrent(root: string, slug: string, raw: unknown) {
  const input = markCurrentInputSchema.parse(raw);
  const story = await storyForAcceptance(root, slug);
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
        const previous = chapter.stages[stage]; const acceptedFingerprint = manualAcceptanceFingerprint(stage, outputFingerprint, story); const acceptedAt = new Date().toISOString();
        chapter.stages[stage] = { ...previous, status: "complete", fingerprint: `manual-accept:${acceptedFingerprint}`, outputFingerprint, error: undefined, staleReason: undefined, manualReviewRequired: undefined, completedAt: previous.completedAt ?? acceptedAt, manualAcceptance: { acceptedAt, acceptedReason: input.reason || undefined, previousFingerprint: previous.fingerprint, acceptedFingerprint } };
        changed.push({ chapter: chapterNumber, stage }); dirty = true;
      }
      if (dirty) { chapter.updatedAt = new Date().toISOString(); await atomicWriteJson(paths.chapterMeta, chapterSchema.parse(chapter)); }
    }
    if (changed.length) await recordActivity(root, slug, "stages.mark-current", `Marked ${changed.length} existing stage artifact${changed.length === 1 ? "" : "s"} current without regeneration`);
    return { changed, alreadyCurrent: current, missingArtifacts: missing, ineligible, skipped: [...current, ...missing, ...ineligible] };
  });
}

async function inspectStage(root: string, slug: string, chapterNumber: number, stage: MarkCurrentStage, loaded?: Chapter): Promise<Inspection> {
  const paths = storyPaths(root, slug, chapterNumber); const raw = loaded ?? await readJsonIfExists<Chapter>(paths.chapterMeta);
  if (!raw) return { chapter: chapterNumber, stage, state: "missing", reason: "Chapter metadata is missing" };
  const chapter = loaded ?? chapterSchema.parse(raw); const state = chapter.stages[stage];
  if (state.status === "failed") return { chapter: chapterNumber, stage, state: "ineligible", reason: "The stage failed and must be regenerated or repaired" };
  if (state.status === "running") return { chapter: chapterNumber, stage, state: "ineligible", reason: "The stage is currently running" };
  if (!(await artifactIsReadable(paths, stage))) return { chapter: chapterNumber, stage, state: "ineligible", reason: "The retained artifact is unreadable or malformed" };
  const actual = await artifactFingerprint(paths, stage);
  if (!actual) return { chapter: chapterNumber, stage, state: "missing", reason: "No complete artifact is available" };
  if (state.outputFingerprint && state.outputFingerprint !== actual) return { chapter: chapterNumber, stage, state: "ineligible", reason: "The artifact changed after it was generated" };
  if (state.status === "complete") return { chapter: chapterNumber, stage, state: "current", manuallyAccepted: Boolean(state.manualAcceptance) };
  return { chapter: chapterNumber, stage, state: "eligible", reason: state.staleReason };
}

async function artifactFingerprint(paths: ReturnType<typeof storyPaths>, stage: MarkCurrentStage) {
  if (stage === "subtitles") return filesFingerprint([paths.subtitlesSrt, paths.subtitlesVtt, paths.subtitlesDocument]);
  if (stage === "artwork") {
    const raw = await readJsonIfExists(paths.scenesManifest); const parsed = raw ? sceneManifestSchema.safeParse(raw) : undefined;
    if (!parsed?.success) return undefined;
    return fingerprint(enabledProductionScenes(parsed.data.scenes).map((scene) => ({ id: scene.id, fingerprint: scene.artwork.fingerprint, imageFingerprint: scene.artwork.imageFingerprint, review: scene.artwork.review })));
  }
  const path: Record<Exclude<MarkCurrentStage, "subtitles" | "artwork">, string> = { translation: paths.english, narration: paths.narration, qa: paths.qa, storyBible: paths.bibleUpdate, continuity: paths.continuityAnalysis, tts: paths.audioRaw, audioMastering: paths.audio, alignment: paths.alignment, scenePlanning: paths.scenesManifest, video: paths.video };
  return fileFingerprint(path[stage as Exclude<MarkCurrentStage, "subtitles" | "artwork">]);
}

async function artifactIsReadable(paths: ReturnType<typeof storyPaths>, stage: MarkCurrentStage) {
  const parse = async (path: string, schema: z.ZodType) => { try { const raw = await readJsonIfExists(path); return Boolean(raw && schema.safeParse(raw).success); } catch { return false; } };
  if (stage === "qa") return parse(paths.qa, qaResultSchema);
  if (stage === "storyBible") return parse(paths.bibleUpdate, storyBibleUpdateSchema);
  if (stage === "alignment") return parse(paths.alignment, alignmentArtifactSchema);
  if (stage === "subtitles") return parse(paths.subtitlesDocument, subtitleDocumentSchema);
  if (stage === "continuity") return parse(paths.continuityAnalysis, z.object({ version: z.number(), chapter: z.number().int().positive(), inputFingerprint: z.string(), analyzedAt: z.string() }));
  if (stage === "scenePlanning") return parse(paths.scenesManifest, sceneManifestSchema);
  if (stage === "artwork") {
    const raw = await readJsonIfExists(paths.scenesManifest); const parsed = raw ? sceneManifestSchema.safeParse(raw) : undefined;
    return Boolean(parsed?.success && enabledProductionScenes(parsed.data.scenes).length);
  }
  return true;
}

async function storyForAcceptance(root: string, slug: string) {
  const path = storyPaths(root, slug, 1).storyConfig;
  if (!(await readJsonIfExists(path))) throw new Error(`Story '${slug}' was not found`);
  return loadStory(path);
}
