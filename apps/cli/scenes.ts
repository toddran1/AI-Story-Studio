#!/usr/bin/env node
import { selectChapterRange } from "../../src/batch/range.js";
import { loadEnvironment } from "../../src/config/env.js";
import { loadStory } from "../../src/config/load-config.js";
import { createPipelineRuntime } from "../../src/pipeline/create-pipeline.js";
import { planStoredScenes } from "../../src/scenes/manifest.js";
import { loadImportedChapters } from "../../src/source/importer.js";
import { storyPaths } from "../../src/storage/paths.js";
import { withStoryLock } from "../../src/storage/story-lock.js";

async function main() { const args = parse(process.argv.slice(2)); const env = loadEnvironment(); await withStoryLock(process.cwd(), args.story, "scene planning", async () => { const story = await loadStory(storyPaths(process.cwd(), args.story, 1).storyConfig); const runtime = createPipelineRuntime(env); const selected = selectChapterRange((await loadImportedChapters(process.cwd(), args.story)).chapters, args.from, args.to); for (let index = 0; index < selected.length; index++) { const chapter = selected[index]!.chapter; const result = await planStoredScenes({ root: process.cwd(), story, chapter, provider: runtime.router.forStage(story.pipeline.scenePlanner), force: args.force }); process.stdout.write(`[${index + 1}/${selected.length}] Chapter ${chapter}: ${result.reused ? "reused" : `planned ${result.manifest.scenes.length} scenes`}\n`); } }); }
function parse(values: string[]) { let story = ""; let from: number | undefined; let to: number | undefined; let chapter: number | undefined; let force = false; for (let index = 0; index < values.length; index++) { const key = values[index]!; if (key === "--force") { force = true; continue; } const value = values[++index]; if (!value || value.startsWith("--")) usage(`Missing value for ${key}`); if (key === "--story") story = value; else if (key === "--chapter") chapter = integer(value, key); else if (key === "--from") from = integer(value, key); else if (key === "--to") to = integer(value, key); else usage(`Unknown argument: ${key}`); } if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(story)) usage("--story must be a lowercase kebab-case slug"); if (chapter !== undefined) { if (from !== undefined || to !== undefined) usage("Use --chapter or --from/--to, not both"); from = chapter; to = chapter; } if (from === undefined || to === undefined) usage("Choose an explicit --chapter or --from and --to range"); if (to < from) usage("--to must be greater than or equal to --from"); return { story, from, to, force }; }
function integer(value: string, key: string) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1) usage(`${key} must be a positive integer`); return parsed; }
function usage(message: string): never { throw new Error(`${message}\nUsage: npm run story:scenes -- --story <slug> (--chapter N | --from N --to N) [--force]`); }
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
