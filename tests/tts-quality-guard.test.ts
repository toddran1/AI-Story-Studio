import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AlignmentObservation } from "../src/alignment/types.js";
import { loadEnvironment } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { fishTtsStageConfigSchema, ttsSynthesisSettings } from "../src/domain/provider.js";
import { storySchema } from "../src/domain/story.js";
import { canonicalEntitySchema } from "../src/domain/story-bible.js";
import { ConfigurationError } from "../src/pipeline/errors.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { withUsageScope, TrackedTTSProvider } from "../src/cost/context.js";
import { ProviderUsageRecord } from "../src/cost/types.js";
import { invalidateStoryForConfigChange } from "../src/studio/projects.js";
import { FfmpegCensorAudioService } from "../src/tts/censor-audio.js";
import {
  QualityGuardTTSProvider, SpeechTranscriber, compareSpokenText, defaultQualityThresholds, deliveryIntensityForAttempt,
  TtsQualityReport, TtsSegmentQuality, summarizeQuality, tokenizeSpoken,
} from "../src/tts/quality-guard.js";
import {
  acceptStoredChapterTtsSegment, loadChapterTtsQuality, persistChapterTtsQuality, regenerateStoredChapterTtsSegment, ttsQualityArtifactSchema, verifyStoredChapterTts,
} from "../src/tts/chapter-quality.js";
import { FishAudioProvider } from "../src/tts/fish/fish-audio.provider.js";
import { TTSProvider } from "../src/tts/provider.js";
import { adaptPronunciationText, pronunciationProvider, resolvePronunciations } from "../src/tts/pronunciation.js";
import { splitForTTS } from "../src/tts/split-text.js";
import { TTSRequest, TTSResult } from "../src/tts/types.js";
import { fingerprint } from "../src/utils/hash.js";
import { testStory } from "./helpers.js";

const bytes = (marker: string, length = 8) => new Uint8Array([...Buffer.from(marker.padEnd(length, marker))]);

class ScriptedTTS implements TTSProvider {
  readonly name = "fish";
  calls: TTSRequest[] = [];
  constructor(private readonly handler: (request: TTSRequest, call: number) => TTSResult) {}
  async validateConfiguration() {}
  async synthesize(request: TTSRequest): Promise<TTSResult> { this.calls.push({ ...request }); return this.handler(request, this.calls.length); }
}

class FakeTranscriber implements SpeechTranscriber {
  readonly name = "fake-transcriber";
  calls = 0;
  available = true;
  constructor(private readonly resolve: (audio: Uint8Array) => AlignmentObservation[]) {}
  async validateConfiguration() { if (!this.available) throw new ConfigurationError("whisper-cli unavailable"); }
  async transcribe(request: { audioPath: string; language: string }) { this.calls++; return this.resolve(new Uint8Array(await readFile(request.audioPath))); }
}

/** Timed token observations for plain text (one observation per word). */
const say = (text: string, confidence = .95, secondsPerWord = .5): AlignmentObservation[] =>
  text.split(/\s+/).filter(Boolean).map((word, index) => ({ text: word, start: index * secondsPerWord, end: index * secondsPerWord + .4, confidence }));

const request = (overrides: Partial<TTSRequest> = {}): TTSRequest => ({
  text: "The rain stopped. Mara opened the gate.", model: "s2-pro", speed: 1, format: "mp3",
  sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 1750, ...overrides,
});

const guard = (inner: TTSProvider, transcriber: SpeechTranscriber, maxRetries = 2, extra: Partial<ConstructorParameters<typeof QualityGuardTTSProvider>[2]> = {}) =>
  new QualityGuardTTSProvider(inner, transcriber, { maxRetries, language: "en-US", durationProbe: async () => undefined, ...extra });

const singleSegment = (text: string, marker: string): TTSResult => { const audio = bytes(marker); return { audio, segments: [audio], segmentTexts: [text], providerRequests: 1 }; };

