import { describe, expect, it } from "vitest";
import { activeQaIssues, dismissQaIssues, normalizeQaResult, qaResultSchema, resolveQaIssues } from "../src/domain/qa.js";
import { emptyStoryBible, storyBibleSchema } from "../src/domain/story-bible.js";
import { QA_PROMPT_VERSION, authorizedNarrationNaming, qaInstructions, qaInstructionsFor } from "../src/qa/prompts.js";
import { validateChapterQuality } from "../src/qa/validator.js";
import { MockLLM } from "./helpers.js";

const checks = { completeness: "pass", names: "pass", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" } as const;
describe("QA result", () => {
  it("validates structured output", () => { expect(qaResultSchema.parse({ status: "pass", score: 0.96, issues: [], checks }).score).toBe(0.96); });
  it("rejects invalid scores and categories", () => {
    expect(qaResultSchema.safeParse({ status: "pass", score: 2, issues: [], checks }).success).toBe(false);
    expect(qaResultSchema.safeParse({ status: "warn", score: 0.5, issues: [{ category: "style", severity: "warn", message: "x" }], checks }).success).toBe(false);
  });
  it("promotes understated model status to the worst check", () => {
    expect(normalizeQaResult({ status: "pass", score: 0.5, issues: [], checks: { ...checks, numbers: "fail" } }).status).toBe("fail");
  });
  it("retains dismissed evidence while removing it from the active decision", () => {
    const result = dismissQaIssues({ status: "warn", score: 0.86, issues: [
      { category: "dialogue", severity: "warn", message: "A threat is softened", evidence: "The intent remains intact." },
      { category: "numbers", severity: "warn", message: "A number changed", evidence: "Ten became twelve." },
    ], checks: { ...checks, dialogue: "warn", numbers: "warn" } }, [0], "2026-09-14T18:00:00.000Z");
    expect(result.status).toBe("warn");
    expect(result.checks.dialogue).toBe("pass");
    expect(result.issues[0]?.review).toEqual({ disposition: "dismissed", reviewedAt: "2026-09-14T18:00:00.000Z" });
    expect(activeQaIssues(result).map((issue) => issue.category)).toEqual(["numbers"]);
    expect(result.originalScore).toBe(0.86);
    expect(result.score).toBeCloseTo(0.93);
  });
  it("marks the chapter pass when its only warning is dismissed", () => {
    const result = dismissQaIssues({ status: "warn", score: 0.9, issues: [
      { category: "dialogue", severity: "warn", message: "Minor wording", evidence: "No action needed." },
    ], checks: { ...checks, dialogue: "warn" } }, [0]);
    expect(result.status).toBe("pass");
    expect(result.checks.dialogue).toBe("pass");
    expect(activeQaIssues(result)).toEqual([]);
    expect(result.originalScore).toBe(0.9);
    expect(result.score).toBe(1);
  });
  it("records manually fixed findings as resolved and excludes them from the reviewed score", () => {
    const result = resolveQaIssues({ status: "fail", score: 0.72, issues: [
      { category: "numbers", severity: "fail", message: "A number changed", evidence: "The editor restored the original quantity." },
    ], checks: { ...checks, numbers: "fail" } }, [0], "manually_fixed", "2026-09-16T14:00:00.000Z");
    expect(result.status).toBe("pass");
    expect(result.score).toBe(1);
    expect(result.originalScore).toBe(0.72);
    expect(result.issues[0]?.review).toEqual({ disposition: "manually_fixed", reviewedAt: "2026-09-16T14:00:00.000Z" });
    expect(activeQaIssues(result)).toEqual([]);
  });
});

const namingBible = () => storyBibleSchema.parse({
  ...emptyStoryBible(),
  canonicalEntities: [{
    id: "ent_aaaaaaaaaaaaaaaaaaaaaaaa", type: "character", canonicalName: "Su Ming", originalName: "苏明", aliases: ["Ming"],
    preferredNarrationName: "Asher",
    aliasNarrationRules: [{ alias: "Ming", behavior: "custom", replacement: "Ash" }],
    localizedNaming: { locale: "en-US", fullName: "Asher Voss", shortName: "Asher", usageMode: "ai_contextual" },
    canonicalNameLocked: true,
    firstAppearance: 1, lastKnownAppearance: 3, status: "alive",
  }],
});

const qaCall = (llm: MockLLM) => llm.calls.find((call) => "schemaName" in call && call.schemaName === "chapter_qa")!;

describe("QA authorized narration naming", () => {
  it("passes explicit authorized mappings to the model and accepts no finding for authorized replacement in dialogue", async () => {
    const llm = new MockLLM();
    const result = await validateChapterQuality(llm, { provider: "openai", model: "qa-model" }, {
      chapter: 3, sourceLanguage: "zh-CN", outputLanguage: "en-US",
      source: "苏明说：“我们走。”", translation: `Su Ming said, "Let's go."`,
      narration: `"Let's go," Asher said. Asher Voss had made up his mind.`,
      context: namingBible(),
    });
    expect(result.value.status).toBe("pass");
    expect(result.value.checks.names).toBe("pass");
    const call = qaCall(llm) as { input: string; instructions: string };
    expect(call.input).toContain("AUTHORIZED NARRATION NAMING MAPPINGS");
    expect(call.input).toContain('canonical "Su Ming"');
    expect(call.input).toContain('original "苏明"');
    expect(call.input).toContain('fullName "Asher Voss"');
    expect(call.input).toContain('shortName "Asher"');
    expect(call.input).toContain('usageMode "ai_contextual"');
    expect(call.input).toContain('the alias "Ming" is rendered as the custom phrase "Ash"');
    expect(call.input).toContain('canonical name is locked');
    expect(call.input).toContain("including inside dialogue");
    expect(call.instructions).toContain("including inside spoken dialogue");
  });

  it("still surfaces a names finding for an unauthorized substitution", async () => {
    const llm = new MockLLM("openai", undefined, {
      status: "warn", score: 0.7,
      issues: [{ category: "names", severity: "warn", message: "Narration renames Su Ming to 'Marcus', which matches neither the translation nor an authorized mapping.", evidence: `"Let's go," Marcus said.` }],
      checks: { completeness: "pass", names: "warn", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" },
    });
    const result = await validateChapterQuality(llm, { provider: "openai", model: "qa-model" }, {
      chapter: 3, sourceLanguage: "zh-CN", outputLanguage: "en-US",
      source: "苏明", translation: `Su Ming said, "Let's go."`, narration: `"Let's go," Marcus said.`,
      context: namingBible(),
    });
    expect(result.value.checks.names).toBe("warn");
    expect(activeQaIssues(result.value).map((issue) => issue.category)).toEqual(["names"]);
  });

  it("states that no overrides exist when the bible has no naming preferences", () => {
    expect(authorizedNarrationNaming(emptyStoryBible())).toContain("None.");
  });

  it("records the bumped prompt version", () => {
    expect(QA_PROMPT_VERSION).toBe("8");
  });

  it("documents the output contract, severity rubric, and repair-routing phrasing", () => {
    for (const category of ["completeness", "names", "numbers", "terminology", "dialogue", "storyConsistency", "narrationFidelity"]) expect(qaInstructions).toContain(category);
    expect(qaInstructions).toContain("1.0 means no issues");
    expect(qaInstructions).toContain("block publication");
    expect(qaInstructions).toContain("dropped dialogue or merged speaker turns");
    expect(qaInstructions).toContain("TRANSLATION or the NARRATION");
    expect(qaInstructions).toContain("both the translation and narration");
    expect(qaInstructions).toContain("both the translation and the narration");
    expect(qaInstructions).toMatch(/length tolerance/i);
  });

  it("partitions profanity with the same strong/mild lists as the narration prompt", () => {
    const qa = qaInstructionsFor("soften-strong");
    expect(qa).toMatch(/fuck.*bitch.*shit.*cunt/i);
    expect(qa).toMatch(/ass.*hell.*damn/i);
  });

  it("accepts cosmetic regrouping while protecting substantive dialogue and formatting boundaries", () => {
    const instructions = qaInstructionsFor();
    expect(instructions).toContain("do not label them warn or fail");
    expect(instructions).toContain("same speaker's separate quotations");
    expect(instructions).toContain("Cut the crap! The earlier we leave, the earlier we finish!");
    expect(instructions).toContain("Are you messing with me?");
    for (const defect of ["merged speaker turns that misattribute", "reordered exchanges", "narration/action swallowed into dialogue", "unbalanced quotation marks", "missing meaningful interruptions or pauses", "punctuation damage that changes meaning"]) {
      expect(instructions).toContain(defect);
    }
    expect(instructions).not.toContain("for example dropped or merged dialogue");
  });
});
