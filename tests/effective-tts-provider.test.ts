import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AlignmentObservation } from "../src/alignment/types.js";
import { loadEnvironment } from "../src/config/env.js";
import { canonicalEntitySchema } from "../src/domain/story-bible.js";
import { TrackedTTSProvider, withUsageScope } from "../src/cost/context.js";
import { ProviderUsageRecord, UsageSink } from "../src/cost/types.js";
import { atomicWrite } from "../src/storage/atomic-write.js";
import { storyPaths, voicePreviewPaths } from "../src/storage/paths.js";
import { createEffectiveTtsProvider } from "../src/tts/effective-provider.js";
import { QualityGuardTTSProvider, SpeechTranscriber } from "../src/tts/quality-guard.js";
import { TTSProvider } from "../src/tts/provider.js";
import { TTSRequest, TTSResult } from "../src/tts/types.js";
import { StudioOperations } from "../apps/server/operations.js";
import { JobManager } from "../apps/server/job-manager.js";
import { createBlankStory } from "../src/studio/projects.js";
import { SummaryMediaService } from "../src/summaries/media.js";
import { SummaryService } from "../src/summaries/service.js";
import { LLMRouter } from "../src/llm/router.js";
import { TTSProviderRouter } from "../src/tts/router.js";
import { MockLLM } from "./helpers.js";

const bytes = (marker: string, length = 8) => new Uint8Array([...Buffer.from(marker.padEnd(length, marker))]);

class ScriptedTTS implements TTSProvider {
  readonly name = "fish";
  calls: TTSRequest[] = [];
  constructor(private readonly handler: (request: TTSRequest, call: number) => TTSResult) {}
  async validateConfiguration() {}
  async synthesize(request: TTSRequest): Promise<TTSResult> {
    this.calls.push({ ...request });
    return this.handler(request, this.calls.length);
  }
}

class FakeTranscriber implements SpeechTranscriber {
  readonly name = "fake-transcriber";
  calls = 0;
  available = true;
  constructor(private readonly resolve: (audio: Uint8Array) => AlignmentObservation[]) {}
  async validateConfiguration() {
    if (!this.available) throw new Error("whisper-cli unavailable");
  }
  async transcribe(request: { audioPath: string; language: string }) {
    this.calls++;
    return this.resolve(new Uint8Array(await readFile(request.audioPath)));
  }
}

const say = (text: string): AlignmentObservation[] =>
  text.split(/\s+/).filter(Boolean).map((word, index) => ({
    text: word,
    start: index * 0.5,
    end: index * 0.5 + 0.4,
    confidence: 0.95,
  }));

const singleSegment = (text: string, marker: string): TTSResult => {
  const audio = bytes(marker);
  return { audio, segments: [audio], segmentTexts: [text], providerRequests: 1 };
};

