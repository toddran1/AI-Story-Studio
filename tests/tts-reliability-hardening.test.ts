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

const realAtomicWrite = atomicWriteModule.atomicWrite;
const realAtomicWriteJson = atomicWriteModule.atomicWriteJson;

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
import type { TTSProvider } from "../src/tts/provider.js";
import type { AudioMasteringProcessor } from "../src/audio/mastering.js";
import { withUsageScope, TrackedTTSProvider } from "../src/cost/context.js";
import type { ProviderUsageRecord } from "../src/cost/types.js";
import { logger } from "../src/utils/logger.js";
import { MockLLM, MockTTS, testStory } from "./helpers.js";

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

  const ttsReq = (overrides: Partial<TTSRequest> & { text: string }): TTSRequest => ({
    model: "s2-pro",
    speed: 1,
    format: "mp3",
    sampleRate: 44100,
    bitrate: 128,
    normalize: true,
    maxCharsPerRequest: 1750,
    ...overrides,
  });

  // Test 24: Censor Checkpoint Namespace
  describe("Test 24: Censor Checkpoint Namespace", () => {
    it("allocates separate child checkpoint directories for each censor speech fragment", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-censor-checkpoint-"));
      const checkpointDir = join(root, "tts-working");
      const calls: TTSRequest[] = [];
      const tools = {
        validateAvailability: async () => undefined,
        ffmpeg: async (args: string[]) => {
          await atomicWrite(args.at(-1)!, new Uint8Array([1, 2, 3]));
        },
      };
      const provider: TTSProvider = {
        name: "fish",
        validateConfiguration: async () => {},
        synthesize: async (req) => {
          calls.push(req);
          return { audio: new Uint8Array([1]), segments: [new Uint8Array([1])], providerRequests: 1 };
        },
      };
      const service = new FfmpegCensorAudioService(tools as any);
      await service.synthesize(provider, ttsReq({
        text: "This shit is fucking crazy.",
        bleepStrongProfanity: true,
        checkpointDir,
      }));

      expect(calls).toHaveLength(3);
      expect(calls[0]?.checkpointDir).toBe(join(checkpointDir, "censor-0001"));
      expect(calls[1]?.checkpointDir).toBe(join(checkpointDir, "censor-0002"));
      expect(calls[2]?.checkpointDir).toBe(join(checkpointDir, "censor-0003"));
    });
  });

  // Test 25: Censored Resume After Later Failure
  describe("Test 25: Censored Resume After Later Failure", () => {
    it("resumes censored chapters by reusing successful speech fragments on retry", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-censor-resume-"));
      const checkpointDir = join(root, "tts-working");
      const tools = {
        validateAvailability: async () => undefined,
        ffmpeg: async (args: string[]) => {
          await atomicWrite(args.at(-1)!, new Uint8Array([1, 2, 3]));
        },
      };

      let attempt = 1;
      let totalFishCalls = 0;
      const fetcher = vi.fn(async (_url: unknown, options?: { body?: unknown }) => {
        totalFishCalls++;
        const parsed = JSON.parse(String((options as any)?.body ?? "{}"));
        if (attempt === 1 && parsed.text.includes("crazy")) {
          return new Response("Simulated failure", { status: 500 });
        }
        return new Response(new Uint8Array([0x49, 0x44, 0x33, totalFishCalls]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg", "x-request-id": `req-${totalFishCalls}` },
        });
      });

      const provider = new FishAudioProvider("test-key", fetcher as unknown as typeof fetch, 5000, undefined, { retryDelayMs: 1 });
      const service = new FfmpegCensorAudioService(tools as any);

      // First run: fragments 1 and 2 succeed, fragment 3 fails
      await expect(service.synthesize(provider, ttsReq({
        text: "This shit is fucking crazy.",
        bleepStrongProfanity: true,
        checkpointDir,
      }))).rejects.toThrow();

      expect(totalFishCalls).toBeGreaterThanOrEqual(3);
      const callsBeforeRetry = totalFishCalls;

      // Second run: retry
      attempt = 2;
      const result = await service.synthesize(provider, ttsReq({
        text: "This shit is fucking crazy.",
        bleepStrongProfanity: true,
        checkpointDir,
      }));

      expect(result.assembled).toBe(true);
      expect(totalFishCalls - callsBeforeRetry).toBe(1);
      expect(result.reusedChunks).toBe(2);
      expect(result.providerRequests).toBe(1);
    });
  });

  // Test 26: Invalid Content Type Partial Usage
  describe("Test 26: Invalid Content Type Partial Usage", () => {
    it("preserves prior chunk usage when a chunk returns HTTP 200 with invalid content-type", async () => {
      let callCount = 0;
      const fetcher = vi.fn(async () => {
        callCount++;
        if (callCount <= 2) {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "Content-Type": "audio/mpeg", "x-request-id": `req-${callCount}` },
          });
        }
        return new Response("<html>Bad Gateway / Maintenance</html>", {
          status: 200,
          headers: { "Content-Type": "text/html", "x-request-id": "req-3" },
        });
      });

      const provider = new FishAudioProvider("test-key", fetcher as unknown as typeof fetch);
      const records: ProviderUsageRecord[] = [];
      const tracked = new TrackedTTSProvider(provider, {
        record: async (record) => { records.push(record); },
      });

      const progressEvents: any[] = [];
      let thrownError: any;
      try {
        await withUsageScope({ story: "demo", chapter: 1, stage: "tts" }, () =>
          tracked.synthesize(ttsReq({
            text: "Short text here",
            maxCharsPerRequest: 5,
            onChunkProgress: (progress) => progressEvents.push(progress),
          }))
        );
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeDefined();
      expect(thrownError.message).toMatch(/Fish s2-pro failed for chunk 3 of \d+/);
      expect(thrownError.message).toMatch(/unexpected content type/);

      expect(progressEvents.some((p) => p.currentChunk === 3 && p.status === "failed" && p.errorCategory === "provider")).toBe(true);

      expect(thrownError.partialUsage).toBeDefined();
      expect(thrownError.partialUsage.successfulRequests.providerRequests).toBe(2);
      expect(thrownError.partialUsage.successfulRequests.requestIds).toEqual(["req-1", "req-2"]);
      expect(thrownError.partialUsage.failedRequest.requestId).toBe("req-3");
      expect(thrownError.partialUsage.failedRequest.errorCategory).toBe("provider");

      expect(records).toHaveLength(2);
      expect(records[0]?.success).toBe(true);
      expect(records[0]?.providerRequests).toBe(2);
      expect(records[0]?.requestId).toBe("req-1,req-2");
      expect(records[1]?.success).toBe(false);
      expect(records[1]?.requestId).toBe("req-3");
      expect(records[1]?.errorCategory).toBe("provider");
    });
  });

  // Test 27: Empty Response Partial Usage
  describe("Test 27: Empty Response Partial Usage", () => {
    it("preserves prior chunk usage when a chunk returns HTTP 200 with an empty body", async () => {
      let callCount = 0;
      const fetcher = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "Content-Type": "audio/mpeg", "x-request-id": "req-1" },
          });
        }
        return new Response(new Uint8Array(0), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg", "x-request-id": "req-2" },
        });
      });

      const provider = new FishAudioProvider("test-key", fetcher as unknown as typeof fetch);
      const progressEvents: any[] = [];
      let thrownError: any;
      try {
        await provider.synthesize(ttsReq({
          text: "First. Second.",
          maxCharsPerRequest: 7,
          onChunkProgress: (p) => progressEvents.push(p),
        }));
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeDefined();
      expect(thrownError.message).toMatch(/chunk 2 of 2/);
      expect(thrownError.message).toMatch(/empty audio response/);
      expect(thrownError.partialUsage.successfulRequests.providerRequests).toBe(1);
      expect(thrownError.partialUsage.successfulRequests.requestIds).toEqual(["req-1"]);
      expect(thrownError.partialUsage.failedRequest.requestId).toBe("req-2");
      expect(thrownError.partialUsage.failedRequest.errorCategory).toBe("provider");
      expect(progressEvents.some((p) => p.currentChunk === 2 && p.status === "failed")).toBe(true);
    });
  });

  // Test 28: Transactional Censored Regeneration
  describe("Test 28: Transactional Censored Regeneration", () => {
    it("leaves canonical files untouched when staged censor reassembly fails", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-regen-staged-fail-"));
      const story = testStory();
      const paths = storyPaths(root, story.slug, 1);
      const oldSegmentAudio = new Uint8Array([0x11, 0x22, 0x33]);
      const oldRawAudio = new Uint8Array([0xaa, 0xbb, 0xcc]);
      await atomicWrite(join(paths.segments, "0001.mp3"), oldSegmentAudio);
      await atomicWrite(paths.audioRaw, oldRawAudio);
      const censorManifest = { version: 1, items: [{ kind: "speech" as const, speechIndex: 0 }] };
      await atomicWriteJson(paths.censorManifest, censorManifest);
      const report: TtsQualityReport = {
        version: 1,
        status: "needs_review",
        retried: 0,
        segments: [{ index: 0, expectedText: "Speech text", status: "needs_review", issues: [], attempts: [], finalAttempt: 0 }],
      };
      await persistChapterTtsQuality({ root, story, chapter: 1, report, maxRetries: 0, transcriber: "mock" });

      const mockProvider: TTSProvider = {
        name: "fish",
        validateConfiguration: async () => {},
        synthesize: async () => ({ audio: new Uint8Array([0x99]), segments: [new Uint8Array([0x99])] }),
      };

      const reassembleSpy = vi.spyOn(FfmpegCensorAudioService.prototype, "reassemble").mockRejectedValueOnce(new Error("FFmpeg reassembly failed"));
      try {
        await expect(regenerateStoredChapterTtsSegment({
          root,
          story,
          chapter: 1,
          segment: 0,
          provider: mockProvider,
          maxRetries: 0,
        })).rejects.toThrow("FFmpeg reassembly failed");

        expect(new Uint8Array(await readFile(join(paths.segments, "0001.mp3")))).toEqual(oldSegmentAudio);
        expect(new Uint8Array(await readFile(paths.audioRaw))).toEqual(oldRawAudio);
      } finally {
        reassembleSpy.mockRestore();
      }
    });

    it("rolls back canonical files and quality metadata if promotion fails in a censored chapter", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-regen-promote-fail-"));
      const story = testStory();
      const paths = storyPaths(root, story.slug, 1);
      const oldSegmentAudio = new Uint8Array([0x11, 0x22, 0x33]);
      const oldRawAudio = new Uint8Array([0xaa, 0xbb, 0xcc]);
      await atomicWrite(join(paths.segments, "0001.mp3"), oldSegmentAudio);
      await atomicWrite(paths.audioRaw, oldRawAudio);
      const censorManifest = { version: 1, items: [{ kind: "speech" as const, speechIndex: 0 }] };
      await atomicWriteJson(paths.censorManifest, censorManifest);
      const report: TtsQualityReport = {
        version: 1,
        status: "needs_review",
        retried: 0,
        segments: [{ index: 0, expectedText: "Speech text", status: "needs_review", issues: [], attempts: [], finalAttempt: 0 }],
      };
      await persistChapterTtsQuality({ root, story, chapter: 1, report, maxRetries: 0, transcriber: "mock" });

      const mockProvider: TTSProvider = {
        name: "fish",
        validateConfiguration: async () => {},
        synthesize: async () => ({ audio: new Uint8Array([0x99]), segments: [new Uint8Array([0x99])] }),
      };

      const reassembleSpy = vi.spyOn(FfmpegCensorAudioService.prototype, "reassemble").mockImplementation(async (_dir, _man, outPath) => {
        await atomicWrite(outPath, new Uint8Array([0x99, 0x99]));
      });

      const writeSpy = vi.spyOn(atomicWriteModule, "atomicWriteJson").mockImplementation(async (targetPath, value) => {
        if (String(targetPath).endsWith("tts-quality.json")) {
          throw new Error("Disk full on quality write");
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

        expect(new Uint8Array(await readFile(join(paths.segments, "0001.mp3")))).toEqual(oldSegmentAudio);
        expect(new Uint8Array(await readFile(paths.audioRaw))).toEqual(oldRawAudio);
      } finally {
        reassembleSpy.mockRestore();
        writeSpy.mockRestore();
      }
    });
  });

  // Test 29: FFmpeg Reassembly Cannot Corrupt Canonical Raw Audio
  describe("Test 29: FFmpeg Reassembly Cannot Corrupt Canonical Raw Audio", () => {
    it("ensures FFmpeg partial write during staged reassembly cannot corrupt canonical raw audio", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-censor-corrupt-raw-"));
      const story = testStory();
      const paths = storyPaths(root, story.slug, 1);
      const originalRawAudio = Buffer.from("OLD_RAW_AUDIO_CANONICAL");
      await atomicWrite(join(paths.segments, "0001.mp3"), new Uint8Array([1, 2, 3]));
      await atomicWrite(paths.audioRaw, originalRawAudio);
      const censorManifest = { version: 1, items: [{ kind: "speech" as const, speechIndex: 0 }] };
      await atomicWriteJson(paths.censorManifest, censorManifest);
      const report: TtsQualityReport = {
        version: 1,
        status: "needs_review",
        retried: 0,
        segments: [{ index: 0, expectedText: "Speech", status: "needs_review", issues: [], attempts: [], finalAttempt: 0 }],
      };
      await persistChapterTtsQuality({ root, story, chapter: 1, report, maxRetries: 0, transcriber: "mock" });

      const mockProvider: TTSProvider = {
        name: "fish",
        validateConfiguration: async () => {},
        synthesize: async () => ({ audio: new Uint8Array([4, 5, 6]), segments: [new Uint8Array([4, 5, 6])] }),
      };

      const reassembleSpy = vi.spyOn(FfmpegCensorAudioService.prototype, "reassemble").mockImplementation(async (_dir, _man, outPath) => {
        await atomicWrite(outPath, Buffer.from("CORRUPT_PARTIAL_DATA"));
        throw new Error("FFmpeg killed with SIGSEGV");
      });

      try {
        await expect(regenerateStoredChapterTtsSegment({
          root,
          story,
          chapter: 1,
          segment: 0,
          provider: mockProvider,
          maxRetries: 0,
        })).rejects.toThrow("FFmpeg killed with SIGSEGV");

        const onDiskRaw = await readFile(paths.audioRaw);
        expect(onDiskRaw.toString()).toBe("OLD_RAW_AUDIO_CANONICAL");
      } finally {
        reassembleSpy.mockRestore();
      }
    });
  });

  // Test 30: Segment Set Consistency in Verify
  describe("Test 30: Segment Set Consistency in Verify", () => {
    it("detects missing files and surfaces extra segment files during verifyStoredChapterTts", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-verify-consistency-"));
      const story = testStory();
      const paths = storyPaths(root, story.slug, 1);

      await atomicWrite(join(paths.segments, "0001.mp3"), new Uint8Array([1]));
      await atomicWrite(join(paths.segments, "0002.mp3"), new Uint8Array([2]));
      await atomicWrite(join(paths.segments, "0004.mp3"), new Uint8Array([4]));

      const report: TtsQualityReport = {
        version: 1,
        status: "unverified",
        retried: 0,
        segments: [
          { index: 0, expectedText: "One", status: "unverified", issues: [], attempts: [], finalAttempt: 0 },
          { index: 1, expectedText: "Two", status: "unverified", issues: [], attempts: [], finalAttempt: 0 },
          { index: 2, expectedText: "Three", status: "unverified", issues: [], attempts: [], finalAttempt: 0 },
        ],
      };
      await persistChapterTtsQuality({ root, story, chapter: 1, report, maxRetries: 0, transcriber: "mock" });

      const warnSpy = vi.spyOn(logger, "warn");
      const mockTranscriber: SpeechTranscriber = {
        name: "mock",
        validateConfiguration: async () => {},
        transcribe: async () => [{ text: "One", start: 0, end: 1 }],
      };

      try {
        const verified = await verifyStoredChapterTts({
          root,
          story,
          chapter: 1,
          transcriber: mockTranscriber,
        });

        expect(verified.segments[2]?.status).toBe("unverified");
        expect(verified.segments[2]?.issues[0]?.detail).toBe("Segment audio file is missing");

        expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({
          event: "tts.verify.extra_segments_detected",
          extraFiles: ["0004.mp3"],
          count: 1,
        }));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("verifies cleanly on exact match and reports empty directory gracefully", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-verify-exact-"));
      const story = testStory();
      const paths = storyPaths(root, story.slug, 1);

      await atomicWrite(join(paths.segments, "0001.mp3"), new Uint8Array([1]));
      const report: TtsQualityReport = {
        version: 1,
        status: "unverified",
        retried: 0,
        segments: [{ index: 0, expectedText: "Exact match speech", status: "unverified", issues: [], attempts: [], finalAttempt: 0 }],
      };
      await persistChapterTtsQuality({ root, story, chapter: 1, report, maxRetries: 0, transcriber: "mock" });

      const warnSpy = vi.spyOn(logger, "warn");
      const mockTranscriber: SpeechTranscriber = {
        name: "mock",
        validateConfiguration: async () => {},
        transcribe: async () => [{ text: "Exact match speech", start: 0, end: 1 }],
      };

      try {
        const verified = await verifyStoredChapterTts({
          root,
          story,
          chapter: 1,
          transcriber: mockTranscriber,
        });

        expect(verified.segments[0]?.status).toBe("verified");
        expect(warnSpy).not.toHaveBeenCalledWith(expect.objectContaining({
          event: "tts.verify.extra_segments_detected",
        }));
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // Test 31: Request ID Semantics
  describe("Test 31: Request ID Semantics", () => {
    it("separates new request IDs from reused checkpoint request IDs", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-request-id-semantics-"));
      const checkpointDir = join(root, "tts-working");

      let pass1Calls = 0;
      const pass1Fetcher = vi.fn(async () => {
        pass1Calls++;
        if (pass1Calls >= 3) {
          return new Response("Simulated failure for chunk 3", { status: 500 });
        }
        return new Response(new Uint8Array([pass1Calls]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg", "x-request-id": `old-req-${pass1Calls}` },
        });
      });
      const pass1Provider = new FishAudioProvider("test-key", pass1Fetcher as unknown as typeof fetch, 5000, undefined, { retryDelayMs: 0 });

      const text = `${"First paragraph. ".repeat(15)}\n\n${"Second paragraph. ".repeat(15)}\n\n${"Third paragraph. ".repeat(15)}`;
      await expect(pass1Provider.synthesize(ttsReq({
        text,
        checkpointDir,
        maxCharsPerRequest: 400,
      }))).rejects.toThrow();

      const pass2Fetcher = vi.fn(async () =>
        new Response(new Uint8Array([3]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg", "x-request-id": "new-req-3" },
        })
      );
      const pass2Provider = new FishAudioProvider("test-key", pass2Fetcher as unknown as typeof fetch);

      const result = await pass2Provider.synthesize(ttsReq({
        text,
        checkpointDir,
        maxCharsPerRequest: 400,
      }));

      expect(result.providerRequests).toBe(1);
      expect(result.requestIds).toEqual(["new-req-3"]);
      expect(result.reusedRequestIds).toEqual(["old-req-1", "old-req-2"]);
      expect(result.reusedChunks).toBe(2);
    });
  });

  // Test 32: Fully Resumed Usage
  describe("Test 32: Fully Resumed Usage", () => {
    it("reports 0 new provider requests and preserves reusedChunks on fully resumed chapter", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-fully-resumed-"));
      const checkpointDir = join(root, "tts-working");

      let pass1Calls = 0;
      const pass1Fetcher = vi.fn(async () => {
        pass1Calls++;
        return new Response(new Uint8Array([pass1Calls]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg", "x-request-id": `req-${pass1Calls}` },
        });
      });
      const pass1Provider = new FishAudioProvider("test-key", pass1Fetcher as unknown as typeof fetch);
      const text = `${"First paragraph. ".repeat(15)}\n\n${"Second paragraph. ".repeat(15)}`;

      const pass1Result = await pass1Provider.synthesize(ttsReq({
        text,
        checkpointDir,
        maxCharsPerRequest: 400,
      }));
      expect(pass1Result.providerRequests).toBe(2);

      const pass2Fetcher = vi.fn(async () => {
        throw new Error("Should not be called");
      });
      const pass2Provider = new FishAudioProvider("test-key", pass2Fetcher as unknown as typeof fetch);

      const result = await pass2Provider.synthesize(ttsReq({
        text,
        checkpointDir,
        maxCharsPerRequest: 400,
      }));

      expect(pass2Fetcher).not.toHaveBeenCalled();
      expect(result.providerRequests).toBe(0);
      expect(result.requestIds).toBeUndefined();
      expect(result.reusedChunks).toBe(2);
      expect(result.segments).toHaveLength(2);
    });
  });

  // Test 33: Checkpoint Metadata Privacy & Legacy Compatibility
  describe("Test 33: Checkpoint Metadata Privacy & Legacy Compatibility", () => {
    it("does not store raw narration text in checkpoint metadata and preserves legacy checkpoint readability", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-meta-privacy-"));
      const checkpointDir = join(root, "tts-working");
      const fetcher = vi.fn(async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg", "x-request-id": "req-1" },
        })
      );
      const provider = new FishAudioProvider("test-key", fetcher as unknown as typeof fetch);

      await provider.synthesize(ttsReq({
        text: "Private sensitive narration text.",
        checkpointDir,
      }));

      const metaPath = join(checkpointDir, "0001.json");
      const meta = JSON.parse(await readFile(metaPath, "utf8"));

      expect(meta.text).toBeUndefined();
      expect("text" in meta).toBe(false);
      expect(meta.textFingerprint).toBeDefined();
      expect(meta.fingerprint).toBeDefined();
      expect(meta.characters).toBeDefined();
      expect(meta.utf8Bytes).toBeDefined();

      meta.text = "Private sensitive narration text.";
      await atomicWriteJson(metaPath, meta);

      fetcher.mockClear();
      const legacyResult = await provider.synthesize(ttsReq({
        text: "Private sensitive narration text.",
        checkpointDir,
      }));

      expect(fetcher).not.toHaveBeenCalled();
      expect(legacyResult.providerRequests).toBe(0);
      expect(legacyResult.reusedChunks).toBe(1);
      expect(new Uint8Array(legacyResult.segments[0]!)).toEqual(new Uint8Array([1, 2, 3]));
    });
  });

  // Test 15: Successful TTS Promotion Removes Orphan Segment Files
  describe("Test 15: Successful TTS Promotion Removes Orphan Segment Files", () => {
    it("removes orphan segment files from disk upon successful TTS stage completion", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-orphan-removal-"));
      const story = testStory();
      const paths = storyPaths(root, story.slug, 1);
      await atomicWrite(join(paths.segments, "0099.mp3"), new Uint8Array([0xff]));

      const llm = new MockLLM("gemini", ["English translation", "English narration"]);
      const tts = new MockTTS();
      const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm], ["kimi", llm]]));
      const pipeline = new ChapterPipeline(router, tts);
      const input = join(root, "chapter.txt");
      await writeFile(input, "第一章\n\n测试内容", "utf8");

      await pipeline.run({ root, story, chapter: 1, inputPath: input, stopAfter: "tts" });

      const files = await readdir(paths.segments);
      expect(files).not.toContain("0099.mp3");
    });
  });

  // Test 22: Full TTS Transactional Promotion
  describe("Test 22: Full TTS Transactional Promotion", () => {
    it("preserves all old canonical artifacts byte-for-byte when forced TTS rerun fails during segment promotion", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-transactional-promotion-"));
      const story = testStory();
      const paths = storyPaths(root, story.slug, 1);

      // Create a previously complete chapter with old canonical artifacts
      const oldAudioRaw = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
      const oldSegment1 = new Uint8Array([0x10, 0x20]);
      const oldSegment2 = new Uint8Array([0x30, 0x40]);
      await atomicWrite(paths.audioRaw, oldAudioRaw);
      await atomicWrite(join(paths.segments, "0001.mp3"), oldSegment1);
      await atomicWrite(join(paths.segments, "0002.mp3"), oldSegment2);

      const oldQuality = {
        version: 1,
        chapter: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        provider: "fish",
        model: "s2.1-pro",
        status: "verified" as const,
        verificationPolicy: { transcriber: "mock", maxRetries: 0, thresholds: {}, fingerprint: "fp-1" },
        segments: [
          { index: 0, expectedText: "Old seg 1", status: "verified" as const, attempts: [], finalAttempt: 0, issues: [] },
          { index: 1, expectedText: "Old seg 2", status: "verified" as const, attempts: [], finalAttempt: 0, issues: [] },
        ],
      };
      await atomicWriteJson(paths.ttsQuality, oldQuality);

      const oldCensor = { version: 1, items: [{ kind: "speech" as const, speechIndex: 0 }] };
      await atomicWriteJson(paths.censorManifest, oldCensor);

      const now = new Date().toISOString();
      const oldChapterMeta = chapterSchema.parse({
        chapter: 1,
        sourceLanguage: story.sourceLanguage,
        outputLanguage: story.outputLanguage,
        counts: { originalCharacters: 10, englishWords: 10, narrationWords: 10 },
        createdAt: now,
        updatedAt: now,
        stages: {
          ingestion: { status: "complete" },
          translation: { status: "complete" },
          narration: { status: "complete" },
          storyBible: { status: "complete" },
          tts: { status: "complete", outputFingerprint: await fileFingerprint(paths.audioRaw) },
          audioMastering: { status: "pending" },
          alignment: { status: "pending" },
          subtitles: { status: "pending" },
        },
      });
      await atomicWriteJson(paths.chapterMeta, oldChapterMeta);

      const llm = new MockLLM("gemini", ["English translation", "English narration"]);
      const newAudioRaw = new Uint8Array([0x99, 0x88, 0x77]);
      const newSeg1 = new Uint8Array([0x99]);
      const newSeg2 = new Uint8Array([0x88, 0x77]);
      const mockTts: TTSProvider = {
        name: "fish",
        validateConfiguration: async () => {},
        synthesize: async () => ({
          audio: newAudioRaw,
          segments: [newSeg1, newSeg2],
          segmentTexts: ["New seg 1", "New seg 2"],
        }),
      };
      const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm], ["kimi", llm]]));
      const pipeline = new ChapterPipeline(router, mockTts);
      const input = join(root, "chapter.txt");
      await writeFile(input, "第一章\n\n测试内容", "utf8");

      // Inject failure when writing 0002.mp3 in canonical paths.segments
      let failSegment2 = true;
      const writeSpy = vi.spyOn(atomicWriteModule, "atomicWrite").mockImplementation(async (targetPath, data) => {
        if (failSegment2 && String(targetPath) === join(paths.segments, "0002.mp3")) {
          failSegment2 = false;
          throw new Error("Simulated disk error during segment 2 promotion");
        }
        return realAtomicWrite(targetPath, data);
      });

      try {
        await expect(pipeline.run({
          root,
          story,
          chapter: 1,
          inputPath: input,
          force: "tts",
          stopAfter: "tts",
        })).rejects.toThrow(/Simulated disk error during segment 2 promotion/);

        // Verify all old canonical artifacts remain byte-for-byte unchanged!
        expect(new Uint8Array(await readFile(paths.audioRaw))).toEqual(oldAudioRaw);
        expect(new Uint8Array(await readFile(join(paths.segments, "0001.mp3")))).toEqual(oldSegment1);
        expect(new Uint8Array(await readFile(join(paths.segments, "0002.mp3")))).toEqual(oldSegment2);
        expect(JSON.parse(await readFile(paths.ttsQuality, "utf8"))).toEqual(oldQuality);
        expect(JSON.parse(await readFile(paths.censorManifest, "utf8"))).toEqual(oldCensor);

        // Staging directory was cleaned up
        const chapterFiles = await readdir(paths.chapterDir);
        expect(chapterFiles.some((f) => f.startsWith(".tts-stage-"))).toBe(false);
      } finally {
        writeSpy.mockRestore();
      }
    });
  });

  // Test 23: Successful Full TTS Promotion
  describe("Test 23: Successful Full TTS Promotion", () => {
    it("stages and atomically commits the entire new TTS artifact set, removing orphans and staging area", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-successful-promotion-"));
      const story = testStory();
      const paths = storyPaths(root, story.slug, 1);

      // Pre-create orphan segment and old artifacts
      await atomicWrite(join(paths.segments, "0099.mp3"), new Uint8Array([0xee, 0xee]));
      await atomicWrite(paths.audioRaw, new Uint8Array([0x11, 0x11]));

      const llm = new MockLLM("gemini", ["English translation", "English narration"]);
      const newAudio = new Uint8Array([0x55, 0x66]);
      const newSeg1 = new Uint8Array([0x55]);
      const newSeg2 = new Uint8Array([0x66]);
      const mockTts: TTSProvider = {
        name: "fish",
        validateConfiguration: async () => {},
        synthesize: async () => ({
          audio: newAudio,
          segments: [newSeg1, newSeg2],
          segmentTexts: ["Part 1", "Part 2"],
          providerRequests: 2,
        }),
      };
      const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm], ["kimi", llm]]));
      const pipeline = new ChapterPipeline(router, mockTts);
      const input = join(root, "chapter.txt");
      await writeFile(input, "第一章\n\n测试内容", "utf8");

      await pipeline.run({
        root,
        story,
        chapter: 1,
        inputPath: input,
        stopAfter: "tts",
      });

      // Assertions:
      // - new audioRaw present
      expect(new Uint8Array(await readFile(paths.audioRaw))).toEqual(newAudio);
      // - only new canonical segments present, old orphan removed
      const segments = (await readdir(paths.segments)).sort();
      expect(segments).toEqual(["0001.mp3", "0002.mp3"]);
      expect(new Uint8Array(await readFile(join(paths.segments, "0001.mp3")))).toEqual(newSeg1);
      expect(new Uint8Array(await readFile(join(paths.segments, "0002.mp3")))).toEqual(newSeg2);
      // - quality artifact correct
      const quality = JSON.parse(await readFile(paths.ttsQuality, "utf8"));
      expect(quality.segments).toHaveLength(2);
      // - staging directory removed
      const chapterFiles = await readdir(paths.chapterDir);
      expect(chapterFiles.some((f) => f.startsWith(".tts-stage-"))).toBe(false);
      // - ttsWorking removed only after success
      expect(chapterFiles.includes("audio")).toBe(false);
    });
  });

  // Test 24: Failure Preserves ttsWorking
  describe("Test 24: Failure Preserves ttsWorking", () => {
    it("preserves ttsWorking resumable checkpoints if promotion fails so a retry does not pay Fish again", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-fail-preserves-working-"));
      const story = testStory();
      const paths = storyPaths(root, story.slug, 1);

      let fetchCount = 0;
      const fetcher = vi.fn(async () => {
        fetchCount++;
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x00]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg", "x-request-id": `req-${fetchCount}` },
        });
      });
      const fishProvider = new FishAudioProvider("test-key", fetcher as unknown as typeof fetch);

      const llm = new MockLLM("gemini", ["English translation", "English narration"]);
      const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm], ["kimi", llm]]));
      const pipeline = new ChapterPipeline(router, fishProvider);
      const input = join(root, "chapter.txt");
      await writeFile(input, "第一章\n\n测试内容", "utf8");

      // Inject promotion failure when writing paths.audioRaw
      let failPromotion = true;
      const writeSpy = vi.spyOn(atomicWriteModule, "atomicWrite").mockImplementation(async (targetPath, data) => {
        if (failPromotion && String(targetPath) === paths.audioRaw) {
          throw new Error("Promotion write error on audioRaw");
        }
        return realAtomicWrite(targetPath, data);
      });

      try {
        await expect(pipeline.run({
          root,
          story,
          chapter: 1,
          inputPath: input,
          stopAfter: "tts",
        })).rejects.toThrow("Promotion write error on audioRaw");

        // Verify ttsWorking exists and has checkpoint files
        const checkpointFiles = await readdir(paths.ttsWorking);
        expect(checkpointFiles).toContain("0001.json");
        expect(checkpointFiles).toContain("0001.mp3");

        const firstRunFetchCount = fetchCount;
        expect(firstRunFetchCount).toBeGreaterThan(0);

        // Now retry without injected failure
        failPromotion = false;
        fetcher.mockClear();

        await pipeline.run({
          root,
          story,
          chapter: 1,
          inputPath: input,
          stopAfter: "tts",
        });

        // The retry reused the checkpoint without calling Fish again!
        expect(fetcher).not.toHaveBeenCalled();
        expect(await fileFingerprint(paths.audioRaw)).toBeDefined();
      } finally {
        writeSpy.mockRestore();
      }
    });
  });

  // Test 25: Quality Rollback Flag Bug
  describe("Test 25: Quality Rollback Flag Bug", () => {
    it("rolls back quality artifact and audio if syncChapterQualitySummary fails after quality write", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-quality-rollback-bug-"));
      const story = testStory();
      const paths = storyPaths(root, story.slug, 1);

      const oldSegmentAudio = new Uint8Array([0x11, 0x22, 0x33]);
      const oldRawAudio = new Uint8Array([0xaa, 0xbb, 0xcc]);
      await atomicWrite(join(paths.segments, "0001.mp3"), oldSegmentAudio);
      await atomicWrite(paths.audioRaw, oldRawAudio);
      const censorManifest = { version: 1, items: [{ kind: "speech" as const, speechIndex: 0 }] };
      await atomicWriteJson(paths.censorManifest, censorManifest);

      const oldQualityReport: TtsQualityReport = {
        version: 1,
        status: "needs_review",
        retried: 0,
        segments: [{ index: 0, expectedText: "Initial speech", status: "needs_review", issues: [], attempts: [], finalAttempt: 0 }],
      };
      await persistChapterTtsQuality({ root, story, chapter: 1, report: oldQualityReport, maxRetries: 0, transcriber: "mock" });
      const oldQualityJson = await readFile(paths.ttsQuality, "utf8");

      const now = new Date().toISOString();
      const oldChapterMeta = chapterSchema.parse({
        chapter: 1,
        sourceLanguage: story.sourceLanguage,
        outputLanguage: story.outputLanguage,
        counts: { originalCharacters: 10, englishWords: 10, narrationWords: 10 },
        createdAt: now,
        updatedAt: now,
        stages: {
          ingestion: { status: "complete" },
          translation: { status: "complete" },
          narration: { status: "complete" },
          storyBible: { status: "complete" },
          tts: { status: "complete", outputFingerprint: await fileFingerprint(paths.audioRaw) },
          audioMastering: { status: "pending" },
          alignment: { status: "pending" },
          subtitles: { status: "pending" },
        },
      });
      await atomicWriteJson(paths.chapterMeta, oldChapterMeta);

      const mockProvider: TTSProvider = {
        name: "fish",
        validateConfiguration: async () => {},
        synthesize: async () => ({ audio: new Uint8Array([0x99]), segments: [new Uint8Array([0x99])] }),
      };

      const reassembleSpy = vi.spyOn(FfmpegCensorAudioService.prototype, "reassemble").mockImplementation(async (_dir, _man, outPath) => {
        await atomicWrite(outPath, new Uint8Array([0x99, 0x99]));
      });

      // Inject failure specifically when syncChapterQualitySummary writes to chapter.json
      const writeSpy = vi.spyOn(atomicWriteModule, "atomicWriteJson").mockImplementation(async (targetPath, value) => {
        if (String(targetPath).endsWith("chapter.json")) {
          throw new Error("Disk error syncing chapter quality summary");
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
        })).rejects.toThrow(/Failed to sync chapter quality summary after regenerating segment; rolled back audio file/);

        // Old quality JSON, segment audio, and raw audio must be restored!
        expect(await readFile(paths.ttsQuality, "utf8")).toBe(oldQualityJson);
        expect(new Uint8Array(await readFile(join(paths.segments, "0001.mp3")))).toEqual(oldSegmentAudio);
        expect(new Uint8Array(await readFile(paths.audioRaw))).toEqual(oldRawAudio);
        expect(JSON.parse(await readFile(paths.chapterMeta, "utf8"))).toEqual(oldChapterMeta);
      } finally {
        reassembleSpy.mockRestore();
        writeSpy.mockRestore();
      }
    });
  });

  // Test 26: Corrupt Checkpoint JSON
  describe("Test 26: Corrupt Checkpoint JSON", () => {
    it("regenerates only the corrupt checkpoint when JSON is malformed and reuses valid chunks", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-corrupt-meta-"));
      const checkpointDir = join(root, "tts-working");

      let fetchCount = 0;
      const requestedTexts: string[] = [];
      const fetcher = vi.fn(async (_url, init) => {
        fetchCount++;
        const body = JSON.parse(String(init?.body));
        requestedTexts.push(body.text);
        return new Response(new Uint8Array([fetchCount, fetchCount]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg", "x-request-id": `req-${fetchCount}` },
        });
      });

      const provider = new FishAudioProvider("test-key", fetcher as unknown as typeof fetch);
      const text = "First sentence to synthesize. Second sentence to synthesize. Third sentence to synthesize.";

      // Initial run: 3 chunks
      const req = ttsReq({ text, checkpointDir, maxCharsPerRequest: 35 });
      const initial = await provider.synthesize(req);
      expect(initial.segments).toHaveLength(3);
      expect(fetchCount).toBe(3);

      // Verify all 3 checkpoints exist
      expect(await readFile(join(checkpointDir, "0001.json"), "utf8")).toBeDefined();
      expect(await readFile(join(checkpointDir, "0002.json"), "utf8")).toBeDefined();
      expect(await readFile(join(checkpointDir, "0003.json"), "utf8")).toBeDefined();

      // Corrupt chunk 2 checkpoint
      await writeFile(join(checkpointDir, "0002.json"), "CORRUPT_MALFORMED_JSON{{{", "utf8");

      fetchCount = 0;
      requestedTexts.length = 0;
      fetcher.mockClear();

      const secondRun = await provider.synthesize(req);

      // Chunks 1 and 3 reused; only chunk 2 regenerated!
      expect(secondRun.segments).toHaveLength(3);
      expect(secondRun.reusedChunks).toBe(2);
      expect(secondRun.providerRequests).toBe(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(requestedTexts).toEqual([initial.segmentTexts![1]]);

      // Corrupt checkpoint was replaced with valid JSON!
      const repairedMeta = JSON.parse(await readFile(join(checkpointDir, "0002.json"), "utf8"));
      expect(repairedMeta.chunk).toBe(2);
      expect(repairedMeta.totalChunks).toBe(3);
    });
  });

  // Test 27: Invalid Checkpoint Schema
  describe("Test 27: Invalid Checkpoint Schema", () => {
    it("treats syntactically valid JSON with invalid schema as corrupt and regenerates safely", async () => {
      const root = await mkdtemp(join(tmpdir(), "tts-invalid-schema-"));
      const checkpointDir = join(root, "tts-working");

      const fetcher = vi.fn(async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg", "x-request-id": "req-1" },
        })
      );
      const provider = new FishAudioProvider("test-key", fetcher as unknown as typeof fetch);

      const req = ttsReq({ text: "Valid sentence.", checkpointDir });
      await provider.synthesize(req);
      expect(fetcher).toHaveBeenCalledTimes(1);

      // Write invalid schema JSON into checkpoint
      await writeFile(join(checkpointDir, "0001.json"), JSON.stringify({ version: 1, chunk: -5 }), "utf8");

      fetcher.mockClear();
      const rerun = await provider.synthesize(req);

      // Did not trust the invalid checkpoint; regenerated without fatal error
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(rerun.providerRequests).toBe(1);
      const fixedMeta = JSON.parse(await readFile(join(checkpointDir, "0001.json"), "utf8"));
      expect(fixedMeta.chunk).toBe(1);
    });
  });

  // Test 28: Sanitized HTTP Error
  describe("Test 28: Sanitized HTTP Error", () => {
    it("does not expose provider body or narration text in user-facing Fish errors", async () => {
      const secretNarration = "SECRET NARRATION TEXT DO NOT LEAK";
      const fetcher = vi.fn(async () =>
        new Response(`Internal error while processing narration: ${secretNarration}`, {
          status: 500,
          headers: { "Content-Type": "text/plain", "x-request-id": "req-secret-fail" },
        })
      );
      const provider = new FishAudioProvider("test-key", fetcher as unknown as typeof fetch, 120_000, undefined, { retryDelayMs: 0 });

      let thrownError: any;
      try {
        await provider.synthesize(ttsReq({
          text: secretNarration,
          model: "s2.1-pro",
        }));
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeDefined();
      expect(thrownError).toBeInstanceOf(ProviderError);

      // User-facing message:
      // - includes HTTP 500
      expect(thrownError.message).toMatch(/HTTP 500/);
      // - includes chunk index
      expect(thrownError.message).toMatch(/chunk 1 of 1/);
      // - includes model
      expect(thrownError.message).toMatch(/s2\.1-pro/);
      // - does NOT contain provider body
      expect(thrownError.message).not.toMatch(/Internal error while processing narration/);
      // - does NOT contain secret narration text
      expect(thrownError.message).not.toMatch(/SECRET NARRATION TEXT/);

      // Structured cause / diagnostics contains status and sanitized provider detail
      expect(thrownError.cause.status).toBe(500);
      expect(thrownError.cause.requestId).toBe("req-secret-fail");
      expect(thrownError.cause.providerDetail).toBe(`Internal error while processing narration: ${secretNarration}`);
    });
  });

  // Test 29: Retry-After
  describe("Test 29: Retry-After", () => {
    it("follows Retry-After header delay on 429 and falls back to exponential backoff when malformed", async () => {
      const slept: number[] = [];
      const fakeSleep = async (ms: number) => { slept.push(ms); };

      let attempt = 0;
      const fetcher = vi.fn(async () => {
        attempt++;
        if (attempt === 1) {
          return new Response("Too Many Requests", {
            status: 429,
            headers: { "Retry-After": "2", "x-request-id": "req-429" },
          });
        }
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg", "x-request-id": "req-ok" },
        });
      });

      const provider = new FishAudioProvider("test-key", fetcher as unknown as typeof fetch, 120_000, undefined, {
        sleep: fakeSleep,
      });

      const res = await provider.synthesize(ttsReq({ text: "Testing retry-after header." }));
      expect(res.segments).toHaveLength(1);
      expect(attempt).toBe(2);
      expect(slept).toEqual([2000]); // 2 seconds from Retry-After

      // Now test malformed Retry-After falls back to exponential backoff
      slept.length = 0;
      attempt = 0;
      const fetcherMalformed = vi.fn(async () => {
        attempt++;
        if (attempt === 1) {
          return new Response("Too Many Requests", {
            status: 429,
            headers: { "Retry-After": "invalid-non-numeric-header", "x-request-id": "req-429-malformed" },
          });
        }
        return new Response(new Uint8Array([4, 5, 6]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      });

      const providerMalformed = new FishAudioProvider("test-key", fetcherMalformed as unknown as typeof fetch, 120_000, undefined, {
        sleep: fakeSleep,
      });

      const resMalformed = await providerMalformed.synthesize(ttsReq({ text: "Testing malformed retry-after." }));
      expect(resMalformed.segments).toHaveLength(1);
      expect(attempt).toBe(2);
      expect(slept).toEqual([1000]); // Default attempt 1 exponential delay: 1000 * (2^0) = 1000
    });
  });
});

