import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyStoryBible, storyBibleUpdateSchema, type StoryBible } from "../src/domain/story-bible.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { mergeStoryBible } from "../src/story-bible/updater.js";
import { updateCanonicalEntity, applyCanonicalOverlay } from "../src/story-bible/canonical.js";
import { rebuildStoryBibleBeforeChapter } from "../src/story-bible/rebuild.js";
import { enrichStoryPronunciations, invalidatePronunciationChange, loadPronunciationEntities, loadPronunciationSuggestions } from "../src/story-bible/pronunciation.js";
import { adaptPronunciationText, pronunciationProvider, resolvePronunciations } from "../src/tts/pronunciation.js";
import { FishAudioProvider } from "../src/tts/fish/fish-audio.provider.js";
import { retrieveRelevantContext } from "../src/story-bible/retrieval.js";
import { StudioOperations } from "../apps/server/operations.js";
import { JobManager, type Job } from "../apps/server/job-manager.js";
import { loadEnvironment } from "../src/config/env.js";
import { MockLLM, MockTTS, testStory } from "./helpers.js";
import { runPronunciation } from "../apps/cli/pronunciation.js";
import { LLMRouter } from "../src/llm/router.js";
import { ChapterPipeline } from "../src/pipeline/chapter-pipeline.js";
import { CopyingAudioProcessor } from "../src/audio/chapter-audio.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const update = storyBibleUpdateSchema.parse({ chapterSummary: "Jiang Yue arrived", characters: [{ canonicalEnglishName: "Jiang Yue", originalName: "江月", aliases: ["Brother Jiang"], firstSeenChapter: 1, lastSeenChapter: 1 }] });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pronunciation-")); roots.push(root);
  const story = testStory(), paths = storyPaths(root, story.slug, 1), bible = mergeStoryBible(emptyStoryBible(), update, 1);
  await atomicWriteJson(paths.storyConfig, story); await atomicWriteJson(paths.bible, bible); await atomicWriteJson(paths.bibleUpdate, update);
  return { root, story, paths, bible, entity: bible.canonicalEntities[0]! };
}
async function wait(jobs: JobManager, id: string): Promise<Job> {
  return new Promise(resolve => { let stop: (() => void) | undefined; stop = jobs.subscribe(id, job => { if (["completed", "failed", "paused"].includes(job.status)) { stop?.(); resolve(job); } }); });
}
describe("pronunciation persistence and production boundary", () => {
  it("CLI list, set, clear, enrich and test reuse web services with validated errors", async () => {
    const { root, story, entity } = await fixture(); const llm = new MockLLM("gemini"), tts = new MockTTS();
    vi.spyOn(llm, "generateStructured").mockImplementation(async request => ({ value: request.schema.parse({ pronunciation: { mode: "automatic", sourceLanguage: "zh-CN", phoneticHint: "Jyang Yweh", confidence: .95 } }) }));
    const ops = new StudioOperations(root, loadEnvironment({}), new JobManager(), { tts, llm: new LLMRouter(new Map([["gemini", llm]])), censor: { version: "fake", synthesize: (provider, request) => provider.synthesize(request) } });
    const output: string[] = [], stdout = (text: string) => { output.push(text); };
    try {
      await runPronunciation(["list", story.slug], root, ops, stdout); expect(JSON.parse(output.pop()!)[0].id).toBe(entity.id);
      await runPronunciation(["set", story.slug, entity.id, '{"mode":"custom","customPronunciation":"Manual sounds"}'], root, ops, stdout); expect(JSON.parse(output.pop()!).entity.pronunciation.source).toBe("manual");
      await runPronunciation(["enrich", story.slug], root, ops, stdout); expect(llm.generateStructured).not.toHaveBeenCalled();
      await runPronunciation(["clear", story.slug, entity.id], root, ops, stdout); expect(JSON.parse(output.pop()!).entity.pronunciation).toBeUndefined();
      await runPronunciation(["enrich", story.slug, "--missing", "--dry-run"], root, ops, stdout); expect(JSON.parse(output.pop()!).dryRun).toBe(true); expect(llm.generateStructured).not.toHaveBeenCalled();
      await runPronunciation(["enrich", story.slug], root, ops, stdout); expect(JSON.parse(output.pop()!).enriched).toContain(entity.id);
      await runPronunciation(["test", story.slug, entity.id], root, ops, stdout); expect(JSON.parse(output.pop()!).audioUrl).toContain("voice-previews");
      await expect(runPronunciation(["show", "missing-story", entity.id], root, ops, stdout)).rejects.toThrow();
      await expect(runPronunciation(["show", story.slug, "invalid-id"], root, ops, stdout)).rejects.toThrow();
      await expect(runPronunciation(["set", story.slug, entity.id, '{"mode":"custom"}'], root, ops, stdout)).rejects.toThrow();
    } finally { await ops.close(); }
  });
  it("production applies pronunciation without rerunning translation or narration on pronunciation-only changes", async () => {
    const { root, story, bible, entity } = await fixture(); const input = join(root, "source.txt"); await atomicWrite(input, "江月走进门。");
    const gemini = new MockLLM("gemini", ["Jiang Yue entered." ]), openai = new MockLLM("openai", ["Jiang Yue entered." ]);
    const original = gemini.generateStructured.bind(gemini);
    gemini.generateStructured = async request => request.schemaName === "story_bible_update" ? { value: request.schema.parse(update) } : original(request);
    const tts = new MockTTS(), pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), tts, new CopyingAudioProcessor());
    await updateCanonicalEntity(root, story.slug, bible, entity.id, { pronunciation: { mode: "custom", customPronunciation: "First hint", source: "manual" } });
    await pipeline.run({ root, story, chapter: 1, inputPath: input });
    expect(tts.requests[0]?.pronunciation?.[0]?.pronunciation.customPronunciation).toBe("First hint");
    const textCalls = [...gemini.calls, ...openai.calls].filter(request => !request.structured).length;
    await updateCanonicalEntity(root, story.slug, bible, entity.id, { pronunciation: { mode: "custom", customPronunciation: "Second hint", source: "manual" } });
    await pipeline.run({ root, story, chapter: 1, inputPath: input });
    expect(tts.calls).toBe(2); expect(tts.requests[1]?.pronunciation?.[0]?.pronunciation.customPronunciation).toBe("Second hint");
    expect([...gemini.calls, ...openai.calls].filter(request => !request.structured).length).toBe(textCalls);
  });
  it("applies the same normalized speech to chapter TTS that summaries use", async () => {
    const { root, story, bible, entity } = await fixture(); const input = join(root, "source.txt"); await atomicWrite(input, "江月走进门。");
    const gemini = new MockLLM("gemini", ["Jiang Yue entered."]), openai = new MockLLM("openai", ['Jiang Yue activates its "Worry-Free EXP" feature.']);
    const original = gemini.generateStructured.bind(gemini);
    gemini.generateStructured = async request => request.schemaName === "story_bible_update" ? { value: request.schema.parse(update) } : original(request);
    const tts = new MockTTS(), pipeline = new ChapterPipeline(new LLMRouter(new Map([["gemini", gemini], ["openai", openai]])), tts, new CopyingAudioProcessor());
    await updateCanonicalEntity(root, story.slug, bible, entity.id, { pronunciation: { mode: "custom", customPronunciation: "Jyang Yweh", source: "manual" } });
    await pipeline.run({ root, story, chapter: 1, inputPath: input });
    expect(tts.requests[0]?.text).toContain("Jiang Yue activates its Worry-Free E X P feature.");
    expect(tts.requests[0]?.pronunciation?.[0]?.surfaceText).toBe("Jiang Yue");
  });
  it("preserves manual/locked pronunciation through stale reconstruction and identity reconciliation", async () => {
    const { root, story, bible, entity, paths } = await fixture();
    const pronunciation = { mode: "custom", customPronunciation: "Jyang Yweh", locked: true, source: "manual" };
    await updateCanonicalEntity(root, story.slug, bible, entity.id, { pronunciation });
    await atomicWriteJson(paths.chapterMeta, { stages: { storyBible: { status: "complete", staleReason: "Imported source changed" } } });
    const rebuilt = await rebuildStoryBibleBeforeChapter(root, story.slug, 2);
    expect(rebuilt.canonicalEntities[0]?.id).toBe(entity.id); expect(rebuilt.canonicalEntities[0]?.pronunciation).toEqual(pronunciation);
    const next = mergeStoryBible(rebuilt, storyBibleUpdateSchema.parse({ chapterSummary: "Later", characters: [{ canonicalEnglishName: "Jiang Yu", originalName: "江月", firstSeenChapter: 2, lastSeenChapter: 2 }] }), 2);
    expect((await applyCanonicalOverlay(root, story.slug, next)).bible.canonicalEntities[0]?.pronunciation).toEqual(pronunciation);
    const unrelated = mergeStoryBible(emptyStoryBible(), storyBibleUpdateSchema.parse({ chapterSummary: "Different person", characters: [{ canonicalEnglishName: "Lin Yao", originalName: "林遥", firstSeenChapter: 1, lastSeenChapter: 1 }] }), 1);
    expect((await applyCanonicalOverlay(root, story.slug, unrelated)).bible.canonicalEntities[0]?.pronunciation).toBeUndefined();
  });
  it("enriches once per identity, protects manual values, and caches null English-term results", async () => {
    const { root, story, bible, entity } = await fixture(); const llm = new MockLLM();
    const generate = vi.spyOn(llm, "generateStructured").mockImplementation(async request => ({ value: request.schema.parse({ pronunciation: { mode: "automatic", sourceLanguage: "zh-CN", originalText: "江月", romanization: "Jiāng Yuè", phoneticHint: "Jyang Yweh", confidence: .95 } }) }));
    await enrichStoryPronunciations(root, story.slug, bible, llm, story.pipeline.storyBible, story.sourceLanguage);
    await enrichStoryPronunciations(root, story.slug, bible, llm, story.pipeline.storyBible, story.sourceLanguage);
    expect(generate).toHaveBeenCalledTimes(1);
    // Enrichment stores a suggestion; the canonical entity keeps default TTS.
    expect((await loadPronunciationEntities(root, story.slug))[0]?.pronunciation).toBeUndefined();
    expect((await loadPronunciationSuggestions(root, story.slug))[entity.id]).toMatchObject({ sourceLanguage: "zh-CN", source: "ai" });
    await updateCanonicalEntity(root, story.slug, bible, entity.id, { pronunciation: { mode: "custom", customPronunciation: "Manual", source: "manual" } });
    await enrichStoryPronunciations(root, story.slug, bible, llm, story.pipeline.storyBible, story.sourceLanguage, [entity.id]);
    expect(generate).toHaveBeenCalledTimes(1);
    const english = structuredClone(bible); english.canonicalEntities[0]!.id = "ent_111111111111111111111111"; english.canonicalEntities[0]!.canonicalName = "Fireball";
    generate.mockImplementation(async request => ({ value: request.schema.parse({ pronunciation: null }) }));
    await enrichStoryPronunciations(root, story.slug, english, llm, story.pipeline.storyBible, story.sourceLanguage);
    await enrichStoryPronunciations(root, story.slug, english, llm, story.pipeline.storyBible, story.sourceLanguage);
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("uses original chapter evidence for AI enrichment and records an uncertain outcome as a suggestion, not an obligation", async () => {
    const { root, story, bible, entity, paths } = await fixture(); const llm = new MockLLM();
    await atomicWrite(paths.original, "江月抬头，看见远处的山门。");
    const generate = vi.spyOn(llm, "generateStructured").mockImplementation(async request => ({ value: request.schema.parse({ pronunciation: { mode: "automatic", sourceLanguage: "zh-CN", originalText: "江月", romanization: "Jiāng Yuè", phoneticHint: "Jyang Yweh", confidence: .96, evidence: [{ chapter: 1, sourceText: "江月抬头", reason: "Source name appears in Chapter 1" }] } }) }));
    await enrichStoryPronunciations(root, story.slug, bible, llm, story.pipeline.storyBible, story.sourceLanguage, [entity.id]);
    expect(String(generate.mock.calls[0]?.[0].input)).toContain("江月抬头");
    expect((await loadPronunciationEntities(root, story.slug))[0]?.pronunciation).toBeUndefined();
    expect((await loadPronunciationSuggestions(root, story.slug))[entity.id]).toMatchObject({ originalText: "江月", romanization: "Jiāng Yuè", source: "ai" });
    await updateCanonicalEntity(root, story.slug, bible, entity.id, { pronunciation: null });
    await atomicWrite(paths.original, "这段来源没有提供能够确认该实体身份的名字。");
    generate.mockImplementation(async request => ({ value: request.schema.parse({ pronunciation: null }) }));
    const result = await enrichStoryPronunciations(root, story.slug, bible, llm, story.pipeline.storyBible, story.sourceLanguage, [entity.id]);
    expect(result.unresolved).toContain(entity.id);
    // Uncertain AI analysis: an optional suggestion, never an active record.
    expect((await loadPronunciationEntities(root, story.slug))[0]?.pronunciation).toBeUndefined();
    expect((await loadPronunciationSuggestions(root, story.slug))[entity.id]).toMatchObject({ needsReview: true, confidence: 0, source: "ai" });
  });
  it("batches eligible entities, skips protected records, and never calls a provider during a dry run", async () => {
    const { root, story, bible, entity, paths } = await fixture(); const second = structuredClone(entity), third = structuredClone(entity);
    second.id = "ent_222222222222222222222222"; second.canonicalName = "Lin Yao"; second.originalName = "林遥"; second.aliases = ["Yao"];
    third.id = "ent_333333333333333333333333"; third.canonicalName = "Mo Xie"; third.originalName = "莫邪"; third.aliases = ["Mo"];
    const base = { ...bible, canonicalEntities: [entity, second, third] }; const llm = new MockLLM();
    await atomicWrite(paths.original, "江月与林遥、莫邪一起走进山门。");
    const generate = vi.spyOn(llm, "generateStructured").mockImplementation(async request => ({ value: request.schema.parse({ results: [
      { entityId: second.id, pronunciation: { mode: "automatic", sourceLanguage: "zh-CN", originalText: "林遥", romanization: "Lín Yáo", confidence: .92 } },
      { entityId: third.id, pronunciation: { mode: "automatic", sourceLanguage: "zh-CN", originalText: "莫邪", romanization: "Mò Xié", confidence: .92 } },
    ] }) }));
    const dryRun = await enrichStoryPronunciations(root, story.slug, base, llm, story.pipeline.storyBible, story.sourceLanguage, undefined, false, true);
    expect(dryRun.summary.eligible).toBe(3); expect(generate).not.toHaveBeenCalled();
    await updateCanonicalEntity(root, story.slug, base, entity.id, { pronunciation: { mode: "custom", customPronunciation: "Manual", source: "manual", locked: true } });
    const result = await enrichStoryPronunciations(root, story.slug, base, llm, story.pipeline.storyBible, story.sourceLanguage);
    expect(generate).toHaveBeenCalledTimes(1); expect(result.summary.protected).toBe(1); expect(result.enriched).toEqual([second.id, third.id]);
  });
  it("distinguishes an explicit null (ordinary term, cached silently) from an entity missing from the batch results (unresolved)", async () => {
    const { root, story, bible, entity, paths } = await fixture(); const ordinary = structuredClone(entity);
    ordinary.id = "ent_222222222222222222222222"; ordinary.canonicalName = "Level"; ordinary.originalName = "等级"; ordinary.aliases = [];
    const base = { ...bible, canonicalEntities: [entity, ordinary] }; const llm = new MockLLM();
    await atomicWrite(paths.original, "江月突破了等级。");
    const generate = vi.spyOn(llm, "generateStructured").mockImplementation(async request => ({ value: request.schema.parse({ results: [
      { entityId: ordinary.id, pronunciation: null },
    ] }) }));
    const result = await enrichStoryPronunciations(root, story.slug, base, llm, story.pipeline.storyBible, story.sourceLanguage);
    const entities = await loadPronunciationEntities(root, story.slug);
    const suggestions = await loadPronunciationSuggestions(root, story.slug);
    // Explicit null: no record, no suggestion, no unresolved flag; the attempt is cached.
    expect(entities.find(item => item.id === ordinary.id)?.pronunciation).toBeUndefined();
    expect(suggestions[ordinary.id]).toBeUndefined();
    expect(result.unresolved).not.toContain(ordinary.id);
    // Missing from the batch results: an uncertain suggestion, not an active record.
    expect(entities.find(item => item.id === entity.id)?.pronunciation).toBeUndefined();
    expect(suggestions[entity.id]).toMatchObject({ needsReview: true, confidence: 0 });
    // A second run must not re-query the cached null outcome.
    await enrichStoryPronunciations(root, story.slug, base, llm, story.pipeline.storyBible, story.sourceLanguage);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("reports enrichment progress as candidates are processed", async () => {
    const { root, story, bible, entity, paths } = await fixture(); const second = structuredClone(entity), third = structuredClone(entity);
    second.id = "ent_222222222222222222222222"; second.canonicalName = "Lin Yao"; second.originalName = "林遥"; second.aliases = [];
    third.id = "ent_333333333333333333333333"; third.canonicalName = "Mo Xie"; third.originalName = "莫邪"; third.aliases = [];
    const base = { ...bible, canonicalEntities: [entity, second, third] }; const llm = new MockLLM();
    await atomicWrite(paths.original, "江月与林遥、莫邪一起走进山门。");
    vi.spyOn(llm, "generateStructured").mockImplementation(async request => ({ value: request.schema.parse({ results: [
      { entityId: entity.id, pronunciation: { mode: "automatic", sourceLanguage: "zh-CN", confidence: .9 } },
      { entityId: second.id, pronunciation: null },
      { entityId: third.id, pronunciation: null },
    ] }) }));
    const events: Array<{ processed: number; total: number }> = [];
    await enrichStoryPronunciations(root, story.slug, base, llm, story.pipeline.storyBible, story.sourceLanguage, undefined, false, false, event => events.push(event));
    expect(events[0]).toEqual({ processed: 0, total: 3 });
    expect(events.at(-1)).toEqual({ processed: 3, total: 3 });
    // Fully cached run: total is zero, so callers can skip rendering progress.
    const cached: Array<{ processed: number; total: number }> = [];
    await enrichStoryPronunciations(root, story.slug, base, llm, story.pipeline.storyBible, story.sourceLanguage, undefined, false, false, event => cached.push(event));
    expect(cached).toEqual([{ processed: 0, total: 0 }]);
  });
  it("stores suggestions without touching chapter freshness; accepting activates TTS, clearing returns to default", async () => {
    const { root, story, bible, entity, paths } = await fixture();
    const now = new Date().toISOString(), complete = { status: "complete", fingerprint: "old", outputFingerprint: "old" };
    await atomicWrite(paths.narration, "Jiang Yue's sword fell.");
    await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({ chapter: 1, sourceLanguage: "zh-CN", outputLanguage: "en-US", counts: { originalCharacters: 1, englishWords: 1, narrationWords: 1 }, createdAt: now, updatedAt: now, stages: Object.fromEntries(["ingestion", "translation", "narration", "qa", "storyBible", "continuity", "tts", "audioMastering", "alignment", "subtitles", "scenePlanning", "artwork", "video"].map(stage => [stage, complete])) }));
    const llm = new MockLLM();
    vi.spyOn(llm, "generateStructured").mockImplementation(async request => ({ value: request.schema.parse({ pronunciation: { mode: "automatic", sourceLanguage: "zh-CN", phoneticHint: "Jyang Yweh", confidence: .95 } }) }));
    const result = await enrichStoryPronunciations(root, story.slug, bible, llm, story.pipeline.storyBible, story.sourceLanguage);
    expect(result.enriched).toEqual([entity.id]);
    // Suggestion-only change: the entity stays on default TTS and no stage goes stale.
    expect((await loadPronunciationEntities(root, story.slug))[0]?.pronunciation).toBeUndefined();
    expect(resolvePronunciations("Jiang Yue entered.", await loadPronunciationEntities(root, story.slug))).toEqual([]);
    const meta = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    for (const stage of ["tts", "audioMastering", "alignment", "subtitles", "video"]) expect(meta.stages[stage].staleReason).toBeUndefined();
    // Accepting the suggestion (explicit user action) activates it for TTS.
    const suggestion = (await loadPronunciationSuggestions(root, story.slug))[entity.id]!;
    await updateCanonicalEntity(root, story.slug, bible, entity.id, { pronunciation: { ...suggestion, source: "manual", needsReview: false } });
    const active = resolvePronunciations("Jiang Yue entered.", await loadPronunciationEntities(root, story.slug));
    expect(active).toHaveLength(1);
    expect(active[0]?.pronunciation.phoneticHint).toBe("Jyang Yweh");
    // Clearing the override returns to default TTS with no placeholder record.
    await updateCanonicalEntity(root, story.slug, bible, entity.id, { pronunciation: null });
    const cleared = await loadPronunciationEntities(root, story.slug);
    expect(cleared[0]?.pronunciation).toBeUndefined();
    expect(resolvePronunciations("Jiang Yue entered.", cleared)).toEqual([]);
  });
  it("marks only referenced sound-dependent stages stale and retains playable files", async () => {
    const { root, story, entity } = await fixture(); const now = new Date().toISOString();
    for (const number of [1, 2]) {
      const paths = storyPaths(root, story.slug, number), complete = { status: "complete", fingerprint: "old", outputFingerprint: "old" };
      await atomicWrite(paths.narration, number === 1 ? "Jiang Yue's sword fell." : "The sky turned red.");
      await atomicWrite(paths.audio, "old playable audio");
      await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({ chapter: number, sourceLanguage: "zh-CN", outputLanguage: "en-US", counts: { originalCharacters: 1, englishWords: 1, narrationWords: 1 }, createdAt: now, updatedAt: now, stages: Object.fromEntries(["ingestion", "translation", "narration", "qa", "storyBible", "continuity", "tts", "audioMastering", "alignment", "subtitles", "scenePlanning", "artwork", "video"].map(stage => [stage, complete])) }));
    }
    const after = { ...entity, pronunciation: { mode: "custom" as const, customPronunciation: "Jyang Yweh" } };
    expect(await invalidatePronunciationChange(root, story.slug, entity, after)).toEqual([1]);
    const first = JSON.parse(await readFile(storyPaths(root, story.slug, 1).chapterMeta, "utf8"));
    for (const stage of ["tts", "audioMastering", "alignment", "subtitles", "video"]) expect(first.stages[stage].staleReason).toBe("Entity pronunciation changed");
    for (const stage of ["ingestion", "translation", "narration", "qa", "storyBible", "continuity", "scenePlanning", "artwork"]) expect(first.stages[stage].staleReason).toBeUndefined();
    expect(await readFile(storyPaths(root, story.slug, 1).audio, "utf8")).toBe("old playable audio");
    expect(JSON.parse(await readFile(storyPaths(root, story.slug, 2).chapterMeta, "utf8")).stages.tts.staleReason).toBeUndefined();
  });
  it("keeps pronunciation outside text-stage context and handles fresh censor offsets", async () => {
    const { bible, entity } = await fixture(); entity.pronunciation = { mode: "custom", customPronunciation: "Jyang Yweh" };
    expect(retrieveRelevantContext(bible, "Jiang Yue", 2).canonicalEntities[0]?.pronunciation).toBeUndefined();
    const tts = new MockTTS(), provider = pronunciationProvider(tts, [entity]); const request = { ...testStory().pipeline.tts, text: "Jiang Yue shouted." };
    await provider.synthesize(request); await provider.synthesize({ ...request, text: "Then Jiang Yue replied." });
    expect(tts.requests[0]?.pronunciation?.[0]?.start).toBe(0); expect(tts.requests[1]?.pronunciation?.[0]?.start).toBe(5);
  });
  it("Fish renders hints only in the outgoing synthesis text", async () => {
    const { entity } = await fixture(); entity.pronunciation = { mode: "custom", customPronunciation: "Jyang Yweh" };
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }));
    const provider = pronunciationProvider(new FishAudioProvider("fake-key", fetcher), [entity]); const text = "Jiang Yue entered.";
    await provider.synthesize({ ...testStory().pipeline.tts, text });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).text).toContain("Jyang Yweh"); expect(text).toBe("Jiang Yue entered.");
  });
  it("voice preview and pronunciation replay use the production resolver without extra calls", async () => {
    const { root, story, bible, entity } = await fixture();
    await updateCanonicalEntity(root, story.slug, bible, entity.id, { pronunciation: { mode: "custom", customPronunciation: "Jyang Yweh", source: "manual" } });
    const tts = new MockTTS(), jobs = new JobManager(), ops = new StudioOperations(root, loadEnvironment({}), jobs, { tts, censor: { version: "fake", synthesize: (provider, request) => provider.synthesize(request) } });
    try {
      const voice = await wait(jobs, ops.startVoicePreview(story.slug, { text: "Jiang Yue entered." }).id); expect(voice.status).toBe("completed"); expect(tts.requests[0]?.pronunciation?.[0]?.entityId).toBe(entity.id);
      const preview = await wait(jobs, ops.startPronunciationTest(story.slug, entity.id).id); expect(preview.status).toBe("completed");
      const replay = await wait(jobs, ops.startPronunciationTest(story.slug, entity.id).id); expect(replay.result).toMatchObject({ cached: true }); expect(tts.calls).toBe(2);
      let output = ""; await runPronunciation(["show", story.slug, entity.id], root, ops, text => { output += text; }); expect(JSON.parse(output).pronunciation.customPronunciation).toBe("Jyang Yweh");
      await expect(runPronunciation(["invalid", story.slug], root, ops, () => {})).rejects.toThrow("Usage");
    } finally { await ops.close(); }
  });
});
