import { resolveSceneMotion, type SceneMotionContext, type ConcreteMotion } from "./scene-motion.js";
import type { SceneVideoTreatment } from "../scenes/types.js";
import type { VideoMotionMode, VideoSettings, VideoTransitionMode } from "./config.js";

export type VideoScenePresentation = { index: number; durationSeconds: number; motion: ConcreteMotion; reason: string; framing: NonNullable<SceneVideoTreatment["framing"]>; visualDurationSeconds: number };
export type VideoTransitionBoundary = { fromIndex: number; toIndex: number; mode: VideoTransitionMode; configuredDurationSeconds: number; effectiveDurationSeconds: number; boundaryTimeSeconds: number };
export type PresentationScene = { durationSeconds: number; disabled?: boolean; videoTreatment?: SceneVideoTreatment; motionContext?: SceneMotionContext };

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
  const auto: Array<ConcreteMotion> = ["zoom_in", "pan_right", "zoom_out", "pan_left"];
  const presentations: VideoScenePresentation[] = enabled.map((scene, index) => {
    const requested = scene.videoTreatment?.motion && scene.videoTreatment.motion !== "story_default" ? scene.videoTreatment.motion : settings.motion.mode;
    const decision = requested === "scene_aware" ? resolveSceneMotion(scene.motionContext) : undefined;
    const motion = decision?.motion ?? (requested === "auto_subtle" ? auto[index % auto.length]! : requested as ConcreteMotion);
    const framing = scene.videoTreatment?.framing ?? { fit: requested === "scene_aware" ? "contain" as const : "cover" as const, focusX: .5, focusY: .5 };
    return { index, durationSeconds: scene.durationSeconds, motion, framing, reason: decision?.reason ?? (requested === "auto_subtle" ? "Alternating subtle camera movement." : "Explicit camera treatment."), visualDurationSeconds: scene.durationSeconds + (boundaries[index - 1]?.effectiveDurationSeconds ?? 0) / 2 + (boundaries[index]?.effectiveDurationSeconds ?? 0) / 2 };
  });
  return { scenes: presentations, boundaries, totalDurationSeconds: enabled.reduce((sum, scene) => sum + scene.durationSeconds, 0) };
}

export function buildSceneMotionFilter(input: { mode: VideoScenePresentation["motion"]; width: number; height: number; fps: number; durationSeconds: number; intensity: VideoSettings["motion"]["intensity"]; framing?: SceneVideoTreatment["framing"] }) {
  const { mode, width, height, fps, durationSeconds, intensity } = input;
  const framing = input.framing ?? { fit: "cover", focusX: .5, focusY: .5 };
  const amplitude = intensity === "normal" ? 0.10 : 0.06;
  // Contain reserves enough border for the entire pan/zoom envelope. No
  // invented subject detection or cropped heads at the edges of a frame.
  const ratio = mode === "still" ? 1 : (1 - amplitude) / (1 + amplitude);
  const innerWidth = Math.max(2, Math.floor(width * ratio / 2) * 2);
  const innerHeight = Math.max(2, Math.floor(height * ratio / 2) * 2);
  const base = framing.fit === "contain"
    ? `scale=${innerWidth}:${innerHeight}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x11131a`
    : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}:(iw-ow)*${framing.focusX}:(ih-oh)*${framing.focusY}`;
  if (mode === "still") return base;
  const frames = Math.max(1, Math.round(durationSeconds * fps) - 1);
  const progress = `min(on/${frames},1)`;
  const zoom = mode === "zoom_in" ? `1+${amplitude}*${progress}` : mode === "zoom_out" ? `1+${amplitude}*(1-${progress})` : String(1 + amplitude);
  const maxX = "iw-iw/zoom";
  const maxY = "ih-ih/zoom";
  const x = mode === "pan_left" ? `${maxX}*(1-${progress})` : mode === "pan_right" ? `${maxX}*${progress}` : `(${maxX})*${framing.fit === "contain" ? .5 : framing.focusX}`;
  const y = mode === "pan_up" ? `${maxY}*(1-${progress})` : mode === "pan_down" ? `${maxY}*${progress}` : `(${maxY})*${framing.fit === "contain" ? .5 : framing.focusY}`;
  return `${base},zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps}`;
}
