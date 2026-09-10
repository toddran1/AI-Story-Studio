#!/usr/bin/env node
import { loadStory } from "../../src/config/load-config.js";
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { applyPreviewProfile } from "../../src/preview/profile.js";
import { storyPaths } from "../../src/storage/paths.js";
import { withStoryLock } from "../../src/storage/story-lock.js";

async function main() {
  const args = parseArgs(process.argv.slice(2)); const root = resolveStudioRoot(loadEnvironment());
  await withStoryLock(root, args.story, `select preview ${args.preview}`, async () => {
    const story = await loadStory(storyPaths(root, args.story, 1).storyConfig);
    const updated = await applyPreviewProfile(root, story, args.preview, args.choice);
    process.stdout.write(`${JSON.stringify({ status: "saved", story: updated.slug, preview: args.preview, choice: args.choice, pipeline: updated.pipeline }, null, 2)}\n`);
  });
}
function parseArgs(values: string[]) {
  let story = "", preview = "", choice: "a" | "b" | undefined;
  for (let index = 0; index < values.length; index++) { const key = values[index]!, value = values[++index]; if (!value || value.startsWith("--")) usage(`Missing value for ${key}`); if (key === "--story") story = value; else if (key === "--use-preview") preview = value; else if (key === "--choice" && (value === "a" || value === "b")) choice = value; else usage(`Invalid argument: ${key}`); }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(story) || !preview || !choice) usage("Required: --story, --use-preview, and --choice a|b");
  return { story, preview, choice };
}
function usage(message: string): never { throw new Error(`${message}\nUsage: npm run story:profile -- --story <slug> --use-preview <id> --choice a|b`); }
main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
