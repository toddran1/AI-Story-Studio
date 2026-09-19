import { stat } from "node:fs/promises";
import { z } from "zod";
import { Chapter, StageName, stageNameSchema } from "../domain/chapter.js";
import { qaResultSchema } from "../domain/qa.js";
import { storyBibleUpdateSchema } from "../domain/story-bible.js";
import { sceneManifestSchema } from "../scenes/types.js";
import { readJsonIfExists, readTextIfExists } from "../storage/story-files.js";
import { sceneImagePath, storyPaths } from "../storage/paths.js";
import type { Story } from "../domain/story.js";
import type { PipelineOptions } from "../pipeline/chapter-pipeline.js";
import { alignStoredChapter } from "../alignment/chapter-alignment.js";
import type { AlignmentConfig, AlignmentEngine } from "../alignment/types.js";
import { generateStoredSubtitles } from "../subtitles/chapter-subtitles.js";
import { planStoredScenes } from "../scenes/manifest.js";
import { generateStoredArtwork } from "../artwork/generator.js";
import { renderStoredChapterVideo } from "../video/chapter-video.js";
import type { LLMProvider } from "../llm/provider.js";
import type { ImageProviderSource } from "../artwork/providers.js";
import { resolveImageProvider } from "../artwork/providers.js";
import type { VideoProcessor } from "../video/renderer.js";

/** `context` is a local, derived artifact. It is deliberately visible in plans
 * even though it is not a user-selectable Chapter stage. */
export const stageExecutionNodeSchema = z.union([stageNameSchema, z.literal("context")]);
export type StageExecutionNode = z.infer<typeof stageExecutionNodeSchema>;
export const stageExecutionModeSchema = z.enum(["selected", "through"]);
export type StageExecutionMode = z.infer<typeof stageExecutionModeSchema>;
export const stageExecutionInputSchema = z.object({
  chapters: z.array(z.number().int().positive()).min(1).max(2_000),
  stage: stageNameSchema,
  mode: stageExecutionModeSchema.default("selected"),
  dryRun: z.boolean().default(false),
}).strict();

export type ArtifactAvailability = "available" | "missing" | "invalid";
export type ArtifactFreshness = "current" | "stale";
export type StageArtifactState = {
  stage: StageExecutionNode;
  availability: ArtifactAvailability;
  freshness?: ArtifactFreshness;
};
export type StageExecutionPlan = {
  selectedStage: StageName;
  mode: StageExecutionMode;
  prerequisitesComplete: boolean;
  runStages: StageExecutionNode[];
  reusedStages: Array<{ stage: StageExecutionNode; state: ArtifactFreshness }>;
  missingStages: StageExecutionNode[];
  artifacts: StageArtifactState[];
  reason: string;
};

// This is the processing graph, not the visual tab order. Keep it here so
// planning and invalidation use the same source of truth.
const dependencies: Record<StageExecutionNode, StageExecutionNode[]> = {
  ingestion: [],
  translation: ["ingestion"],
  narration: ["translation"],
  qa: ["ingestion", "narration"],
  storyBible: ["narration", "qa"],
  context: ["storyBible"],
  continuity: ["context"],
  tts: ["narration", "context"],
  audioMastering: ["tts"],
  alignment: ["audioMastering"],
  subtitles: ["alignment"],
  scenePlanning: ["narration", "context"],
  artwork: ["scenePlanning"],
  video: ["audioMastering", "subtitles", "artwork"],
};

export function requiredStageNodes(stage: StageExecutionNode): StageExecutionNode[] {
  const result: StageExecutionNode[] = [];
  const visiting = new Set<StageExecutionNode>();
  const visit = (node: StageExecutionNode) => {
    if (visiting.has(node)) return;
    visiting.add(node);
    for (const dependency of dependencies[node]) visit(dependency);
    result.push(node);
  };
  visit(stage);
  return result;
}