describe("tts quality guard verification", () => {
  it("passes a good synthesis without retries", async () => {
    const text = "The rain stopped outside the station. Mara opened the heavy gate and listened.";
    const inner = new ScriptedTTS(() => singleSegment(text, "a"));
    const transcriber = new FakeTranscriber(() => say(text));
    const result = await guard(inner, transcriber).synthesize(request({ text }));
    expect(inner.calls).toHaveLength(1);
    expect(result.quality?.status).toBe("verified");
    expect(result.quality?.segments[0]).toMatchObject({ status: "verified", expectedText: text, finalAttempt: 1 });
    expect(result.quality?.segments[0]?.score).toBeGreaterThanOrEqual(defaultQualityThresholds.passScore);
  });

  it("passes an ordinary single-word ASR mistake", async () => {
    const text = "The rain stopped outside the station and Mara opened the heavy iron gate slowly.";
    const inner = new ScriptedTTS(() => singleSegment(text, "a"));
    const transcriber = new FakeTranscriber(() => say(text.replace("heavy", "havoc")));
    const result = await guard(inner, transcriber).synthesize(request({ text }));
    expect(result.quality?.status).toBe("verified");
    expect(inner.calls).toHaveLength(1);
  });

  it("retries gibberish output and succeeds on a later attempt", async () => {
    const text = "The rain stopped outside the station and Mara opened the gate.";
    let attemptAudio = "a";
    const inner = new ScriptedTTS((_request, call) => { attemptAudio = call === 1 ? "bad" : "good"; return singleSegment(text, attemptAudio); });
    const transcriber = new FakeTranscriber((audio) => say(String.fromCharCode(...audio.slice(0, 3)).startsWith("bad") ? "sshsgegefee" : text));
    const result = await guard(inner, transcriber).synthesize(request({ text, deliveryIntensity: "expressive" }));
    expect(inner.calls).toHaveLength(2);
    // Attempt 2 steps the neutral delivery control one level more conservative.
    expect(inner.calls[1]?.deliveryIntensity).toBe("restrained");
    expect(result.quality?.segments[0]).toMatchObject({ status: "verified", finalAttempt: 2 });
    expect(result.quality?.segments[0]?.attempts.map((attempt) => attempt.status)).toEqual(["retry", "pass"]);
  });

  it("retries substantial unexpected speech", async () => {
    const text = "Mara opened the gate and stepped inside the quiet yard.";
    const inner = new ScriptedTTS(() => singleSegment(text, "a"));
    const transcriber = new FakeTranscriber(() => say(`${text} The moon exploded over the mountains twice.`));
    const comparison = compareSpokenText(text, say(`${text} The moon exploded over the mountains twice.`));
    expect(comparison.issues.some((issue) => issue.type === "unexpected_speech")).toBe(true);
    const result = await guard(inner, transcriber, 0).synthesize(request({ text }));
    expect(result.quality?.segments[0]?.status).toBe("needs_review");
  });

  it("retries missing speech, truncation, and repeated sentences", async () => {
    const text = "Mara opened the heavy gate and stepped carefully inside the quiet yard beyond the wall.";
    expect(compareSpokenText(text, say("Mara opened the heavy gate")).issues.map((issue) => issue.type)).toContain("truncated");
    expect(compareSpokenText(text, say("Mara opened the gate and stepped inside the yard")).issues.map((issue) => issue.type)).toContain("missing_speech");
    const repeated = compareSpokenText("The door opened. She walked out.", say("The door opened. She walked out. She walked out."));
    expect(repeated.issues.map((issue) => issue.type)).toContain("repetition");
    const inner = new ScriptedTTS(() => singleSegment(text, "a"));
    const transcriber = new FakeTranscriber(() => say("Mara opened the heavy gate"));
    const result = await guard(inner, transcriber, 0).synthesize(request({ text }));
    expect(result.quality?.segments[0]?.status).toBe("needs_review");
    expect(result.quality?.segments[0]?.issues.some((issue) => issue.type === "truncated")).toBe(true);
  });

  it("fails invalid empty audio without transcribing it", async () => {
    const text = "Mara opened the gate.";
    const inner = new ScriptedTTS(() => ({ audio: new Uint8Array(), segments: [new Uint8Array()], segmentTexts: [text] }));
    const transcriber = new FakeTranscriber(() => say(text));
    const result = await guard(inner, transcriber).synthesize(request({ text }));
    expect(transcriber.calls).toBe(0);
    expect(result.quality?.segments[0]).toMatchObject({ status: "needs_review", finalAttempt: 1 });
    expect(result.quality?.segments[0]?.issues[0]?.type).toBe("invalid_audio");
  });

  it("detects abnormal duration via the words-per-second band", async () => {
    const text = "Mara opened the gate and walked through the yard.";
    const comparison = compareSpokenText(text, say(text), { durationSeconds: 120 });
    expect(comparison.issues.map((issue) => issue.type)).toContain("abnormal_duration");
    expect(comparison.metrics.durationRatio).toBeGreaterThan(defaultQualityThresholds.durationRatioHigh);
    // Non-critical: a perfect transcription with odd duration still passes.
    const inner = new ScriptedTTS(() => singleSegment(text, "a"));
    const transcriber = new FakeTranscriber(() => say(text));
    const result = await guard(inner, transcriber, 2, { durationProbe: async () => 120 }).synthesize(request({ text }));
    expect(result.quality?.segments[0]?.status).toBe("verified");
    expect(result.quality?.segments[0]?.issues.some((issue) => issue.type === "abnormal_duration")).toBe(true);
  });

  it("detects mid-segment silence and suspected gibberish", async () => {
    const text = "Mara opened the gate and walked through the yard slowly today.";
    const gapped = say(text, .95, .5).map((observation, index) => index < 3 ? observation : { ...observation, start: observation.start + 8, end: observation.end + 8 });
    expect(compareSpokenText(text, gapped).issues.map((issue) => issue.type)).toContain("unexpected_silence");
    const gibberish = compareSpokenText(text, say("krzzt blorp fnord krzzt blorp fnord krzzt blorp fnord", .2));
    expect(gibberish.issues.map((issue) => issue.type)).toContain("suspected_gibberish");
  });

  it("ignores non-speech sound tokens when vocalizations are intentional", async () => {
    const text = "He laughed. Hahaha! That was the funniest joke ever told.";
    const observations = [...say("He laughed. Hahaha! That was the funniest joke ever told."), { text: "♪", start: 6, end: 6.4 }];
    const comparison = compareSpokenText(text, observations, { expectedVocalizations: true });
    expect(comparison.issues).toEqual([]);
    const inner = new ScriptedTTS(() => singleSegment(text, "a"));
    const transcriber = new FakeTranscriber(() => observations);
    const result = await guard(inner, transcriber).synthesize(request({ text }));
    // scanVocalizations("Hahaha!") makes the guard treat the segment as vocalized.
    expect(result.quality?.segments[0]?.status).toBe("verified");
  });

  it("counts unexplained sounds toward failure when no vocalization instruction exists", async () => {
    const text = "Mara opened the gate and walked through.";
    const observations = [...say(text), { text: "♪", start: 6, end: 6.4 }, { text: "♪", start: 6.5, end: 6.9 }, { text: "♪", start: 7, end: 7.4 }];
    const comparison = compareSpokenText(text, observations, { expectedVocalizations: false });
    expect(comparison.issues.map((issue) => issue.type)).toContain("unexpected_speech");
  });

  it("respects pronunciation tolerated terms during comparison", async () => {
    const text = "Jiang Yue entered the hall and greeted the elders assembled there.";
    const heard = say("Jyang Yweh entered the hall and greeted the elders assembled there.");
    const strict = compareSpokenText(text, heard);
    expect(strict.issues.length).toBeGreaterThan(0);
    const tolerant = compareSpokenText(text, heard, { toleratedTerms: [{ surface: "Jiang Yue", spoken: "Jyang Yweh" }] });
    expect(tolerant.issues).toEqual([]);
    expect(tolerant.score).toBe(1);
  });

  it("replaces the failed segment with a successful retry and keeps max retries bounded", async () => {
    const first = "First sentence stays perfect. "; const bad = "Second sentence fails twice. ";
    const text = first + bad;
    const inner = new ScriptedTTS((req, call) => {
      if (call === 1) return { audio: new Uint8Array([...bytes("aa"), ...bytes("bb")]), segments: [bytes("aa"), bytes("bb")], segmentTexts: [first.trim(), bad.trim()], providerRequests: 2 };
      return singleSegment(req.text, "cc");
    });
    const transcriber = new FakeTranscriber((audio) => {
      const marker = String.fromCharCode(audio[0]!, audio[1]!);
      if (marker === "aa") return say(first.trim());
      if (marker === "cc") return say(bad.trim());
      return say("total garbage words here");
    });
    const result = await guard(inner, transcriber).synthesize(request({ text }));
    expect(inner.calls).toHaveLength(2);
    // Only the failed segment is regenerated: the retry request is exactly its expected text.
    expect(inner.calls[1]?.text).toBe(bad.trim());
    expect(result.segments[1]).toEqual(bytes("cc"));
    expect(result.segments[0]).toEqual(bytes("aa"));
    expect([...result.audio]).toEqual([...bytes("aa"), ...bytes("cc")]);
    expect(result.quality?.segments.map((segment) => segment.status)).toEqual(["verified", "verified"]);
  });

  it("keeps the best audio and marks needs_review after retry exhaustion", async () => {
    const text = "Mara opened the gate and walked through the yard.";
    const inner = new ScriptedTTS((_req, call) => singleSegment(text, `v${call}`));
    const transcriber = new FakeTranscriber(() => say("nothing matches at all here ever"));
    const result = await guard(inner, transcriber).synthesize(request({ text }));
    expect(inner.calls).toHaveLength(3); // 1 initial + 2 retries
    expect(result.quality?.segments[0]?.status).toBe("needs_review");
    expect(result.quality?.segments[0]?.attempts).toHaveLength(3);
    expect(result.quality?.status).toBe("needs_review");
    // Generated audio is preserved, never deleted.
    expect(result.segments[0]?.byteLength).toBeGreaterThan(0);
  });

  it("does not retry at all when maxQualityRetries is 0", async () => {
    const text = "Mara opened the gate and walked through the yard.";
    const inner = new ScriptedTTS(() => singleSegment(text, "a"));
    const transcriber = new FakeTranscriber(() => say("nothing matches at all here ever"));
    const result = await guard(inner, transcriber, 0).synthesize(request({ text }));
    expect(inner.calls).toHaveLength(1);
    expect(result.quality?.segments[0]?.status).toBe("needs_review");
  });

  it("progresses delivery intensity none-ward across attempts", () => {
    expect(deliveryIntensityForAttempt("expressive", 1)).toBe("expressive");
    expect(deliveryIntensityForAttempt("expressive", 2)).toBe("restrained");
    expect(deliveryIntensityForAttempt("expressive", 3)).toBe("none");
    expect(deliveryIntensityForAttempt("restrained", 2)).toBe("none");
    expect(deliveryIntensityForAttempt("none", 2)).toBe("none");
  });

  it("never mutates the synthesis request or canonical text", async () => {
    const text = "Mara opened the gate.";
    const pronunciation = [{ entityId: "ent_1", surfaceText: "Mara", start: 0, end: 4, pronunciation: { mode: "custom" as const, customPronunciation: "Mah-rah" } }];
    const req = request({ text, deliveryIntensity: "restrained" });
    req.pronunciation = pronunciation;
    const inner = new ScriptedTTS(() => singleSegment(text, "a"));
    const transcriber = new FakeTranscriber(() => say(text));
    await guard(inner, transcriber).synthesize(req);
    expect(req.text).toBe(text);
    expect(req.pronunciation).toBe(pronunciation);
    expect(inner.calls[0]?.pronunciation).toBe(pronunciation);
  });

  it("skips transcription entirely when the guard is disabled", async () => {
    const text = "Mara opened the gate.";
    const inner = new ScriptedTTS(() => singleSegment(text, "a"));
    const transcriber = new FakeTranscriber(() => say(text));
    const result = await guard(inner, transcriber).synthesize(request({ text, qualityGuard: false }));
    expect(transcriber.calls).toBe(0);
    expect(result.quality).toBeUndefined();
  });

  it("marks segments unverified (never passed) when transcription fails or is unavailable", async () => {
    const text = "Mara opened the gate.";
    const failing = new ScriptedTTS(() => singleSegment(text, "a"));
    const throwing = new FakeTranscriber(() => { throw new Error("whisper crashed"); });
    const failed = await guard(failing, throwing).synthesize(request({ text }));
    expect(failed.quality?.segments[0]?.status).toBe("unverified");
    expect(failed.quality?.status).toBe("unverified");
    expect(failing.calls).toHaveLength(1); // no blind retries
    expect(failed.segments[0]?.byteLength).toBeGreaterThan(0);
    const unavailable = new ScriptedTTS(() => singleSegment(text, "a"));
    const offline = new FakeTranscriber(() => say(text)); offline.available = false;
    const skipped = await guard(unavailable, offline).synthesize(request({ text }));
    expect(offline.calls).toBe(0);
    expect(skipped.quality?.segments[0]?.status).toBe("unverified");
  });

  it("records every retry in tracked usage with attempt numbers", async () => {
    const text = "Mara opened the gate and walked through the yard.";
    const scripted = new ScriptedTTS((_req, call) => singleSegment(text, call === 1 ? "bad" : "ok"));
    const records: ProviderUsageRecord[] = [];
    const tracked = new TrackedTTSProvider(scripted, { record: async (record) => { records.push(record); } });
    const transcriber = new FakeTranscriber((audio) => say(String.fromCharCode(audio[0]!) === "b" ? "garbage output words" : text));
    await withUsageScope({ story: "demo", chapter: 1, stage: "tts" }, () => guard(tracked, transcriber).synthesize(request({ text })));
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.attempt)).toEqual([1, 2]);
    expect(records[0]?.retry).toBe(false);
    expect(records[1]?.retry).toBe(true);
    expect(records.every((record) => record.success)).toBe(true);
  });
});

