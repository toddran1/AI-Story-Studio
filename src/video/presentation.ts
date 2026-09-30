import type { SceneVideoTreatment } from "../scenes/types.js";
import type { VideoMotionMode, VideoSettings, VideoTransitionMode } from "./config.js";

export type VideoScenePresentation = { index: number; durationSeconds: number; motion: Exclude<VideoMotionMode, "auto_subtle">; visualDurationSeconds: number };
export type VideoTransitionBoundary = { fromIndex: number; toIndex: number; mode: VideoTransitionMode; configuredDurationSeconds: number; effectiveDurationSeconds: number; boundaryTimeSeconds: number };
export type PresentationScene = { durationSeconds: number; disabled?: boolean; videoTreatment?: SceneVideoTreatment };

/** Timings are measured on the mastered audio timeline. Visual handles pay for overlap. */
export function buildVideoPresentationTimeline(scenes: PresentationScene[], settings: VideoSettings) {
  const enabled = scenes.filter((scene) => !scene.disabled && scene.durationSeconds > 0);
  const boundaries: VideoTransitionBoundary[] = [];
  let elapsed = 0;
  for (let index = 0; index < enabled.length - 1; index++) {
    const current = enabled[index]!;
    const next = enabled[index + 1]!;
    elapsed += current.durationSeconds;
    const override = current.videoTreatment?.transitionOut;
    const configuredMode = override?.mode && override.mode !== "story_default" ? override.mode : settings.transition.mode;
    const configuredDurationSeconds = override?.durationSeconds ?? settings.transition.durationSeconds;
    const clamped = Math.min(configuredDurationSeconds, current.durationSeconds * 0.25, next.durationSeconds * 0.25);
    const effectiveDurationSeconds = configuredMode === "cut" || clamped < Math.max(0.08, 2 / settings.fps) ? 0 : clamped;
    boundaries.push({ fromIndex: index, toIndex: index + 1, mode: effectiveDurationSeconds ? configuredMode : "cut", configuredDurationSeconds, effectiveDurationSeconds, boundaryTimeSeconds: elapsed });
  }
  const auto: Array<Exclude<VideoMotionMode, "auto_subtle">> = ["zoom_in", "pan_right", "zoom_out", "pan_left"];
  const presentations: VideoScenePresentation[] = enabled.map((scene, index) => {
    const requested = scene.videoTreatment?.motion && scene.videoTreatment.motion !== "story_default" ? scene.videoTreatment.motion : settings.motion.mode;
    const motion = requested === "auto_subtle" ? auto[index % auto.length]! : requested;
    return { index, durationSeconds: scene.durationSeconds, motion, visualDurationSeconds: scene.durationSeconds + (boundaries[index - 1]?.effectiveDurationSeconds ?? 0) / 2 + (boundaries[index]?.effectiveDurationSeconds ?? 0) / 2 };
  });
  return { scenes: presentations, boundaries, totalDurationSeconds: enabled.reduce((sum, scene) => sum + scene.durationSeconds, 0) };
}

export function buildSceneMotionFilter(input: { mode: VideoScenePresentation["motion"]; width: number; height: number; fps: number; durationSeconds: number; intensity: VideoSettings["motion"]["intensity"] }) {
  const { mode, width, height, fps, durationSeconds, intensity } = input;
  if (mode === "still") return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  const amplitude = intensity === "normal" ? 0.10 : 0.06;
  const frames = Math.max(1, Math.round(durationSeconds * fps) - 1);
  const progress = `min(on/${frames},1)`;
  const zoom = mode === "zoom_in" ? `1+${amplitude}*${progress}` : mode === "zoom_out" ? `1+${amplitude}*(1-${progress})` : String(1 + amplitude);
  const maxX = "iw-iw/zoom";
  const maxY = "ih-ih/zoom";
  const x = mode === "pan_left" ? `${maxX}*(1-${progress})` : mode === "pan_right" ? `${maxX}*${progress}` : `(${maxX})/2`;
  const y = mode === "pan_up" ? `${maxY}*(1-${progress})` : mode === "pan_down" ? `${maxY}*${progress}` : `(${maxY})/2`;
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps}`;
}
