import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseNamesArgs, runNamesCommand } from "../apps/cli/names.js";
import { JobManager } from "../apps/server/job-manager.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { emptyStoryBible, storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { LLMRouter } from "../src/llm/router.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { mergeStoryBible } from "../src/story-bible/updater.js";
import { MockLLM, testStory } from "./helpers.js";

const env = loadEnvironment({});

describe("story:names CLI", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("parses list, show, suggest, set, and clear commands", () => {
    const id = "ent_1234567890abcdef12345678";
    expect(parseNamesArgs(["list", "demo-story", "--type", "character", "--query", "Su"])).toMatchObject({ action: "list", story: "demo-story", type: "character", query: "Su" });
    expect(parseNamesArgs(["show", "demo-story", id])).toEqual({ action: "show", story: "demo-story", id });
    expect(parseNamesArgs(["suggest", "demo-story", id, "--locale", "en-US", "--count", "5"])).toMatchObject({ action: "suggest", id, locale: "en-US", count: 5 });
    expect(parseNamesArgs(["set", "demo-story", id, "--locale", "en-US", "--full", "Malakai Sterling", "--short", "Malakai"])).toMatchObject({ action: "set", localizedNaming: { usageMode: "ai_contextual", fullName: "Malakai Sterling" } });
    expect(parseNamesArgs(["clear", "demo-story", id])).toEqual({ action: "clear", story: "demo-story", id });
    expect(() => parseNamesArgs(["set", "demo-story", id, "--full", "Malakai Sterling"])).toThrow(/requires --locale/i);
  });

  it("uses the web localization operation and storage for list, show, suggest, set, and clear", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-names-cli-")); roots.push(root); const story = testStory(); const paths = storyPaths(root, story.slug, 1);
    const bible = mergeStoryBible(emptyStoryBible(), storyBibleUpdateSchema.parse({ chapterSummary: "Su Ming arrives.", characters: [{ canonicalEnglishName: "Su Ming", originalName: "苏铭", aliases: ["Student Su"], description: "A necromancer", firstSeenChapter: 1, lastSeenChapter: 1 }] }), 1); const id = bible.canonicalEntities[0]!.id;
    await atomicWriteJson(paths.storyConfig, story); await atomicWriteJson(paths.bible, bible);
    const openai = new MockLLM("openai"); openai.generateStructured = async (request: any) => ({ value: request.schema.parse({ suggestions: [{ fullName: "Malakai Sterling", shortName: "Malakai", rationale: "A natural English full and familiar form." }] }) });
    const operations = new StudioOperations(root, env, new JobManager(), { llm: new LLMRouter(new Map([["openai", openai], ["gemini", new MockLLM("gemini")]])) }); const output: string[] = [];
    const io = { root, operations, stdout: (text: string) => output.push(text) };
    try {
      await runNamesCommand(parseNamesArgs(["list", story.slug]), io); expect(output.pop()).toContain("Su Ming");
      await runNamesCommand(parseNamesArgs(["show", story.slug, id]), io); expect(JSON.parse(output.pop()!).id).toBe(id);
      await runNamesCommand(parseNamesArgs(["suggest", story.slug, id, "--locale", "en-US", "--count", "3"]), io); expect(JSON.parse(output.pop()!).suggestions[0]).toMatchObject({ fullName: "Malakai Sterling", shortName: "Malakai" });
      await runNamesCommand(parseNamesArgs(["set", story.slug, id, "--locale", "en-US", "--full", "Malakai Sterling", "--short", "Malakai", "--mode", "ai_contextual"]), io); expect(JSON.parse(output.pop()!).entity.localizedNaming).toMatchObject({ fullName: "Malakai Sterling", shortName: "Malakai", usageMode: "ai_contextual" });
      await runNamesCommand(parseNamesArgs(["clear", story.slug, id]), io); expect(JSON.parse(output.pop()!).entity.localizedNaming).toBeUndefined();
    } finally { await operations.close(); }
  });
});