describe("tts quality settings and fingerprints", () => {
  it("defaults maxCharsPerRequest to 1750 for new configuration only", () => {
    expect(fishTtsStageConfigSchema.parse({ provider: "fish", model: "s2-pro" }).maxCharsPerRequest).toBe(1750);
    expect(fishTtsStageConfigSchema.parse({ provider: "fish", model: "s2-pro" }).maxQualityRetries).toBe(2);
    const env = loadEnvironment({});
    expect(env.FISH_AUDIO_MAX_CHARS).toBe(1750);
    expect(defaultStory("new-story", env).pipeline.tts.maxCharsPerRequest).toBe(1750);
  });

  it("loads legacy explicit maxCharsPerRequest 4000 untouched", () => {
    const story = storySchema.parse({ ...testStory(), pipeline: { ...testStory().pipeline, tts: { provider: "fish", model: "s2-pro", maxCharsPerRequest: 4000 } } });
    expect(story.pipeline.tts.maxCharsPerRequest).toBe(4000);
    expect(story.pipeline.tts.maxQualityRetries).toBe(2);
  });

  it("keeps the synthesis fingerprint stable when only verification settings change", () => {
    const base = fishTtsStageConfigSchema.parse({ provider: "fish", model: "s2-pro" });
    const changed = { ...base, qualityGuard: false, maxQualityRetries: 5 };
    expect(fingerprint({ config: { ...ttsSynthesisSettings(base), referenceId: "voice" } }))
      .toBe(fingerprint({ config: { ...ttsSynthesisSettings(changed), referenceId: "voice" } }));
    expect(fingerprint({ config: ttsSynthesisSettings({ ...base, speed: 1.2 }) })).not.toBe(fingerprint({ config: ttsSynthesisSettings(base) }));
    // Changing providerQualityGuard changes the synthesis fingerprint
    expect(fingerprint({ config: ttsSynthesisSettings({ ...base, providerQualityGuard: false }) }))
      .not.toBe(fingerprint({ config: ttsSynthesisSettings(base) }));
  });

  it("does not stale tts for verification-only config changes but stales synthesis changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tts-quality-invalidation-"));
    const story = testStory();
    const paths = storyPaths(root, story.slug, 1);
    const now = new Date().toISOString();
    const complete = { status: "complete" as const };
    await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({
      chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
      counts: { originalCharacters: 10, englishWords: 10, narrationWords: 10 }, createdAt: now, updatedAt: now,
      stages: { ingestion: complete, translation: complete, narration: complete, storyBible: complete, tts: complete, audioMastering: complete },
    }));
    const verificationOnly = { ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, qualityGuard: false, maxQualityRetries: 5 } } };
    await invalidateStoryForConfigChange(root, story.slug, story, verificationOnly);
    let meta = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8")));
    expect(meta.stages.tts.status).toBe("complete");

    // Changing providerQualityGuard stales synthesis (tts and audioMastering pending)
    const providerQualityChanged = { ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, providerQualityGuard: false } } };
    await invalidateStoryForConfigChange(root, story.slug, story, providerQualityChanged);
    meta = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8")));
    expect(meta.stages.tts.status).toBe("pending");
    expect(meta.stages.audioMastering.status).toBe("pending");

    // Reset back to complete
    await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({
      ...meta, stages: { ...meta.stages, tts: complete, audioMastering: complete },
    }));

    const synthesisChanged = { ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, speed: 1.2 } } };
    await invalidateStoryForConfigChange(root, story.slug, story, synthesisChanged);
    meta = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8")));
    expect(meta.stages.tts.status).toBe("pending");
    expect(meta.stages.audioMastering.status).toBe("pending");
  });
});

