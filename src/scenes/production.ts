import type { Scene, SceneSettings } from "./types.js";
import { SceneError } from "../pipeline/errors.js";
import { boundedDurations, validateSceneCoverage } from "./timing.js";

/** Scenes that participate in Chapter artwork/video production. Stored plans retain disabled scenes and their history. */
export function enabledProductionScenes<T extends { disabled?: boolean }>(scenes: readonly T[]): T[] {
  return scenes.filter((scene) => !scene.disabled);
}

export function nextSceneId(scenes: readonly Pick<Scene, "id">[], nextSceneNumber?: number): string {
  const next = Math.max(nextSceneNumber ?? 1, Math.max(0, ...scenes.map((scene) => Number(scene.id.slice(6)) || 0)) + 1);
  if (next > 999) throw new SceneError("Scene ID limit reached");
  return `scene-${String(next).padStart(3, "0")}`;
}

/** A new scene starts disabled so its blank visual fields cannot enter artwork or video. */
export function emptySceneAtEnd(scenes: readonly Scene[], durationSeconds: number, nextSceneNumber?: number): Scene {
  if (!scenes.length) throw new SceneError("Create a scene plan before adding a scene");
  return {
    id: nextSceneId(scenes, nextSceneNumber), summary: "", visualPrompt: "", characters: [], entityIds: [],
    startSeconds: Math.max(0, durationSeconds - Math.min(10, durationSeconds / 2)), endSeconds: durationSeconds,
    importance: "standard", disabled: true, artwork: { status: "pending", review: "unreviewed", versions: [] },
  };
}

/** Derive a contiguous, deterministic production timeline without mutating the saved scene records. */
export function retimeScenesToDuration(scenes: readonly Scene[], durationSeconds: number, settings?: SceneSettings): Scene[] {
  if (!scenes.length) throw new SceneError("At least one enabled scene is required for a production timeline");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new SceneError("Scene timing requires a positive chapter duration");
  const weights = scenes.map((scene) => Math.max(0.1, scene.endSeconds - scene.startSeconds));
  const durations = settings
    ? boundedDurations(weights, durationSeconds, settings.minimumDurationSeconds, settings.maximumDurationSeconds)
    : weights.map((weight) => durationSeconds * weight / weights.reduce((sum, value) => sum + value, 0));
  let cursor = 0;
  const retimed = scenes.map((scene, index) => {
    const startSeconds = round(cursor);
    const endSeconds = index === scenes.length - 1 ? durationSeconds : round(cursor + durations[index]!);
    cursor = endSeconds;
    return { ...scene, startSeconds, endSeconds };
  });
  validateSceneCoverage(retimed, durationSeconds, settings);
  return retimed;
}

function round(value: number) { return Math.round(value * 1000) / 1000; }
