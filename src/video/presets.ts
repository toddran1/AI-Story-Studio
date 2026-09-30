import type { VideoSettings } from "./config.js";

export const videoPresentationPresets = {
  audiobook_subtle: { label: "Audiobook / Subtle", description: "Restrained image movement with gentle dissolves.", motion: { mode: "auto_subtle", intensity: "subtle" }, transition: { mode: "dissolve", durationSeconds: 0.5 } },
  cinematic: { label: "Cinematic", description: "Measured camera movement and dramatic fades.", motion: { mode: "auto_subtle", intensity: "normal" }, transition: { mode: "fade_black", durationSeconds: 0.6 } },
  manga_dynamic: { label: "Manga / Dynamic", description: "Quicker dissolves and more energetic movement.", motion: { mode: "auto_subtle", intensity: "normal" }, transition: { mode: "dissolve", durationSeconds: 0.35 } },
  minimal: { label: "Minimal", description: "Still artwork with clean, direct cuts.", motion: { mode: "still", intensity: "subtle" }, transition: { mode: "cut", durationSeconds: 0 } },
} as const;

export type VideoPresentationPreset = keyof typeof videoPresentationPresets | "custom";

export function matchVideoPresentationPreset(settings: Pick<VideoSettings, "motion" | "transition">): VideoPresentationPreset {
  const motion = settings.motion ?? videoPresentationPresets.audiobook_subtle.motion;
  const transition = settings.transition ?? videoPresentationPresets.audiobook_subtle.transition;
  for (const [id, preset] of Object.entries(videoPresentationPresets)) {
    if (motion.mode === preset.motion.mode && motion.intensity === preset.motion.intensity
      && transition.mode === preset.transition.mode && transition.durationSeconds === preset.transition.durationSeconds) return id as keyof typeof videoPresentationPresets;
  }
  return "custom";
}
