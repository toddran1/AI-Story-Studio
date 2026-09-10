#!/usr/bin/env node
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { loadStory } from "../../src/config/load-config.js";
import { selectChapterRange } from "../../src/batch/range.js";
import { loadImportedChapters } from "../../src/source/importer.js";
import { storyPaths } from "../../src/storage/paths.js";
import { withStoryLock } from "../../src/storage/story-lock.js";
import { generateStoredSubtitles } from "../../src/subtitles/chapter-subtitles.js";
import { renderStoredChapterVideo } from "../../src/video/chapter-video.js";
import { FfmpegVideoProcessor } from "../../src/video/renderer.js";
import { assembleVideoExport, FfmpegVideoExportProcessor } from "../../src/video/video-export.js";

async function main() { const args = parse(process.argv.slice(2)); const root = resolveStudioRoot(loadEnvironment()); await withStoryLock(root, args.story, "combined video export", async () => { const story = await loadStory(storyPaths(root, args.story, 1).storyConfig); const selected = selectChapterRange((await loadImportedChapters(root, args.story)).chapters, args.from, args.to); const renderer = new FfmpegVideoProcessor(); for (let index = 0; index < selected.length; index++) { const chapter = selected[index]!.chapter; if (story.video.subtitleMode !== "none") await generateStoredSubtitles({ root, story, chapter }); const result = await renderStoredChapterVideo({ root, story, chapter, processor: renderer }); process.stdout.write(`[render ${index + 1}/${selected.length}] Chapter ${chapter}: ${result.reused ? "reused" : "rendered"}\n`); } const from = selected[0]!.chapter; const to = selected.at(-1)!.chapter; const result = await assembleVideoExport({ root, story, from, to, processor: new FfmpegVideoExportProcessor(), force: args.force }); process.stdout.write(`${result.reused ? "Reused" : "Built"} ${result.manifest.output}\n`); }); }
function parse(values: string[]) { let story = ""; let from: number | undefined; let to: number | undefined; let force = false; for (let index = 0; index < values.length; index++) { const key = values[index]!; if (key === "--force") { force = true; continue; } const value = values[++index]; if (!value || value.startsWith("--")) usage(`Missing value for ${key}`); if (key === "--story") story = value; else if (key === "--from") from = integer(value, key); else if (key === "--to") to = integer(value, key); else usage(`Unknown argument: ${key}`); } if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(story)) usage("--story must be a lowercase kebab-case slug"); return { story, from, to, force }; }
function integer(value: string, key: string) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1) usage(`${key} must be a positive integer`); return parsed; }
function usage(message: string): never { throw new Error(`${message}\nUsage: npm run story:video-export -- --story <slug> [--from N --to N] [--force]`); }
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
