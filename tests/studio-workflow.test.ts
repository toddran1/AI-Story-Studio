import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getOutputsLibrary, getStoryDashboard } from "../apps/server/catalog.js";
import { JobManager } from "../apps/server/job-manager.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { emptyStoryBible } from "../src/domain/story-bible.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths, voicePreviewPaths } from "../src/storage/paths.js";
import { addManualBibleEntry, applyManualBibleOverlay, deleteBibleEntry, saveChapterTextEdit, updateManualBibleEntry } from "../src/studio/workflow.js";
import { MockTTS, testStory } from "./helpers.js";

const pending = () => ({ status: "pending" as const });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "studio-workflow-")); const story = testStory(); const paths = storyPaths(root, story.slug, 1); await atomicWriteJson(paths.storyConfig, story); await atomicWriteJson(paths.pipelineConfig, story.pipeline); return { root, story, paths }; }

describe("production studio workflow", () => {
  it("keeps manual Story Bible edits over later generated extraction", async () => {
    const { root, story } = await fixture(); const firstBase = emptyStoryBible();
    firstBase.characters.push({ canonicalEnglishName: "Lin", originalName: "林", description: "A scout", firstSeenChapter: 1, lastSeenChapter: 1, aliases: [], pronouns: [] });
    const id = await addManualBibleEntry(root, story.slug, firstBase, "characters", { canonicalEnglishName: "Lynn", originalName: "林", description: "Deliberate spelling", firstSeenChapter: 1, lastSeenChapter: 2, aliases: [], pronouns: [] });
    const laterBase = structuredClone(firstBase); laterBase.characters[0]!.description = "Automatically expanded description";
    expect((await applyManualBibleOverlay(root, story.slug, laterBase)).bible.characters).toEqual([expect.objectContaining({ canonicalEnglishName: "Lynn", description: "Deliberate spelling" })]);
    await updateManualBibleEntry(root, story.slug, laterBase, id, { canonicalEnglishName: "Lyn", originalName: "林", description: "Final spelling", firstSeenChapter: 1, lastSeenChapter: 3, aliases: [], pronouns: [] });
    expect((await applyManualBibleOverlay(root, story.slug, laterBase)).bible.characters[0]?.canonicalEnglishName).toBe("Lyn");
  });

  it("can hide an incorrect generated Bible entry without modifying generated files", async () => {
    const { root, story } = await fixture(); const base = emptyStoryBible(); base.items.push({ canonicalEnglishName: "Wrong Blade", originalName: "错刀", description: "Incorrect", firstSeenChapter: 1, lastSeenChapter: 1 });
    const entry = (await applyManualBibleOverlay(root, story.slug, base)).entries[0]!; await deleteBibleEntry(root, story.slug, base, entry.id);
    expect((await applyManualBibleOverlay(root, story.slug, base)).bible.items).toEqual([]);
  });

  it("invalidates downstream stages after manual text edits without running providers", async () => {
    const { root, story, paths } = await fixture(); const now = new Date().toISOString(); const complete = { status: "complete" as const, fingerprint: "old", outputFingerprint: "old" };
    await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({ chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, counts: { originalCharacters: 4, englishWords: 2, narrationWords: 2 }, createdAt: now, updatedAt: now, stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, tts: complete, audioMastering: complete, subtitles: complete, scenePlanning: complete, artwork: complete, video: complete } }));
    const result = await saveChapterTextEdit(root, story.slug, 1, { field: "narration", text: "A deliberate new narration." });
    expect(result.invalidated).toEqual(["qa", "storyBible", "tts", "audioMastering", "alignment", "subtitles", "scenePlanning", "artwork", "video"]); expect(result.chapter.stages.narration).toMatchObject({ status: "complete", provider: "manual" }); expect(result.chapter.stages.tts.status).toBe("pending"); expect(await readFile(paths.narration, "utf8")).toBe("A deliberate new narration.");
  });

  it("generates voice previews outside chapter artifacts", async () => {
    const { root, story, paths } = await fixture(); const jobs = new JobManager(); const tts = new MockTTS(); const operations = new StudioOperations(root, loadEnvironment({}), jobs, { tts });
    const started = operations.startVoicePreview(story.slug, { text: "Demo narration", model: "s2-pro" }); const finished = await wait(jobs, started.id); const id = (finished.result as { id: string }).id;
    expect(tts.calls).toBe(1); expect(await readFile(voicePreviewPaths(root, story.slug, id).audio)).toHaveLength(3); await expect(readFile(paths.audioRaw)).rejects.toMatchObject({ code: "ENOENT" }); await operations.close();
  });

  it("aggregates dashboard progress without provider work", async () => {
    const { root, story, paths } = await fixture(); const now = new Date().toISOString(); const complete = { status: "complete" as const, fingerprint: "x", outputFingerprint: "x" };
    await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({ chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, counts: { originalCharacters: 1, englishWords: 1, narrationWords: 1 }, createdAt: now, updatedAt: now, stages: { ingestion: complete, translation: complete, narration: complete, qa: pending(), storyBible: pending(), tts: pending(), audioMastering: pending() } }));
    const dashboard = await getStoryDashboard(root, story.slug); expect(dashboard.progress.processed).toBe(1); expect(dashboard.estimatedRemainingStages).toBe(7);
  });

  it("lists only safe API URLs for output files", async () => {
    const { root, story, paths } = await fixture(); const now = new Date().toISOString(); const complete = { status: "complete" as const, fingerprint: "x", outputFingerprint: "x" };
    await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({ chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, counts: { originalCharacters: 1, englishWords: 1, narrationWords: 1 }, audio: { durationSeconds: 4, codec: "mp3", container: "mp3" }, createdAt: now, updatedAt: now, stages: { ingestion: complete, translation: complete, narration: complete, qa: pending(), storyBible: pending(), tts: complete, audioMastering: complete } })); await atomicWrite(paths.audio, Buffer.from("mastered audio"));
    const outputs = await getOutputsLibrary(root, story.slug); expect(outputs.items).toEqual([expect.objectContaining({ group: "chapterAudio", bytes: 14, url: "/api/stories/demo-story/chapters/1/audio" })]); expect(JSON.stringify(outputs)).not.toContain(root);
  });
});

function wait(jobs: JobManager, id: string): Promise<any> { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("timeout")), 2000); const unsubscribe = jobs.subscribe(id, (job) => { if (["completed", "failed", "paused"].includes(job.status)) { clearTimeout(timer); unsubscribe?.(); resolve(job); } }); }); }
