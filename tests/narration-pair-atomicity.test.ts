import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { loadEnvironment } from "../src/config/env.js";
import { ChapterPipeline } from "../src/pipeline/chapter-pipeline.js";
import { LLMRouter } from "../src/llm/router.js";
import { TTSProviderRouter } from "../src/tts/router.js";
import { createBlankStory } from "../src/studio/projects.js";
import { storyPaths } from "../src/storage/paths.js";
import { atomicWrite } from "../src/storage/atomic-write.js";
import { readTextIfExists } from "../src/storage/story-files.js";
import { MockLLM, MockTTS } from "./helpers.js";

let mockAtomicWriteHook: ((path: string, data: string | Uint8Array) => Promise<void> | void) | undefined;

vi.mock("../src/storage/atomic-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/storage/atomic-write.js")>();
  return {
    ...actual,
    atomicWrite: async (path: string, data: string | Uint8Array) => {
      if (mockAtomicWriteHook) {
        await mockAtomicWriteHook(path, data);
      }
      return actual.atomicWrite(path, data);
    },
  };
});

describe("Narration pair atomicity", () => {
  beforeEach(() => {
    mockAtomicWriteHook = undefined;
  });

  it("A. Normal success: writes clean narration to paths.narration and delivery cues to paths.narrationTts", async () => {
    const root = await mkdtemp(join(tmpdir(), "narration-atomicity-a-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "Test Story", slug: "test-story" });
    const paths = storyPaths(root, story.slug, 1);

    await atomicWrite(paths.original, "第一章 初始内容");

    const deliveryNarration = '[whisper] "Be quiet," he whispered. They crept forward.';
    const llm = new MockLLM("gemini", [
      "Initial English translation", // translation
      deliveryNarration,             // narration with cues
    ]);
    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", new MockTTS()]])));

    const result = await pipeline.run({
      root,
      story,
      chapter: 1,
      inputPath: paths.original,
      stopAfter: "narration",
    });

    expect(result.stages.narration.status).toBe("complete");

    // Clean narration without cues
    const cleanNarration = await readFile(paths.narration, "utf8");
    expect(cleanNarration).toBe('"Be quiet," he whispered. They crept forward.');

    // Full delivery script with cues
    const ttsScript = await readFile(paths.narrationTts, "utf8");
    expect(ttsScript).toBe(deliveryNarration);
  });

  it("B. narration write fails: old narration and old narrationTts remain unchanged, no partial new pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "narration-atomicity-b-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "Test Story", slug: "test-story" });
    const paths = storyPaths(root, story.slug, 1);

    await atomicWrite(paths.original, "第一章 初始内容");
    await atomicWrite(paths.english, "Initial English translation");
    await atomicWrite(paths.narration, "Old narration v1");
    await atomicWrite(paths.narrationTts, "Old narration TTS v1");

    const llm = new MockLLM("gemini", [
      "New narration text to write",
    ]);
    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", new MockTTS()]])));

    mockAtomicWriteHook = async (path, data) => {
      if (path === paths.narration && data === "New narration text to write") {
        throw new Error("Disk full: cannot write narration");
      }
    };

    await expect(
      pipeline.run({
        root,
        story,
        chapter: 1,
        inputPath: paths.original,
        executionStages: ["narration"],
        force: "narration",
        stopAfter: "narration",
      })
    ).rejects.toThrow("Disk full: cannot write narration");

    expect(await readFile(paths.narration, "utf8")).toBe("Old narration v1");
    expect(await readFile(paths.narrationTts, "utf8")).toBe("Old narration TTS v1");
  });

  it("C. narrationTts write fails: restores old narration and old narrationTts", async () => {
    const root = await mkdtemp(join(tmpdir(), "narration-atomicity-c-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "Test Story", slug: "test-story" });
    const paths = storyPaths(root, story.slug, 1);

    await atomicWrite(paths.original, "第一章 初始内容");
    await atomicWrite(paths.english, "Initial English translation");
    await atomicWrite(paths.narration, "Old narration v1");
    await atomicWrite(paths.narrationTts, "Old narration TTS v1");

    const llm = new MockLLM("gemini", [
      "New clean narration text",
    ]);
    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", new MockTTS()]])));

    let newNarrationWritten = false;
    mockAtomicWriteHook = async (path, data) => {
      if (path === paths.narration && data === "New clean narration text") {
        newNarrationWritten = true;
      }
      if (path === paths.narrationTts && newNarrationWritten && data === "New clean narration text") {
        throw new Error("IO error while writing narrationTts");
      }
    };

    await expect(
      pipeline.run({
        root,
        story,
        chapter: 1,
        inputPath: paths.original,
        executionStages: ["narration"],
        force: "narration",
        stopAfter: "narration",
      })
    ).rejects.toThrow("IO error while writing narrationTts");

    // Verify rollback: old narration restored, old narrationTts restored
    expect(await readFile(paths.narration, "utf8")).toBe("Old narration v1");
    expect(await readFile(paths.narrationTts, "utf8")).toBe("Old narration TTS v1");
  });

  it("D. Previously missing narrationTts: restores old narration and leaves narrationTts absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "narration-atomicity-d-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "Test Story", slug: "test-story" });
    const paths = storyPaths(root, story.slug, 1);

    await atomicWrite(paths.original, "第一章 初始内容");
    await atomicWrite(paths.english, "Initial English translation");
    await atomicWrite(paths.narration, "Old narration without TTS file");
    // Ensure narrationTts does NOT exist
    await rm(paths.narrationTts, { force: true });

    const llm = new MockLLM("gemini", [
      "New clean narration text",
    ]);
    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", new MockTTS()]])));

    let newNarrationWritten = false;
    mockAtomicWriteHook = async (path, data) => {
      if (path === paths.narration && data === "New clean narration text") {
        newNarrationWritten = true;
      }
      if (path === paths.narrationTts && newNarrationWritten && data === "New clean narration text") {
        throw new Error("IO error on narrationTts write");
      }
    };

    await expect(
      pipeline.run({
        root,
        story,
        chapter: 1,
        inputPath: paths.original,
        executionStages: ["narration"],
        force: "narration",
        stopAfter: "narration",
      })
    ).rejects.toThrow("IO error on narrationTts write");

    // Verify rollback: old narration restored, narrationTts remains absent
    expect(await readFile(paths.narration, "utf8")).toBe("Old narration without TTS file");
    expect(await readTextIfExists(paths.narrationTts)).toBeUndefined();
  });

  it("E. Rollback restoration failure: surfaces AggregateError and attempts both restorations", async () => {
    const root = await mkdtemp(join(tmpdir(), "narration-atomicity-e-"));
    const env = loadEnvironment({});
    const story = await createBlankStory(root, env, { title: "Test Story", slug: "test-story" });
    const paths = storyPaths(root, story.slug, 1);

    await atomicWrite(paths.original, "第一章 初始内容");
    await atomicWrite(paths.english, "Initial English translation");
    await atomicWrite(paths.narration, "Old narration v1");
    await atomicWrite(paths.narrationTts, "Old narration TTS v1");

    const llm = new MockLLM("gemini", [
      "New clean narration text",
    ]);
    const router = new LLMRouter(new Map([["gemini", llm], ["openai", llm]]));
    const pipeline = new ChapterPipeline(router, new TTSProviderRouter(new Map([["fish", new MockTTS()]])));

    let initialPairWriteStarted = false;
    mockAtomicWriteHook = async (path, data) => {
      if (path === paths.narration && data === "New clean narration text") {
        initialPairWriteStarted = true;
        return;
      }
      if (path === paths.narrationTts && data === "New clean narration text" && initialPairWriteStarted) {
        throw new Error("Pair write failed at narrationTts");
      }
      // During rollback: fail restoring paths.narration
      if (path === paths.narration && data === "Old narration v1") {
        throw new Error("Rollback failed to restore old narration");
      }
    };

    let thrown: unknown;
    try {
      await pipeline.run({
        root,
        story,
        chapter: 1,
        inputPath: paths.original,
        executionStages: ["narration"],
        force: "narration",
        stopAfter: "narration",
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const cause = (thrown as Error).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    const agg = cause as AggregateError;
    expect(agg.message).toContain("Narration pair write failed and rollback was incomplete");
    expect(agg.errors[0]?.message).toBe("Pair write failed at narrationTts");
    expect(agg.errors[1]?.message).toBe("Rollback failed to restore old narration");

    // The other restoration (narrationTts) must still have succeeded!
    expect(await readFile(paths.narrationTts, "utf8")).toBe("Old narration TTS v1");
  });
});
