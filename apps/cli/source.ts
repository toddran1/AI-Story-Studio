#!/usr/bin/env node
import { resolve } from "node:path";
import { loadEnvironment } from "../../src/config/env.js";
import { defaultStory, loadStory } from "../../src/config/load-config.js";
import { Story } from "../../src/domain/story.js";
import { atomicWriteJson } from "../../src/storage/atomic-write.js";
import { storyPaths } from "../../src/storage/paths.js";
import { exists } from "../../src/storage/story-files.js";
import { importSource } from "../../src/source/importer.js";
import { validateImportable } from "../../src/source/inspection.js";
import { SourceProviderRegistry } from "../../src/source/registry.js";
import { sourceTypeSchema, SourceInspection, SourceType } from "../../src/source/types.js";
import { withStoryLock } from "../../src/storage/story-lock.js";

async function main() {
  const command = process.argv[2]; if (command !== "inspect" && command !== "import") usage("Expected inspect or import");
  const args = parseArgs(process.argv.slice(3)); if (!args.source) usage("--source is required");
  if (command === "import" && !args.story) usage("--story is required for import");
  if (args.story && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.story)) usage("--story must be a lowercase kebab-case slug");
  const sourcePath = resolve(args.source); const registry = new SourceProviderRegistry();
  const { provider, semanticType } = await registry.resolve(sourcePath, args.type);
  if (args.chapter && args.splitChapters) usage("--chapter and --split-chapters cannot be used together");
  if ((args.chapter || args.splitChapters) && !["text", "manual", "original"].includes(semanticType)) usage("--chapter and --split-chapters apply only to TXT/manual/original sources");
  const inspection = await provider.inspect(sourcePath, { splitChapters: args.splitChapters, chapter: args.chapter, allowGaps: args.allowGaps, semanticType });
  if (command === "inspect") { process.stdout.write(`${formatInspection(inspection)}\n`); return; }
  validateImportable(inspection.chapters, inspection.warnings, args.allowGaps);
  const root = process.cwd(); const storySlug = args.story!;
  await withStoryLock(root, storySlug, "source import", async () => {
    const paths = storyPaths(root, storySlug, inspection.chapters[0]?.ref.chapter ?? 1); const existed = await exists(paths.storyConfig);
    let story = existed ? await loadStory(paths.storyConfig) : defaultStory(storySlug, loadEnvironment());
    story = applySourceMetadata(story, inspection, !existed);
    const result = await importSource(root, storySlug, inspection, async () => {
      await atomicWriteJson(paths.pipelineConfig, story.pipeline); await atomicWriteJson(paths.storyConfig, story);
    });
    process.stdout.write(`${formatImport(storySlug, result)}\n`);
  });
}

type Args = { source?: string; story?: string; type?: SourceType; chapter?: number; splitChapters: boolean; allowGaps: boolean };
function parseArgs(values: string[]): Args {
  const args: Args = { splitChapters: false, allowGaps: false };
  for (let index = 0; index < values.length; index++) {
    const key = values[index]!;
    if (key === "--split-chapters") { args.splitChapters = true; continue; }
    if (key === "--allow-gaps") { args.allowGaps = true; continue; }
    const value = values[++index]; if (!value || value.startsWith("--")) usage(`Missing value for ${key}`);
    if (key === "--source") args.source = value; else if (key === "--story") args.story = value;
    else if (key === "--chapter") { const number = Number(value); if (!Number.isInteger(number) || number < 1) usage("--chapter must be a positive integer"); args.chapter = number; }
    else if (key === "--type") { const parsed = sourceTypeSchema.safeParse(value); if (!parsed.success) usage(`Unsupported source type: ${value}`); args.type = parsed.data; }
    else usage(`Unknown argument: ${key}`);
  }
  return args;
}

function applySourceMetadata(story: Story, inspection: SourceInspection, isNew: boolean): Story {
  return {
    ...story,
    title: isNew && inspection.title ? inspection.title : story.title,
    author: story.author ?? inspection.author,
    sourceLanguage: isNew && inspection.language ? normalizeLanguage(inspection.language) : story.sourceLanguage,
    source: { type: inspection.sourceType, path: "source" },
  };
}
function normalizeLanguage(language: string) {
  const normalized = language.trim().replace(/_/g, "-");
  if (normalized.toLowerCase() === "en") return "en-US";
  if (normalized.toLowerCase() === "zh") return "zh-CN";
  return normalized;
}
function formatInspection(inspection: SourceInspection) {
  const lines = [`Source: ${inspection.sourcePath}`, `Type: ${inspection.sourceType.toUpperCase()}`, `Title: ${inspection.title ?? "unknown"}`, `Author: ${inspection.author ?? "unknown"}`, `Language: ${inspection.language ?? "unknown"}`, `Detected chapters: ${inspection.chapters.length}`];
  for (const item of inspection.chapters) lines.push(`${item.ref.chapter}\t${item.ref.originalTitle ?? item.ref.sourceTitle ?? item.ref.sourceId}`);
  if (inspection.unnumberedSections.length) { lines.push("Unnumbered sections:"); for (const item of inspection.unnumberedSections) lines.push(`- ${item.title ?? item.sourceId}`); }
  lines.push("Warnings:"); if (!inspection.warnings.length) lines.push("- none"); else for (const warning of inspection.warnings) lines.push(`- [${warning.code}] ${warning.message}`);
  return lines.join("\n");
}
function formatImport(story: string, result: Awaited<ReturnType<typeof importSource>>) {
  const list = (values: number[]) => values.join(", ") || "none";
  return [`Source ${result.status}`, `Story: ${story}`, `Chapters: ${result.manifest.chapters.length}`, `Added: ${list(result.added)}`, `Modified: ${list(result.modified)}`, `Removed: ${list(result.removed)}`, `Manifest: stories/${story}/source/source.json`, "No LLM or TTS calls were made."].join("\n");
}
function usage(message: string): never { throw new Error(`${message}\nUsage: npm run story:inspect -- --source <path> [--type text|epub|docx|manual|original] [--split-chapters] [--chapter N] [--allow-gaps]\n   or: npm run story:import -- --story <slug> --source <path> [same options]`); }

main().catch((error: unknown) => { process.stderr.write(`${JSON.stringify({ event: "source.failed", error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`); process.exitCode = 1; });