describe("split safety for spoken instructions", () => {
  it("never hard-slices through provider control tags", () => {
    const text = `${"word ".repeat(400)}[laugh] ${"more ".repeat(400)}`;
    const chunks = splitForTTS(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect((chunk.match(/\[/g) ?? []).length).toBe((chunk.match(/\]/g) ?? []).length);
      expect((chunk.match(/<\|speaker:[01]\|>/g) ?? []).every((tag) => tag === "<|speaker:0|>" || tag === "<|speaker:1|>")).toBe(true);
    }
    expect(chunks.join(" ")).toContain("[laugh]");
  });

  it("re-resolves pronunciation occurrences per request so splits cannot invalidate offsets", async () => {
    const entity = canonicalEntitySchema.parse({ id: "ent_123456789012345678901234", type: "character", canonicalName: "Jiang Yue", firstAppearance: 1, lastKnownAppearance: 2,
      pronunciation: { mode: "automatic", phoneticHint: "Jyang Yweh", confidence: .9 } });
    const received: TTSRequest[] = [];
    const inner: TTSProvider = { name: "fish", validateConfiguration: async () => undefined, synthesize: async (req) => { received.push(req); return singleSegment(req.text, "a"); } };
    const provider = pronunciationProvider(inner, [entity]);
    const first = "Jiang Yue waited. " + "The rain fell. ".repeat(200);
    await provider.synthesize(request({ text: first }));
    // A downstream split/retry sends a shorter chunk: occurrences are resolved
    // fresh against THAT text, so offsets always match the request's own text.
    const chunk = splitForTTS(first, 1750).find((part) => part.includes("Jiang Yue"))!;
    await provider.synthesize(request({ text: chunk }));
    for (const call of received) {
      for (const occurrence of call.pronunciation ?? []) {
        expect(call.text.slice(occurrence.start, occurrence.end)).toBe(occurrence.surfaceText);
      }
    }
    const adapted = adaptPronunciationText(chunk, received.at(-1)!.pronunciation ?? [], { phoneticText: true });
    expect(adapted).toContain("Jyang Yweh");
  });
});

describe("censor flow with quality guard", () => {
  it("verifies each speech chunk and aggregates quality through bleep assembly", async () => {
    const text = "This shit is fucking crazy.";
    const calls: TTSRequest[] = [];
    const inner: TTSProvider = { name: "fish", validateConfiguration: async () => undefined, synthesize: async (req) => { calls.push(req); return singleSegment(req.text, `s${calls.length}`); } };
    const transcriber = new FakeTranscriber(() => say(calls.at(-1)!.text));
    const tools = { validateAvailability: async () => undefined, ffmpeg: async (args: string[]) => { await atomicWrite(args.at(-1)!, bytes("tone")); } };
    const service = new FfmpegCensorAudioService(tools as never);
    const result = await service.synthesize(guard(inner, transcriber), request({ text, bleepStrongProfanity: true }));
    expect(result.assembled).toBe(true);
    expect(transcriber.calls).toBe(calls.length);
    expect(result.quality?.status).toBe("verified");
    expect(result.quality?.segments.map((segment) => segment.index)).toEqual([0, 1, 2]);
    expect(result.quality?.segments.map((segment) => segment.expectedText)).toEqual(calls.map((call) => call.text));
    expect(result.segmentTexts).toBeUndefined(); // tone segments make a 1:1 mapping impossible
  });
});

