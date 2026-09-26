import { StageModelConfig } from "../domain/provider.js";
import { generatedQaResultSchema, QaResult, normalizeQaResult } from "../domain/qa.js";
import { CanonicalEntity, StoryBible } from "../domain/story-bible.js";
import { LLMProvider } from "../llm/provider.js";
import type { NarrationProfanityMode } from "../domain/story.js";
import { authorizedNarrationNaming, previousQaFindingsSection, qaChangedContentInstructions, qaInstructionsFor, qaModeInstructionsFor, qaRecheckInstructions } from "./prompts.js";

export type QaValidationInput = {
  chapter: number; sourceLanguage: string; outputLanguage: string; source: string; translation: string; narration: string; context: StoryBible;
  authorizedNarrationEntities?: CanonicalEntity[];
  profanityMode?: NarrationProfanityMode; includeChapterTitle?: boolean;
  /** Compact rendering of prior findings; present on stateful rechecks. */
  previousFindingsContext?: string;
  /** Compact rendering of approved story-level QA exceptions. */
  exceptionsContext?: string;
  /** QA depth; thorough adds style/flow/minor-grammar review. */
  mode?: "production" | "thorough";
  /** Recheck mode; "changed" replaces the full translation/narration with labeled changed paragraphs. */
  recheck?: { mode: "full" | "changed"; changedContent?: string };
};

export async function validateChapterQuality(
  provider: LLMProvider,
  config: StageModelConfig,
  input: QaValidationInput,
): Promise<{ value: QaResult; usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; requestId?: string } }> {
  const changedMode = input.recheck?.mode === "changed" && input.recheck.changedContent !== undefined;
  const instructions = [
    qaInstructionsFor(input.profanityMode, input.includeChapterTitle),
    qaModeInstructionsFor(input.mode),
    input.previousFindingsContext || input.recheck ? qaRecheckInstructions : "",
    changedMode ? qaChangedContentInstructions : "",
  ].filter(Boolean).join("\n\n");
  const result = await provider.generateStructured({
    model: config.model,
    instructions,
    input: [
      `CHAPTER NUMBER: ${input.chapter}`,
      `SOURCE LANGUAGE: ${input.sourceLanguage}`,
      `OUTPUT LANGUAGE: ${input.outputLanguage}`,
      `ESTABLISHED STORY BIBLE:\n${JSON.stringify(input.context, null, 2)}`,
      authorizedNarrationNaming(input.authorizedNarrationEntities ?? input.context),
      input.previousFindingsContext ? previousQaFindingsSection(input.previousFindingsContext) : "",
      input.exceptionsContext ?? "",
      `SOURCE CHAPTER:\n${input.source}`,
      changedMode
        ? `CHANGED CONTENT (only changed paragraphs and their immediate neighbors; labels are translation (T) and narration (N) paragraph numbers):\n${input.recheck!.changedContent}`
        : `TRANSLATION:\n${input.translation}\n\nNARRATION:\n${input.narration}`,
    ].filter(Boolean).join("\n\n"),
    schemaName: "chapter_qa",
    schema: generatedQaResultSchema,
  });
  return { ...result, value: normalizeQaResult(promoteConfirmedMaterialIssues(result.value)) };
}

/** A model can describe a confirmed material change yet label it a warning.
 * Promote only explicit, attributable defects; uncertain contextual naming
 * choices and ordinary tone differences remain review warnings. */
export function promoteConfirmedMaterialIssues(value: unknown): unknown {
  const parsed = generatedQaResultSchema.parse(value);
  const issues = parsed.issues.map((issue) => {
    const description = `${issue.message} ${issue.evidence}`;
    const wrongAuthorizedName = issue.category === "names"
      && /\bnarration\b/i.test(description)
      && /\b(?:retains?|uses?)\s+(?:the\s+)?canonical\s+names?\b/i.test(description)
      && /\b(?:authorized|localized|preferred)\b/i.test(description)
      && /\b(?:required|instead|where|mismatch|violation)\b/i.test(description);
    const addedInsult = issue.category === "narrationFidelity"
      && /\bnarration\b/i.test(description)
      && /\badds?\s+(?:an?\s+)?insult\b/i.test(description)
      && /\babsent\s+from\b/i.test(description);
    return wrongAuthorizedName || addedInsult ? { ...issue, severity: "fail" as const } : issue;
  });
  const checks = { ...parsed.checks };
  for (const issue of issues) if (issue.severity === "fail") checks[issue.category] = "fail";
  return { ...parsed, issues, checks };
}
