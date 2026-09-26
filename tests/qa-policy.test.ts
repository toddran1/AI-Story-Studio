import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storySchema } from "../src/domain/story.js";
import { runDeterministicQaChecks } from "../src/qa/deterministic.js";
import { filterQaDetectionsForStory } from "../src/qa/policy.js";
import { testStory } from "./helpers.js";

describe("per-story QA policy", () => {
  it("defaults to every category and rule enabled for older stories", () => {
    const story = testStory();
    const { qaPolicy: _policy, ...legacy } = story;
    expect(storySchema.parse(legacy).qaPolicy).toEqual({ disabledCategories: [], disabledRules: [] });
  });

  it("suppresses repeated paragraphs for one story without weakening other checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-policy-"));
    const story = testStory();
    const chapter = { root, story, chapter: 1, source: "源文", translation: "[Level-up successful]\n\nAn ordinary sentence.\n\n[Level-up successful]", narration: "[EXP gained...]\n\nAnother sentence.\n\n[EXP gained...]" };
    const enabled = await runDeterministicQaChecks(chapter);
    expect(enabled.detections.some((item) => item.ruleKey?.startsWith("completeness:duplicate-paragraph:"))).toBe(true);
    const scoped = { ...story, qaPolicy: { disabledCategories: [], disabledRules: ["duplicateParagraph" as const] } };
    const disabled = await runDeterministicQaChecks({ ...chapter, story: scoped });
    expect(disabled.detections.some((item) => item.ruleKey?.startsWith("completeness:duplicate-paragraph:"))).toBe(false);
    expect(filterQaDetectionsForStory(scoped, [
      { category: "completeness" as const, message: "The narration repeats a paragraph verbatim" },
      { category: "completeness" as const, message: "The narration omits a sentence" },
    ])).toHaveLength(1);
    expect(story.qaPolicy.disabledRules).toEqual([]);
  });

  it("filters disabled categories while retaining enabled categories", () => {
    const story = { ...testStory(), qaPolicy: { disabledCategories: ["dialogue" as const], disabledRules: [] } };
    expect(filterQaDetectionsForStory(story, [
      { category: "dialogue" as const, message: "Dropped line" },
      { category: "numbers" as const, message: "Wrong level" },
    ])).toEqual([{ category: "numbers", message: "Wrong level" }]);
  });
});
