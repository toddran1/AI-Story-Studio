import { z } from "zod";
import { StageName, stageNameSchema } from "../domain/chapter.js";
import type { Story } from "../domain/story.js";
import { inspectStageArtifact } from "./artifact-state.js";
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
import { fingerprint } from "../utils/hash.js";
import { BatchStage, batchStageSchema } from "./stage-selection.js";

/** `context` is a local, derived artifact. It is deliberately visible in plans
 * even though it is not a user-selectable Chapter stage. */
export const stageExecutionNodeSchema = z.union([stageNameSchema, z.literal("context")]);
export type StageExecutionNode = z.infer<typeof stageExecutionNodeSchema>;
export const stageExecutionModeSchema = z.preprocess((value) => value === "through" ? "prerequisites" : value, z.enum(["selected", "prerequisites"]));
export type StageExecutionMode = z.infer<typeof stageExecutionModeSchema>;
const canonicalStageExecutionInputSchema = z.object({
  chapters: z.array(z.number().int().positive()).min(1).max(2_000),
  stages: z.array(batchStageSchema).min(1).max(batchStageSchema.options.length),
  mode: stageExecutionModeSchema.default("selected"),
  force: z.boolean().default(false),
  continueOnError: z.boolean().default(false),
  expectedPlanFingerprint: z.string().length(64).optional(),
  dryRun: z.boolean().default(false),
}).strict().transform((input) => ({ ...input, chapters: [...new Set(input.chapters)].sort((left, right) => left - right), stages: orderedBatchStages(input.stages) }));
export const stageExecutionInputSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const { stage, selectedStage, ...rest } = input;
  const legacyStage = stage ?? selectedStage;
  return { ...rest, ...(rest.stages === undefined && legacyStage !== undefined ? { stages: [legacyStage] } : {}) };
}, canonicalStageExecutionInputSchema);

