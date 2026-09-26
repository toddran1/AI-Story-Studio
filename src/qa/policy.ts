import type { Story } from "../domain/story.js";
import type { QaFinding } from "../domain/qa.js";
import type { FreshQaDetection } from "./review.js";

export function qaFindingEnabled(policy: Story["qaPolicy"], item: { category: FreshQaDetection["category"]; message: string; ruleKey?: string }): boolean {
  if (policy.disabledCategories.includes(item.category)) return false;
  if (policy.disabledRules.includes("duplicateParagraph") && item.category === "completeness") {
    if (item.ruleKey?.startsWith("completeness:duplicate-paragraph:")) return false;
    const repetition = /\bparagraphs?\b/i.test(item.message) && /\b(?:duplicat(?:e|ed|es|ion)|repeat(?:s|ed|ing)?|identical|verbatim)\b/i.test(item.message);
    const additionalDefect = /\b(?:omit(?:ted|s|ting)?|missing|skip(?:ped|s|ping)?|drop(?:ped|s|ping)?|lost|alter(?:ed|s)?|change(?:d|s)?\s+(?:the\s+)?meaning|incomplete)\b/i.test(item.message);
    if (repetition && !additionalDefect) return false;
  }
  return true;
}

/** Story-level scope for QA findings. This runs before finding reconciliation. */
export function filterQaDetectionsForStory<T extends Pick<FreshQaDetection, "category" | "message"> & { ruleKey?: string }>(story: Story, detections: T[]): T[] {
  return detections.filter((item) => qaFindingEnabled(story.qaPolicy, item));
}

export function storedQaFindingEnabled(policy: Story["qaPolicy"], finding: QaFinding): boolean {
  return qaFindingEnabled(policy, { category: finding.category, message: finding.message, ruleKey: finding.provenance?.ruleKey });
}

export function qaPolicyPrompt(story: Story): string {
  const disabled = story.qaPolicy.disabledCategories;
  const duplicate = story.qaPolicy.disabledRules.includes("duplicateParagraph");
  if (!disabled.length && !duplicate) return "";
  return `STORY QA POLICY: Do not report findings in these disabled categories: ${disabled.join(", ") || "none"}.${duplicate ? " Repeated paragraphs are expected in this story; do not flag duplicate paragraphs solely for repetition." : ""} Continue checking all other issues normally.`;
}

/** Keep legacy QA fingerprints for stories whose checks are all enabled. */
export function qaFingerprintConfig(story: Story): unknown {
  const policy = story.qaPolicy;
  return policy.disabledCategories.length || policy.disabledRules.length
    ? { model: story.pipeline.qa, policy }
    : story.pipeline.qa;
}
