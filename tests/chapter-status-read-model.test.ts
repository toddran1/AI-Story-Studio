import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getChapterStatusReadModel, getStoryDashboard, getStoryOverview, invalidateChapterStatusDerivedReads } from "../apps/server/catalog.js";
import { defaultStory } from "../src/config/load-config.js";
import { loadEnvironment } from "../src/config/env.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { chapterStatusReadRevisionPath, getChapterStatusReadRevision } from "../src/studio/chapter-status-revision.js";
import { resetStoryReadCaches, storyReadCacheStats } from "../src/story-bible/read-cache.js";

async function fixture() {
  resetStoryReadCaches();
  const root = await mkdtemp(join(tmpdir(), "chapter-status-"));
  const slug = "read-model";
  const story = defaultStory(slug, loadEnvironment({}));
  await atomicWriteJson(storyPaths(root, slug, 1).storyConfig, story);
  return { root, slug };
}
const builds = (root: string, slug: string) => storyReadCacheStats().builds[`chapter_status\0${root}\0${slug}`] ?? 0;

describe("chapter status read model", () => {
  it("shares concurrent and warm reads, including overview and dashboard", async () => {
    const { root, slug } = await fixture();
    const [a, b] = await Promise.all([getChapterStatusReadModel(root, slug), getChapterStatusReadModel(root, slug)]);
    expect(a).toEqual(b);
    expect(builds(root, slug)).toBe(1);
    await getStoryOverview(root, slug);
    await getStoryDashboard(root, slug);
    expect(builds(root, slug)).toBe(1);
    await invalidateChapterStatusDerivedReads(root, slug);
    await getChapterStatusReadModel(root, slug);
    expect(builds(root, slug)).toBe(2);
  });

  it("uses a stable missing revision and heals malformed JSON on bump", async () => {
    const { root, slug } = await fixture();
    expect(await getChapterStatusReadRevision(root, slug)).toBe("missing");
    const path = chapterStatusReadRevisionPath(root, slug);
    await writeFile(path, "{broken");
    expect(await getChapterStatusReadRevision(root, slug)).toBe("missing");
    await invalidateChapterStatusDerivedReads(root, slug);
    expect(await getChapterStatusReadRevision(root, slug)).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
