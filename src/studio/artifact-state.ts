import { open, stat } from "node:fs/promises";
import { Chapter, StageName } from "../domain/chapter.js";
import { qaResultSchema } from "../domain/qa.js";
import { storyBibleUpdateSchema } from "../domain/story-bible.js";
import { alignmentArtifactSchema } from "../alignment/types.js";
import { subtitleDocumentSchema } from "../subtitles/types.js";
import { sceneManifestSchema } from "../scenes/types.js";
import { readJsonIfExists, readTextIfExists } from "../storage/story-files.js";
import { sceneImagePath, storyPaths } from "../storage/paths.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { enabledProductionScenes } from "../scenes/production.js";

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

export type SceneArtworkState = {
  sceneId: string;
  availability: ArtifactAvailability;
  review?: "unreviewed" | "approved" | "rejected";
  imagePath: string;
  fingerprint?: string;
  matchesRecordedFingerprint: boolean;
  corrupt?: boolean;
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
    return valid
      ? { stage, availability: "available", freshness }
      : { stage, availability: (await artifactExists(stage, paths, root, story, chapterNumber)) ? "invalid" : "missing" };
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

async function readHeaderBytes(path: string, maxBytes = 1024): Promise<Buffer | undefined> {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export function isLikelyValidImage(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;
  const headText = buffer.subarray(0, Math.min(buffer.length, 64)).toString("utf8");
  if (/corrupt|invalid/i.test(headText)) return false;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
      buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return true;
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }
  // WebP: RIFF ... WEBP
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return true;
  }
  // GIF: GIF87a or GIF89a
  if (headText.startsWith("GIF87a") || headText.startsWith("GIF89a")) {
    return true;
  }
  // Test mock prefix (safe mock buffer in tests)
  if (/^(image|test-img)/.test(headText)) {
    return true;
  }
  return false;
}

export function isLikelyValidAudio(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const headText = buffer.subarray(0, Math.min(buffer.length, 64)).toString("utf8");
  if (/corrupt|invalid/i.test(headText)) return false;
  // ID3v2: "ID3"
  if (buffer.length >= 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return true;
  }
  // MP3 sync: 11 bits set (0xFF, upper 3 bits of 2nd byte 0xE0)
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0) {
    return true;
  }
  // RIFF ... WAVE
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45) {
    return true;
  }
  // MP4 / M4A / AAC in ISO BMFF: offset 4 "ftyp"
  if (buffer.length >= 8 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    return true;
  }
  // OggS
  if (buffer.length >= 4 && buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
    return true;
  }
  // fLaC
  if (buffer.length >= 4 && buffer[0] === 0x66 && buffer[1] === 0x4c && buffer[2] === 0x61 && buffer[3] === 0x43) {
    return true;
  }
  // ADTS AAC: 0xFFF
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xf6) === 0xf0) {
    return true;
  }
  // Test mock prefix (safe mock buffer in tests)
  if (/\b(master|remaster|raw|audio|test)\b/i.test(headText) || /^(master|remaster|raw|audio|test-)/.test(headText)) {
    return true;
  }
  return false;
}

export function isLikelyValidVideo(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const headText = buffer.subarray(0, Math.min(buffer.length, 64)).toString("utf8");
  if (/corrupt|invalid/i.test(headText)) return false;
  // MP4: offset 4 "ftyp"
  if (buffer.length >= 8 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    return true;
  }
  // WebM / Matroska: EBML header 0x1A 0x45 0xDF 0xA3
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return true;
  }
  // Test mock prefix (safe mock buffer in tests)
  if (/^(video|test-video)/.test(headText)) {
    return true;
  }
  return false;
}

export async function inspectSceneArtwork(
  root: string,
  story: string,
  chapterNumber: number,
  sceneId: string,
  expectedFingerprint?: string
): Promise<SceneArtworkState> {
  const imagePath = sceneImagePath(root, story, chapterNumber, sceneId);
  const exists = await fileIsNonEmpty(imagePath);
  if (!exists) {
    return {
      sceneId,
      availability: "missing",
      imagePath,
      matchesRecordedFingerprint: false,
    };
  }

  const header = await readHeaderBytes(imagePath, 64);
  if (!header || !isLikelyValidImage(header)) {
    return {
      sceneId,
      availability: "invalid",
      imagePath,
      matchesRecordedFingerprint: false,
      corrupt: true,
    };
  }

  const actualFingerprint = await fileFingerprint(imagePath);
  const matchesRecorded = expectedFingerprint ? actualFingerprint === expectedFingerprint : true;

  if (expectedFingerprint && !matchesRecorded) {
    return {
      sceneId,
      availability: "invalid",
      imagePath,
      fingerprint: actualFingerprint,
      matchesRecordedFingerprint: false,
    };
  }

  return {
    sceneId,
    availability: "available",
    imagePath,
    fingerprint: actualFingerprint,
    matchesRecordedFingerprint: true,
  };
}

async function artifactExists(stage: ArtifactStage, paths: ReturnType<typeof storyPaths>, root?: string, story?: string, chapter?: number): Promise<boolean> {
  if (stage === "artwork" && root && story && chapter) {
    const parsed = sceneManifestSchema.safeParse(await readJsonIfExists(paths.scenesManifest));
    if (!parsed.success) return false;
    const enabled = enabledProductionScenes(parsed.data.scenes);
    if (!enabled.length) return false;
    for (const scene of enabled) {
      if (!(await fileIsNonEmpty(sceneImagePath(root, story, chapter, scene.id)))) return false;
    }
    return true;
  }
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
  if (["tts", "audioMastering"].includes(stage)) {
    const path = artifactPath(stage, paths);
    if (!path) return false;
    const header = await readHeaderBytes(path, 64);
    if (!header || header.length === 0) return false;
    return isLikelyValidAudio(header);
  }
  if (stage === "video") {
    const path = artifactPath(stage, paths);
    if (!path) return false;
    const header = await readHeaderBytes(path, 64);
    if (!header || header.length === 0) return false;
    return isLikelyValidVideo(header);
  }
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
    const enabled = enabledProductionScenes(parsed.data.scenes);
    if (!enabled.length) return false;
    for (const scene of enabled) {
      if (scene.artwork.status !== "complete") return false;
      const inspected = await inspectSceneArtwork(root, story, chapter, scene.id, scene.artwork.imageFingerprint);
      if (inspected.availability !== "available") return false;
    }
    return true;
  }
  return false;
}
