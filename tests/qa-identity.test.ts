import { describe, expect, it } from "vitest";
import { emptyStoryBible } from "../src/domain/story-bible.js";
import { validateChapterQuality } from "../src/qa/validator.js";
import { MockLLM } from "./helpers.js";

const checks = { completeness: "pass", names: "pass", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "warn", narrationFidelity: "pass" } as const;
const source = "叶凌石皱眉，他举起自己的剑。";
const wrong = "Ye Lingshi frowned. She raised her sword.";
const correct = "Ye Lingshi frowned. He raised his sword.";
const config = { provider: "openai", model: "fake-qa" } as const;

async function review(message: string, translation = wrong, narration = wrong, evidence = `SOURCE: ${source} TRANSLATION: ${translation} NARRATION: ${narration}`) {
  const llm = new MockLLM("openai", [], { status: "warn", score: 0.9, checks, issues: [{ category: "storyConsistency", severity: "warn", message, evidence }] });
  const result = await validateChapterQuality(llm, config, { chapter: 343, sourceLanguage: "zh-CN", outputLanguage: "en-US", source, translation, narration, context: emptyStoryBible() });
  return { llm, result: result.value };
}

describe("QA character identity verification", () => {
  it("keeps a source-backed mismatch critical when both English artifacts repeat it", async () => {
    const { llm, result } = await review("Confirmed identity mismatch: The fault lies in both the translation and narration: Ye Lingshi is incorrectly referred to as she/her although the source uses 他 for him.");
    expect(result.status).toBe("fail");
    expect(result.checks.storyConsistency).toBe("fail");
    expect(result.issues[0]?.severity).toBe("fail");
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.instructions).toContain("Compare SOURCE -> TRANSLATION and SOURCE -> NARRATION independently");
    expect(llm.calls[0]?.input).toContain(`SOURCE CHAPTER:\n${source}`);
    expect(llm.calls[0]?.input).toContain(`TRANSLATION:\n${wrong}\n\nNARRATION:\n${wrong}`);
  });

  it("preserves translation-only attribution when narration has already corrected the pronoun", async () => {
    const { result } = await review("Confirmed identity mismatch: The fault lies in the TRANSLATION: it refers to Ye Lingshi as she/her; narration already correctly uses he/him.", wrong, correct);
    expect(result.status).toBe("fail");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toContain("narration already correctly uses he/him");
    expect(result.issues[0]?.evidence).toContain(`NARRATION: ${correct}`);
  });

  it.each([
    ["The fault lies in the TRANSLATION: the source pronoun may be a typo; gender is uncertain.", `SOURCE: 他 TRANSLATION: she NARRATION: she`],
    ["Confirmed identity mismatch: The fault lies in the TRANSLATION: the referent might be ambiguous.", `SOURCE: 他 TRANSLATION: she NARRATION: she`],
    ["Confirmed identity mismatch: The fault lies in the TRANSLATION: it uses she/her.", "TRANSLATION: she NARRATION: he"],
  ])("does not promote uncertain or source-unsupported identity concerns", async (message, evidence) => {
    const { result } = await review(message, wrong, correct, evidence);
    expect(result.issues[0]?.severity).toBe("warn");
    expect(result.status).toBe("warn");
  });

  it("includes the identity source check in changed-content reviews", async () => {
    const llm = new MockLLM();
    await validateChapterQuality(llm, config, { chapter: 343, sourceLanguage: "zh-CN", outputLanguage: "en-US", source, translation: correct, narration: correct, context: emptyStoryBible(), recheck: { mode: "changed", changedContent: `T1: ${wrong}\nN1: ${correct}` } });
    expect(llm.calls[0]?.instructions).toContain("CHARACTER IDENTITY VERIFICATION");
    expect(llm.calls[0]?.instructions).toContain("across neighboring sentences and paragraphs");
    expect(llm.calls[0]?.instructions).toContain("An isolated source pronoun can be a typo");
    expect(llm.calls[0]?.input).toContain(source);
  });
});
