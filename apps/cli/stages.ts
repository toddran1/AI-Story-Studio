#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { loadStory } from "../../src/config/load-config.js";
import { createPipelineRuntime } from "../../src/pipeline/create-pipeline.js";
import { alignmentConfig, createAlignmentEngine } from "../../src/alignment/config.js";
import { FfmpegVideoProcessor } from "../../src/video/renderer.js";
import { loadImportedChapters } from "../../src/source/importer.js";
import { storyPaths } from "../../src/storage/paths.js";
import { withStoryLock } from "../../src/storage/story-lock.js";
import { markCurrentStageSchema, markStagesCurrent } from "../../src/studio/stage-acceptance.js";
import { executeStagePlan, planStageExecutionBatch, stageExecutionModeSchema, type StageExecutionBatchPlan, type StageExecutionMode } from "../../src/studio/stage-execution.js";
import { batchStageSchema, type BatchStage } from "../../src/studio/stage-selection.js";
import { parseChapterSelection, selectChapterNumbers } from "../../src/batch/range.js";

type MarkCurrentCommand = { kind: "mark-current"; story: string; chapters: number[]; stages: Array<(typeof markCurrentStageSchema.options)[number]>; reason?: string };
type RunCommand = { kind: "run"; story: string; chapters: number[]; stages: BatchStage[]; mode: StageExecutionMode; force: boolean; dryRun: boolean };
type Command = MarkCurrentCommand | RunCommand;
export function parseStagesArgs(args: string[]): Command {
  const action = args.shift();
  if (action === "run") return parseRun(args);
  if (action !== "mark-current") throw new Error(usage());
  const story = validSlug(args.shift()); let from: number | undefined; let to: number | undefined; let chapters: number[] | undefined; let stages: MarkCurrentCommand["stages"] | undefined; let reason: string | undefined;
  while (args.length) { const key = args.shift()!; const value = args.shift(); if (!value) throw new Error(`Missing value for ${key}`); if (key === "--from") from = positive(value); else if (key === "--to") to = positive(value); else if (key === "--chapters") chapters = parseChapterSelection(value); else if (key === "--stages") stages = value.split(",").map((stage) => markCurrentStageSchema.parse(stage.trim())); else if (key === "--reason") reason = value; else throw new Error(`Unknown option: ${key}`); }
  if (!stages?.length) throw new Error("--stages is required"); if (chapters && (from || to)) throw new Error("Use either --chapters or --from/--to");
  if (!chapters) { if (!from || !to || to < from || to - from > 1_999) throw new Error("--from and --to must be a valid range of at most 2,000 chapters"); chapters = Array.from({ length: to - from + 1 }, (_, index) => from + index); }
  return { kind: "mark-current", story, chapters, stages, reason };
}
function parseRun(args: string[]): RunCommand {
  const story = validSlug(args.shift()); let chapters: number[] | undefined; let stages: BatchStage[] | undefined; let mode: StageExecutionMode = "selected"; let force = false; let dryRun = false;
  if (args[0] && !args[0].startsWith("--")) { chapters = [positive(args.shift()!)]; stages = [batchStageSchema.parse(args.shift())]; }
  while (args.length) {
    const key = args.shift()!;
    if (key === "--dry-run") dryRun = true;
    else if (key === "--force") force = true;
    else if (key === "--through") mode = "prerequisites";
    else { const value = args.shift(); if (!value) throw new Error(`Missing value for ${key}`); if (key === "--chapters") chapters = parseChapterSelection(value); else if (key === "--stages") stages = [...new Set(value.split(",").map((stage) => batchStageSchema.parse(stage.trim())))]; else if (key === "--mode") mode = stageExecutionModeSchema.parse(value); else throw new Error(`Unknown option: ${key}`); }
  }
  if (!chapters?.length || !stages?.length) throw new Error(usage("Run requires --chapters and --stages"));
  return { kind: "run", story, chapters, stages, mode, force, dryRun };
}
function validSlug(value: string | undefined) { if (!value || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error("A valid story slug is required"); return value; }
function positive(value: string) { const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new Error(`Expected a positive chapter number, received '${value}'`); return number; }
function usage(message = "Invalid stage command") { return `${message}\nUsage:\n  story:stages run <story> --chapters "5,10,40-50" --stages narration,qa [--mode selected|prerequisites] [--force] [--dry-run]\n  story:stages mark-current <story> (--from N --to N | --chapters "1,3,8-10") --stages translation,narration [--reason text]`; }
export function formatStagePlan(plan: StageExecutionBatchPlan) { const lines = [`Chapters: ${plan.summary.chapterCount}`, `Stages: ${plan.summary.selectedStages.join(", ")}`, `Mode: ${plan.summary.mode === "selected" ? "selected stages only" : "selected stages + prerequisites"}`, "", "RUN"]; for (const [stage, count] of Object.entries(plan.summary.plannedByStage)) lines.push(`  ${stage.padEnd(18)} ${count}`); lines.push("", "REUSE"); for (const [stage, count] of Object.entries(plan.summary.reusedByStage)) lines.push(`  ${stage.padEnd(18)} ${count}`); lines.push("", "BLOCKED"); for (const [stage, count] of Object.entries(plan.summary.blockedByStage)) lines.push(`  ${stage.padEnd(18)} ${count}`); lines.push("", "Provider operations", `  LLM       ${plan.summary.providerOperations.llm}`, `  TTS       ${plan.summary.providerOperations.tts}`, `  Images    ${plan.summary.providerOperations.images}`, `Plan: ${plan.fingerprint}`); return `${lines.join("\n")}\n`; }
async function main() {
  const command = parseStagesArgs(process.argv.slice(2)); const env = loadEnvironment(); const root = resolveStudioRoot(env);
  if (command.kind === "mark-current") { const result = await markStagesCurrent(root, command.story, { chapters: command.chapters, stages: command.stages, reason: command.reason }); process.stdout.write(`${JSON.stringify(result)}\n`); return; }
  const imported = await loadImportedChapters(root, command.story); const selected = selectChapterNumbers(imported.chapters, command.chapters);
  const makePlan = () => planStageExecutionBatch({ root, story: command.story, chapters: selected.map((chapter) => chapter.chapter), selectedStages: command.stages, mode: command.mode, force: command.force });
  if (command.dryRun) { process.stdout.write(formatStagePlan(await makePlan())); return; }
  const runtime = createPipelineRuntime(env); const config = alignmentConfig(env, root);
  await withStoryLock(root, command.story, "manual stage processing", async () => {
    const story = await loadStory(storyPaths(root, command.story, 1).storyConfig); const plan = await makePlan(); process.stdout.write(formatStagePlan(plan));
    if (plan.summary.blockedOperations) throw new Error(`${plan.summary.blockedOperations} operation${plan.summary.blockedOperations === 1 ? " is" : "s are"} blocked. Use --mode prerequisites or provide the missing prerequisites.`);
    const sources = new Map(selected.map((chapter) => [chapter.chapter, chapter]));
    for (const chapterPlan of plan.chapters) {
      if (chapterPlan.blockedStages.length) { process.stdout.write(`blocked\t${chapterPlan.chapter}\t${chapterPlan.blockedStages.join(",")}\n`); continue; }
      if (!chapterPlan.runStages.length) { process.stdout.write(`reused\t${chapterPlan.chapter}\n`); continue; }
      const source = sources.get(chapterPlan.chapter)!;
      await executeStagePlan({ root, story, chapter: chapterPlan.chapter, inputPath: source.path, source: source.source, plan: chapterPlan, runtime: { pipeline: runtime.pipeline, alignment: { config, engine: createAlignmentEngine(config) }, scenePlanner: runtime.router.forStage(story.pipeline.scenePlanner), image: runtime.images.forName(story.artwork.provider), video: new FfmpegVideoProcessor() }, onStageEvent: (event) => process.stdout.write(`${event.status}\t${chapterPlan.chapter}\t${event.stage}\n`) });
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
