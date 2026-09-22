import type { StoryArtDirection, ArtDirectionPreset } from "../domain/art-direction.js";
import type { Scene } from "../scenes/types.js";
import type { SummaryArtDirectionOverride } from "./types.js";
import { resolveActiveArtDirection } from "../visual-canon/art-direction.js";

export type SummaryArtDirectionSource = "story-default" | "summary-override" | "scene-override" | "disabled";

/** Resolve the shared Story → Summary → Scene direction hierarchy. Scene's
 * existing opt-out is strongest; otherwise an explicit scene preset wins. */
export function resolveSummarySceneArtDirection(
  storyDirection: StoryArtDirection,
  summaryOverride: SummaryArtDirectionOverride | undefined,
  scene: Scene,
): { preset: ArtDirectionPreset; source: SummaryArtDirectionSource; missingPresetId?: string } {
  const fallback = resolveActiveArtDirection(storyDirection);
  if (scene.direction?.useStoryArtDirection === false) return { preset: fallback, source: "disabled" };

  const scenePresetId = scene.overrides?.artDirectionPresetId;
  if (scenePresetId) {
    const exists = storyDirection.presets.some((preset) => preset.id === scenePresetId);
    return { preset: resolveActiveArtDirection(storyDirection, scenePresetId), source: exists ? "scene-override" : "story-default", ...(!exists ? { missingPresetId: scenePresetId } : {}) };
  }

  if (scene.overrides?.artDirectionMode === "story-default") return { preset: fallback, source: "story-default" };

  if (summaryOverride?.mode === "disabled") return { preset: fallback, source: "disabled" };
  if (summaryOverride?.mode === "preset") {
    const exists = storyDirection.presets.some((preset) => preset.id === summaryOverride.presetId);
    return { preset: resolveActiveArtDirection(storyDirection, summaryOverride.presetId), source: exists ? "summary-override" : "story-default", ...(!exists ? { missingPresetId: summaryOverride.presetId } : {}) };
  }
  return { preset: fallback, source: "story-default" };
}
