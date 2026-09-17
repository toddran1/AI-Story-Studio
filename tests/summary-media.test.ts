import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobManager } from "../apps/server/job-manager.js";
import { parseSummaryArgs, runSummaryCommand } from "../apps/cli/summary.js";
import { LLMRouter } from "../src/llm/router.js";
import { TTSProviderRouter } from "../src/tts/router.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { SummaryService } from "../src/summaries/service.js";
import { SummaryMediaService, summaryMediaPaths, summaryDownloadName } from "../src/summaries/media.js";
import { estimateSummaryMinutes, summaryGenerationInputSchema } from "../src/summaries/types.js";
import { emptyStoryBible, storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { mergeStoryBible } from "../src/story-bible/updater.js";
import { MockLLM, MockTTS, testStory } from "./helpers.js";
import { createApiHandler } from "../apps/server/api.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { PassThrough, Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

describe("summary narration and audio", () => {
  let root: string, llm: MockLLM, tts: MockTTS, summaries: SummaryService, media: SummaryMediaService;
  const story = () => testStory();
  const master = { version: "test-master", master: vi.fn(async (_inputs: string[], output: string) => { await atomicWrite(output, "mastered-mp3"); return { durationSeconds: 10, codec: "mp3", container: "mp3" }; }) };
  const censor = { version: "test-censor", synthesize: vi.fn(async (provider: MockTTS, request: Parameters<MockTTS["synthesize"]>[0]) => provider.synthesize(request)) };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "summary-media-")); llm = new MockLLM("openai", ["Su Ming faced the horde.", "Malakai Sterling fell into the monster horde. None noticed Malakai seething. “Hey Malakai!”"]); tts = new MockTTS();
    const router = new LLMRouter(new Map([["openai", llm]])); summaries = new SummaryService(root, router);
    media = new SummaryMediaService(root, router, new TTSProviderRouter(tts), censor, master);
    await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, story());
    await atomicWrite(storyPaths(root, "demo-story", 1).english, "Su Ming joins the fight.");
    master.master.mockClear(); censor.synthesize.mockClear();
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const create = () => summaries.generate("demo-story", { title: "Arc", chapters: [1] });

  it("uses shared pronunciation and invalidates only summary sound dependencies", async () => {
    const bible = mergeStoryBible(emptyStoryBible(), storyBibleUpdateSchema.parse({ chapterSummary: "Arrival", characters: [{ canonicalEnglishName: "Jiang Yue", originalName: "江月", firstSeenChapter: 1, lastSeenChapter: 1 }] }), 1);
    bible.canonicalEntities[0]!.pronunciation = { mode: "custom", customPronunciation: "Jyang Yweh", source: "manual" };
    await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, bible);
    const canonical = await create(); await media.editNarration("demo-story", canonical.id, { text: "Jiang Yue walked through the gate." });
    const audio = await media.audio("demo-story", canonical.id);
    expect(tts.requests[0]?.pronunciation?.[0]?.entityId).toBe(bible.canonicalEntities[0]!.id);
    const unrelated = await create(); await media.editNarration("demo-story", unrelated.id, { text: "The sky turned red." }); await media.audio("demo-story", unrelated.id);
    bible.canonicalEntities[0]!.pronunciation.customPronunciation = "Different hint"; await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, bible);
    const stale = await media.get("demo-story", canonical.id);
    expect(stale.narration?.status).toBe("current"); expect(stale.text).toBe(canonical.text); expect(stale.tts?.status).toBe("stale"); expect(stale.audio?.status).toBe("stale");
    expect(await readFile(summaryMediaPaths(root, "demo-story", canonical.id).audio)).toBeDefined();
    expect((await media.get("demo-story", unrelated.id)).audio?.status).toBe("current"); expect(audio.narration?.text).toBe(stale.narration?.text);
  });

  it("plans recap scenes through the shared provider and reuses current artifacts", async () => {
    const canonical = await create(); await media.audio("demo-story", canonical.id);
    const plan = vi.spyOn(llm, "generateStructured").mockImplementation(async (request) => ({ value: request.schema.parse({ scenes: [
      { summary: "Arrival", startSeconds: 0, endSeconds: 5, characters: [], visualPrompt: "A necromancer enters the horde", importance: "standard" },
      { summary: "The final confrontation", startSeconds: 5, endSeconds: 10, characters: [], visualPrompt: "The horde turns toward him", importance: "major" },
    ] }) }));
    const result = await media.scenes("demo-story", canonical.id, { pacing: "custom", sceneCount: 2 });
    expect(result.scenePlan).toMatchObject({ sourceType: "summary", sourceId: canonical.id, sourceChapters: [1], durationSeconds: 10, timingMethod: "estimated" });
    expect(result.scenePlan?.scenes).toHaveLength(2);
    expect(result.scenePlan?.scenes.at(-1)?.endSeconds).toBe(10);
    expect(plan.mock.calls[0]![0].input).toContain(result.narration!.text!);
    await media.scenes("demo-story", canonical.id, { pacing: "custom", sceneCount: 2 });
    expect(plan).toHaveBeenCalledTimes(1);
    expect(parseSummaryArgs(["scenes", "demo-story", canonical.id, "--pacing", "custom", "--scene-count", "2"])).toMatchObject({ action: "scenes", input: { sceneCount: 2 } });
    let output = "";
    await runSummaryCommand({ action: "scenes", story: "demo-story", id: canonical.id, input: { pacing: "custom", sceneCount: 2 } }, { root, service: summaries, media, stdout: (text) => { output += text; }, stderr: () => {} });
    expect(JSON.parse(output).scenes.status).toBe("current"); expect(plan).toHaveBeenCalledTimes(1);
    await summaries.update("demo-story", canonical.id, { text: "A different recap" });
    const stale = await media.get("demo-story", canonical.id);
    expect(stale.scenes?.status).toBe("stale"); expect(stale.scenePlan?.scenes).toHaveLength(2);
  });

  it("keeps canonical text isolated and passes contextual localization to the narration model", async () => {
    const bible = mergeStoryBible(emptyStoryBible(), storyBibleUpdateSchema.parse({ chapterSummary: "Battle", characters: [{ canonicalEnglishName: "Su Ming", originalName: "苏铭", aliases: ["Student Su"], firstSeenChapter: 1, lastSeenChapter: 1 }] }), 1);
    bible.canonicalEntities[0]!.localizedNaming = { locale: "en-US", fullName: "Malakai Sterling", shortName: "Malakai", usageMode: "ai_contextual" };
    bible.canonicalEntities[0]!.preferredNarrationName = "Legacy Name";
    await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, bible);
    const canonical = await create(), result = await media.narration("demo-story", canonical.id);
    expect(result.text).toBe(canonical.text); expect(result.narration?.text).toContain("Hey Malakai");
    const request = llm.calls[1]!; expect(request.model).toBe("narration-model");
    expect(request.input).toContain("Malakai Sterling"); expect(request.input).toContain('"shortName": "Malakai"'); expect(request.input).toContain("苏铭"); expect(request.instructions).toContain("canonical story recap");
    expect(result.narration?.text).toBe("Malakai Sterling fell into the monster horde. None noticed Malakai seething. “Hey Malakai!”");
  });

  it("uses narration exclusively for TTS and reuses raw audio after mastering-only changes", async () => {
    const canonical = await create(), result = await media.audio("demo-story", canonical.id);
    expect(tts.requests[0]?.text).toBe(result.narration?.ttsText); expect(tts.requests[0]?.model).toBe("s2-pro");
    expect(tts.requests[0]).toMatchObject({ voiceMode: "same-voice-dialogue", deliveryIntensity: "restrained", qualityGuard: true });
    expect(result.audio).toMatchObject({ status: "current", durationSeconds: 10 });
    await media.audio("demo-story", canonical.id); expect(tts.calls).toBe(1); expect(master.master).toHaveBeenCalledTimes(1);
    const changed = story(); changed.audio.loudnessTarget = -18; await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, changed);
    const stale = await media.get("demo-story", canonical.id); expect(stale.narration?.status).toBe("current"); expect(stale.tts?.status).toBe("current"); expect(stale.audio?.status).toBe("stale");
    await media.audio("demo-story", canonical.id); expect(tts.calls).toBe(1); expect(master.master).toHaveBeenCalledTimes(2);
  });

  it("uses the shared normalized spoken form for summary audio without editing narration", async () => {
    const canonical = await create(); const written = 'It activates its "Worry-Free EXP" feature.';
    await media.editNarration("demo-story", canonical.id, { text: written });
    const speech = await media.speech("demo-story", canonical.id); await media.audio("demo-story", canonical.id);
    expect(speech).toMatchObject({ narrationText: written, spokenText: "It activates its Worry-Free E-X-P feature." });
    expect(tts.requests[0]?.text).toBe("It activates its Worry-Free E-X-P feature.");
  });

  it("normalizes vocalizations in summary narration for TTS without editing the narration", async () => {
    const canonical = await create(); const written = "Hehe... that worked.";
    await media.editNarration("demo-story", canonical.id, { text: written });
    const speech = await media.speech("demo-story", canonical.id); await media.audio("demo-story", canonical.id);
    // MockTTS has no native-tag strategy, so the safe_normalize fallback applies the
    // canonical spoken form ("Hehe..." → "Hehehe..."); the stored narration is untouched.
    expect(speech).toMatchObject({ narrationText: written, spokenText: "Hehehe... that worked." });
    expect(speech.transformations).toEqual([expect.objectContaining({ kind: "vocalization", written: "Hehe...", spoken: "Hehehe..." })]);
    expect(tts.requests[0]?.text).toBe("Hehehe... that worked.");
  });

  it("applies legacy preferred names and contextual alias rules through the shared narration context", async () => {
    const bible = mergeStoryBible(emptyStoryBible(), storyBibleUpdateSchema.parse({ chapterSummary: "Battle", characters: [{ canonicalEnglishName: "Su Ming", originalName: "苏铭", aliases: ["Student Su"], firstSeenChapter: 1, lastSeenChapter: 1 }] }), 1);
    bible.canonicalEntities[0]!.preferredNarrationName = "Shi Wang";
    bible.canonicalEntities[0]!.aliasNarrationRules = [{ alias: "Student Su", behavior: "no_override" }];
    await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, bible);
    const canonical = await create(); await media.narration("demo-story", canonical.id);
    expect(llm.calls[1]!.input).toContain('"preferredNarrationName": "Shi Wang"'); expect(llm.calls[1]!.input).toContain('"alias": "Student Su"');
    bible.canonicalEntities[0]!.preferredNarrationName = "Malakai";
    await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, bible);
    expect(await media.get("demo-story", canonical.id)).toMatchObject({ text: canonical.text, status: "complete", narration: { status: "stale" } });
  });

  it("voice changes invalidate only audio; canonical edits invalidate every derivative", async () => {
    const canonical = await create(); await media.audio("demo-story", canonical.id);
    const changed = story(); changed.pipeline.tts.referenceId = "other-voice"; await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, changed);
    expect(await media.get("demo-story", canonical.id)).toMatchObject({ narration: { status: "current" }, tts: { status: "stale" }, audio: { status: "stale" } });
    await media.audio("demo-story", canonical.id); expect(llm.calls).toHaveLength(2); expect(tts.calls).toBe(2);
    await summaries.update("demo-story", canonical.id, { text: "New canonical recap" });
    expect(await media.get("demo-story", canonical.id)).toMatchObject({ manuallyEdited: true, narration: { status: "stale" }, tts: { status: "stale" }, audio: { status: "stale" } });
  });

  it("preserves manual narration on setting changes until review or explicit regeneration", async () => {
    const canonical = await create(); await media.narration("demo-story", canonical.id);
    await media.editNarration("demo-story", canonical.id, { text: "My protected narration" });
    const changed = story(); changed.narrationSettings.profanityMode = "soften-strong"; await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, changed);
    expect(await media.get("demo-story", canonical.id)).toMatchObject({ narration: { text: "My protected narration", status: "stale", reviewRequired: true } });
    await expect(media.audio("demo-story", canonical.id)).rejects.toThrow(/Manual narration requires review/);
    await media.editNarration("demo-story", canonical.id, { acceptCurrent: true });
    await media.audio("demo-story", canonical.id); expect(tts.requests[0]?.text).toBe("My protected narration");
    const replaced = await media.narration("demo-story", canonical.id, { force: true }); expect(replaced.narration?.manuallyEdited).toBe(false);
  });

  it("shares the provider-agnostic censor service without touching canonical text", async () => {
    const changed = story(); changed.narrationSettings.bleepStrongProfanity = true; await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, changed);
    const canonical = await create(); await media.editNarration("demo-story", canonical.id, { text: "This shit is fucking crazy." });
    const result = await media.audio("demo-story", canonical.id);
    expect(censor.synthesize).toHaveBeenCalledWith(tts, expect.objectContaining({ bleepStrongProfanity: true, text: "This shit is fucking crazy." })); expect(result.text).toBe(canonical.text);
  });

  it("exports safe filenames and leaves public text artifacts separate", async () => {
    const canonical = await create(); await media.audio("demo-story", canonical.id);
    const txt = await media.export("demo-story", canonical.id, "summary"), audio = await media.export("demo-story", canonical.id, "audio");
    expect(await readFile(txt.path, "utf8")).toBe(canonical.text); expect(txt.name).toBe("chapters-1-1-summary.txt"); expect(audio.contentType).toBe("audio/mpeg"); expect(await readFile(audio.path, "utf8")).toBe("mastered-mp3");
    expect(summaryDownloadName({ ...canonical, title: '../../bad\r\n"' }, "narration")).toBe("chapters-1-1-narration.txt");
    expect(() => summaryMediaPaths(root, "../escape", canonical.id)).toThrow(); await expect(media.export("demo-story", canonical.id, "bad")).rejects.toThrow();
  });

  it("retains raw TTS after mastering failure for a resumable retry", async () => {
    const canonical = await create(); master.master.mockRejectedValueOnce(new Error("FFmpeg unavailable"));
    await expect(media.audio("demo-story", canonical.id)).rejects.toThrow("FFmpeg unavailable");
    expect(await media.get("demo-story", canonical.id)).toMatchObject({ tts: { status: "current" }, audio: { status: "failed" } });
    await media.audio("demo-story", canonical.id); expect(tts.calls).toBe(1);
  });

  it("detects changed TTS segments instead of reusing mismatched mastered audio", async () => {
    const canonical = await create(); await media.audio("demo-story", canonical.id);
    await atomicWrite(join(summaryMediaPaths(root, "demo-story", canonical.id).segments, "0001.mp3"), "changed-audio");
    expect(await media.get("demo-story", canonical.id)).toMatchObject({ tts: { status: "stale" }, audio: { status: "stale" } });
  });

  it("preserves manual narration if an explicitly requested regeneration fails", async () => {
    const canonical = await create(); await media.editNarration("demo-story", canonical.id, { text: "My protected narration" });
    llm.generateText = vi.fn().mockRejectedValue(new Error("Provider unavailable"));
    await expect(media.narration("demo-story", canonical.id, { force: true })).rejects.toThrow("Provider unavailable");
    expect(await media.get("demo-story", canonical.id)).toMatchObject({ text: canonical.text, narration: { text: "My protected narration", manuallyEdited: true, status: "failed" } });
  });

  it("serves canonical/narration/audio downloads through the API, with ranges and safe headers", async () => {
    const canonical = await create(); await media.audio("demo-story", canonical.id);
    const operations = new StudioOperations(root, loadEnvironment({}), undefined, { llm: new LLMRouter(new Map([["openai", llm]])), tts, audio: master, censor });
    const handle = createApiHandler(operations);
    const request = async (type: string, range?: string) => {
      const req = Object.assign(Readable.from([]), { method: "GET", url: `/api/stories/demo-story/summaries/${canonical.id}/export/${type}?download=1`, headers: { host: "localhost:3000", ...(range ? { range } : {}) } });
      const headers: Record<string, unknown> = {}; let status = 0; const chunks: Buffer[] = [];
      const res = Object.assign(new PassThrough(), { setHeader: (name: string, value: unknown) => { headers[name] = value; }, writeHead: (code: number, values: object) => { status = code; Object.assign(headers, values); } });
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk))); const done = new Promise<void>((resolve) => res.on("finish", resolve));
      await handle(req as unknown as IncomingMessage, res as unknown as ServerResponse); await done;
      return { status, headers, body: Buffer.concat(chunks).toString() };
    };
    try {
      const txt = await request("summary"); expect(txt.status).toBe(200); expect(txt.body).toBe(canonical.text); expect(txt.headers["content-disposition"]).toContain("chapters-1-1-summary.txt");
      const narration = await request("narration"); expect(narration.body).toContain("Malakai Sterling");
      const audio = await request("audio", "bytes=0-3"); expect(audio.status).toBe(206); expect(audio.body).toBe("mast"); expect(audio.headers["content-type"]).toBe("audio/mpeg");
    } finally { await operations.close(); }
  });

  it("converts target minutes to a bounded word count and exposes CLI parity", async () => {
    expect(summaryGenerationInputSchema.parse({ title: "Five minutes", chapters: [1], targetMinutes: 5 }).targetWords).toBe(750);
    expect(estimateSummaryMinutes(Array(750).fill("word").join(" "))).toBe(5);
    const canonical = await create(); const output: string[] = [];
    const command = parseSummaryArgs(["narration", "demo-story", canonical.id]);
    await runSummaryCommand(command, { root, service: summaries, media, stdout: (text) => output.push(text), stderr: () => undefined });
    expect(JSON.parse(output[0]!).narration.status).toBe("current");
    expect(parseSummaryArgs(["export", "demo-story", canonical.id, "--type", "audio"])).toMatchObject({ action: "export", type: "audio" });
  });

  it("durably records summary job results and pauses interrupted jobs on restart", async () => {
    const directory = join(root, ".data", "summary-jobs"), jobs = new JobManager();
    await atomicWrite(join(directory, "11111111-1111-4111-8111-111111111111.json"), "not-json");
    const completed = await jobs.createDurable(directory, "demo-story", async () => ({ id: "summary-result" }));
    await vi.waitFor(() => expect(jobs.get(completed.id)?.status).toBe("completed")); await jobs.flushDurable();
    const restored = new JobManager(); await restored.restoreDurable(directory); expect(restored.get(completed.id)?.result).toEqual({ id: "summary-result" });
    let finish!: () => void; const interrupted = await jobs.createDurable(directory, "demo-story", async () => new Promise<void>((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(jobs.get(interrupted.id)?.status).toBe("running")); await jobs.flushDurable();
    await restored.restoreDurable(directory); expect(restored.get(interrupted.id)?.status).toBe("paused"); finish();
    await vi.waitFor(() => expect(jobs.get(interrupted.id)?.status).toBe("completed")); await jobs.flushDurable();
  });
});
