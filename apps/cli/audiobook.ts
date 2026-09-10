#!/usr/bin/env node
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { loadStory } from "../../src/config/load-config.js";
import { loadImportedChapters } from "../../src/source/importer.js";
import { selectChapterRange } from "../../src/batch/range.js";
import { storyPaths } from "../../src/storage/paths.js";
import { withStoryLock } from "../../src/storage/story-lock.js";
import { FfmpegMasteringProcessor } from "../../src/audio/mastering.js";
import { masterStoredChapter } from "../../src/audio/chapter-audio.js";
import { AudiobookFormat, FfmpegAudiobookProcessor, assembleAudiobook } from "../../src/audio/audiobook.js";

async function main() {
  const args = parse(process.argv.slice(2)); const root = resolveStudioRoot(loadEnvironment());
  await withStoryLock(root, args.story, "audiobook assembly", async () => {
    const story = await loadStory(storyPaths(root, args.story, 1).storyConfig); const imported = await loadImportedChapters(root, args.story);
    const selected = selectChapterRange(imported.chapters, args.from, args.to); const mastering = new FfmpegMasteringProcessor();
    for (let index = 0; index < selected.length; index++) { const item = selected[index]!; const result = await masterStoredChapter({ root, story, chapter: item.chapter, processor: mastering }); process.stdout.write(`[master ${index + 1}/${selected.length}] Chapter ${item.chapter}: ${result.reused ? "reused" : "mastered"}\n`); }
    const from = selected[0]!.chapter; const to = selected.at(-1)!.chapter; const result = await assembleAudiobook({ root, story, from, to, format: args.format, processor: new FfmpegAudiobookProcessor(), force: args.force });
    process.stdout.write(`${result.reused ? "Reused" : "Built"} ${result.manifest.output}\nDuration: ${result.manifest.durationSeconds.toFixed(1)}s\n`);
  });
}

function parse(values: string[]) { let story = ""; let from: number | undefined; let to: number | undefined; let format: AudiobookFormat = "m4b"; let force = false;
  for (let index = 0; index < values.length; index++) { const key = values[index]!; if (key === "--force") { force = true; continue; } const value = values[++index]; if (!value || value.startsWith("--")) usage(`Missing value for ${key}`);
    if (key === "--story") story = value; else if (key === "--from") from = integer(value, key); else if (key === "--to") to = integer(value, key); else if (key === "--format" && (value === "mp3" || value === "m4b")) format = value; else usage(`Invalid argument: ${key}`); }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(story)) usage("--story must be a lowercase kebab-case slug"); return { story, from, to, format, force }; }
function integer(value: string, key: string) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1) usage(`${key} must be a positive integer`); return parsed; }
function usage(message: string): never { throw new Error(`${message}\nUsage: npm run story:audiobook -- --story <slug> [--from N --to N] [--format mp3|m4b] [--force]`); }
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
