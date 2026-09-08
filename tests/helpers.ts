import { Story } from "../src/domain/story.js";
import { LLMProvider } from "../src/llm/provider.js";
import { LLMRequest, StructuredLLMRequest } from "../src/llm/types.js";
import { storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { TTSProvider } from "../src/tts/provider.js";

export class MockLLM implements LLMProvider {
  readonly name: "openai" | "gemini";
  calls: Array<LLMRequest & { structured?: boolean }> = [];
  constructor(name: "openai" | "gemini" = "gemini", private readonly responses = ["Faithful English translation", "Polished English narration"]) { this.name = name; }
  async validateConfiguration() {}
  async generateText(request: LLMRequest) { this.calls.push(request); return { text: this.responses.shift() ?? "Generated text", usage: { inputTokens: 10, outputTokens: 5 } }; }
  async generateStructured<T>(request: StructuredLLMRequest<T>) {
    this.calls.push({ ...request, structured: true });
    const value = storyBibleUpdateSchema.parse({ chapterSummary: "A star lamp awakens." });
    return { value: request.schema.parse(value) };
  }
}

export class MockTTS implements TTSProvider {
  readonly name = "fish" as const; calls = 0;
  async validateConfiguration() {}
  async synthesize() { this.calls++; const audio = new Uint8Array([0x49, 0x44, 0x33]); return { audio, segments: [audio] }; }
}

export const testStory = (overrides: Partial<Story["pipeline"]> = {}): Story => ({
  id: "demo-story", slug: "demo-story", title: "Demo Story", sourceLanguage: "zh-CN", outputLanguage: "en-US", source: { type: "text" },
  pipeline: {
    translation: { provider: "gemini", model: "translation-model" },
    narration: { provider: "openai", model: "narration-model" },
    storyBible: { provider: "gemini", model: "bible-model" },
    tts: { provider: "fish", model: "s2-pro", speed: 1, format: "mp3", sampleRate: 44100, bitrate: 128, normalize: true, maxCharsPerRequest: 4000 },
    ...overrides,
  },
});
