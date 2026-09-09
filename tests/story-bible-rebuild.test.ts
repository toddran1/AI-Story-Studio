import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyStoryBible, storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { storyPaths } from "../src/storage/paths.js";
import { rebuildStoryBibleBeforeChapter } from "../src/story-bible/rebuild.js";
import { mergeStoryBible } from "../src/story-bible/updater.js";

describe("Story Bible chronological reconstruction", () => {
  it("removes future facts before an earlier chapter rerun", async () => {
    const root = await mkdtemp(join(tmpdir(), "bible-rebuild-")); const slug = "story";
    const first = storyBibleUpdateSchema.parse({ characters: [{ canonicalEnglishName: "Lin Yao", originalName: "林遥", description: "Carries a lamp", firstSeenChapter: 1, lastSeenChapter: 1 }], chapterSummary: "Found a lamp" });
    const second = storyBibleUpdateSchema.parse({ characters: [{ canonicalEnglishName: "Lin Yao", originalName: "林遥", description: "Learns the villain's identity", firstSeenChapter: 2, lastSeenChapter: 2 }], chapterSummary: "Read a letter" });
    for (const [chapter, update] of [[1, first], [2, second]] as const) {
      const path = storyPaths(root, slug, chapter).bibleUpdate; await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(update));
    }
    const cumulative = mergeStoryBible(mergeStoryBible(emptyStoryBible(), first, 1), second, 2);
    const cumulativePath = storyPaths(root, slug, 2).bible; await mkdir(dirname(cumulativePath), { recursive: true }); await writeFile(cumulativePath, JSON.stringify(cumulative));
    const beforeTwo = await rebuildStoryBibleBeforeChapter(root, slug, 2);
    expect(beforeTwo.characters[0]?.description).toBe("Carries a lamp");
    expect(beforeTwo.chapterSummaries).toEqual({ "1": "Found a lamp" });
  });

  it("ignores a stale update after its Story Bible stage is invalidated", async () => {
    const root = await mkdtemp(join(tmpdir(), "bible-invalidated-")); const slug = "story";
    const paths = storyPaths(root, slug, 1); const update = storyBibleUpdateSchema.parse({ chapterSummary: "Stale summary" });
    await mkdir(dirname(paths.bibleUpdate), { recursive: true });
    await writeFile(paths.bibleUpdate, JSON.stringify(update));
    await writeFile(paths.chapterMeta, JSON.stringify({ stages: { storyBible: { status: "pending" } } }));
    const rebuilt = await rebuildStoryBibleBeforeChapter(root, slug, 2);
    expect(rebuilt.chapterSummaries).toEqual({});
  });
});