export type { ArtifactAvailability, ArtifactFreshness, StageArtifactState } from "./artifact-state.js";
import type { ArtifactAvailability, ArtifactFreshness, StageArtifactState } from "./artifact-state.js";
export type StageExecutionPlan = {
  selectedStages: BatchStage[];
  mode: StageExecutionMode;
  force: boolean;
  prerequisitesComplete: boolean;
  runStages: StageExecutionNode[];
  reusedStages: Array<{ stage: StageExecutionNode; state: ArtifactFreshness }>;
  missingStages: StageExecutionNode[];
  blockedStages: StageExecutionNode[];
  entries: StageExecutionEntry[];
  artifacts: StageArtifactState[];
  reason: string;
};
export type StageExecutionAction = "selected-run" | "prerequisite-run" | "reuse" | "blocked";
export type StageExecutionEntry = { stage: StageExecutionNode; action: StageExecutionAction; reason: string; availability: ArtifactAvailability; freshness?: ArtifactFreshness; requiredBy: BatchStage[] };
export type StageExecutionBatchPlan = {
  chapters: Array<{ chapter: number } & StageExecutionPlan>;
  summary: {
    chapterCount: number; selectedStages: BatchStage[]; mode: StageExecutionMode; force: boolean;
    operationCount: number; reusedCount: number; blockedOperations: number; blockedChapters: number;
    plannedByStage: Partial<Record<StageExecutionNode, number>>; reusedByStage: Partial<Record<StageExecutionNode, number>>; blockedByStage: Partial<Record<StageExecutionNode, number>>;
    addedPrerequisites: StageExecutionNode[]; providerOperations: { llm: number; tts: number; images: number };
  };
  fingerprint: string;
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

const allStageOrder = topologicalOrder(Object.keys(dependencies) as StageExecutionNode[]);

function topologicalOrder(nodes: readonly StageExecutionNode[]): StageExecutionNode[] {
  const result: StageExecutionNode[] = []; const visited = new Set<StageExecutionNode>();
  const visit = (node: StageExecutionNode) => { if (visited.has(node)) return; visited.add(node); for (const dependency of dependencies[node]) visit(dependency); result.push(node); };
  for (const node of nodes) visit(node);
  return result;
}

export function orderedBatchStages(stages: readonly BatchStage[]): BatchStage[] {
  const selected = new Set(stages); return allStageOrder.filter((stage): stage is BatchStage => stage !== "ingestion" && stage !== "context" && selected.has(stage as BatchStage));
}

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

export function requiredStageNodesFor(stages: readonly BatchStage[]): StageExecutionNode[] {
  const required = new Set(stages.flatMap((stage) => requiredStageNodes(stage)));
  return allStageOrder.filter((stage) => required.has(stage));
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

export async function planStageExecution(options: { root: string; story: string; chapter: number; selectedStages: readonly BatchStage[]; mode?: StageExecutionMode; force?: boolean }): Promise<StageExecutionPlan> {
  const mode = options.mode ?? "selected"; const force = options.force ?? false; const selectedStages = orderedBatchStages(options.selectedStages);
  if (!selectedStages.length) throw new Error("Select at least one executable stage");
  const required = requiredStageNodesFor(selectedStages);
  const artifacts = await Promise.all(required.map((stage) => inspectArtifact(options.root, options.story, options.chapter, stage)));
  const byStage = new Map(artifacts.map((item) => [item.stage, item])); const selected = new Set<StageExecutionNode>(selectedStages); const entries = new Map<StageExecutionNode, StageExecutionEntry>();
  const requiredBy = (stage: StageExecutionNode) => selectedStages.filter((selectedStage) => requiredStageNodes(selectedStage).includes(stage));
  const entry = (stage: StageExecutionNode, action: StageExecutionAction, reason: string) => {
    const artifact = byStage.get(stage)!; const value: StageExecutionEntry = { stage, action, reason, availability: artifact.availability, freshness: artifact.freshness, requiredBy: requiredBy(stage) }; entries.set(stage, value); return value;
  };
  const ensurePrerequisite = (stage: StageExecutionNode): StageExecutionEntry => {
    const existing = entries.get(stage); if (existing) return existing;
    const artifact = byStage.get(stage)!;
    if (artifact.availability === "available") return entry(stage, "reuse", `${stage} is available${artifact.freshness === "stale" ? " and stale but usable" : ""}.`);
    if (mode === "selected") return entry(stage, "blocked", `${stage} prerequisite is ${artifact.availability}; selected-only mode will not regenerate it.`);
    const blockedDependency = dependencies[stage].map(ensurePrerequisite).find((item) => item.action === "blocked");
    return blockedDependency
      ? entry(stage, "blocked", `${stage} cannot run because ${blockedDependency.stage} is blocked.`)
      : entry(stage, "prerequisite-run", `${stage} is ${artifact.availability} and is required by ${requiredBy(stage).join(", ")}.`);
  };
  for (const stage of selectedStages) {
    const artifact = byStage.get(stage)!;
    if (artifact.availability === "available" && !force) { entry(stage, "reuse", `${stage} is already available${artifact.freshness === "stale" ? "; stale remains usable" : ""}.`); continue; }
    const blockedDependency = dependencies[stage].map((dependency) => selected.has(dependency) ? entries.get(dependency) ?? ensurePrerequisite(dependency) : ensurePrerequisite(dependency)).find((item) => item.action === "blocked");
    if (blockedDependency) entry(stage, "blocked", `${stage} cannot run because ${blockedDependency.stage} is unavailable.`);
    else entry(stage, "selected-run", force && artifact.availability === "available" ? "User requested regeneration of the selected stage." : `User selected this ${artifact.availability} stage.`);
  }
  const orderedEntries = allStageOrder.flatMap((stage) => entries.has(stage) ? [entries.get(stage)!] : []);
  const runStages = orderedEntries.filter((item) => item.action === "selected-run" || item.action === "prerequisite-run").map((item) => item.stage);
  const reusedStages = orderedEntries.filter((item) => item.action === "reuse").map((item) => ({ stage: item.stage, state: item.freshness ?? "stale" }));
  const missingStages = artifacts.filter((item) => item.availability !== "available").map((item) => item.stage);
  const blockedStages = orderedEntries.filter((item) => item.action === "blocked").map((item) => item.stage);
  const prerequisitesComplete = blockedStages.length === 0;
  const reason = blockedStages.length ? "One or more selected operations are blocked by unavailable prerequisites." : mode === "selected" ? "Only selected stages will run; usable prerequisites are reused." : "Missing prerequisites are included explicitly; usable prerequisites are reused.";
  return { selectedStages, mode, force, prerequisitesComplete, runStages, reusedStages, missingStages, blockedStages, entries: orderedEntries, artifacts, reason };
}

export async function planStageExecutionBatch(options: { root: string; story: string; chapters: readonly number[]; selectedStages: readonly BatchStage[]; mode?: StageExecutionMode; force?: boolean }): Promise<StageExecutionBatchPlan> {
  const chapters = await Promise.all(options.chapters.map(async (chapter) => ({ chapter, ...await planStageExecution({ ...options, chapter }) })));
  const count = (actions: StageExecutionAction[]) => chapters.flatMap((chapter) => chapter.entries).filter((entry) => actions.includes(entry.action));
  const planned = count(["selected-run", "prerequisite-run"]); const reused = count(["reuse"]); const blocked = count(["blocked"]);
  const stageCounts = (entries: StageExecutionEntry[]) => entries.reduce<Partial<Record<StageExecutionNode, number>>>((result, item) => ({ ...result, [item.stage]: (result[item.stage] ?? 0) + 1 }), {});
  const providerOperations = planned.reduce((totals, item) => { const kind = providerKind(item.stage); if (kind) totals[kind]++; return totals; }, { llm: 0, tts: 0, images: 0 });
  const summary: StageExecutionBatchPlan["summary"] = { chapterCount: chapters.length, selectedStages: orderedBatchStages(options.selectedStages), mode: options.mode ?? "selected", force: options.force ?? false, operationCount: planned.length, reusedCount: reused.length, blockedOperations: blocked.length, blockedChapters: chapters.filter((chapter) => chapter.blockedStages.length > 0).length, plannedByStage: stageCounts(planned), reusedByStage: stageCounts(reused), blockedByStage: stageCounts(blocked), addedPrerequisites: allStageOrder.filter((stage) => planned.some((entry) => entry.stage === stage && entry.action === "prerequisite-run")), providerOperations };
  const planFingerprint = fingerprint({ chapters: chapters.map((chapter) => ({ chapter: chapter.chapter, entries: chapter.entries })), summary });
  return { chapters, summary, fingerprint: planFingerprint };
}

function providerKind(stage: StageExecutionNode): "llm" | "tts" | "images" | undefined {
  if (["translation", "narration", "qa", "storyBible", "continuity", "scenePlanning"].includes(stage)) return "llm";
  if (stage === "tts") return "tts";
  if (stage === "artwork") return "images";
  return undefined;
}

async function inspectArtifact(root: string, story: string, chapterNumber: number, stage: StageExecutionNode): Promise<StageArtifactState> {
  return inspectStageArtifact(root, story, chapterNumber, stage);
}

export type StageExecutionProcessor = { run(options: PipelineOptions): Promise<unknown> };
export type StageExecutionRuntime = {
  pipeline: StageExecutionProcessor;
  alignment: { config: AlignmentConfig; engine?: AlignmentEngine };
  scenePlanner?: LLMProvider;
  image?: ImageProviderSource;
  video: VideoProcessor;
};

export function pipelineStopAfterForStages(stages: readonly StageExecutionNode[]): StageName | undefined {
  const core: StageName[] = ["ingestion", "translation", "narration", "qa", "storyBible", "continuity", "tts", "audioMastering"];
  const plannedCore = stages.filter((stage): stage is StageName => core.includes(stage as StageName));
  if (!plannedCore.length) return stages.includes("context") ? "storyBible" : undefined;
  return core[Math.max(...plannedCore.map((stage) => core.indexOf(stage)))]!;
}

/** Execute exactly the stages chosen by `planStageExecution`.  The core
 * pipeline receives the plan, while optional media branches use their existing
 * application services. */
export async function executeStagePlan(options: {
  root: string; story: Story; chapter: number; inputPath: string;
  source?: PipelineOptions["source"]; plan: StageExecutionPlan; runtime: StageExecutionRuntime;
  onStageEvent?: PipelineOptions["onStageEvent"];
}): Promise<void> {
  if (options.plan.blockedStages.length) throw new Error(`Cannot execute blocked plan: ${options.plan.blockedStages.join(", ")}`);
  const core: StageName[] = ["ingestion", "translation", "narration", "qa", "storyBible", "continuity", "tts", "audioMastering"];
  const last = pipelineStopAfterForStages(options.plan.runStages);
  if (last) {
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
