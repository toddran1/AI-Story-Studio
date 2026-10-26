import type { Scene } from "../scenes/types.js";
import type { VideoMotionMode } from "./config.js";

export type SceneMotionContext = Pick<Scene, "characters" | "importance"> & Partial<Pick<Scene, "direction" | "sequence">>;
export type ConcreteMotion = Exclude<VideoMotionMode, "auto_subtle" | "scene_aware">;
/** Only structured scene decisions drive movement; narration is not guessed. */
export function sceneMotionContext(scene: Scene): SceneMotionContext {
  return { characters: scene.characters, importance: scene.importance, direction: scene.direction, sequence: scene.sequence };
}
export function resolveSceneMotion(context?: SceneMotionContext): { motion: ConcreteMotion; reason: string } {
  const shot = context?.direction?.shotType;
  const beat = context?.sequence?.beat;
  if (shot === "extreme_close_up" || (context?.characters.length ?? 0) > 2) return { motion: "still", reason: "Keep tight details or a large cast stable and fully visible." };
  if (beat === "reaction" || shot === "close_up" || shot === "medium_close_up") return { motion: "zoom_in", reason: "A restrained push supports the character's reaction." };
  if (beat === "interaction") return { motion: "still", reason: "Hold the conversation frame to preserve eyelines and screen geography." };
  if (beat === "action") {
    const facing = context?.sequence?.positions.filter(p => p.movement && (p.facing === "left" || p.facing === "right")) ?? [];
    if (facing.length && facing.every(p => p.facing === facing[0]!.facing)) return { motion: facing[0]!.facing === "left" ? "pan_left" : "pan_right", reason: "Follow the recorded movement direction without reversing the screen axis." };
    return { motion: "zoom_in", reason: "A restrained push supports action without inventing a movement direction." };
  }
  if (beat === "establishing" || shot === "wide" || shot === "extreme_wide" || context?.direction?.composition === "environmental") return { motion: "zoom_out", reason: "Reveal the setting gradually while preserving its landmarks." };
  if (beat === "detail") return { motion: "still", reason: "Hold the detail long enough to read it clearly." };
  return { motion: "zoom_in", reason: "Use a restrained push when no more specific camera direction is established." };
}