describe("stored chapter quality service", () => {
  const good = "Mara opened the gate and walked through the yard.";
  const bad = "The tower collapsed into the sea before dawn.";

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "tts-quality-store-"));
    const story = testStory();
    const paths = storyPaths(root, story.slug, 1);
    const now = new Date().toISOString();
    const complete = { status: "complete" as const };
    await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({
      chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
      counts: { originalCharacters: 10, englishWords: 10, narrationWords: 10 }, createdAt: now, updatedAt: now,
      stages: { ingestion: complete, translation: complete, narration: complete, storyBible: complete, tts: complete, audioMastering: complete, alignment: complete, subtitles: complete },
    }));
    await atomicWrite(join(paths.segments, "0001.mp3"), bytes("aa"));
    await atomicWrite(join(paths.segments, "0002.mp3"), bytes("bb"));
    const report: TtsQualityReport = { version: 1, status: "needs_review", retried: 1, segments: [
      { index: 0, expectedText: good, status: "verified", score: 1, issues: [], attempts: [{ attempt: 1, settings: { deliveryIntensity: "restrained" }, status: "pass", score: 1, issues: [] }], finalAttempt: 1 },
      { index: 1, expectedText: bad, status: "needs_review", score: .2, issues: [{ type: "missing_speech", severity: .8 }], attempts: [{ attempt: 1, settings: { deliveryIntensity: "restrained" }, status: "needs_review", score: .2, issues: [] }], finalAttempt: 3 },
    ] };
    await persistChapterTtsQuality({ root, story, chapter: 1, report, maxRetries: 2, transcriber: "fake-transcriber" });
    return { root, story, paths };
  }

  it("re-verifies stored segments without any TTS call", async () => {
    const { root, story, paths } = await fixture();
    const transcriber = new FakeTranscriber((audio) => say(String.fromCharCode(audio[0]!) === "a" ? good : bad));
    const quality = await verifyStoredChapterTts({ root, story, chapter: 1, transcriber });
    expect(quality.status).toBe("verified");
    expect(quality.segments.every((segment) => segment.status === "verified")).toBe(true);
    const meta = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8")));
    expect(meta.stages.tts.usage?.quality).toMatchObject({ status: "verified", segments: 2, needsReview: 0 });
    expect(ttsQualityArtifactSchema.parse(JSON.parse(await readFile(paths.ttsQuality, "utf8"))).status).toBe("verified");
  });

  it("marks segments unverified rather than passed when re-verification cannot transcribe", async () => {
    const { root, story } = await fixture();
    const transcriber = new FakeTranscriber(() => { throw new Error("whisper crashed"); });
    const quality = await verifyStoredChapterTts({ root, story, chapter: 1, transcriber });
    expect(quality.segments.map((segment) => segment.status)).toEqual(["unverified", "unverified"]);
    expect(quality.status).toBe("unverified");
  });

  it("preserves manual acceptance and never reports it as objectively passed", async () => {
    const { root, story, paths } = await fixture();
    const accepted = await acceptStoredChapterTtsSegment({ root, slug: story.slug, chapter: 1, segment: 1, reason: "sounds fine to a human" });
    expect(accepted.segments[1]?.status).toBe("manually_accepted");
    expect(accepted.segments[1]?.acceptedReason).toBe("sounds fine to a human");
    expect(accepted.status).not.toBe("verified");
    // Re-verification must not touch the accepted segment even when it would fail.
    const transcriber = new FakeTranscriber((audio) => say(String.fromCharCode(audio[0]!) === "a" ? good : "garbage words everywhere"));
    const reverified = await verifyStoredChapterTts({ root, story, chapter: 1, transcriber });
    expect(reverified.segments[1]?.status).toBe("manually_accepted");
    expect(reverified.status).toBe("partial");
    const meta = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8")));
    expect(meta.stages.tts.usage?.quality?.manuallyAccepted).toBe(1);
  });

  it("regenerates exactly one segment, replaces its audio, and stales mastering downstream", async () => {
    const { root, story, paths } = await fixture();
    const transcriber = new FakeTranscriber(() => say(bad));
    const inner = new ScriptedTTS((req) => singleSegment(req.text, "cc"));
    const provider = guard(inner, transcriber);
    const quality = await regenerateStoredChapterTtsSegment({ root, story, chapter: 1, segment: 1, provider, maxRetries: 2 });
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0]?.text).toBe(bad);
    expect(new Uint8Array(await readFile(join(paths.segments, "0002.mp3")))).toEqual(bytes("cc"));
    expect(quality.segments[1]?.status).toBe("verified");
    expect(quality.segments[0]?.status).toBe("verified"); // untouched
    const meta = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8")));
    expect(meta.stages.tts.status).toBe("complete");
    expect(meta.stages.audioMastering.status).toBe("pending");
    expect(meta.stages.alignment.status).toBe("pending");
  });

  it("survives regeneration of verification state with prior manual acceptance intact", async () => {
    const { root, story } = await fixture();
    await acceptStoredChapterTtsSegment({ root, slug: story.slug, chapter: 1, segment: 1 });
    const report: TtsQualityReport = { version: 1, status: "unverified", retried: 0, segments: [
      { index: 0, expectedText: good, status: "unverified", issues: [], attempts: [], finalAttempt: 0 },
      { index: 1, expectedText: bad, status: "unverified", issues: [], attempts: [], finalAttempt: 0 },
    ] };
    const persisted = await persistChapterTtsQuality({ root, story, chapter: 1, report, maxRetries: 2, transcriber: "fake-transcriber" });
    expect(persisted.segments[1]?.status).toBe("manually_accepted");
    expect(persisted.createdAt).toBeDefined();
    const loaded = await loadChapterTtsQuality(root, story.slug, 1);
    expect(loaded?.verificationPolicy.fingerprint).toBe(persisted.verificationPolicy.fingerprint);
  });

  it("summarizes statuses deterministically", () => {
    const segment = (status: TtsSegmentQuality["status"], attempts = 1): Pick<TtsSegmentQuality, "status" | "attempts"> => ({ status, attempts: Array.from({ length: attempts }, (_, index) => ({ attempt: index + 1, settings: { deliveryIntensity: "restrained" as const }, status: "pass" as const, issues: [] })) });
    expect(summarizeQuality([segment("verified"), segment("verified")]).status).toBe("verified");
    expect(summarizeQuality([segment("verified"), segment("needs_review")]).status).toBe("needs_review");
    expect(summarizeQuality([segment("unverified"), segment("unverified")]).status).toBe("unverified");
    expect(summarizeQuality([segment("verified"), segment("manually_accepted")]).status).toBe("partial");
    expect(summarizeQuality([segment("verified", 2)]).retried).toBe(1);
  });
});

