import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ChapterPipeline, type PipelineStageEvent } from "../src/pipeline/chapter-pipeline.js";
import { LLMRouter } from "../src/llm/router.js";
import { FishAudioProvider } from "../src/tts/fish/fish-audio.provider.js";
import { storyPaths } from "../src/storage/paths.js";
import { loadChapterTtsQuality, verifyStoredChapterTts } from "../src/tts/chapter-quality.js";
import { MockLLM, testStory } from "./helpers.js";

describe("default chapter Fish synthesis", () => {
  it("emits ordered chunk progress and records one Fish request per generated chunk", async () => {
    const root = await mkdtemp(join(tmpdir(), "tts-simple-production-"));
    const input = join(root, "chapter.txt");
    await writeFile(input, "第一章\n\n主角进入房间。", "utf8");
    const narration = Array.from({ length: 15 }, (_, index) => `Paragraph ${index + 1}. ${"The hero walked through the quiet corridor. ".repeat(6)}`).join("\n\n");
    const english = narration;
    const llms = new LLMRouter(new Map([
      ["gemini", new MockLLM("gemini", [english])],
      ["openai", new MockLLM("openai", [narration])],
    ]));
    const fetcher = vi.fn(async () => new Response(new Uint8Array([0x49, 0x44, 0x33]), { headers: { "content-type": "audio/mpeg", "x-request-id": "mock-fish" } }));
    const pipeline = new ChapterPipeline(llms, new FishAudioProvider("test-key", fetcher as typeof fetch));
    const story = testStory({ tts: { ...testStory().pipeline.tts, model: "s2.1-pro", qualityMode: "off", qualityGuard: false, maxCharsPerRequest: 1750 } });
    const events: PipelineStageEvent[] = [];
    const chapter = await pipeline.run({ root, story, chapter: 1, inputPath: input, stopAfter: "tts", onStageEvent: (event) => events.push(event) });
    const chunks = await readdir(storyPaths(root, story.slug, 1).segments);
    expect(chunks.length).toBeGreaterThan(1);
    expect(fetcher).toHaveBeenCalledTimes(chunks.length);
    expect(chapter.stages.tts.usage).toMatchObject({ requests: chunks.length, chunks: chunks.length });
    expect(chapter.stages.tts.usage?.quality).toBeUndefined();
    expect(events.filter((event) => event.stage === "tts" && event.status === "progress").map((event) => `${event.currentChunk}/${event.totalChunks}:${event.detail?.includes("completed") ? "completed" : "started"}`))
      .toEqual(chunks.flatMap((_, index) => [`${index + 1}/${chunks.length}:started`, `${index + 1}/${chunks.length}:completed`]));
    expect(events.find((event) => event.stage === "tts" && event.status === "completed")?.detail).toContain("Automatic retries: off");
    const quality = await loadChapterTtsQuality(root, story.slug, 1);
    expect(quality?.status).toBe("unverified");
    expect(quality?.segments).toHaveLength(chunks.length);
    expect(quality?.segments.every((segment) => segment.expectedText.length > 0 && segment.status === "unverified")).toBe(true);
    const checked = await verifyStoredChapterTts({ root, story, chapter: 1, transcriber: {
      name: "mock-transcriber",
      async validateConfiguration() {},
      async transcribe() { return [{ text: "unrelated speech", start: 0, end: 1 }]; },
    } });
    expect(checked.status).toBe("needs_review");
    expect(fetcher).toHaveBeenCalledTimes(chunks.length);
  });
});
