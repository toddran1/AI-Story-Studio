#!/usr/bin/env node
import { loadEnvironment } from "../../src/config/env.js";
import { loadStory } from "../../src/config/load-config.js";
import { QaResult, qaResultSchema } from "../../src/domain/qa.js";
import { createPipeline } from "../../src/pipeline/create-pipeline.js";
import { QualityGateError } from "../../src/pipeline/errors.js";
import { selectRepairStage } from "../../src/qa/repair.js";
import { loadImportedChapters } from "../../src/source/importer.js";
import { storyPaths } from "../../src/storage/paths.js";
import { readJsonIfExists } from "../../src/storage/story-files.js";
import { withStoryLock } from "../../src/storage/story-lock.js";

async function main() {
  const args = parseArgs(process.argv.slice(2)); const root = process.cwd(); const env = loadEnvironment();
  await withStoryLock(root, args.story, `repair chapter ${args.chapter}`, async () => {
    const paths = storyPaths(root, args.story, args.chapter); const story = await loadStory(paths.storyConfig);
    const imported = await loadImportedChapters(root, args.story); const source = imported.chapters.find((item) => item.chapter === args.chapter);
    if (!source) throw new Error(`Imported source does not contain Chapter ${args.chapter}`);
    const previous = await readJsonIfExists<QaResult>(paths.qa);
    if (!previous && !args.stage) throw new Error(`Chapter ${args.chapter} has no qa.json; run it normally or pass --stage translation|narration`);
    const stage = args.stage ?? selectRepairStage(qaResultSchema.parse(previous));
    let lastError: unknown;
    for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
      try {
        const chapter = await createPipeline(env).run({ root, story, chapter: args.chapter, inputPath: source.path, source: source.source, force: stage });
        process.stdout.write(`${JSON.stringify({ status: "repaired", story: story.slug, chapter: args.chapter, regenerated: stage, attempts: attempt, qa: chapter.quality }, null, 2)}\n`);
        return;
      } catch (error) {
        lastError = error;
        if (!(error instanceof QualityGateError) || attempt === args.maxAttempts) break;
      }
    }
    throw lastError;
  });
}

function parseArgs(values: string[]) {
  let story = "", chapter = 0, stage: "translation" | "narration" | undefined, maxAttempts = 1;
  for (let index = 0; index < values.length; index++) { const key = values[index]!, value = values[++index]; if (!value || value.startsWith("--")) usage(`Missing value for ${key}`); if (key === "--story") story = value; else if (key === "--chapter") chapter = Number(value); else if (key === "--stage" && (value === "translation" || value === "narration")) stage = value; else if (key === "--max-attempts") maxAttempts = Number(value); else usage(`Invalid argument: ${key}`); }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(story) || !Number.isInteger(chapter) || chapter < 1) usage("Required: --story and a positive --chapter");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2) usage("--max-attempts must be 1 or 2");
  return { story, chapter, stage, maxAttempts };
}
function usage(message: string): never { throw new Error(`${message}\nUsage: npm run story:repair -- --story <slug> --chapter <number> [--stage translation|narration] [--max-attempts 1|2]`); }
main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
