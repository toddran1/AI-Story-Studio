#!/usr/bin/env node
import { resolve } from "node:path";
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { defaultStory, loadStory } from "../../src/config/load-config.js";
import { atomicWriteJson } from "../../src/storage/atomic-write.js";
import { storyPaths } from "../../src/storage/paths.js";
import { exists } from "../../src/storage/story-files.js";
import { importSource } from "../../src/source/importer.js";
import { validateImportable } from "../../src/source/inspection.js";
import { SourceProviderRegistry } from "../../src/source/registry.js";
import { sourceTypeSchema, SourceInspection, SourceType } from "../../src/source/types.js";
import { withStoryLock } from "../../src/storage/story-lock.js";
import { createWebHttpClient } from "../../src/source/web/create-client.js";
import { applySourceMetadata } from "../../src/source/story-metadata.js";

async function main() {
  const command = process.argv[2]; if (command !== "inspect" && command !== "import" && command !== "update") usage("Expected inspect, import, or update");
  const args = parseArgs(process.argv.slice(3)); if (!args.source) usage("--source is required");
  if ((command === "import" || command === "update") && !args.story) usage(`--story is required for ${command}`);
  if (args.story && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.story)) usage("--story must be a lowercase kebab-case slug");
  const env = loadEnvironment(); const root = resolveStudioRoot(env);
  const sourcePath = isUrl(args.source) ? args.source : resolve(args.source); const registry = new SourceProviderRegistry(undefined, createWebHttpClient(root, env));
  const { provider, semanticType } = await registry.resolve(sourcePath, args.type);
  if (args.chapter && args.splitChapters) usage("--chapter and --split-chapters cannot be used together");
  if ((args.chapter || args.splitChapters) && !["text", "manual", "original"].includes(semanticType)) usage("--chapter and --split-chapters apply only to TXT/manual/original sources");
  const remote = semanticType === "fanqie" || semanticType === "web";
  if (remote && command !== "inspect" && (args.from === undefined || args.to === undefined)) usage("Remote imports require both --from and --to");
  if (!remote && (args.from !== undefined || args.to !== undefined || args.probe !== undefined)) usage("--from, --to, and --probe apply only to remote sources");
  if (command !== "inspect" && args.probe !== undefined) usage("--probe is inspection-only");
  const inspection = await provider.inspect(sourcePath, { splitChapters: args.splitChapters, chapter: args.chapter, allowGaps: args.allowGaps, semanticType, from: args.from, to: args.to, probe: args.probe });
  if (command === "inspect") { process.stdout.write(`${formatInspection(inspection)}\n`); return; }
  validateImportable(inspection.chapters, inspection.warnings, args.allowGaps);
  const storySlug = args.story!;
  await withStoryLock(root, storySlug, "source import", async () => {
    const paths = storyPaths(root, storySlug, inspection.chapters[0]?.ref.chapter ?? 1); const existed = await exists(paths.storyConfig);
    if (command === "update" && !existed) throw new Error(`Story '${storySlug}' does not exist. Use story:import to create its initial source.`);
    if (command === "update") inspection.additive = true;
    let story = existed ? await loadStory(paths.storyConfig) : defaultStory(storySlug, loadEnvironment());
    story = applySourceMetadata(story, inspection, !existed);
    const result = await importSource(root, storySlug, inspection, async () => {
      await atomicWriteJson(paths.pipelineConfig, story.pipeline); await atomicWriteJson(paths.storyConfig, story);
    });
    process.stdout.write(`${formatImport(storySlug, result)}\n`);
  });
}

type Args = { source?: string; story?: string; type?: SourceType; chapter?: number; from?: number; to?: number; probe?: number; splitChapters: boolean; allowGaps: boolean };
function parseArgs(values: string[]): Args {
  const args: Args = { splitChapters: false, allowGaps: false };
  for (let index = 0; index < values.length; index++) {
    const key = values[index]!;
    if (key === "--split-chapters") { args.splitChapters = true; continue; }
    if (key === "--allow-gaps") { args.allowGaps = true; continue; }
    const value = values[++index]; if (!value || value.startsWith("--")) usage(`Missing value for ${key}`);
    if (key === "--source") args.source = value; else if (key === "--story") args.story = value;
    else if (key === "--chapter") { const number = Number(value); if (!Number.isInteger(number) || number < 1) usage("--chapter must be a positive integer"); args.chapter = number; }
    else if (key === "--from" || key === "--to" || key === "--probe") { const number = Number(value); if (!Number.isInteger(number) || number < 1) usage(`${key} must be a positive integer`); args[key.slice(2) as "from" | "to" | "probe"] = number; }
    else if (key === "--type") { const parsed = sourceTypeSchema.safeParse(value); if (!parsed.success) usage(`Unsupported source type: ${value}`); args.type = parsed.data; }
    else usage(`Unknown argument: ${key}`);
  }
  return args;
}

function formatInspection(inspection: SourceInspection) {
  const directory = inspection.directory ?? inspection.chapters.map((item) => item.ref);
  const lines = [`Source: ${inspection.sourcePath}`, `Type: ${inspection.sourceType.toUpperCase()}`, `Title: ${inspection.title ?? "unknown"}`, `Author: ${inspection.author ?? "unknown"}`, `Language: ${inspection.language ?? "unknown"}`, `Detected chapters: ${directory.length}`];
  if (inspection.metadata?.description) lines.push(`Description: ${inspection.metadata.description}`);
  if (inspection.metadata?.status) lines.push(`Status: ${inspection.metadata.status}`);
  if (inspection.metadata?.coverUrl) lines.push(`Cover: ${inspection.metadata.coverUrl}`);
  for (const item of directory) lines.push(`${item.chapter}\t${item.originalTitle ?? item.sourceTitle ?? item.sourceId}`);
  if (inspection.chapters.length && inspection.directory) lines.push(`Probed chapter bodies: ${inspection.chapters.length}`);
  if (inspection.unnumberedSections.length) { lines.push("Unnumbered sections:"); for (const item of inspection.unnumberedSections) lines.push(`- ${item.title ?? item.sourceId}`); }
  lines.push("Warnings:"); if (!inspection.warnings.length) lines.push("- none"); else for (const warning of inspection.warnings) lines.push(`- [${warning.code}] ${warning.message}`);
  return lines.join("\n");
}
function formatImport(story: string, result: Awaited<ReturnType<typeof importSource>>) {
  const list = (values: number[]) => values.join(", ") || "none";
  return [`Source ${result.status}`, `Story: ${story}`, `Chapters: ${result.manifest.chapters.length}`, `Added: ${list(result.added)}`, `Modified: ${list(result.modified)}`, `Removed: ${list(result.removed)}`, `Manifest: stories/${story}/source/source.json`, "No LLM or TTS calls were made."].join("\n");
}
function isUrl(value: string) { try { new URL(value); return true; } catch { return false; } }
function usage(message: string): never { throw new Error(`${message}\nUsage: npm run story:inspect -- --source <path-or-url> [--type text|epub|docx|fanqie|manual|original] [--probe N]\n   or: npm run story:import -- --story <slug> --source <path-or-url> [--from N --to N] [local source options]\n   or: npm run story:update -- --story <slug> --source <path-or-url> [--chapter N | --split-chapters] [--from N --to N] [--allow-gaps]`); }

main().catch((error: unknown) => { process.stderr.write(`${JSON.stringify({ event: "source.failed", error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`); process.exitCode = 1; });
