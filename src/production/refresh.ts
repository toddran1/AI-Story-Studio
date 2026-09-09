import { Story } from "../domain/story.js";
import { importSource } from "../source/importer.js";
import { compareRemoteDirectory } from "../source/refresh.js";
import { SourceProviderRegistry } from "../source/registry.js";
import { SourceManifest, sourceManifestSchema } from "../source/types.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";

export async function refreshProductionRange(options: { root: string; story: Story; from: number; to: number; registry: SourceProviderRegistry }) {
  const paths = storyPaths(options.root, options.story.slug, 1); const raw = await readJsonIfExists<SourceManifest>(paths.sourceManifest); if (!raw) throw new Error(`Story '${options.story.slug}' has no imported source manifest`);
  const manifest = sourceManifestSchema.parse(raw); if (!("url" in manifest.origin) || !manifest.remote) throw new Error(`Story '${options.story.slug}' does not use a refreshable remote source`);
  const { provider } = await options.registry.resolve(manifest.origin.url, manifest.type); const directory = await provider.inspect(manifest.origin.url, { refresh: true }); const comparison = compareRemoteDirectory(manifest, directory);
  if (comparison.removed.length || comparison.reordered.length) throw new Error("Refusing automatic refresh because the remote source removed or reordered existing chapters");
  const requested = comparison.added.filter((item) => item.chapter >= options.from && item.chapter <= options.to);
  if (!requested.length) return { ...comparison, requested: [], imported: [] as number[] };
  const inspection = await provider.inspect(manifest.origin.url, { chapters: requested.map((item) => item.chapter) }); const result = await importSource(options.root, options.story.slug, inspection, async () => { await atomicWriteJson(paths.storyConfig, options.story); await atomicWriteJson(paths.pipelineConfig, options.story.pipeline); });
  return { ...comparison, requested: requested.map((item) => item.chapter), imported: result.added };
}
