#!/usr/bin/env node
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { loadStory } from "../../src/config/load-config.js";
import { selectChapterRange } from "../../src/batch/range.js";
import { loadImportedChapters } from "../../src/source/importer.js";
import { storyPaths } from "../../src/storage/paths.js";
import { withStoryLock } from "../../src/storage/story-lock.js";
import { generateStoredSubtitles } from "../../src/subtitles/chapter-subtitles.js";

async function main() { const args = parse(process.argv.slice(2)); const root = resolveStudioRoot(loadEnvironment()); await withStoryLock(root, args.story, "subtitle generation", async () => { const story = await loadStory(storyPaths(root, args.story, 1).storyConfig); const imported = await loadImportedChapters(root, args.story); const selected = selectChapterRange(imported.chapters, args.from, args.to); for (let index = 0; index < selected.length; index++) { const chapter = selected[index]!.chapter; const result = await generateStoredSubtitles({ root, story, chapter, force: args.force }); process.stdout.write(`[${index + 1}/${selected.length}] Chapter ${chapter}: ${result.reused ? "reused" : "generated"}\n`); } }); }
function parse(values: string[]) { let story = ""; let from: number | undefined; let to: number | undefined; let force = false; for (let index = 0; index < values.length; index++) { const key = values[index]!; if (key === "--force") { force = true; continue; } const value = values[++index]; if (!value || value.startsWith("--")) usage(`Missing value for ${key}`); if (key === "--story") story = value; else if (key === "--from") from = integer(value, key); else if (key === "--to") to = integer(value, key); else usage(`Unknown argument: ${key}`); } if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(story)) usage("--story must be a lowercase kebab-case slug"); return { story, from, to, force }; }
function integer(value: string, key: string) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1) usage(`${key} must be a positive integer`); return parsed; }
function usage(message: string): never { throw new Error(`${message}\nUsage: npm run story:subtitles -- --story <slug> [--from N --to N] [--force]`); }
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
