import { resolve } from "node:path";
import { loadEnvironment } from "../../src/config/env.js";
import { defaultStory } from "../../src/config/load-config.js";
import { createPipeline } from "../../src/pipeline/create-pipeline.js";
import { atomicWriteJson } from "../../src/storage/atomic-write.js";
import { storyPaths } from "../../src/storage/paths.js";

const root = process.cwd();
const env = loadEnvironment();
const story = defaultStory("smoke-test", env);
const paths = storyPaths(root, story.slug, 1);
await atomicWriteJson(paths.storyConfig, story);
await atomicWriteJson(paths.pipelineConfig, story.pipeline);
await createPipeline(env).run({
  root,
  story,
  chapter: 1,
  inputPath: resolve("tests/examples/chapter-001.zh.txt"),
  force: "all",
});
process.stdout.write(`Smoke test complete: ${paths.audio}\n`);
