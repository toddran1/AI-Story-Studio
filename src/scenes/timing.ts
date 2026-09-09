import { SceneError } from "../pipeline/errors.js";
import { Scene, SceneSettings } from "./types.js";

export function normalizeSceneTiming(raw: Array<Omit<Scene, "id" | "artwork">>, durationSeconds: number, settings: SceneSettings): Scene[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new SceneError("Scene timing requires a positive chapter duration");
  if (!raw.length) throw new SceneError("Scene planner returned no scenes");
  const idealCount = Math.max(1, Math.ceil(durationSeconds / settings.targetDurationSeconds));
  const maximumUseful = Math.max(1, Math.ceil(durationSeconds / settings.minimumDurationSeconds));
  const count = Math.min(raw.length, settings.maximumScenesPerChapter, Math.max(idealCount, maximumUseful));
  const selected = raw.slice(0, count); const weights = selected.map((scene) => Math.max(.1, scene.endSeconds - scene.startSeconds));
  const total = weights.reduce((sum, value) => sum + value, 0); let cursor = 0;
  return selected.map((scene, index) => {
    const endSeconds = index === selected.length - 1 ? durationSeconds : Math.min(durationSeconds, cursor + durationSeconds * weights[index]! / total);
    const result: Scene = { ...scene, id: `scene-${String(index + 1).padStart(3, "0")}`, startSeconds: round(cursor), endSeconds: round(endSeconds), artwork: { status: "pending", review: "unreviewed" } };
    cursor = endSeconds; return result;
  });
}

export function validateSceneCoverage(scenes: Scene[], durationSeconds: number) {
  if (!scenes.length) throw new SceneError("A scene manifest must contain at least one scene");
  const tolerance = .02; if (Math.abs(scenes[0]!.startSeconds) > tolerance) throw new SceneError("The first scene must start at 0:00");
  for (let index = 0; index < scenes.length; index++) {
    const scene = scenes[index]!; if (scene.endSeconds <= scene.startSeconds) throw new SceneError(`${scene.id} has an invalid time range`);
    if (index && Math.abs(scene.startSeconds - scenes[index - 1]!.endSeconds) > tolerance) throw new SceneError(`${scene.id} must begin where the previous scene ends`);
  }
  if (Math.abs(scenes.at(-1)!.endSeconds - durationSeconds) > tolerance) throw new SceneError("The final scene must end at the mastered chapter duration");
}
const round = (value: number) => Math.round(value * 1000) / 1000;