describe("effective TTS provider construction", () => {
  it("wraps baseProvider with pronunciation and QualityGuard in the correct order", async () => {
    const text = "Mara walked through the gate.";
    let synthesizeCount = 0;
    const base = new ScriptedTTS(() => {
      synthesizeCount++;
      return singleSegment(text, "a");
    });
    const entity = canonicalEntitySchema.parse({
      id: "ent_0123456789abcdef01234567",
      type: "character",
      canonicalName: "Mara",
      originalName: "玛拉",
      pronunciation: {
        mode: "custom",
        customPronunciation: "MAH-rah",
        source: "manual",
      },
      firstAppearance: 1,
      lastKnownAppearance: 1,
    });
    const transcriber = new FakeTranscriber(() => say(text));
    const effective = createEffectiveTtsProvider({
      baseProvider: base,
      pronunciationEntities: [entity],
      qualityGuardEnabled: true,
      maxQualityRetries: 2,
      language: "en-US",
      transcriber,
    });

    expect(effective.provider).toBeInstanceOf(QualityGuardTTSProvider);
    expect(effective.basePronunciationProvider).not.toBeInstanceOf(QualityGuardTTSProvider);
    expect(effective.baseProvider).toBe(base);

    const result = await effective.provider.synthesize({
      text,
      model: "s2-pro",
      speed: 1,
      format: "mp3",
      sampleRate: 44100,
      bitrate: 128,
      normalize: true,
      maxCharsPerRequest: 1750,
      qualityGuard: true,
    });

    expect(synthesizeCount).toBe(1);
    expect(result.quality?.status).toBe("verified");
    expect(base.calls[0]?.pronunciation?.[0]?.entityId).toBe(entity.id);
  });

  it("returns basePronunciationProvider directly when qualityGuard is disabled", () => {
    const base = new ScriptedTTS(() => singleSegment("Hello", "a"));
    const effective = createEffectiveTtsProvider({
      baseProvider: base,
      qualityGuardEnabled: false,
    });

    expect(effective.provider).toBe(effective.basePronunciationProvider);
    expect(effective.provider).not.toBeInstanceOf(QualityGuardTTSProvider);
  });

  it("tracks retries through the inner provider and preserves usage scope", async () => {
    const text = "First sentence needs retry.";
    let callCount = 0;
    const base = new ScriptedTTS(() => {
      callCount++;
      return singleSegment(text, callCount === 1 ? "bad" : "good");
    });

    const records: ProviderUsageRecord[] = [];
    const usageSink: UsageSink = {
      record: async (r: ProviderUsageRecord) => {
        records.push(r);
      },
    };
    const trackedBase = new TrackedTTSProvider(base, usageSink);

    const transcriber = new FakeTranscriber((audio) => {
      const marker = Buffer.from(audio.slice(0, 3)).toString();
      return marker === "bad" ? say("completely different words") : say(text);
    });

    const effective = createEffectiveTtsProvider({
      baseProvider: trackedBase,
      qualityGuardEnabled: true,
      maxQualityRetries: 2,
      language: "en-US",
      transcriber,
    });

    const result = await withUsageScope({ story: "test-story", stage: "voicePreview" }, async () => {
      return effective.provider.synthesize({
        text,
        model: "s2-pro",
        speed: 1,
        format: "mp3",
        sampleRate: 44100,
        bitrate: 128,
        normalize: true,
        maxCharsPerRequest: 1750,
        qualityGuard: true,
      });
    });

    expect(callCount).toBe(2);
    expect(result.quality?.status).toBe("verified");
    expect(result.quality?.retried).toBe(1);
    expect(records.length).toBe(2);
    expect(records.every((r) => r.stage === "voicePreview")).toBe(true);
  });
});

describe("voice preview with quality guard", () => {
  it("runs QualityGuardTTSProvider on voice preview and includes quality in the saved manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "voice-preview-quality-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "Voice Story", slug: "voice-story" });
    const text = "Voice test preview sample.";

    let callCount = 0;
    const tts = new ScriptedTTS(() => {
      callCount++;
      return singleSegment(text, callCount === 1 ? "bad" : "good");
    });

    const transcriber = new FakeTranscriber((audio) => {
      const marker = Buffer.from(audio.slice(0, 3)).toString();
      return marker === "bad" ? say("unrelated words") : say(text);
    });

    const jobs = new JobManager();
    const censor = {
      version: "test-censor",
      synthesize: async (p: TTSProvider, req: TTSRequest) => p.synthesize(req),
    };

    const operations = new StudioOperations(root, env, jobs, {
      tts,
      censor,
      speechTranscriber: transcriber,
    });

    const job = operations.startVoicePreview(story.slug, { text });
    await vi.waitFor(() => expect(jobs.get(job.id)?.status).toBe("completed"));

    const result = jobs.get(job.id)?.result as { id: string; audioUrl: string; bytes: number; quality?: unknown };
    expect(result).toBeDefined();
    expect(result.quality).toMatchObject({
      status: "verified",
      retried: 1,
    });

    // Check on-disk manifest
    const paths = voicePreviewPaths(root, story.slug, result.id);
    const rawManifest = JSON.parse(await readFile(paths.manifest, "utf8"));
    expect(rawManifest.quality).toMatchObject({
      status: "verified",
      retried: 1,
    });

    await operations.close();
  });
});

