#!/usr/bin/env node
import { loadEnvironment } from "../../src/config/env.js";
import { loadStory } from "../../src/config/load-config.js";
import { SourceProviderRegistry } from "../../src/source/registry.js";
import { importSource } from "../../src/source/importer.js";
import { compareRemoteDirectory } from "../../src/source/refresh.js";
import { SourceManifest, sourceManifestSchema } from "../../src/source/types.js";
import { createWebHttpClient } from "../../src/source/web/create-client.js";
import { atomicWriteJson } from "../../src/storage/atomic-write.js";
import { storyPaths } from "../../src/storage/paths.js";
import { readJsonIfExists } from "../../src/storage/story-files.js";
import { withStoryLock } from "../../src/storage/story-lock.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.story)) usage("--story must be a lowercase kebab-case slug");
  await withStoryLock(process.cwd(), args.story, "source refresh", () => refresh(args.story, args.importNew));
}

async function refresh(slug: string, importNew: boolean) {
  const root = process.cwd(); const paths = storyPaths(root, slug, 1);
  const raw = await readJsonIfExists<SourceManifest>(paths.sourceManifest); if (!raw) throw new Error(`Story '${slug}' has no imported source manifest`);
  const manifest = sourceManifestSchema.parse(raw); if (!("url" in manifest.origin) || !manifest.remote) throw new Error(`Story '${slug}' does not use a refreshable remote source`);
  const env = loadEnvironment(); const registry = new SourceProviderRegistry(undefined, createWebHttpClient(root, env));
  const { provider } = await registry.resolve(manifest.origin.url, manifest.type);
  const directoryInspection = await provider.inspect(manifest.origin.url, { refresh: true }); const comparison = compareRemoteDirectory(manifest, directoryInspection);
  process.stdout.write(`${formatRefresh(slug, comparison)}\n`);
  if (!importNew || !comparison.added.length) return;
  if (comparison.removed.length || comparison.reordered.length) throw new Error("Refusing automatic import because the remote directory removed or reordered existing chapters");
  const chapters = comparison.added.map((ref) => ref.chapter);
  const inspection = await provider.inspect(manifest.origin.url, { chapters });
  const story = await loadStory(paths.storyConfig);
  const result = await importSource(root, slug, inspection, async () => {
    await atomicWriteJson(paths.pipelineConfig, story.pipeline); await atomicWriteJson(paths.storyConfig, story);
  });
  process.stdout.write(`Imported new chapters: ${result.added.join(", ") || "none"}\n`);
}

function parseArgs(values: string[]) {
  let story = ""; let importNew = false;
  for (let index = 0; index < values.length; index++) {
    const key = values[index]!;
    if (key === "--import-new") { importNew = true; continue; }
    if (key !== "--story") usage(`Unknown argument: ${key}`);
    const value = values[++index]; if (!value || value.startsWith("--")) usage("Missing value for --story"); story = value;
  }
  if (!story) usage("--story is required"); return { story, importNew };
}
function formatRefresh(story: string, result: ReturnType<typeof compareRemoteDirectory>) {
  const numbers = (items: Array<{ chapter: number }>) => items.map((item) => item.chapter).join(", ") || "none";
  return [`Remote source refresh`, `Story: ${story}`, `Previous chapters: ${result.previousCount}`, `Current chapters: ${result.currentCount}`,
    `New: ${numbers(result.added)}`, `Removed: ${numbers(result.removed)}`, `Retitled: ${result.retitled.map((item) => item.chapter).join(", ") || "none"}`,
    `Reordered: ${result.reordered.map((item) => `${item.before}->${item.after}`).join(", ") || "none"}`].join("\n");
}
function usage(message: string): never { throw new Error(`${message}\nUsage: npm run story:refresh -- --story <slug> [--import-new]`); }

main().catch((error: unknown) => { process.stderr.write(`${JSON.stringify({ event: "refresh.failed", error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`); process.exitCode = 1; });
