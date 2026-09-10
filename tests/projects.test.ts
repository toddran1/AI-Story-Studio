import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { loadEnvironment } from "../src/config/env.js";
import { loadStory } from "../src/config/load-config.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { exists } from "../src/storage/story-files.js";
import { buildStoryBackup, cleanupStory, createBlankStory, deleteStory, duplicateStory, getStorageUsage, loadGlobalSettings, readActivity, restoreStoryBackup, saveCover, saveGlobalSettings } from "../src/studio/projects.js";

const env = loadEnvironment({ OPENAI_DEFAULT_MODEL: "openai-default", GEMINI_DEFAULT_MODEL: "gemini-default" });
const metadata = { slug: "ember-book", title: "Ember Book", author: "R. Vale", description: "A local story", tags: ["fantasy"], notes: "private", sourceLanguage: "zh-CN", outputLanguage: "en-US" };

async function root() { return mkdtemp(join(tmpdir(), "story-projects-")); }

describe("story project management", () => {
  it("uses application defaults only when creating a new story", async () => {
    const directory = await root(); const defaults = await loadGlobalSettings(directory, env);
    await saveGlobalSettings(directory, { ...defaults, defaultSourceLanguage: "ja-JP", defaultOutputLanguage: "en-GB", defaultProductionProfile: "everything", translation: { provider: "openai", model: "new-model" } });
    const first = await createBlankStory(directory, env, metadata); expect(first.pipeline.translation.model).toBe("new-model"); expect(first.defaultProductionProfile).toBe("everything");
    await saveGlobalSettings(directory, { ...defaults, translation: { provider: "gemini", model: "later-model" } });
    expect((await loadStory(storyPaths(directory, first.slug, 1).storyConfig)).pipeline.translation.model).toBe("new-model");
  });

  it("duplicates settings alone or the full project and always chooses a unique slug", async () => {
    const directory = await root(); await createBlankStory(directory, env, metadata); const sourceFile = join(storyPaths(directory, metadata.slug, 1).source, "chapters", "0001.txt"); await writeFile(sourceFile, "chapter", { encoding: "utf8", flag: "w" }).catch(async () => { const { atomicWrite } = await import("../src/storage/atomic-write.js"); await atomicWrite(sourceFile, "chapter"); });
    const settings = await duplicateStory(directory, metadata.slug, "ember-copy", "settings"); const full = await duplicateStory(directory, metadata.slug, "ember-copy", "full");
    expect(settings.slug).toBe("ember-copy"); expect(full.slug).toBe("ember-copy-2"); expect(await exists(join(storyPaths(directory, settings.slug, 1).source, "chapters", "0001.txt"))).toBe(false); expect(await readFile(join(storyPaths(directory, full.slug, 1).source, "chapters", "0001.txt"), "utf8")).toBe("chapter");
  });

  it("requires exact title confirmation and removes the project from the library recoverably", async () => {
    const directory = await root(); await createBlankStory(directory, env, metadata); await expect(deleteStory(directory, metadata.slug, "Ember")).rejects.toThrow("exactly match"); const result = await deleteStory(directory, metadata.slug, metadata.title); expect(result).toEqual({ deleted: metadata.slug, recoverable: true }); expect(await exists(storyPaths(directory, metadata.slug, 1).story)).toBe(false);
  });

  it("backs up and safely restores with a unique slug", async () => {
    const directory = await root(); await createBlankStory(directory, env, metadata); const backup = await buildStoryBackup(directory, metadata.slug, false); const bytes = await readFile(join(directory, ".ai-story-studio", "backups", `${backup.id}.zip`)); const restored = await restoreStoryBackup(directory, bytes); expect(restored.slug).toBe("ember-book-2"); expect(restored.story.title).toContain("Restored");
    const unsafe = zipSync({ "../outside.txt": Buffer.from("no"), "backup.json": Buffer.from("{}"), "story.json": Buffer.from("{}") }); await expect(restoreStoryBackup(directory, unsafe)).rejects.toThrow("Unsafe backup path"); expect(await exists(join(directory, "outside.txt"))).toBe(false);
  });

  it("categorizes storage and cleanup preserves source and manual project data", async () => {
    const directory = await root(); await createBlankStory(directory, env, metadata); const paths = storyPaths(directory, metadata.slug, 1); const { atomicWrite } = await import("../src/storage/atomic-write.js"); await atomicWrite(join(paths.source, "chapters", "0001.txt"), "source"); await atomicWrite(paths.narration, "manual narration"); await atomicWrite(join(paths.story, "voice-previews", "preview.mp3"), Buffer.alloc(24)); const before = await getStorageUsage(directory, metadata.slug); expect(before.source).toBeGreaterThan(0); expect(before.previews).toBe(24); const cleaned = await cleanupStory(directory, metadata.slug, "voicePreviews"); expect(cleaned.removedBytes).toBe(24); expect(await readFile(join(paths.source, "chapters", "0001.txt"), "utf8")).toBe("source"); expect(await readFile(paths.narration, "utf8")).toBe("manual narration"); expect((await readActivity(directory, metadata.slug)).some((item) => item.type === "storage.cleanup")).toBe(true);
  });

  it("invalidates video only when a cover changes", async () => {
    const directory = await root(); await createBlankStory(directory, env, metadata); const paths = storyPaths(directory, metadata.slug, 1); const now = new Date().toISOString(); const complete = { status: "complete" as const, fingerprint: "in", outputFingerprint: "out" };
    await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({ chapter: 1, sourceLanguage: "zh-CN", outputLanguage: "en-US", counts: { originalCharacters: 10, englishWords: 2, narrationWords: 2 }, createdAt: now, updatedAt: now, stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, tts: complete, audioMastering: complete, subtitles: complete, scenePlanning: complete, artwork: complete, video: complete } }));
    await saveCover(directory, metadata.slug, "cover.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])); const chapter = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8"))); expect(chapter.stages.video.status).toBe("pending"); expect(chapter.stages.tts.status).toBe("complete"); expect(chapter.stages.audioMastering.status).toBe("complete"); expect(chapter.stages.artwork.status).toBe("complete");
  });
});
