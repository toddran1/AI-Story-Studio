import { describe, expect, it } from "vitest";
import { qaResultSchema } from "../src/domain/qa.js";
import { emptyStoryBible, storyBibleSchema } from "../src/domain/story-bible.js";
import { issueRepairTargets, repairQaText, repairTargets, selectRepairStage } from "../src/qa/repair.js";
import { MockLLM } from "./helpers.js";

const checks = { completeness: "pass", names: "pass", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" } as const;

describe("repair stage selection", () => {
  it("regenerates translation for source fidelity issues", () => {
    const qa = qaResultSchema.parse({ status: "fail", score: 0.2, issues: [{ category: "numbers", severity: "fail", message: "Changed value", evidence: "10 became 12" }], checks: { ...checks, numbers: "fail" } });
    expect(selectRepairStage(qa)).toBe("translation");
  });
  it("regenerates narration for narration-only fidelity issues", () => {
    const qa = qaResultSchema.parse({ status: "fail", score: 0.2, issues: [{ category: "narrationFidelity", severity: "fail", message: "POV changed", evidence: "First person became third person" }], checks: { ...checks, narrationFidelity: "fail" } });
    expect(selectRepairStage(qa)).toBe("narration");
  });

  it("routes mixed selected findings to both affected artifacts", () => {
    const qa = qaResultSchema.parse({ status: "fail", score: 0.2, issues: [
      { category: "terminology", severity: "warn", message: "Wrong term", evidence: "Blade became sword" },
      { category: "narrationFidelity", severity: "fail", message: "Meaning changed", evidence: "Narration adds an event" },
    ], checks: { ...checks, terminology: "warn", narrationFidelity: "fail" } });
    expect(repairTargets(qa.issues)).toEqual(["translation", "narration"]);
    expect(repairTargets([...qa.issues].reverse())).toEqual(["translation", "narration"]);
    expect(issueRepairTargets({ category: "terminology", severity: "warn", message: "Wrong in both the translation and narration", evidence: "Use Flame Blade" })).toEqual(["translation", "narration"]);
  });

  it("passes selected evidence and the complete chapter to a focused repair", async () => {
    const current = "A complete corrected chapter remains long enough to pass the conservative repair guard. ".repeat(12);
    const provider = new MockLLM("openai", [current.replace("corrected", "faithful")]);
    const issue = qaResultSchema.parse({ status: "warn", score: 0.8, issues: [{ category: "terminology", severity: "warn", message: "Use canonical term", evidence: "Use Flame Blade" }], checks: { ...checks, terminology: "warn" } }).issues;
    const result = await repairQaText(provider, { provider: "openai", model: "repair-model" }, { target: "translation", chapter: 6, sourceLanguage: "zh-CN", outputLanguage: "en-US", source: "原文", translation: current, narration: current, issues: issue });
    expect(result.text).toContain("faithful");
    expect(provider.calls[0]?.input).toContain("Use Flame Blade");
    expect(provider.calls[0]?.input).toContain("CURRENT TRANSLATION");
  });

  it("rejects a suspiciously shortened repair before it can be saved", async () => {
    const provider = new MockLLM("openai", ["Short summary."]);
    const current = "Full chapter sentence. ".repeat(100);
    const issue = qaResultSchema.parse({ status: "warn", score: 0.8, issues: [{ category: "terminology", severity: "warn", message: "Fix term", evidence: "Evidence" }], checks: { ...checks, terminology: "warn" } }).issues;
    await expect(repairQaText(provider, { provider: "openai", model: "repair-model" }, { target: "translation", chapter: 6, sourceLanguage: "zh-CN", outputLanguage: "en-US", source: "原文", translation: current, narration: current, issues: issue })).rejects.toThrow("length implausibly");
  });

  it("rejects an unchanged repair instead of reporting a misleading success", async () => {
    const current = "The complete chapter preserves every important detail. ".repeat(20);
    const provider = new MockLLM("openai", [current]);
    const issue = qaResultSchema.parse({ status: "warn", score: 0.8, issues: [{ category: "narrationFidelity", severity: "warn", message: "Narration adds an unsupported detail", evidence: "The source does not mention this event." }], checks: { ...checks, narrationFidelity: "warn" } }).issues;
    await expect(repairQaText(provider, { provider: "openai", model: "repair-model" }, { target: "narration", chapter: 6, sourceLanguage: "zh-CN", outputLanguage: "en-US", source: "原文", translation: current, narration: current, issues: issue })).rejects.toThrow("unchanged narration repair");
  });

  it("guards authorized narration names, system panels, and wrong findings in repair instructions", async () => {
    const current = "Asher crossed the courtyard beneath a status window. ".repeat(20);
    const repaired = current.replace("crossed", "walked through");
    const provider = new MockLLM("openai", [repaired]);
    const context = storyBibleSchema.parse({ ...emptyStoryBible(), canonicalEntities: [{ id: "ent_aaaaaaaaaaaaaaaaaaaaaaaa", type: "character", canonicalName: "Su Ming", originalName: "苏明", aliases: [], preferredNarrationName: "Asher", aliasNarrationRules: [], firstAppearance: 1, lastKnownAppearance: 6, status: "alive" }] });
    const issue = qaResultSchema.parse({ status: "warn", score: 0.8, issues: [{ category: "narrationFidelity", severity: "warn", message: "Fault lies in the narration", evidence: "Narration: walked. Translation: crossed." }], checks: { ...checks, narrationFidelity: "warn" } }).issues;
    await repairQaText(provider, { provider: "openai", model: "repair-model" }, { target: "narration", chapter: 6, sourceLanguage: "zh-CN", outputLanguage: "en-US", source: "原文", translation: current, narration: current, issues: issue, context });
    const instructions = (provider.calls[0] as { instructions?: string })?.instructions ?? "";
    expect(instructions).toContain("AUTHORIZED NARRATION NAMING MAPPINGS");
    expect(instructions).toContain('Preferred Narration Name "Asher"');
    expect(instructions).toContain("never revert an authorized narration-name substitution");
    expect(instructions).toContain("verbatim, character for character");
    expect(instructions).toContain("make no change for that finding");
  });
});
