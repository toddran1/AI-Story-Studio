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
import { stageNameSchema } from "../../src/domain/chapter.js";
import { markCurrentStageSchema, markStagesCurrent } from "../../src/studio/stage-acceptance.js";
import { executeStagePlan, planStageExecution, stageExecutionModeSchema } from "../../src/studio/stage-execution.js";

type MarkCurrentCommand = { story: string; chapters: number[]; stages: Array<(typeof markCurrentStageSchema.options)[number]>; reason?: string };
type RunCommand = { kind: "run"; story: string; chapter: number; stage: ReturnType<typeof stageNameSchema.parse>; mode: "selected" | "through"; dryRun: boolean };
type Command = MarkCurrentCommand | RunCommand;
export function parseStagesArgs(args: string[]): Command {
  const action = args.shift();
  if (action === "run") return parseRun(args);
  if (action !== "mark-current") throw new Error("Usage: story:stages run <story> <chapter> <stage> [--through|--mode through] [--dry-run]\n       story:stages mark-current <story> (--from N --to N | --chapters 1,2) --stages translation,narration [--reason text]");
  const story = validSlug(args.shift()); let from: number | undefined; let to: number | undefined; let chapters: number[] | undefined; let stages: MarkCurrentCommand["stages"] | undefined; let reason: string | undefined;
  while (args.length) { const key = args.shift()!; const value = args.shift(); if (!value) throw new Error(`Missing value for ${key}`); if (key === "--from") from = positive(value); else if (key === "--to") to = positive(value); else if (key === "--chapters") chapters = value.split(",").map(positive); else if (key === "--stages") stages = value.split(",").map((stage) => markCurrentStageSchema.parse(stage)); else if (key === "--reason") reason = value; else throw new Error(`Unknown option: ${key}`); }
  if (!stages?.length) throw new Error("--stages is required"); if (chapters && (from || to)) throw new Error("Use either --chapters or --from/--to");
  if (!chapters) { if (!from || !to || to < from || to - from > 1_999) throw new Error("--from and --to must be a valid range of at most 2,000 chapters"); chapters = Array.from({ length: to - from + 1 }, (_, index) => from + index); }
  return { story, chapters, stages, reason };
}
function parseRun(args: string[]): RunCommand { const story = validSlug(args.shift()); const chapter = positive(args.shift() ?? ""); const stage = stageNameSchema.parse(args.shift()); let mode: RunCommand["mode"] = "selected"; let dryRun = false; while (args.length) { const key = args.shift()!; if (key === "--through") mode = "through"; else if (key === "--dry-run") dryRun = true; else if (key === "--mode") mode = stageExecutionModeSchema.parse(args.shift()); else throw new Error(`Unknown option: ${key}`); } return { kind: "run", story, chapter, stage, mode, dryRun }; }
function validSlug(value: string | undefined) { if (!value || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error("A valid story slug is required"); return value; }
function positive(value: string) { const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new Error(`Expected a positive chapter number, received '${value}'`); return number; }
async function main() {
  const command = parseStagesArgs(process.argv.slice(2)); const env = loadEnvironment(); const root = resolveStudioRoot(env);
  if (!("chapter" in command)) { const result = await markStagesCurrent(root, command.story, { chapters: command.chapters, stages: command.stages, reason: command.reason }); process.stdout.write(`${JSON.stringify(result)}\n`); return; }
  const story = await loadStory(storyPaths(root, command.story, 1).storyConfig); const plan = await planStageExecution({ root, story: command.story, chapter: command.chapter, selectedStage: command.stage, mode: command.mode });
  if (command.dryRun) { process.stdout.write(`${JSON.stringify(plan)}\n`); return; }
  const source = (await loadImportedChapters(root, command.story)).chapters.find((item) => item.chapter === command.chapter); if (!source) throw new Error(`Chapter ${command.chapter} is not imported for story '${command.story}'`);
  const runtime = createPipelineRuntime(env); const config = alignmentConfig(env, root);
  await withStoryLock(root, command.story, "manual stage processing", () => executeStagePlan({ root, story, chapter: command.chapter, inputPath: source.path, source: source.source, plan, runtime: { pipeline: runtime.pipeline, alignment: { config, engine: createAlignmentEngine(config) }, scenePlanner: runtime.router.forStage(story.pipeline.scenePlanner), image: runtime.images.forName(story.artwork.provider), video: new FfmpegVideoProcessor() }, onStageEvent: (event) => process.stdout.write(`${event.status}\t${event.stage}\n`) }));
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
