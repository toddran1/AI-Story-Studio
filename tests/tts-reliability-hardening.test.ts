import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChapterPipeline, type PipelineStageEvent } from "../src/pipeline/chapter-pipeline.js";
import { LLMRouter } from "../src/llm/router.js";
import { FishAudioProvider } from "../src/tts/fish/fish-audio.provider.js";
import { QualityGuardTTSProvider, type SpeechTranscriber, type TtsQualityReport } from "../src/tts/quality-guard.js";
import { FfmpegCensorAudioService } from "../src/tts/censor-audio.js";
import { masterStoredChapter } from "../src/audio/chapter-audio.js";
import { storyPaths } from "../src/storage/paths.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import * as atomicWriteModule from "../src/storage/atomic-write.js";
import {
  acceptStoredChapterTtsSegment,
  loadChapterTtsQuality,
  persistChapterTtsQuality,
  regenerateStoredChapterTtsSegment,
  verifyStoredChapterTts,
} from "../src/tts/chapter-quality.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { ttsSynthesisSettings } from "../src/domain/provider.js";
import { calculateCost, pricingFor, PRICING_CATALOG_VERSION } from "../src/cost/pricing.js";
import { createPipelineRuntime } from "../src/pipeline/create-pipeline.js";
import { loadEnvironment } from "../src/config/env.js";
import { fingerprint } from "../src/utils/hash.js";
import { fileFingerprint } from "../src/utils/file-fingerprint.js";
import { StorageError, ProviderError } from "../src/pipeline/errors.js";
import type { TTSRequest, TTSResult } from "../src/tts/types.js";
import type { AudioMasteringProcessor } from "../src/audio/mastering.js";
import { MockLLM, testStory } from "./helpers.js";

