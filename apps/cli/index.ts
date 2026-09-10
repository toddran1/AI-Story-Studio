#!/usr/bin/env node
import { resolve } from "node:path";
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { defaultStory, loadStory } from "../../src/config/load-config.js";
import { createPipeline } from "../../src/pipeline/create-pipeline.js";
import { ForceStage } from "../../src/pipeline/chapter-pipeline.js";
import { atomicWriteJson } from "../../src/storage/atomic-write.js";
import { exists } from "../../src/storage/story-files.js";
import { storyPaths } from "../../src/storage/paths.js";
import { withStoryLock } from "../../src/storage/story-lock.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== "process") usage("Expected the 'process' command");
  if (!args.story || !args.chapter || !args.input) usage("Required: --story, --chapter, and --input");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.story)) usage("--story must be a lowercase kebab-case slug");
  const chapter = Number(args.chapter);
  if (!Number.isInteger(chapter) || chapter < 1) usage("--chapter must be a positive integer");
  const env = loadEnvironment(); const root = resolveStudioRoot(env);
  await withStoryLock(root, args.story, `process chapter ${chapter}`, () => processChapter({ ...args, story: args.story!, input: args.input! }, chapter, root, env));
}

async function processChapter(args: Args & { story: string; input: string }, chapter: number, root: string, env: ReturnType<typeof loadEnvironment>) {
  const paths = storyPaths(root, args.story, chapter);
  const story = await exists(paths.storyConfig) ? await loadStory(paths.storyConfig) : defaultStory(args.story, env);
  await atomicWriteJson(paths.storyConfig, story);
  await atomicWriteJson(paths.pipelineConfig, story.pipeline);
  const result = await createPipeline(env).run({ root, story, chapter, inputPath: resolve(args.input), force: args.force });
  process.stdout.write(`${JSON.stringify({ story: story.slug, chapter, status: "complete", stages: result.stages, output: paths.chapterDir }, null, 2)}\n`);
}

type Args = { command?: string; story?: string; chapter?: string; input?: string; force?: ForceStage };
function parseArgs(values: string[]): Args {
  const result: Args = { command: values[0] };
  for (let index = 1; index < values.length; index++) {
    const key = values[index]; const value = values[index + 1];
    if (["--story", "--chapter", "--input", "--force"].includes(key ?? "") && (value === undefined || value.startsWith("--"))) usage(`Missing value for ${key}`);
    if (key === "--story" || key === "--chapter" || key === "--input") { result[key.slice(2) as "story" | "chapter" | "input"] = value; index++; }
    else if (key === "--force") { if (!["translation", "narration", "qa", "story-bible", "tts", "audio", "all"].includes(value)) usage("Invalid --force stage"); result.force = value as ForceStage; index++; }
    else usage(`Unknown argument: ${key}`);
  }
  return result;
}
function usage(message: string): never {
  throw new Error(`${message}\nUsage: npm run story:process -- --story <slug> --chapter <number> --input <file> [--force translation|narration|qa|story-bible|tts|audio|all]`);
}
main().catch((error: unknown) => {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
  process.stderr.write(`${JSON.stringify({ event: "cli.failed", error: error instanceof Error ? error.message : String(error), cause }, null, 2)}\n`);
  process.exitCode = 1;
});
