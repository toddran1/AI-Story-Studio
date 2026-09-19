import { stat } from "node:fs/promises";
import { Chapter, StageName } from "../domain/chapter.js";
import { qaResultSchema } from "../domain/qa.js";
import { storyBibleUpdateSchema } from "../domain/story-bible.js";
import { alignmentArtifactSchema } from "../alignment/types.js";
import { subtitleDocumentSchema } from "../subtitles/types.js";
import { sceneManifestSchema } from "../scenes/types.js";
import { readJsonIfExists, readTextIfExists } from "../storage/story-files.js";
import { sceneImagePath, storyPaths } from "../storage/paths.js";

/** `context` is a local, derived artifact visible to planning even though it is
 * not a user-selectable Chapter stage. */
export type ArtifactStage = StageName | "context";
export type ArtifactAvailability = "available" | "missing" | "invalid";
export type ArtifactFreshness = "current" | "stale";
export type StageArtifactState = {
  stage: ArtifactStage;
  availability: ArtifactAvailability;
  freshness?: ArtifactFreshness;
};

/**
 * The canonical artifact classification used by both planning and services.
 * AVAIL: an artifact is usable when it exists, is non-empty, and parses —
 * staleness never blocks use. Freshness is derived from stage metadata only
 * (complete && no staleReason → current) and is reported, never enforced here.
 */
export async function inspectStageArtifact(root: string, story: string, chapterNumber: number, stage: ArtifactStage): Promise<StageArtifactState> {
  const paths = storyPaths(root, story, chapterNumber);
  const chapter = await readJsonIfExists<Chapter>(paths.chapterMeta);
  const freshness = stageFreshness(chapter, stage);
  try {
    const valid = await artifactIsValid(stage, paths, root, story, chapterNumber);
    return valid ? { stage, availability: "available", freshness } : { stage, availability: await artifactExists(stage, paths) ? "invalid" : "missing" };
  } catch {
    return { stage, availability: "invalid" };
  }
}

export function stageFreshness(chapter: Chapter | undefined, stage: ArtifactStage): ArtifactFreshness {
  const state = stage === "context" ? chapter?.stages?.storyBible : chapter?.stages?.[stage];
  return state?.status === "complete" && !state.staleReason ? "current" : "stale";
}

/** Non-blocking notice recorded when a stage proceeds with a stale prerequisite. */
export function stalePrerequisiteWarning(stage: ArtifactStage): string {
  switch (stage) {
    case "translation": return "Using stale translation — it may not reflect the latest source changes.";
    case "narration": return "Using stale narration — it may not reflect the latest Translation changes.";
    case "context": return "Using stale story context.";
    case "tts": return "Using stale raw TTS audio — it may not reflect the latest Narration changes.";
    case "audioMastering": return "Using stale mastered audio.";
    case "alignment": return "Using stale alignment.";
    case "subtitles": return "Using stale subtitles.";
    case "scenePlanning": return "Using stale scene plan — it may not reflect the latest Narration changes.";
    case "artwork": return "Using stale artwork.";
    default: return `Using stale ${stage}.`;
  }
}

export async function fileIsNonEmpty(path: string): Promise<boolean> {
  try { return (await stat(path)).size > 0; } catch { return false; }
}

async function artifactExists(stage: ArtifactStage, paths: ReturnType<typeof storyPaths>): Promise<boolean> {
  const path = artifactPath(stage, paths);
  return path ? fileIsNonEmpty(path) : false;
}

function artifactPath(stage: ArtifactStage, paths: ReturnType<typeof storyPaths>): string | undefined {
  return ({ ingestion: paths.original, translation: paths.english, narration: paths.narration, qa: paths.qa,
    storyBible: paths.bibleUpdate, context: paths.storyContext, continuity: paths.continuityAnalysis,
    tts: paths.audioRaw, audioMastering: paths.audio, alignment: paths.alignment, subtitles: paths.subtitlesDocument,
    scenePlanning: paths.scenesManifest, video: paths.video } as Partial<Record<ArtifactStage, string>>)[stage];
}

async function artifactIsValid(stage: ArtifactStage, paths: ReturnType<typeof storyPaths>, root: string, story: string, chapter: number): Promise<boolean> {
  if (["ingestion", "translation", "narration"].includes(stage)) return Boolean((await readTextIfExists(artifactPath(stage, paths)!))?.trim());
  if (["tts", "audioMastering", "video"].includes(stage)) return artifactExists(stage, paths);
  if (stage === "qa") return qaResultSchema.safeParse(await readJsonIfExists(paths.qa)).success;
  if (stage === "storyBible") return storyBibleUpdateSchema.safeParse(await readJsonIfExists(paths.bibleUpdate)).success;
  if (stage === "alignment") return alignmentArtifactSchema.safeParse(await readJsonIfExists(paths.alignment)).success;
  if (stage === "subtitles") return subtitleDocumentSchema.safeParse(await readJsonIfExists(paths.subtitlesDocument)).success;
  if (stage === "context" || stage === "continuity") {
    const data = await readJsonIfExists(artifactPath(stage, paths)!);
    return Boolean(data && typeof data === "object");
  }
  if (stage === "scenePlanning" || stage === "artwork") {
    const parsed = sceneManifestSchema.safeParse(await readJsonIfExists(paths.scenesManifest));
    if (!parsed.success || !parsed.data.scenes.length) return false;
    if (stage === "scenePlanning") return true;
    for (const scene of parsed.data.scenes) {
      if (scene.artwork.status !== "complete" || !(await fileIsNonEmpty(sceneImagePath(root, story, chapter, scene.id)))) return false;
    }
    return true;
  }
  return false;
}