/** Processing stages which really depend on `stage`; context is internal. */
export function dependentProcessingStages(stage: StageName): StageName[] {
  const direct = new Map<StageExecutionNode, StageExecutionNode[]>();
  for (const [node, required] of Object.entries(dependencies) as Array<[StageExecutionNode, StageExecutionNode[]]>) {
    for (const dependency of required) direct.set(dependency, [...(direct.get(dependency) ?? []), node]);
  }
  const found = new Set<StageExecutionNode>();
  const visit = (node: StageExecutionNode) => {
    for (const child of direct.get(node) ?? []) if (!found.has(child)) { found.add(child); visit(child); }
  };
  visit(stage);
  return [...found].filter((node): node is StageName => node !== "context");
}

export async function planStageExecution(options: { root: string; story: string; chapter: number; selectedStage: StageName; mode?: StageExecutionMode }): Promise<StageExecutionPlan> {
  const mode = options.mode ?? "selected";
  const required = requiredStageNodes(options.selectedStage);
  const prerequisiteNodes = required.slice(0, -1);
  const artifacts = await Promise.all(required.map((stage) => inspectArtifact(options.root, options.story, options.chapter, stage)));
  const byStage = new Map(artifacts.map((item) => [item.stage, item]));
  const missingStages = prerequisiteNodes.filter((stage) => byStage.get(stage)!.availability !== "available");
  const prerequisitesComplete = missingStages.length === 0;
  const runStages = mode === "through" || !prerequisitesComplete ? required : [options.selectedStage];
  const reusedStages = runStages.length === 1
    ? prerequisiteNodes.filter((stage) => byStage.get(stage)!.availability === "available").map((stage) => ({ stage, state: byStage.get(stage)!.freshness! }))
    : [];
  const reason = mode === "through"
    ? "Selected + all prior requested."
    : prerequisitesComplete
      ? "All required prerequisite artifacts exist."
      : "Required prerequisite artifacts are missing or invalid; rebuilding dependency chain.";
  return { selectedStage: options.selectedStage, mode, prerequisitesComplete, runStages, reusedStages, missingStages, artifacts, reason };
}

async function inspectArtifact(root: string, story: string, chapterNumber: number, stage: StageExecutionNode): Promise<StageArtifactState> {
  const paths = storyPaths(root, story, chapterNumber);
  const chapter = await readJsonIfExists<Chapter>(paths.chapterMeta);
  const freshness = stage === "context" ? contextFreshness(chapter) : chapter?.stages?.[stage]?.status === "complete" && !chapter.stages[stage].staleReason ? "current" : "stale";
  try {
    const valid = await artifactIsValid(stage, paths, root, story, chapterNumber);
    return valid ? { stage, availability: "available", freshness } : { stage, availability: await artifactExists(stage, paths) ? "invalid" : "missing" };
  } catch {
    return { stage, availability: "invalid" };
  }
}

function contextFreshness(chapter: Chapter | undefined): ArtifactFreshness {
  return chapter?.stages.storyBible?.status === "complete" && !chapter.stages.storyBible.staleReason ? "current" : "stale";
}

async function artifactExists(stage: StageExecutionNode, paths: ReturnType<typeof storyPaths>): Promise<boolean> {
  const path = artifactPath(stage, paths);
  if (!path) return false;
  try { return (await stat(path)).size > 0; } catch { return false; }
}

function artifactPath(stage: StageExecutionNode, paths: ReturnType<typeof storyPaths>): string | undefined {
  return ({ ingestion: paths.original, translation: paths.english, narration: paths.narration, qa: paths.qa,
    storyBible: paths.bibleUpdate, context: paths.storyContext, continuity: paths.continuityAnalysis,
    tts: paths.audioRaw, audioMastering: paths.audio, alignment: paths.alignment, subtitles: paths.subtitlesDocument,
    scenePlanning: paths.scenesManifest, video: paths.video } as Partial<Record<StageExecutionNode, string>>)[stage];
}

