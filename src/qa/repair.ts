import { QaResult } from "../domain/qa.js";
import { StageModelConfig } from "../domain/provider.js";
import { LLMProvider } from "../llm/provider.js";
import { assertUsableTranslation } from "../translation/translator.js";
import type { NarrationProfanityMode } from "../domain/story.js";
import { softenStrongProfanity } from "../narration/profanity.js";
import { removeLeadingChapterTitle } from "../narration/narration-editor.js";

export function selectRepairStage(qa: QaResult): "translation" | "narration" {
  const translationCategories = new Set(["completeness", "names", "numbers", "terminology", "dialogue"]);
  return qa.issues.some((issue) => translationCategories.has(issue.category)) ? "translation" : "narration";
}

export type QaRepairTarget = "translation" | "narration";

export function repairTargets(issues: QaResult["issues"]): QaRepairTarget[] {
  const targets = new Set<QaRepairTarget>();
  for (const issue of issues) for (const target of issueRepairTargets(issue)) targets.add(target);
  // Translation must be repaired first because saving it invalidates narration.
  return (["translation", "narration"] as const).filter((target) => targets.has(target));
}

export function issueRepairTargets(issue: QaResult["issues"][number]): QaRepairTarget[] {
  if (issue.category === "narrationFidelity") return ["narration"];
  const description = `${issue.message}\n${issue.evidence}`.toLowerCase();
  if (/translation\s*[/&+]\s*narration|both (?:the )?translation and narration/.test(description)) return ["translation", "narration"];
  return ["translation"];
}

export async function repairQaText(provider: LLMProvider, config: StageModelConfig, input: {
  target: QaRepairTarget; chapter: number; sourceLanguage: string; outputLanguage: string; source: string;
  translation: string; narration: string; issues: QaResult["issues"]; context?: unknown; profanityMode?: NarrationProfanityMode; includeChapterTitle?: boolean;
}) {
  const current = input.target === "translation" ? input.translation : input.narration;
  if (!current.trim()) throw new Error(`Chapter ${input.chapter} has no ${input.target} to repair`);
  const instructions = [
    `You are repairing a complete chapter ${input.target} after a quality review.`,
    "Return only the complete corrected text, with no preface, explanation, markdown fence, or change log.",
    "Preserve every unaffected detail, paragraph, event, number, proper name, and line of dialogue.",
    "Make the smallest changes necessary to resolve every supplied QA finding. Never shorten the chapter into a summary.",
    input.target === "translation"
      ? `Keep the result faithful to the ${input.sourceLanguage} source and natural in ${input.outputLanguage}.`
      : `Keep the narration faithful to the approved ${input.outputLanguage} translation; do not introduce new story information.`,
    input.target === "narration" && input.profanityMode === "soften-strong"
      ? "Honor the story's narration-only preference: replace strong profanity with natural milder wording while preserving hostility, emotion, intent, and meaning. Ass, hell, and damn are allowed."
      : "",
    input.target === "narration" && input.includeChapterTitle === false
      ? "The story omits chapter titles from narration. Return the complete narration body without a chapter heading or title."
      : "",
  ].join(" ");
  const result = await provider.generateText({
    model: config.model,
    instructions,
    input: [
      `CHAPTER: ${input.chapter}`,
      `SELECTED QA FINDINGS:\n${JSON.stringify(input.issues, null, 2)}`,
      `RELEVANT STORY CONTEXT:\n${JSON.stringify(input.context ?? {}, null, 2)}`,
      `ORIGINAL SOURCE:\n${input.source}`,
      `CURRENT TRANSLATION:\n${input.translation}`,
      `CURRENT NARRATION:\n${input.narration}`,
      `TEXT TO REPAIR (${input.target.toUpperCase()}):\n${current}`,
    ].join("\n\n"),
  });
  let text = softenStrongProfanity(stripFence(result.text), input.target === "narration" ? (input.profanityMode ?? "preserve") : "preserve");
  if (input.target === "narration" && input.includeChapterTitle === false) text = removeLeadingChapterTitle(text);
  validateRepair(text, current, input.target);
  return { ...result, text };
}

function stripFence(text: string) {
  const trimmed = text.trim();
  const fenced = /^```(?:text|markdown)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

function validateRepair(text: string, current: string, target: QaRepairTarget) {
  if (!text) throw new Error(`AI returned an empty ${target} repair`);
  if (text === current.trim()) throw new Error(`AI returned an unchanged ${target} repair; no changes were saved. Review or dismiss the finding, or edit the text manually.`);
  if (target === "translation") assertUsableTranslation(text);
  const ratio = [...text].length / Math.max(1, [...current].length);
  if (ratio < 0.65 || ratio > 1.6) throw new Error(`AI ${target} repair changed the chapter length implausibly (${Math.round(ratio * 100)}% of the current text); no changes were saved`);
}