describe("tts quality server operations", () => {
  const good = "Mara opened the gate and walked through the yard.";
  const bad = "The tower collapsed into the sea before dawn.";

  async function endpointFixture() {
    const root = await mkdtemp(join(tmpdir(), "tts-quality-api-"));
    const story = testStory();
    const paths = storyPaths(root, story.slug, 1);
    await atomicWriteJson(paths.storyConfig, story);
    const now = new Date().toISOString();
    const complete = { status: "complete" as const };
    await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({
      chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
      counts: { originalCharacters: 10, englishWords: 10, narrationWords: 10 }, createdAt: now, updatedAt: now,
      stages: { ingestion: complete, translation: complete, narration: complete, storyBible: complete, tts: complete, audioMastering: complete, alignment: complete },
    }));
    await atomicWrite(join(paths.segments, "0001.mp3"), bytes("aa"));
    await atomicWrite(join(paths.segments, "0002.mp3"), bytes("bb"));
    const report: TtsQualityReport = { version: 1, status: "needs_review", retried: 1, segments: [
      { index: 0, expectedText: good, status: "verified", score: 1, issues: [], attempts: [], finalAttempt: 1 },
      { index: 1, expectedText: bad, status: "needs_review", score: .2, issues: [{ type: "missing_speech", severity: .8 }], attempts: [], finalAttempt: 3 },
    ] };
    await persistChapterTtsQuality({ root, story, chapter: 1, report, maxRetries: 2, transcriber: "fake-transcriber" });
    const { JobManager } = await import("../apps/server/job-manager.js");
    const { StudioOperations } = await import("../apps/server/operations.js");
    const jobs = new JobManager();
    const inner = new ScriptedTTS((req) => singleSegment(req.text, "cc"));
    const transcriber = new FakeTranscriber((audio) => say(String.fromCharCode(audio[0]!) === "c" ? bad : String.fromCharCode(audio[0]!) === "a" ? good : bad));
    const operations = new StudioOperations(root, loadEnvironment({}), jobs, { tts: inner, speechTranscriber: transcriber });
    return { root, story, paths, jobs, operations, inner, transcriber };
  }

  function waitForJob(jobs: InstanceType<typeof import("../apps/server/job-manager.js").JobManager>, id: string): Promise<import("../apps/server/job-manager.js").Job> {
    return new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error("Job timed out")), 5000); const unsubscribe = jobs.subscribe(id, (job) => { if (["completed", "failed", "paused"].includes(job.status)) { clearTimeout(timeout); unsubscribe?.(); resolve(job); } }); });
  }

  it("serves the stored quality artifact", async () => {
    const { story, operations } = await endpointFixture();
    const response = await operations.getChapterTtsQuality(story.slug, 1);
    expect(response.quality?.segments).toHaveLength(2);
    expect(response.quality?.verificationPolicy.maxRetries).toBe(2);
    await operations.close();
  });

  it("re-verify endpoint re-verifies stored audio without TTS calls", async () => {
    const { story, operations, jobs, inner } = await endpointFixture();
    const job = await waitForJob(jobs, operations.startVerifyChapterTts(story.slug, { chapter: 1 }).id);
    expect(job.status).toBe("completed");
    expect(inner.calls).toHaveLength(0);
    expect((job.result as { quality: { status: string } }).quality.status).toBe("verified");
    await operations.close();
  });

  it("regenerate endpoint replaces one segment and stales mastering", async () => {
    const { story, paths, operations, jobs, inner } = await endpointFixture();
    const job = await waitForJob(jobs, operations.startRegenerateChapterTtsSegment(story.slug, 1, 2).id);
    expect(job.status).toBe("completed");
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0]?.text).toBe(bad);
    expect(new Uint8Array(await readFile(join(paths.segments, "0002.mp3")))).toEqual(bytes("cc"));
    const meta = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8")));
    expect(meta.stages.audioMastering.status).toBe("pending");
    expect(meta.stages.tts.usage?.quality?.status).toBe("verified");
    await operations.close();
  });

  it("accept endpoint records manual acceptance without claiming a pass", async () => {
    const { story, operations } = await endpointFixture();
    const response = await operations.acceptChapterTtsSegment(story.slug, 1, 2, { reason: "reviewed by ear" });
    expect(response.quality.segments[1]).toMatchObject({ status: "manually_accepted", acceptedReason: "reviewed by ear" });
    expect(response.quality.status).not.toBe("verified");
    await operations.close();
  });
});

