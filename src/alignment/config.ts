import { resolve } from "node:path";
import { Environment } from "../config/env.js";
import { AlignmentConfig, AlignmentEngine } from "./types.js";
import { WhisperCppAlignmentEngine } from "./whisper-cpp.js";

export function alignmentConfig(env: Environment, root: string): AlignmentConfig {
  return { engine: env.ALIGNMENT_ENGINE, executable: env.ALIGNMENT_EXECUTABLE, model: env.ALIGNMENT_MODEL ? resolve(root, env.ALIGNMENT_MODEL) : undefined,
    device: env.ALIGNMENT_DEVICE, minimumMatchPercentage: env.ALIGNMENT_MIN_MATCH_PERCENT, minimumConfidence: env.ALIGNMENT_MIN_CONFIDENCE,
    maximumGapSeconds: env.ALIGNMENT_MAX_GAP_SECONDS, timeoutMs: env.ALIGNMENT_TIMEOUT_MS };
}

export function createAlignmentEngine(config: AlignmentConfig): AlignmentEngine | undefined {
  if (config.engine === "disabled") return undefined;
  return new WhisperCppAlignmentEngine(config.executable, config.model, config.timeoutMs);
}
