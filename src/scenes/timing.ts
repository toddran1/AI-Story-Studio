import { SceneError } from "../pipeline/errors.js";
import { Scene, SceneSettings } from "./types.js";

export function normalizeSceneTiming(raw: Array<Omit<Scene, "id" | "artwork">>, durationSeconds: number, settings: SceneSettings): Scene[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new SceneError("Scene timing requires a positive chapter duration");
  if (!raw.length) throw new SceneError("Scene planner returned no scenes");
  const minimumRequired = Math.max(1, Math.ceil(durationSeconds / settings.maximumDurationSeconds));
  const maximumUseful = Math.max(1, Math.floor(durationSeconds / settings.minimumDurationSeconds));
  if (minimumRequired > settings.maximumScenesPerChapter) throw new SceneError(`Chapter duration requires at least ${minimumRequired} scenes, above the configured maximum of ${settings.maximumScenesPerChapter}`);
  if (raw.length < minimumRequired) throw new SceneError(`Scene planner returned ${raw.length} scene(s), but at least ${minimumRequired} are required to stay within the ${settings.maximumDurationSeconds}-second maximum`);
  const idealCount = Math.max(minimumRequired, Math.min(maximumUseful, Math.round(durationSeconds / settings.targetDurationSeconds)));
  const count = Math.min(raw.length, settings.maximumScenesPerChapter, idealCount);
  const selected = raw.slice(0, count); const weights = selected.map((scene) => Math.max(.1, scene.endSeconds - scene.startSeconds));
  const durations = boundedDurations(weights, durationSeconds, settings.minimumDurationSeconds, settings.maximumDurationSeconds); let cursor = 0;
  return selected.map((scene, index) => {
    const endSeconds = index === selected.length - 1 ? durationSeconds : Math.min(durationSeconds, cursor + durations[index]!);
    const result: Scene = { ...scene, id: `scene-${String(index + 1).padStart(3, "0")}`, startSeconds: round(cursor), endSeconds: round(endSeconds), artwork: { status: "pending", review: "unreviewed" } };
    cursor = endSeconds; return result;
  });
}

export function validateSceneCoverage(scenes: Scene[], durationSeconds: number, settings?: SceneSettings) {
  if (!scenes.length) throw new SceneError("A scene manifest must contain at least one scene");
  const tolerance = .02; if (Math.abs(scenes[0]!.startSeconds) > tolerance) throw new SceneError("The first scene must start at 0:00");
  for (let index = 0; index < scenes.length; index++) {
    const scene = scenes[index]!; if (scene.endSeconds <= scene.startSeconds) throw new SceneError(`${scene.id} has an invalid time range`);
    const sceneDuration = scene.endSeconds - scene.startSeconds;
    if (settings && scenes.length > 1 && sceneDuration < settings.minimumDurationSeconds - tolerance) throw new SceneError(`${scene.id} is shorter than the ${settings.minimumDurationSeconds}-second minimum`);
    if (settings && sceneDuration > settings.maximumDurationSeconds + tolerance) throw new SceneError(`${scene.id} exceeds the ${settings.maximumDurationSeconds}-second maximum`);
    if (index && Math.abs(scene.startSeconds - scenes[index - 1]!.endSeconds) > tolerance) throw new SceneError(`${scene.id} must begin where the previous scene ends`);
  }
  if (Math.abs(scenes.at(-1)!.endSeconds - durationSeconds) > tolerance) throw new SceneError("The final scene must end at the mastered chapter duration");
}

function boundedDurations(weights: number[], totalDuration: number, minimum: number, maximum: number): number[] {
  if (weights.length === 1) return [totalDuration];
  if (weights.length * minimum > totalDuration + .001 || weights.length * maximum < totalDuration - .001) throw new SceneError("Scene count cannot satisfy the configured duration bounds");
  const durations = new Array<number>(weights.length).fill(0); const active = new Set(weights.map((_, index) => index)); let remaining = totalDuration;
  while (active.size) {
    const activeWeight = [...active].reduce((sum, index) => sum + weights[index]!, 0); let constrained = false;
    for (const index of active) {
      const proposed = remaining * weights[index]! / activeWeight;
      if (proposed < minimum) { durations[index] = minimum; remaining -= minimum; active.delete(index); constrained = true; break; }
      if (proposed > maximum) { durations[index] = maximum; remaining -= maximum; active.delete(index); constrained = true; break; }
    }
    if (!constrained) { for (const index of active) durations[index] = remaining * weights[index]! / activeWeight; break; }
  }
  return durations;
}
const round = (value: number) => Math.round(value * 1000) / 1000;
