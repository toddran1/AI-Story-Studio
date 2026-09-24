import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSummaryArgs, runSummaryCommand } from "../apps/cli/summary.js";
import { emptyStoryBible } from "../src/domain/story-bible.js";
import { LLMRouter } from "../src/llm/router.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { loadEligibleSummaryContext, SummaryService } from "../src/summaries/service.js";
import { SUMMARY_PROMPT_VERSION, summaryInstructions } from "../src/summaries/prompts.js";
import { normalizeSummaryChapters } from "../src/summaries/types.js";
import { MockLLM, testStory } from "./helpers.js";

describe("summary prompt", () => {
  it("keeps custom instructions subordinate to fidelity constraints", () => {
    expect(SUMMARY_PROMPT_VERSION).toBe("2");
    const prompt = summaryInstructions("custom", 500, "en-US", "The reveal", "Emphasize the rivalry");
    expect(prompt).toMatch(/ADDITIONAL INSTRUCTIONS refines emphasis only; it must never override the fidelity.*do-not-invent constraints/s);
    expect(prompt).toContain("ADDITIONAL INSTRUCTIONS: Emphasize the rivalry");
  });
});

describe("story summaries", () => {
  let root: string; let openai: MockLLM; let gemini: MockLLM; let service: SummaryService;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "story-summaries-"));
    openai = new MockLLM("openai", Array.from({ length: 100 }, (_, index) => `Generated recap ${index + 1}`));
    gemini = new MockLLM("gemini", Array.from({ length: 100 }, (_, index) => `Gemini recap ${index + 1}`));
    service = new SummaryService(root, new LLMRouter(new Map([["openai", openai], ["gemini", gemini]])));
    await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, testStory());
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("normalizes contiguous ranges and non-contiguous selections", () => {
    expect(normalizeSummaryChapters({ from: 3, to: 6 })).toEqual([3, 4, 5, 6]);
    expect(normalizeSummaryChapters({ chapters: [44, 12, 31, 12] })).toEqual([12, 31, 44]);
    expect(() => normalizeSummaryChapters({ from: 5, to: 2 })).toThrow(/Range end/);
  });

  it("uses the selected source mode without modifying source chapters", async () => {
    await chapter(1, "原始第一章", "Translated chapter one");
    const translated = await service.generate("demo-story", { title: "Translated recap", from: 1, to: 1, sourceMode: "translated" });
    expect(openai.calls[0]!.input).toContain("Translated chapter one");
    const original = await service.generate("demo-story", { title: "Original recap", chapters: [1], sourceMode: "original" });
    expect(openai.calls[1]!.input).toContain("原始第一章");
    expect(openai.calls[1]!.instructions).toContain("Write the recap in en-US");
    expect(translated.chapterRange).toEqual({ from: 1, to: 1 });
    expect(original.chapters).toEqual([1]);
  });

  it("hierarchically summarizes large ranges while preserving complete provenance", async () => {
    for (let number = 1; number <= 60; number++) await chapter(number, `原文 ${number}`, `Translated ${number}`);
    const events: string[] = [];
    const summary = await service.generate("demo-story", { title: "Long arc", from: 1, to: 60, sourceMode: "translated", summaryType: "arc", targetWords: 2500, chunkSize: 10 }, (event) => events.push(event.phase));
    expect(openai.calls).toHaveLength(7);
    expect(summary.chapters).toHaveLength(60);
    expect(summary.provenance.chapterSources.map((item) => item.chapter)).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
    expect(summary.provenance.levels.map((level) => level.batches.length)).toEqual([6, 1]);
    expect(events).toContain("finalizing");
  });

  it("preserves manual edits until explicit regeneration", async () => {
    await chapter(1, "原始", "Translation");
    const created = await service.generate("demo-story", { title: "Arc", chapters: [1] });
    const edited = await service.update("demo-story", created.id, { text: "My protected manual recap", contextEligible: true });
    expect(edited).toMatchObject({ text: "My protected manual recap", manuallyEdited: true, origin: "manual", contextEligible: true });
    expect((await service.get("demo-story", created.id)).text).toBe("My protected manual recap");
    const regenerated = await service.regenerate("demo-story", created.id, { instructions: "Emphasize the reveal" });
    expect(regenerated.text).not.toBe("My protected manual recap");
    expect(regenerated.manuallyEdited).toBe(false);
  });

  it("supports existing chapter summaries and reports missing sources", async () => {
    const bible = { ...emptyStoryBible(), chapterSummaries: { "1": "The hero arrives." } };
    await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, bible);
    const summary = await service.generate("demo-story", { title: "From Bible", chapters: [1], sourceMode: "chapter-summaries" });
    expect(summary.status).toBe("complete");
    await expect(service.generate("demo-story", { title: "Missing", chapters: [99], sourceMode: "translated" })).rejects.toThrow(/Chapter 99 has no translated text/);
    expect((await service.list("demo-story", { status: "failed" }))).toHaveLength(1);
  });

  it("routes generation through an explicit provider/model and supports library operations", async () => {
    await chapter(1, "原始", "Translation");
    const summary = await service.generate("demo-story", { title: "Provider route", chapters: [1], model: { provider: "gemini", model: "gemini-summary" } });
    expect(gemini.calls[0]!.model).toBe("gemini-summary");
    expect(openai.calls).toHaveLength(0);
    expect(await service.list("demo-story", { query: "provider", type: "detailed" })).toHaveLength(1);
    await service.delete("demo-story", summary.id);
    await expect(service.get("demo-story", summary.id)).rejects.toThrow(/not found/);
  });

  it("pages lightweight search results and invalidates rows after edits and deletion", async () => {
    await chapter(1, "原始", "Translation");
    const first = await service.generate("demo-story", { title: "First", chapters: [1] });
    const second = await service.generate("demo-story", { title: "Second", chapters: [1] });
    const page = await service.page("demo-story", { page: 1, pageSize: 1, sort: "created" });
    expect(page).toMatchObject({ page: 1, pageSize: 1, pages: 2, total: 2 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty("text");
    expect(page.items[0]).toHaveProperty("wordCount");
    await service.update("demo-story", first.id, { title: "Renamed", text: "Distinct search phrase" });
    expect((await service.page("demo-story", { query: "distinct", page: 1, pageSize: 25 })).items.map((item) => item.id)).toEqual([first.id]);
    await service.delete("demo-story", second.id);
    expect((await service.page("demo-story", { page: 1, pageSize: 25 })).total).toBe(1);
  });

  it("retrieves only opted-in, complete, earlier summaries under a strict bound", async () => {
    await chapter(1, "原始", "Misty enters the arena.");
    const summary = await service.generate("demo-story", { title: "Misty arc", chapters: [1], contextEligible: true });
    await service.update("demo-story", summary.id, { text: "Misty ".repeat(1_000) });
    const context = await loadEligibleSummaryContext(root, "demo-story", 2, "Misty returns", { maxCharacters: 500 });
    expect(context).toHaveLength(1);
    expect(context[0]!.title.length + 1 + [...context[0]!.text].length).toBeLessThanOrEqual(500);
    expect(await loadEligibleSummaryContext(root, "demo-story", 1, "Misty")).toEqual([]);
  });

  it("ignores AppleDouble and malformed files in the summary library", async () => {
    await chapter(1, "原始", "Translation");
    const summary = await service.generate("demo-story", { title: "Arc", chapters: [1] });
    const directory = join(root, "stories", "demo-story", "summaries");
    await atomicWrite(join(directory, `._${summary.id}.json`), Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00, 0x4d, 0x61]));
    await atomicWrite(join(directory, "corrupted.json"), "{not json");
    expect((await service.list("demo-story")).map((item) => item.id)).toEqual([summary.id]);
  });

  it("parses primary CLI workflows and actionable errors", () => {
    expect(parseSummaryArgs(["generate", "demo-story", "--chapters", "12,18,12", "--type", "arc", "--model", "gemini:flash", "--context"])).toMatchObject({ action: "generate", story: "demo-story", input: { chapters: [12, 18], summaryType: "arc", model: { provider: "gemini", model: "flash" }, contextEligible: true } });
    expect(parseSummaryArgs(["list", "demo-story"])).toEqual({ action: "list", story: "demo-story" });
    const id = "sum_12345678-1234-1234-1234-123456789abc";
    expect(parseSummaryArgs(["show", "demo-story", id])).toEqual({ action: "show", story: "demo-story", id });
    expect(parseSummaryArgs(["regenerate", "demo-story", id, "--target-length", "1200"])).toMatchObject({ action: "regenerate", id, overrides: { targetWords: 1200 } });
    expect(parseSummaryArgs(["delete", "demo-story", id])).toMatchObject({ action: "delete", id });
    expect(() => parseSummaryArgs(["generate", "demo-story", "--from", "3"])).toThrow(/both --from and --to/);
  });

  it("runs generate, list, show, regenerate, and delete through the shared CLI service", async () => {
    await chapter(1, "原始", "Translation");
    const output: string[] = [], progress: string[] = []; const io = { root, service, stdout: (text: string) => output.push(text), stderr: (text: string) => progress.push(text) };
    await runSummaryCommand(parseSummaryArgs(["generate", "demo-story", "--from", "1", "--to", "1"]), io);
    const generated = JSON.parse(output.pop()!);
    await runSummaryCommand(parseSummaryArgs(["list", "demo-story"]), io); expect(output.pop()).toContain(generated.id);
    await runSummaryCommand(parseSummaryArgs(["show", "demo-story", generated.id]), io); expect(JSON.parse(output.pop()!).id).toBe(generated.id);
    await runSummaryCommand(parseSummaryArgs(["regenerate", "demo-story", generated.id, "--target-length", "900"]), io); expect(JSON.parse(output.pop()!).targetLength.words).toBe(900);
    await runSummaryCommand(parseSummaryArgs(["delete", "demo-story", generated.id]), io); expect(output.pop()).toContain("Deleted");
    expect(progress.some((line) => line.includes("summarizing"))).toBe(true);
  });

  async function chapter(number: number, original: string, translated: string) {
    const paths = storyPaths(root, "demo-story", number);
    await atomicWrite(paths.original, original); await atomicWrite(paths.english, translated);
  }
});
