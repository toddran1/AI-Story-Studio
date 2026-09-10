import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Chapter, StageState, chapterSchema } from "../domain/chapter.js";
import { ConfigurationError } from "../pipeline/errors.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { exists, readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { reconcileAndValidateAlignment } from "./quality.js";
import { AlignmentArtifact, AlignmentConfig, AlignmentEngine, alignmentArtifactSchema } from "./types.js";

export type AlignmentEvent = { status: "started" | "completed" | "reused"; chapter: number; state: StageState; mode?: "aligned" | "estimated" };
export async function alignStoredChapter(options: { root: string; storySlug: string; chapter: number; language: string; config: AlignmentConfig; engine?: AlignmentEngine; force?: boolean; forceEstimated?: boolean; requireAligned?: boolean; onEvent?: (event: AlignmentEvent) => void }) {
  const paths = storyPaths(options.root, options.storySlug, options.chapter); const raw = await readJsonIfExists<Chapter>(paths.chapterMeta); if (!raw) throw new Error(`Chapter ${options.chapter} has no pipeline metadata`);
  const chapter = chapterSchema.parse(raw); if (chapter.stages.audioMastering.status !== "complete" || !chapter.audio || !(await exists(paths.audio))) throw new Error(`Chapter ${options.chapter} audio is not mastered`);
  const narration = await readFile(paths.narration, "utf8"); if (!narration.trim()) throw new Error(`Chapter ${options.chapter} narration is empty`);
  const narrationFingerprint = fingerprint(narration); const audioFingerprint = await streamFingerprint(paths.audio); const engineName = options.forceEstimated ? "deterministic" : options.engine?.name ?? options.config.engine; const engineVersion = options.forceEstimated ? "forced-estimated-v1" : options.engine?.version ?? "unavailable-v1";
  const inputFingerprint = fingerprint({ narrationFingerprint, audioFingerprint, engine: engineName, engineVersion, model: options.config.model, device: options.config.device, thresholds: { match: options.config.minimumMatchPercentage, confidence: options.config.minimumConfidence, gap: options.config.maximumGapSeconds } });
  const existingRaw = await readJsonIfExists<AlignmentArtifact>(paths.alignment); const existing = existingRaw ? alignmentArtifactSchema.safeParse(existingRaw) : undefined;
  if (!options.force && existing?.success && existing.data.inputFingerprint === inputFingerprint && chapter.stages.alignment.status === "complete" && chapter.stages.alignment.outputFingerprint === await artifactFingerprint(paths.alignment)) { options.onEvent?.({ status: "reused", chapter: options.chapter, state: chapter.stages.alignment, mode: existing.data.mode }); return { chapter, artifact: existing.data, reused: true }; }
  const started = Date.now(); chapter.stages.alignment = { status: "running", provider: engineName, model: options.config.model, fingerprint: inputFingerprint, startedAt: new Date().toISOString() }; await persist(paths.chapterMeta, chapter); options.onEvent?.({ status: "started", chapter: options.chapter, state: chapter.stages.alignment });
  let artifact: AlignmentArtifact;
  try {
    if (options.forceEstimated) artifact = estimatedArtifact("Estimated timing was explicitly requested");
    else if (!options.engine) artifact = estimatedArtifact("Alignment engine is disabled or unavailable");
    else {
      try {
        const observations = await options.engine.align({ audioPath: paths.audio, narration, language: options.language, model: options.config.model, device: options.config.device }); const quality = reconcileAndValidateAlignment(narration, observations, chapter.audio.durationSeconds, options.config);
        artifact = quality.usable ? baseArtifact("aligned", quality.metrics, quality.words) : estimatedArtifact(quality.warnings.join("; "), quality.metrics);
      } catch (error) {
        if (options.requireAligned) throw error;
        artifact = estimatedArtifact(error instanceof Error ? error.message : String(error));
      }
    }
    if (options.requireAligned && artifact.mode !== "aligned") throw new ConfigurationError(artifact.warning ?? "Aligned timestamps are required but unavailable");
    await atomicWriteJson(paths.alignment, alignmentArtifactSchema.parse(artifact)); const outputFingerprint = await artifactFingerprint(paths.alignment); chapter.alignment = { mode: artifact.mode, engine: artifact.engine, matchedWordPercentage: artifact.metrics.matchedWordPercentage, averageConfidence: artifact.metrics.averageConfidence, unmatchedWordCount: artifact.metrics.unmatchedWordCount, audioDurationSeconds: artifact.metrics.audioDurationSeconds, warning: artifact.warning };
    chapter.stages.alignment = { ...chapter.stages.alignment, status: "complete", outputFingerprint, completedAt: new Date().toISOString(), durationMs: Date.now() - started }; await persist(paths.chapterMeta, chapter); options.onEvent?.({ status: "completed", chapter: options.chapter, state: chapter.stages.alignment, mode: artifact.mode }); return { chapter, artifact, reused: false };
  } catch (error) { chapter.stages.alignment = { ...chapter.stages.alignment, status: "failed", durationMs: Date.now() - started, error: { message: error instanceof Error ? error.message : String(error) } }; await persist(paths.chapterMeta, chapter); throw error; }

  function baseArtifact(mode: "aligned" | "estimated", metrics: AlignmentArtifact["metrics"], words: AlignmentArtifact["words"] = [], warning?: string): AlignmentArtifact { return { version: 1, chapter: options.chapter, mode, engine: engineName, engineVersion, model: options.config.model, createdAt: new Date().toISOString(), audioFingerprint, narrationFingerprint, inputFingerprint, metrics, words, warning }; }
  function estimatedArtifact(warning: string, metrics?: AlignmentArtifact["metrics"]): AlignmentArtifact { return baseArtifact("estimated", metrics ?? { matchedWordPercentage: 0, matchedWordCount: 0, unmatchedWordCount: narration.trim().split(/\s+/).length, alignmentDurationSeconds: 0, audioDurationSeconds: chapter.audio!.durationSeconds, maximumGapSeconds: 0 }, [], warning); }
}

async function streamFingerprint(path: string) { return new Promise<string>((resolvePromise, reject) => { const hash = createHash("sha256"); const stream = createReadStream(path); stream.on("data", (chunk) => hash.update(chunk)); stream.once("error", reject); stream.once("end", () => resolvePromise(hash.digest("hex"))); }); }
async function artifactFingerprint(path: string) { return fingerprint((await readFile(path)).toString("base64")); }
async function persist(path: string, chapter: Chapter) { chapter.updatedAt = new Date().toISOString(); await atomicWriteJson(path, chapterSchema.parse(chapter)); }