describe("summary media audio with quality guard", () => {
  it("preserves unverified status when transcriber is unavailable and does not set reviewRequired", async () => {
    const root = await mkdtemp(join(tmpdir(), "summary-quality-unverified-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "Summary Story", slug: "summary-story" });
    await atomicWrite(storyPaths(root, story.slug, 1).english, "Chapter 1 english content.");

    const text = "Summary recap text.";
    const tts = new ScriptedTTS(() => singleSegment(text, "sample"));
    const transcriber = new FakeTranscriber(() => say(text));
    transcriber.available = false; // unavailable transcriber

    const censor = {
      version: "test-censor",
      synthesize: async (p: TTSProvider, req: TTSRequest) => p.synthesize(req),
    };
    const mastering = {
      version: "test-mastering",
      master: async (_inputs: string[], output: string) => {
        await atomicWrite(output, "mastered-audio");
        return { durationSeconds: 2 };
      },
    };

    const llm = new MockLLM("openai", ["Recap summary content"]);
    const llms = new LLMRouter(new Map([["openai", llm], ["gemini", llm]]));
    const ttsRouter = new TTSProviderRouter(new Map([["fish", tts]]));
    const service = new SummaryService(root, llms);
    const media = new SummaryMediaService(root, llms, ttsRouter, censor as any, mastering as any, transcriber);

    const summary = await service.generate(story.slug, {
      title: "Recap",
      summaryType: "brief",
      sourceMode: "translated",
      targetWords: 100,
      chapters: [1],
    });

    // Seed narration so audio can run
    await media.editNarration(story.slug, summary.id, { text });

    const updated = await media.audio(story.slug, summary.id);
    expect(updated.tts?.status).toBe("current");
    expect(updated.tts?.reviewRequired).toBe(false);
    expect(updated.tts?.quality?.status).toBe("unverified");
  });

  it("sets reviewRequired = true when quality ends in needs_review without blocking saving usable audio", async () => {
    const root = await mkdtemp(join(tmpdir(), "summary-quality-review-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "Summary Story", slug: "summary-story" });
    await atomicWrite(storyPaths(root, story.slug, 1).english, "Chapter 1 english content.");

    const text = "Summary recap text that fails verification repeatedly.";
    const tts = new ScriptedTTS(() => singleSegment(text, "flawed"));
    const transcriber = new FakeTranscriber(() => say("completely different words each time"));

    const censor = {
      version: "test-censor",
      synthesize: async (p: TTSProvider, req: TTSRequest) => p.synthesize(req),
    };
    const mastering = {
      version: "test-mastering",
      master: async (_inputs: string[], output: string) => {
        await atomicWrite(output, "mastered-audio");
        return { durationSeconds: 2 };
      },
    };

    const llm = new MockLLM("openai", ["Recap summary content"]);
    const llms = new LLMRouter(new Map([["openai", llm], ["gemini", llm]]));
    const ttsRouter = new TTSProviderRouter(new Map([["fish", tts]]));
    const service = new SummaryService(root, llms);
    const media = new SummaryMediaService(root, llms, ttsRouter, censor as any, mastering as any, transcriber);

    const summary = await service.generate(story.slug, {
      title: "Recap",
      summaryType: "brief",
      sourceMode: "translated",
      targetWords: 100,
      chapters: [1],
    });

    await media.editNarration(story.slug, summary.id, { text });

    const updated = await media.audio(story.slug, summary.id);
    expect(updated.tts?.status).toBe("current");
    expect(updated.tts?.reviewRequired).toBe(true);
    expect(updated.tts?.quality?.status).toBe("needs_review");
    expect(updated.audio?.status).toBe("current");
  });
});
