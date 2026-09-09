import { Story } from "../domain/story.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { previewPaths, storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { PreviewManifest, previewManifestSchema } from "./types.js";

export async function applyPreviewProfile(root: string, story: Story, previewId: string, choice: "a" | "b"): Promise<Story> {
  const raw = await readJsonIfExists<PreviewManifest>(previewPaths(root, story.slug, previewId).manifest);
  if (!raw) throw new Error(`Preview '${previewId}' does not exist for story '${story.slug}'`);
  const preview = previewManifestSchema.parse(raw);
  if (preview.story !== story.slug) throw new Error(`Preview '${previewId}' belongs to story '${preview.story}'`);
  const selected = preview.presets[choice];
  const updated: Story = { ...story, pipeline: { ...story.pipeline, ...selected } };
  const paths = storyPaths(root, story.slug, preview.chapter);
  await atomicWriteJson(paths.storyConfig, updated);
  await atomicWriteJson(paths.pipelineConfig, updated.pipeline);
  return updated;
}
