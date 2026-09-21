import { Story } from "../src/domain/story.js";
import { LLMProvider } from "../src/llm/provider.js";
import { LLMRequest, StructuredLLMRequest } from "../src/llm/types.js";
import { storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { qaResultSchema } from "../src/domain/qa.js";
import { TTSProvider } from "../src/tts/provider.js";
import { TTSRequest } from "../src/tts/types.js";
import { defaultProductionProfiles } from "../src/production/types.js";
import { ImageUpscaler, ImageUpscaleRequest } from "../src/artwork/upscaler.js";
import { ConfigurationError } from "../src/pipeline/errors.js";
import { atomicWrite } from "../src/storage/atomic-write.js";

export class MockLLM implements LLMProvider {
  readonly name: "openai" | "gemini" | "kimi";
  calls: Array<LLMRequest & { structured?: boolean }> = [];
  constructor(
    name: "openai" | "gemini" | "kimi" = "gemini",
    private readonly responses = ["Faithful English translation", "Polished English narration"],
    private readonly qaResponse: unknown = { status: "pass", score: 1, issues: [], checks: {
      completeness: "pass", names: "pass", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass",
    } },
  ) { this.name = name; }
  async validateConfiguration() {}
  async generateText(request: LLMRequest) { this.calls.push(request); return { text: this.responses.shift() ?? "Generated text", usage: { inputTokens: 10, outputTokens: 5 } }; }
  async generateStructured<T>(request: StructuredLLMRequest<T>) {
    this.calls.push({ ...request, structured: true });
    if (request.schemaName === "chapter_qa") {
      const value = qaResultSchema.parse(this.qaResponse);
      return { value: request.schema.parse(value), usage: { inputTokens: 10, outputTokens: 5 } };
    }
    const value = storyBibleUpdateSchema.parse({ chapterSummary: "A star lamp awakens." });
    return { value: request.schema.parse(value) };
  }
}

export class MockTTS implements TTSProvider {
  readonly name = "fish" as const; calls = 0; requests: TTSRequest[] = [];
  async validateConfiguration() {}
  async synthesize(request: TTSRequest) { this.calls++; this.requests.push(request); const audio = new Uint8Array([0x49, 0x44, 0x33]); return { audio, segments: [audio] }; }
}

export const testStory = (overrides: Partial<Story["pipeline"]> = {}): Story => ({
  id: "demo-story", slug: "demo-story", title: "Demo Story", description: "", tags: [], notes: "", defaultProductionProfile: "audiobook", sourceLanguage: "zh-CN", outputLanguage: "en-US", source: { type: "text" }, sources: [],
  context: { recentChapterSummaries: 5 }, narrationSettings: { profanityMode: "preserve", bleepStrongProfanity: false, speechNormalization: "automatic", timeSpeechMode: "natural_12h", speechAbbreviations: {}, speechVocalizations: { mode: "automatic", fallback: "safe_normalize" } }, qaMode: "production", audio: { loudnessTarget: -17, truePeak: -1.5, segmentGapSeconds: 0.35, chapterGapSeconds: 1.5, format: "mp3", bitrate: "128k", sampleRate: 44100 }, pipeline: {
    translation: { provider: "gemini", model: "translation-model" },
    narration: { provider: "openai", model: "narration-model" },
    qa: { provider: "openai", model: "qa-model" },
    storyBible: { provider: "gemini", model: "bible-model" },
    scenePlanner: { provider: "openai", model: "scene-model" },
    tts: { provider: "fish", model: "s2-pro", voiceMode: "same-voice-dialogue", deliveryIntensity: "restrained", qualityGuard: true, providerQualityGuard: true, maxQualityRetries: 2, speed: 1, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 4000 },
    ...overrides,
  }, subtitles: { maxCharactersPerLine: 42, maxLines: 2, minimumDurationSeconds: 1.2, maximumDurationSeconds: 6 }, video: { width: 1920, height: 1080, fps: 30, codec: "libx264", quality: 20, subtitleMode: "burn", subtitleStyle: "default", backgroundMode: "cover", introDurationSeconds: 3 }, scenes: { targetDurationSeconds: 20, minimumDurationSeconds: 10, maximumDurationSeconds: 30, maximumScenesPerChapter: 50 }, artwork: { provider: "openai", model: "gpt-image-1", stylePrompt: "cinematic illustrated fiction", aspectRatio: "16:9", quality: "medium", size: "1536x1024", outputFormat: "png", outputResolution: "native", upscaling: "automatic", upscaler: "local-realesrgan" }, productionProfiles: defaultProductionProfiles,
  pipelineOverrides: {},
});

export function pngWithDims(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  const iend = Buffer.alloc(12);
  iend.write("IEND", 4, "ascii");
  return Buffer.concat([signature, ihdr, iend]);
}

export class FakeUpscaler implements ImageUpscaler {
  readonly name = "local-realesrgan";
  readonly version = "fake-upscaler-v1";
  upscaleCalls: ImageUpscaleRequest[] = [];
  normalizeCalls: ImageUpscaleRequest[] = [];
  constructor(readonly model = "realesrgan-x4plus", private behavior: "ok" | "unavailable" | "fail" = "ok") {}
  async validateConfiguration() {
    if (this.behavior === "unavailable") throw new ConfigurationError("Upscaler executable 'realesrgan-ncnn-vulkan' is unavailable. Install Real-ESRGAN or set UPSCALER_EXECUTABLE.");
  }
  private async derive(request: ImageUpscaleRequest, scaleFactor?: number) {
    await this.validateConfiguration();
    if (this.behavior === "fail") throw new Error("upscaler engine exploded");
    await atomicWrite(request.outputPath, pngWithDims(request.targetWidth, request.targetHeight));
    return {
      outputPath: request.outputPath,
      sourceDimensions: { width: request.sourceWidth, height: request.sourceHeight },
      finalDimensions: { width: request.targetWidth, height: request.targetHeight },
      engine: this.name,
      model: this.model,
      scaleFactor,
      fit: "exact" as const,
    };
  }
  async upscale(request: ImageUpscaleRequest) { this.upscaleCalls.push(request); return this.derive(request, 4); }
  async normalize(request: ImageUpscaleRequest) { this.normalizeCalls.push(request); return this.derive(request); }
}