describe("tts reliability and provenance hardening", () => {
  describe("tokenizeSpoken non-destructive parsing", () => {
    it("preserves ordinary brackets and parentheses while stripping known cues and speaker tags", () => {
      const text = "<|speaker:0|>Subject [REDACTED] engaged protocol (Variant Two) with [laugh] and [sigh].";
      const tokens = tokenizeSpoken(text);
      expect(tokens).toContain("subject");
      expect(tokens).toContain("redacted");
      expect(tokens).toContain("protocol");
      expect(tokens).toContain("variant");
      expect(tokens).toContain("two");
      // Must not contain speaker tag
      expect(tokens).not.toContain("speaker");
      // Must not contain control cues
      expect(tokens).not.toContain("laugh");
      expect(tokens).not.toContain("sigh");
    });
  });

  describe("FishAudioProvider exactChunk and segmentTexts", () => {
    it("produces exact segmentTexts with pronunciation, normalizations, and multi-speaker casting", async () => {
      const sentBodies: Array<{ text: string }> = [];
      const fetcher: typeof fetch = async (_url, init) => {
        sentBodies.push(JSON.parse(init?.body as string));
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/mpeg", "x-request-id": "req-1" },
        });
      };
      const provider = new FishAudioProvider("fake-key", fetcher);
      const text = "Mr. Darcy said, \"Hello, Mara.\" The temperature was 100°F [laugh].";
      const pronunciations = [{
        entityId: "e1", surfaceText: "Mara", start: 24, end: 28,
        pronunciation: { mode: "custom" as const, customPronunciation: "Mah-rah", source: "manual" as const },
      }];
      const result = await provider.synthesize({
        text,
        model: "s2-pro",
        referenceId: "ref1",
        secondaryReferenceId: "ref2",
        voiceMode: "narrator-dialogue",
        speed: 1,
        format: "mp3",
        sampleRate: 44100,
        bitrate: 128,
        normalize: true,
        maxCharsPerRequest: 1750,
        pronunciation: pronunciations,
      });

      expect(result.segmentTexts).toBeDefined();
      expect(result.segmentTexts).toHaveLength(1);
      const chunk = result.segmentTexts![0]!;
      // Contains title replacement
      expect(chunk).toContain("Mister Darcy");
      // Contains pronunciation replacement
      expect(chunk).toContain("Mah-rah");
      // Contains unit replacement
      expect(chunk).toContain("100 degrees Fahrenheit");
      // Contains speaker tags from dialogue casting
      expect(chunk).toContain("<|speaker:");
      // Contains control cue disambiguation
      expect(chunk).toContain("[laugh]");
    });

    it("synthesizes exactChunk without re-splitting, re-casting, or re-normalizing, preserving maxCharsPerRequest", async () => {
      const sentBodies: Array<{ text: string }> = [];
      const fetcher: typeof fetch = async (_url, init) => {
        sentBodies.push(JSON.parse(init?.body as string));
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/mpeg", "x-request-id": "req-retry" },
        });
      };
      const provider = new FishAudioProvider("fake-key", fetcher);
      const exactText = "<|speaker:1|>Mister Darcy said, <|speaker:2|>\"Hello.\"";
      const result = await provider.synthesize({
        text: exactText,
        exactChunk: true,
        model: "s2-pro",
        referenceId: "ref1",
        secondaryReferenceId: "ref2",
        voiceMode: "narrator-dialogue",
        speed: 1,
        format: "mp3",
        sampleRate: 44100,
        bitrate: 128,
        normalize: true,
        maxCharsPerRequest: 1750,
      });
      expect(sentBodies).toHaveLength(1);
      expect(sentBodies[0]!.text).toBe(exactText);
      expect(result.segmentTexts).toEqual([exactText]);
    });
  });

  describe("QualityGuard chunk boundaries on retry", () => {
    it("preserves original chunk limit on retry without inflating maxCharsPerRequest and passes exactChunk", async () => {
      const chunk1 = "First segment of speech.";
      const chunk2 = "Second segment of speech with error.";
      const inner = new ScriptedTTS((req, call) => {
        if (call === 1) {
          const a = bytes("a");
          const b = bytes("b");
          return { audio: new Uint8Array([...a, ...b]), segments: [a, b], segmentTexts: [chunk1, chunk2], providerRequests: 2 };
        }
        // Retry call
        expect(req.exactChunk).toBe(true);
        expect(req.maxCharsPerRequest).toBe(1750); // NOT inflated
        return singleSegment(req.text, "good");
      });
      const transcriber = new FakeTranscriber((audio) => {
        const str = String.fromCharCode(audio[0]!);
        if (str === "a") return say(chunk1);
        if (str === "b") return say("corrupted gibberish words here");
        return say(chunk2);
      });
      const result = await guard(inner, transcriber, 2).synthesize(request({ text: `${chunk1} ${chunk2}`, maxCharsPerRequest: 1750 }));
      expect(inner.calls).toHaveLength(2);
      expect(inner.calls[1]!.exactChunk).toBe(true);
      expect(inner.calls[1]!.maxCharsPerRequest).toBe(1750);
      expect(result.quality?.status).toBe("verified");
    });
  });

  describe("Quality Guard lifecycle when transcriber unavailable", () => {
    it("keeps audio usable and marks status unverified when transcriber is unavailable", async () => {
      const text = "The rain stopped outside the station.";
      const inner = new ScriptedTTS(() => singleSegment(text, "audio"));
      const transcriber: SpeechTranscriber = {
        name: "unavailable-whisper",
        async validateConfiguration() { throw new ConfigurationError("whisper missing"); },
        async transcribe() { throw new Error("not reachable"); },
      };
      const result = await new QualityGuardTTSProvider(inner, transcriber, { maxRetries: 2, language: "en-US" })
        .synthesize(request({ text, qualityGuard: true }));
      expect(result.audio).toBeDefined();
      expect(result.segments).toHaveLength(1);
      expect(result.quality).toBeDefined();
      expect(result.quality?.status).toBe("unverified");
      expect(result.quality?.segments[0]?.status).toBe("unverified");
      expect(result.quality?.segments[0]?.issues[0]?.type).toBe("transcription_failed");
    });

    it("works with optional undefined transcriber and marks unverified", async () => {
      const text = "The rain stopped outside the station.";
      const inner = new ScriptedTTS(() => singleSegment(text, "audio"));
      const result = await new QualityGuardTTSProvider(inner, undefined, { maxRetries: 2, language: "en-US" })
        .synthesize(request({ text, qualityGuard: true }));
      expect(result.quality?.status).toBe("unverified");
      expect(result.quality?.segments[0]?.status).toBe("unverified");
    });

    it("skips quality report completely when qualityGuard is false", async () => {
      const text = "The rain stopped outside the station.";
      const inner = new ScriptedTTS(() => singleSegment(text, "audio"));
      const transcriber = new FakeTranscriber(() => say(text));
      const result = await guard(inner, transcriber).synthesize(request({ text, qualityGuard: false }));
      expect(result.quality).toBeUndefined();
    });
  });

  describe("Reverification and manual acceptance provenance", () => {
    const goodText = "Mara opened the gate and walked through the yard.";
    const badText = "The tower collapsed into the sea before dawn.";

    async function qualityFixture() {
      const root = await mkdtemp(join(tmpdir(), "tts-quality-regress-"));
      const story = testStory();
      const paths = storyPaths(root, story.slug, 1);
      const now = new Date().toISOString();
      const complete = { status: "complete" as const };
      await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({
        chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
        counts: { originalCharacters: 10, englishWords: 10, narrationWords: 10 }, createdAt: now, updatedAt: now,
        stages: { ingestion: complete, translation: complete, narration: complete, storyBible: complete, tts: complete, audioMastering: complete, alignment: complete, subtitles: complete },
      }));
      await atomicWrite(join(paths.segments, "0001.mp3"), bytes("aa"));
      await atomicWrite(join(paths.segments, "0002.mp3"), bytes("bb"));
      const report: TtsQualityReport = { version: 1, status: "needs_review", retried: 1, segments: [
        { index: 0, expectedText: goodText, status: "verified", score: 1, issues: [], attempts: [{ attempt: 1, settings: { deliveryIntensity: "restrained" }, status: "pass", score: 1, issues: [] }], finalAttempt: 1 },
        { index: 1, expectedText: badText, status: "needs_review", score: .2, issues: [{ type: "missing_speech", severity: .8 }], attempts: [{ attempt: 1, settings: { deliveryIntensity: "restrained" }, status: "needs_review", score: .2, issues: [] }], finalAttempt: 3 },
      ] };
      await persistChapterTtsQuality({ root, story, chapter: 1, report, maxRetries: 2, transcriber: "fake-transcriber" });
      return { root, story, paths };
    }

    it("updates policy fingerprint and updatedAt without TTS call when re-verifying with new thresholds", async () => {
      const { root, story } = await qualityFixture();
      const transcriber = new FakeTranscriber(() => say(goodText));
      const before = await loadChapterTtsQuality(root, story.slug, 1);
      expect(before).toBeDefined();

      await new Promise((r) => setTimeout(r, 10));

      const updated = await verifyStoredChapterTts({
        root, story, chapter: 1, transcriber,
        thresholds: { passScore: 0.99 },
      });
      expect(updated.updatedAt).not.toBe(before!.updatedAt);
      expect(updated.verificationPolicy.thresholds.passScore).toBe(0.99);
      expect(updated.verificationPolicy.fingerprint).not.toBe(before!.verificationPolicy.fingerprint);
      const meta = chapterSchema.parse(JSON.parse(await readFile(storyPaths(root, story.slug, 1).chapterMeta, "utf8")));
      expect(meta.stages.tts.status).toBe("complete");
    });

    it("discards manual acceptance if segment audio on disk changed", async () => {
      const { root, story, paths } = await qualityFixture();
      const accepted = await acceptStoredChapterTtsSegment({ root, slug: story.slug, chapter: 1, segment: 1, reason: "approved" });
      expect(accepted.segments[1]?.status).toBe("manually_accepted");
      expect(accepted.segments[1]?.acceptedAudioFingerprint).toBeDefined();

      await atomicWrite(join(paths.segments, "0002.mp3"), bytes("different-audio-bytes"));

      const transcriber = new FakeTranscriber(() => say("different words spoken entirely"));
      const reverified = await verifyStoredChapterTts({ root, story, chapter: 1, transcriber });

      expect(reverified.segments[1]?.status).not.toBe("manually_accepted");
      expect(reverified.segments[1]?.status).toBe("needs_review");
    });

    it("discards manual acceptance when segment is regenerated", async () => {
      const { root, story } = await qualityFixture();
      await acceptStoredChapterTtsSegment({ root, slug: story.slug, chapter: 1, segment: 1 });
      const before = await loadChapterTtsQuality(root, story.slug, 1);
      expect(before?.segments[1]?.status).toBe("manually_accepted");

      const inner = new ScriptedTTS(() => singleSegment(badText, "new-regen-audio"));
      const transcriber = new FakeTranscriber(() => say(badText));
      const regenerated = await regenerateStoredChapterTtsSegment({
        root, story, chapter: 1, segment: 1, provider: guard(inner, transcriber), maxRetries: 2,
      });

      expect(regenerated.segments[1]?.status).toBe("verified");
      expect(regenerated.segments[1]?.acceptedAt).toBeUndefined();
      expect(regenerated.segments[1]?.acceptedAudioFingerprint).toBeUndefined();
    });

    it("preserves manual acceptance across identical re-verification when audio is unchanged", async () => {
      const { root, story } = await qualityFixture();
      await acceptStoredChapterTtsSegment({ root, slug: story.slug, chapter: 1, segment: 1 });
      const transcriber = new FakeTranscriber(() => say("words"));
      const reverified = await verifyStoredChapterTts({ root, story, chapter: 1, transcriber });
      expect(reverified.segments[1]?.status).toBe("manually_accepted");
    });
  });

  describe("Quality Guard separation from providerQualityGuard", () => {
    it("runs post-generation verification when qualityGuard=true regardless of providerQualityGuard", async () => {
      const text = "The quiet morning settled over the misty valley.";
      const inner = new ScriptedTTS(() => singleSegment(text, "audio"));
      const transcriber = new FakeTranscriber(() => say(text));

      // Case 1: qualityGuard: true, providerQualityGuard: false -> verification runs
      const res1 = await guard(inner, transcriber).synthesize(request({ text, qualityGuard: true, providerQualityGuard: false }));
      expect(res1.quality).toBeDefined();
      expect(res1.quality?.status).toBe("verified");

      // Case 2: qualityGuard: true, providerQualityGuard: true -> verification runs
      const res2 = await guard(inner, transcriber).synthesize(request({ text, qualityGuard: true, providerQualityGuard: true }));
      expect(res2.quality).toBeDefined();
      expect(res2.quality?.status).toBe("verified");
    });

    it("skips post-generation verification when qualityGuard=false regardless of providerQualityGuard", async () => {
      const text = "The quiet morning settled over the misty valley.";
      const inner = new ScriptedTTS(() => singleSegment(text, "audio"));
      const transcriber = new FakeTranscriber(() => say(text));

      // Case 3: qualityGuard: false, providerQualityGuard: true -> verification does NOT run
      const res3 = await guard(inner, transcriber).synthesize(request({ text, qualityGuard: false, providerQualityGuard: true }));
      expect(res3.quality).toBeUndefined();

      // Case 4: qualityGuard: false, providerQualityGuard: false -> verification does NOT run
      const res4 = await guard(inner, transcriber).synthesize(request({ text, qualityGuard: false, providerQualityGuard: false }));
      expect(res4.quality).toBeUndefined();
    });

    it("passes providerQualityGuard untouched to the inner provider", async () => {
      const text = "Checking provider passthrough.";
      const inner = new ScriptedTTS(() => singleSegment(text, "audio"));
      const transcriber = new FakeTranscriber(() => say(text));

      await guard(inner, transcriber).synthesize(request({ text, qualityGuard: true, providerQualityGuard: false }));
      expect(inner.calls[0]?.providerQualityGuard).toBe(false);

      await guard(inner, transcriber).synthesize(request({ text, qualityGuard: false, providerQualityGuard: true }));
      expect(inner.calls[1]?.providerQualityGuard).toBe(true);
    });
  });
});
