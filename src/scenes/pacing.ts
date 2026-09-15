import { z } from "zod";

export const scenePacingSchema = z.object({
  pacing: z.enum(["automatic", "slow", "balanced", "fast", "custom"]).default("automatic"),
  sceneCount: z.number().int().min(1).max(100).optional(),
  secondsPerScene: z.number().min(3).max(120).optional(),
}).strict().superRefine((value, context) => {
  if (value.sceneCount !== undefined && value.secondsPerScene !== undefined)
    context.addIssue({ code: "custom", message: "Choose a scene count or seconds per scene, not both" });
  if (value.pacing === "custom" && value.sceneCount === undefined && value.secondsPerScene === undefined)
    context.addIssue({ code: "custom", message: "Custom pacing requires a scene count or seconds per scene" });
});

export function estimateScenePacing(narration: string, input: unknown = {}, measuredDurationSeconds?: number) {
  const settings = scenePacingSchema.parse(input);
  if (measuredDurationSeconds !== undefined && (!Number.isFinite(measuredDurationSeconds) || measuredDurationSeconds <= 0))
    throw new Error("Measured audio duration must be positive");
  const words = narration.trim().split(/\s+/u).filter(Boolean).length;
  const durationSeconds = measuredDurationSeconds ?? Math.max(1, words / 150 * 60);
  const seconds = settings.secondsPerScene ?? ({ automatic: 22, slow: 30, balanced: 22, fast: 12, custom: 22 }[settings.pacing]);
  const sceneCount = settings.sceneCount ?? Math.max(1, Math.min(100, Math.round(durationSeconds / seconds)));
  return { durationSeconds, sceneCount, averageDurationSeconds: durationSeconds / sceneCount,
    durationSource: measuredDurationSeconds === undefined ? "estimated" as const : "mastered-audio" as const };
}