async function artifactIsValid(stage: StageExecutionNode, paths: ReturnType<typeof storyPaths>, root: string, story: string, chapter: number): Promise<boolean> {
  if (["ingestion", "translation", "narration"].includes(stage)) return Boolean((await readTextIfExists(artifactPath(stage, paths)!))?.trim());
  if (["tts", "audioMastering", "video"].includes(stage)) return artifactExists(stage, paths);
  if (stage === "qa") return qaResultSchema.safeParse(await readJsonIfExists(paths.qa)).success;
  if (stage === "storyBible") return storyBibleUpdateSchema.safeParse(await readJsonIfExists(paths.bibleUpdate)).success;
  if (stage === "context" || stage === "continuity" || stage === "alignment" || stage === "subtitles") {
    const data = await readJsonIfExists(artifactPath(stage, paths)!);
    return Boolean(data && typeof data === "object");
  }
  if (stage === "scenePlanning" || stage === "artwork") {
    const parsed = sceneManifestSchema.safeParse(await readJsonIfExists(paths.scenesManifest));
    if (!parsed.success || !parsed.data.scenes.length) return false;
    if (stage === "scenePlanning") return true;
    for (const scene of parsed.data.scenes) {
      if (scene.artwork.status !== "complete" || !(await artifactFileExists(sceneImagePath(root, story, chapter, scene.id)))) return false;
    }
    return true;
  }
  return false;
}

async function artifactFileExists(path: string): Promise<boolean> { try { return (await stat(path)).size > 0; } catch { return false; } }

export type StageExecutionProcessor = { run(options: PipelineOptions): Promise<unknown> };
export type StageExecutionRuntime = {
  pipeline: StageExecutionProcessor;
  alignment: { config: AlignmentConfig; engine?: AlignmentEngine };
  scenePlanner?: LLMProvider;
  image?: ImageProviderSource;
  video: VideoProcessor;
};

/** Execute exactly the stages chosen by `planStageExecution`.  The core
 * pipeline receives the plan, while optional media branches use their existing
 * application services. */
export async function executeStagePlan(options: {
  root: string; story: Story; chapter: number; inputPath: string;
  source?: PipelineOptions["source"]; plan: StageExecutionPlan; runtime: StageExecutionRuntime;
  onStageEvent?: PipelineOptions["onStageEvent"];
}): Promise<void> {
  const core: StageName[] = ["ingestion", "translation", "narration", "qa", "storyBible", "continuity", "tts", "audioMastering"];
  const plannedCore = options.plan.runStages.filter((stage): stage is StageName => core.includes(stage as StageName));
  if (plannedCore.length) {
    const last = core[Math.max(...plannedCore.map((stage) => core.indexOf(stage)))]!;
    await options.runtime.pipeline.run({ root: options.root, story: options.story, chapter: options.chapter, inputPath: options.inputPath, source: options.source,
      executionStages: options.plan.runStages, stopAfter: last, onStageEvent: options.onStageEvent });
  }
  for (const stage of options.plan.runStages) {
    if (["context", ...core].includes(stage)) continue;
    if (stage === "alignment") await alignStoredChapter({ root: options.root, storySlug: options.story.slug, chapter: options.chapter, language: options.story.outputLanguage, config: options.runtime.alignment.config, engine: options.runtime.alignment.engine, force: true,
      onEvent: (event) => options.onStageEvent?.({ stage: "alignment", status: event.status, state: event.state }) });
    if (stage === "subtitles") await generateStoredSubtitles({ root: options.root, story: options.story, chapter: options.chapter, force: true,
      onEvent: (event) => options.onStageEvent?.({ stage: "subtitles", status: event.status, state: event.state }) });
    if (stage === "scenePlanning") {
      if (!options.runtime.scenePlanner) throw new Error("Scene planning provider is not configured");
      await planStoredScenes({ root: options.root, story: options.story, chapter: options.chapter, provider: options.runtime.scenePlanner, force: true });
    }
    if (stage === "artwork") {
      if (!options.runtime.image) throw new Error("Artwork provider is not configured");
      await generateStoredArtwork({ root: options.root, story: options.story, chapter: options.chapter, provider: resolveImageProvider(options.runtime.image, options.story), force: true });
    }
    if (stage === "video") await renderStoredChapterVideo({ root: options.root, story: options.story, chapter: options.chapter, processor: options.runtime.video, force: true });
  }
}