describe("TTS Reliability & Cost Hardening (Tests 26–35)", () => {
  // Test 26: Fingerprint Version & Stability
  describe("Test 26: Fingerprint Version & Stability", () => {
    it("produces stable synthesis fingerprint for identical config and normalization version", () => {
      const provider = new FishAudioProvider("test-key", fetch as typeof fetch);
      const baseConfig = testStory().pipeline.tts;

      const fp1 = fingerprint({
        narration: "narration-fp-1",
        speech: "speech-fp-1",
        config: ttsSynthesisSettings(baseConfig),
        deliveryProfile: "balanced",
        inputNormalizationVersion: provider.inputNormalizationVersion,
      });

      const fp2 = fingerprint({
        narration: "narration-fp-1",
        speech: "speech-fp-1",
        config: ttsSynthesisSettings(baseConfig),
        deliveryProfile: "balanced",
        inputNormalizationVersion: provider.inputNormalizationVersion,
      });

      expect(fp1).toBe(fp2);
    });

    it("changes synthesis fingerprint when inputNormalizationVersion changes", () => {
      const defaultProvider = new FishAudioProvider("test-key", fetch as typeof fetch);
      const directionProvider = new FishAudioProvider("test-key", fetch as typeof fetch, 120_000, undefined, { tskRendering: "direction" });
      const baseConfig = testStory().pipeline.tts;

      expect(defaultProvider.inputNormalizationVersion).toBe("fish-speech-normalization-v10-multispeaker-safe-chunks");
      expect(directionProvider.inputNormalizationVersion).toBe("fish-speech-normalization-v10-multispeaker-safe-chunks-tsk-direction");

      const fpDefault = fingerprint({
        narration: "narration-fp-1",
        speech: "speech-fp-1",
        config: ttsSynthesisSettings(baseConfig),
        deliveryProfile: "balanced",
        inputNormalizationVersion: defaultProvider.inputNormalizationVersion,
      });

      const fpDirection = fingerprint({
        narration: "narration-fp-1",
        speech: "speech-fp-1",
        config: ttsSynthesisSettings(baseConfig),
        deliveryProfile: "balanced",
        inputNormalizationVersion: directionProvider.inputNormalizationVersion,
      });

      expect(fpDefault).not.toBe(fpDirection);
    });

    it("keeps synthesis fingerprint identical when verification-only settings change", () => {
      const provider = new FishAudioProvider("test-key", fetch as typeof fetch);
      const configOff = testStory({ tts: { ...testStory().pipeline.tts, qualityMode: "off", qualityGuard: false, maxQualityRetries: 0 } }).pipeline.tts;
      const configVerify = testStory({ tts: { ...testStory().pipeline.tts, qualityMode: "verify", qualityGuard: true, maxQualityRetries: 3 } }).pipeline.tts;

      expect(ttsSynthesisSettings(configOff)).toEqual(ttsSynthesisSettings(configVerify));

      const fpOff = fingerprint({
        narration: "narration-fp-1",
        speech: "speech-fp-1",
        config: ttsSynthesisSettings(configOff),
        deliveryProfile: "balanced",
        inputNormalizationVersion: provider.inputNormalizationVersion,
      });

      const fpVerify = fingerprint({
        narration: "narration-fp-1",
        speech: "speech-fp-1",
        config: ttsSynthesisSettings(configVerify),
        deliveryProfile: "balanced",
        inputNormalizationVersion: provider.inputNormalizationVersion,
      });

      expect(fpOff).toBe(fpVerify);
    });
  });

  // Test 27: Partial Failure Resume
  describe("Test 27: Partial Failure Resume", () => {
    it("saves chunk checkpoints, survives partial failure, and reuses successful chunks on resume without extra Fish requests", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-resume-test-"));
      const checkpointDir = join(root, "tts-working");

      const text = `${"First paragraph here. ".repeat(15)}\n\n${"Second paragraph here. ".repeat(15)}\n\n${"Third paragraph here. ".repeat(15)}`;

      let callCount = 0;
      const fetcherPass1 = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        callCount++;
        // Chunks 1 and 2 succeed, chunk 3 fails
        if (callCount >= 3) {
          return new Response("Fish gateway error", { status: 502, headers: { "content-type": "text/plain" } });
        }
        return new Response(new Uint8Array([0x49, 0x44, 0x33, callCount]), {
          status: 200,
          headers: { "content-type": "audio/mpeg", "x-request-id": `req-${callCount}` },
        });
      });

      const provider1 = new FishAudioProvider("test-key", fetcherPass1 as typeof fetch, 120_000, undefined, { retryDelayMs: 0 });
      const request: TTSRequest = {
        text,
        model: "s2.1-pro",
        speed: 1,
        format: "mp3",
        sampleRate: 44100,
        bitrate: 128,
        normalize: true,
        maxCharsPerRequest: 500,
        checkpointDir,
      };

      // Pass 1: Fails on chunk 3
      await expect(provider1.synthesize(request)).rejects.toThrow(/Fish s2.1-pro failed for chunk 3 of 3/);

      // Checkpoints for chunks 1 and 2 exist on disk
      const files = await readdir(checkpointDir);
      expect(files).toContain("0001.mp3");
      expect(files).toContain("0001.json");
      expect(files).toContain("0002.mp3");
      expect(files).toContain("0002.json");
      expect(files).not.toContain("0003.mp3");

      // Pass 2: Resume with same checkpointDir; chunk 3 succeeds
      const events: Array<{ status: string; currentChunk: number }> = [];
      const fetcherPass2 = vi.fn(async () => {
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 99]), {
          status: 200,
          headers: { "content-type": "audio/mpeg", "x-request-id": "req-resumed-3" },
        });
      });

      const provider2 = new FishAudioProvider("test-key", fetcherPass2 as typeof fetch, 120_000, undefined, { retryDelayMs: 0 });
      const result = await provider2.synthesize({
        ...request,
        onChunkProgress: (p) => events.push({ status: p.status, currentChunk: p.currentChunk }),
      });

      // Chunks 1 and 2 were reused from checkpoint
      const reused = events.filter((e) => e.status === "reused");
      expect(reused).toHaveLength(2);
      expect(reused.map((e) => e.currentChunk)).toEqual([1, 2]);

      // Fish API was only called once on resume (for chunk 3)
      expect(fetcherPass2).toHaveBeenCalledTimes(1);
      expect(result.providerRequests).toBe(1);
      expect(result.segments).toHaveLength(3);
      expect(result.audio.length).toBe(
        result.segments.reduce((acc, s) => acc + s.length, 0),
      );
    });
  });

  // Test 28: Narrow Transient Transport Retry
  describe("Test 28: Narrow Transient Transport Retry", () => {
    it("retries 500 and 429 errors up to 3 attempts with backoff and succeeds on recovery", async () => {
      let attempts = 0;
      const fetcher = vi.fn(async () => {
        attempts++;
        if (attempts === 1) return new Response("Internal Server Error", { status: 500 });
        if (attempts === 2) return new Response("Too Many Requests", { status: 429 });
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 1]), {
          status: 200,
          headers: { "content-type": "audio/mpeg", "x-request-id": "req-recovered" },
        });
      });

      const provider = new FishAudioProvider("test-key", fetcher as typeof fetch, 120_000, undefined, { retryDelayMs: 0 });
      const result = await provider.synthesize({
        text: "Simple short test phrase.",
        model: "s2.1-pro",
        speed: 1,
        format: "mp3",
        sampleRate: 44100,
        bitrate: 128,
        normalize: true,
        maxCharsPerRequest: 1000,
      });

      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(result.audio.length).toBe(4);
    });

    it("retries network errors and succeeds when connection recovers", async () => {
      let attempts = 0;
      const fetcher = vi.fn(async () => {
        attempts++;
        if (attempts === 1) throw new TypeError("fetch failed");
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 2]), {
          status: 200,
          headers: { "content-type": "audio/mpeg", "x-request-id": "req-net-recovered" },
        });
      });

      const provider = new FishAudioProvider("test-key", fetcher as typeof fetch, 120_000, undefined, { retryDelayMs: 0 });
      const result = await provider.synthesize({
        text: "Simple network retry test phrase.",
        model: "s2.1-pro",
        speed: 1,
        format: "mp3",
        sampleRate: 44100,
        bitrate: 128,
        normalize: true,
        maxCharsPerRequest: 1000,
      });

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(result.audio.length).toBe(4);
    });

    it("fails immediately on 400 Bad Request without retry", async () => {
      const fetcher = vi.fn(async () => new Response("Invalid model parameters", { status: 400 }));
      const provider = new FishAudioProvider("test-key", fetcher as typeof fetch, 120_000, undefined, { retryDelayMs: 0 });

      await expect(provider.synthesize({
        text: "Test bad request.",
        model: "s2.1-pro",
        speed: 1,
        format: "mp3",
        sampleRate: 44100,
        bitrate: 128,
        normalize: true,
        maxCharsPerRequest: 1000,
      })).rejects.toThrow(/HTTP 400/);

      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("fails immediately on 401 Unauthorized without retry", async () => {
      const fetcher = vi.fn(async () => new Response("Invalid API key", { status: 401 }));
      const provider = new FishAudioProvider("test-key", fetcher as typeof fetch, 120_000, undefined, { retryDelayMs: 0 });

      await expect(provider.synthesize({
        text: "Test auth failure.",
        model: "s2.1-pro",
        speed: 1,
        format: "mp3",
        sampleRate: 44100,
        bitrate: 128,
        normalize: true,
        maxCharsPerRequest: 1000,
      })).rejects.toThrow(/HTTP 401/);

      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  // Test 29: Progress Callback Failure
  describe("Test 29: Progress Callback Failure", () => {
    it("continues synthesis even if onChunkProgress throws an error", async () => {
      const fetcher = vi.fn(async () => new Response(new Uint8Array([0x49, 0x44, 0x33]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }));

      const provider = new FishAudioProvider("test-key", fetcher as typeof fetch);
      const result = await provider.synthesize({
        text: "Testing resilient progress callback handling.",
        model: "s2.1-pro",
        speed: 1,
        format: "mp3",
        sampleRate: 44100,
        bitrate: 128,
        normalize: true,
        maxCharsPerRequest: 1000,
        onChunkProgress: () => {
          throw new Error("UI subscriber crashed");
        },
      });

      expect(result.audio).toBeDefined();
      expect(result.audio.length).toBe(3);
    });

    it("continues quality verification even if onQualityProgress throws an error", async () => {
      const fetcher = vi.fn(async () => new Response(new Uint8Array([0x49, 0x44, 0x33]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }));
      const provider = new FishAudioProvider("test-key", fetcher as typeof fetch);
      const transcriber: SpeechTranscriber = {
        name: "mock-transcriber",
        validateConfiguration: async () => {},
        transcribe: async () => [{ text: "Quality checked speech.", start: 0, end: 1, confidence: 0.98 }],
      };

      const guardService = new QualityGuardTTSProvider(provider, transcriber, {
        maxRetries: 1,
        language: "en-US",
        onQualityProgress: () => {
          throw new Error("Quality event listener crashed");
        },
      });

      const result = await guardService.synthesize({
        text: "Quality checked speech.",
        model: "s2.1-pro",
        speed: 1,
        format: "mp3",
        sampleRate: 44100,
        bitrate: 128,
        normalize: true,
        maxCharsPerRequest: 1000,
        qualityGuard: true,
      });

      expect(result.quality?.status).toBe("verified");
    });
  });

  // Test 30: Verify Metadata
  describe("Test 30: Verify Metadata", () => {
    it("persists verificationPolicy.maxRetries = 0 during verifyStoredChapterTts", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-verify-metadata-"));
      const story = testStory();
      const paths = storyPaths(root, story.slug, 1);
      const now = new Date().toISOString();
      const complete = { status: "complete" as const };

      await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({
        chapter: 1,
        sourceLanguage: story.sourceLanguage,
        outputLanguage: story.outputLanguage,
        counts: { originalCharacters: 10, englishWords: 10, narrationWords: 10 },
        createdAt: now,
        updatedAt: now,
        stages: {
          ingestion: complete,
          translation: complete,
          narration: complete,
          storyBible: complete,
          tts: complete,
          audioMastering: complete,
          alignment: complete,
          subtitles: complete,
        },
      }));

      await atomicWrite(join(paths.segments, "0001.mp3"), new Uint8Array([0x49, 0x44, 0x33]));

      const report: TtsQualityReport = {
        version: 1,
        status: "unverified",
        retried: 0,
        segments: [
          { index: 0, expectedText: "The gate opened slowly.", status: "unverified", issues: [], attempts: [], finalAttempt: 0 },
        ],
      };
      await persistChapterTtsQuality({ root, story, chapter: 1, report, maxRetries: 2, transcriber: "mock-transcriber" });

      const transcriber: SpeechTranscriber = {
        name: "mock-transcriber",
        validateConfiguration: async () => {},
        transcribe: async () => [{ text: "The gate opened slowly.", start: 0, end: 1, confidence: 0.95 }],
      };

      const verified = await verifyStoredChapterTts({ root, story, chapter: 1, transcriber });
      expect(verified.verificationPolicy.maxRetries).toBe(0);

      const loaded = await loadChapterTtsQuality(root, story.slug, 1);
      expect(loaded?.verificationPolicy.maxRetries).toBe(0);
    });
  });

  // Test 31: S2.1-Pro Pricing Support
  describe("Test 31: S2.1-Pro Pricing Support", () => {
    it("returns pricing snapshot for s2.1-pro and s2.1-pro-free alias with $15/1M UTF-8 bytes", () => {
      const proSnapshot = pricingFor("fish", "s2.1-pro");
      expect(proSnapshot).toBeDefined();
      expect(proSnapshot?.basis).toBe("utf8_bytes");
      expect(proSnapshot?.utf8BytesPerMillion).toBe(15);
      expect(proSnapshot?.catalogVersion).toBe(PRICING_CATALOG_VERSION);
      expect(proSnapshot?.currency).toBe("USD");

      const freeSnapshot = pricingFor("fish", "s2.1-pro-free");
      expect(freeSnapshot).toBeDefined();
      expect(freeSnapshot).toEqual(proSnapshot);

      // 1,000,000 bytes at $15/1M bytes = $15.00
      const cost1M = calculateCost(proSnapshot, { inputUtf8Bytes: 1_000_000 });
      expect(cost1M).toBe(15);

      // 500,000 bytes = $7.50
      const costHalfM = calculateCost(proSnapshot, { inputUtf8Bytes: 500_000 });
      expect(costHalfM).toBe(7.5);
    });
  });

  // Test 32: Manual Regeneration Transaction
  describe("Test 32: Manual Regeneration Transaction", () => {
    it("rolls back the segment audio file if quality metadata persistence fails", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-regen-tx-"));
      const story = testStory();
      const paths = storyPaths(root, story.slug, 1);
      const now = new Date().toISOString();
      const complete = { status: "complete" as const };

      await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({
        chapter: 1,
        sourceLanguage: story.sourceLanguage,
        outputLanguage: story.outputLanguage,
        counts: { originalCharacters: 10, englishWords: 10, narrationWords: 10 },
        createdAt: now,
        updatedAt: now,
        stages: {
          ingestion: complete,
          translation: complete,
          narration: complete,
          storyBible: complete,
          tts: complete,
          audioMastering: complete,
          alignment: complete,
          subtitles: complete,
        },
      }));

      const segmentPath = join(paths.segments, "0001.mp3");
      const originalAudio = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
      await atomicWrite(segmentPath, originalAudio);

      const report: TtsQualityReport = {
        version: 1,
        status: "needs_review",
        retried: 0,
        segments: [
          { index: 0, expectedText: "Original text.", status: "needs_review", issues: [], attempts: [], finalAttempt: 0 },
        ],
      };
      await persistChapterTtsQuality({ root, story, chapter: 1, report, maxRetries: 0, transcriber: "mock" });

      const mockProvider: import("../src/tts/provider.js").TTSProvider = {
        name: "fish",
        validateConfiguration: async () => {},
        synthesize: async () => ({
          audio: new Uint8Array([0x99, 0x88, 0x77]),
          segments: [new Uint8Array([0x99, 0x88, 0x77])],
        }),
      };

      // Spy on atomicWriteJson to simulate storage failure specifically when saving ttsQuality
      const spy = vi.spyOn(atomicWriteModule, "atomicWriteJson").mockImplementation(async (targetPath, value) => {
        if (String(targetPath).endsWith("tts-quality.json")) {
          throw new Error("Disk full or permission denied on metadata write");
        }
        return atomicWriteModule.atomicWrite(targetPath, `${JSON.stringify(value, null, 2)}\n`);
      });

      try {
        await expect(regenerateStoredChapterTtsSegment({
          root,
          story,
          chapter: 1,
          segment: 0,
          provider: mockProvider,
          maxRetries: 0,
        })).rejects.toThrow(/Failed to persist quality metadata after regenerating segment; rolled back audio file/);

        // Verify the original audio was restored on disk
        const currentAudio = await readFile(segmentPath);
        expect(new Uint8Array(currentAudio)).toEqual(originalAudio);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Test 33: Manual Acceptance Requires Audio on Disk
  describe("Test 33: Manual Acceptance Requires Audio on Disk", () => {
    it("rejects acceptance with a friendly StorageError if the segment audio file is missing on disk", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-accept-missing-"));
      const story = testStory();
      const paths = storyPaths(root, story.slug, 1);
      const now = new Date().toISOString();
      const complete = { status: "complete" as const };

      await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({
        chapter: 1,
        sourceLanguage: story.sourceLanguage,
        outputLanguage: story.outputLanguage,
        counts: { originalCharacters: 10, englishWords: 10, narrationWords: 10 },
        createdAt: now,
        updatedAt: now,
        stages: {
          ingestion: complete,
          translation: complete,
          narration: complete,
          storyBible: complete,
          tts: complete,
          audioMastering: complete,
          alignment: complete,
          subtitles: complete,
        },
      }));

      const report: TtsQualityReport = {
        version: 1,
        status: "needs_review",
        retried: 0,
        segments: [
          { index: 0, expectedText: "Speech segment text.", status: "needs_review", issues: [], attempts: [], finalAttempt: 0 },
        ],
      };
      await persistChapterTtsQuality({ root, story, chapter: 1, report, maxRetries: 0, transcriber: "mock" });

      // Ensure segment file does NOT exist
      const segmentPath = join(paths.segments, "0001.mp3");
      await rm(segmentPath, { force: true });

      await expect(acceptStoredChapterTtsSegment({
        root,
        slug: story.slug,
        chapter: 1,
        segment: 0,
        reason: "Reviewer listened to audio elsewhere",
      })).rejects.toThrow(/Segment audio is missing; regenerate or rerun TTS before accepting it\./);
    });
  });

  // Test 34: Censorship Segment Workflow
  describe("Test 34: Censorship Segment Workflow", () => {
    it("preserves speech chunks in audio-segments, writes censor-manifest, and mastering consumes audioRaw", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-censor-workflow-"));
      const baseStory = testStory();
      const story = {
        ...baseStory,
        narrationSettings: {
          ...baseStory.narrationSettings,
          bleepStrongProfanity: true,
        },
      };
      const paths = storyPaths(root, story.slug, 1);

      // Plan censored text: "Fuck that noise." has censor + speech
      const text = "Fuck that noise.";

      const speechAudio = new Uint8Array([0x49, 0x44, 0x33, 0x01]);
      const mockTtsProvider: import("../src/tts/provider.js").TTSProvider = {
        name: "fish",
        validateConfiguration: async () => {},
        synthesize: async (req) => ({
          audio: speechAudio,
          segments: [speechAudio],
          segmentTexts: [req.text],
        }),
      };

      const mockFfmpegTools = {
        validateAvailability: async () => {},
        ffmpeg: async (args: string[]) => {
          // Output path is always the last argument
          const out = args.at(-1)!;
          await atomicWrite(out, new Uint8Array([0x49, 0x44, 0x33, 0x09]));
        },
      };

      const censorService = new FfmpegCensorAudioService(mockFfmpegTools as never);
      const result = await censorService.synthesize(mockTtsProvider, {
        text,
        model: "s2.1-pro",
        speed: 1,
        format: "mp3",
        sampleRate: 44100,
        bitrate: 128,
        normalize: true,
        maxCharsPerRequest: 1000,
        bleepStrongProfanity: true,
      });

      expect(result.assembled).toBe(true);
      expect(result.censorManifest).toBeDefined();
      expect(result.segments).toHaveLength(1); // Speech segment
      expect(result.segmentTexts).toHaveLength(1);

      // Now test how ChapterPipeline and masterStoredChapter interact with censorManifest
      const complete = { status: "complete" as const };
      const now = new Date().toISOString();
      await atomicWrite(paths.audioRaw, result.audio);
      await atomicWrite(join(paths.segments, "0001.mp3"), result.segments[0]!);
      await atomicWriteJson(paths.censorManifest, result.censorManifest);

      await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({
        chapter: 1,
        sourceLanguage: story.sourceLanguage,
        outputLanguage: story.outputLanguage,
        counts: { originalCharacters: 10, englishWords: 10, narrationWords: 10 },
        createdAt: now,
        updatedAt: now,
        stages: {
          ingestion: complete,
          translation: complete,
          narration: complete,
          storyBible: complete,
          tts: { ...complete, outputFingerprint: await fileFingerprint(paths.audioRaw) },
          audioMastering: { status: "pending" },
          alignment: { status: "pending" },
          subtitles: { status: "pending" },
        },
      }));

      let masteredInputs: string[] = [];
      const mockMasteringProcessor: AudioMasteringProcessor = {
        version: "mock-master-v1",
        master: async (inputs: string[], outputPath: string) => {
          masteredInputs = [...inputs];
          await atomicWrite(outputPath, new Uint8Array([0x49, 0x44, 0x33, 0x99]));
          return {
            durationSeconds: 2.5,
            sampleRate: 44100,
            channels: 2,
            format: "mp3",
            bitrate: 128000,
            codec: "mp3",
            container: "mp3",
          };
        },
      };

      await masterStoredChapter({
        root,
        story,
        chapter: 1,
        processor: mockMasteringProcessor,
      });

      // When censorManifest exists, mastering consumes paths.audioRaw instead of individual speech segments
      expect(masteredInputs).toEqual([paths.audioRaw]);
    });
  });

  // Test 35: Runtime Return Cleanup
  describe("Test 35: Runtime Return Cleanup", () => {
    it("createPipelineRuntime returns all 7 components including transcriber", () => {
      const env = loadEnvironment();
      const runtime = createPipelineRuntime(env);

      expect(runtime).toBeDefined();
      expect(runtime.router).toBeDefined();
      expect(runtime.images).toBeDefined();
      expect(runtime.tts).toBeDefined();
      expect(runtime.audio).toBeDefined();
      expect(runtime.censor).toBeDefined();
      expect("transcriber" in runtime).toBe(true);
      expect(runtime.pipeline).toBeDefined();
    });
  });
});
