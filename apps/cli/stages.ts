#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { markCurrentStageSchema, markStagesCurrent } from "../../src/studio/stage-acceptance.js";

type Command = { story: string; chapters: number[]; stages: Array<(typeof markCurrentStageSchema.options)[number]>; reason?: string };
export function parseStagesArgs(args: string[]): Command {
  if (args.shift() !== "mark-current") throw new Error("Usage: story:stages mark-current <story> (--from N --to N | --chapters 1,2) --stages translation,narration [--reason text]");
  const story = args.shift(); if (!story || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(story)) throw new Error("A valid story slug is required");
  let from: number | undefined; let to: number | undefined; let chapters: number[] | undefined; let stages: Command["stages"] | undefined; let reason: string | undefined;
  while (args.length) { const key = args.shift(); const value = args.shift(); if (!value) throw new Error(`Missing value for ${key}`); if (key === "--from") from = positive(value); else if (key === "--to") to = positive(value); else if (key === "--chapters") chapters = value.split(",").map(positive); else if (key === "--stages") stages = value.split(",").map((stage) => markCurrentStageSchema.parse(stage)); else if (key === "--reason") reason = value; else throw new Error(`Unknown option: ${key}`); }
  if (!stages?.length) throw new Error("--stages is required");
  if (chapters && (from || to)) throw new Error("Use either --chapters or --from/--to");
  if (!chapters) { if (!from || !to || to < from || to - from > 1_999) throw new Error("--from and --to must be a valid range of at most 2,000 chapters"); chapters = Array.from({ length: to - from + 1 }, (_, index) => from + index); }
  return { story, chapters, stages, reason };
}
function positive(value: string) { const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new Error(`Expected a positive chapter number, received '${value}'`); return number; }
async function main() { const command = parseStagesArgs(process.argv.slice(2)); const env = loadEnvironment(); const result = await markStagesCurrent(resolveStudioRoot(env), command.story, { chapters: command.chapters, stages: command.stages, reason: command.reason }); process.stdout.write(`${JSON.stringify(result)}\n`); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
