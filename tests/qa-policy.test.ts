import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storySchema } from "../src/domain/story.js";
import { runDeterministicQaChecks } from "../src/qa/deterministic.js";
import { filterQaDetectionsForStory, qaFingerprintConfig } from "../src/qa/policy.js";
import { buildQaState } from "../src/qa/review.js";
import { testStory } from "./helpers.js";

describe("per-story QA policy", () => {
  it("defaults to every category and rule enabled for older stories", () => {
    const story = testStory();
    const { qaPolicy: _policy, ...legacy } = story;
    expect(storySchema.parse(legacy).qaPolicy).toEqual({ disabledCategories: [], disabledRules: [] });
    expect(qaFingerprintConfig(story)).toBe(story.pipeline.qa);
    expect(qaFingerprintConfig({ ...story, qaPolicy: { disabledCategories: [], disabledRules: ["duplicateParagraph"] } })).not.toEqual(story.pipeline.qa);
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
      { category: "completeness" as const, message: "The narration repeats a paragraph and omits the next passage" },
    ])).toHaveLength(2);
    expect(story.qaPolicy.disabledRules).toEqual([]);
  });

  it("filters disabled categories while retaining enabled categories", () => {
    const story = { ...testStory(), qaPolicy: { disabledCategories: ["dialogue" as const], disabledRules: [] } };
    expect(filterQaDetectionsForStory(story, [
      { category: "dialogue" as const, message: "Dropped line" },
      { category: "numbers" as const, message: "Wrong level" },
    ])).toEqual([{ category: "numbers", message: "Wrong level" }]);
  });

  it("retires an old AI duplicate-paragraph finding when its rule is disabled", () => {
    const story = testStory();
    const options = { chapter: 1, translation: "Repeated line.\n\nRepeated line.", narration: "Repeated line.\n\nRepeated line." };
    const first = buildQaState(undefined, [{ category: "completeness", severity: "warn", message: "The narration repeats a paragraph verbatim", evidence: "Paragraph 2 duplicates paragraph 1", origin: "llm" }], options);
    expect(first.state.findings[0]?.status).toBe("open");
    const policy = { ...story.qaPolicy, disabledRules: ["duplicateParagraph" as const] };
    const second = buildQaState(first.state, [], { ...options, qaPolicy: policy, dependencyFingerprint: "new-policy", evaluatedContent: `${options.translation}\n\n${options.narration}` });
    expect(second.state.findings[0]?.status).toBe("obsolete");
    expect(second.state.checks.completeness).toBe("pass");
    expect(second.outcome.obsoleted).toBe(1);
  });
});
