import type { Story } from "../domain/story.js";
import type { FreshQaDetection } from "./review.js";

/** Story-level scope for QA findings. This runs before finding reconciliation. */
export function filterQaDetectionsForStory<T extends Pick<FreshQaDetection, "category" | "message"> & { ruleKey?: string }>(story: Story, detections: T[]): T[] {
  const disabled = new Set(story.qaPolicy.disabledCategories);
  const duplicateDisabled = story.qaPolicy.disabledRules.includes("duplicateParagraph");
  return detections.filter((item) => {
    if (disabled.has(item.category)) return false;
    if (duplicateDisabled && (item.ruleKey?.startsWith("completeness:duplicate-paragraph:") || (item.category === "completeness" && /(?:duplicate|repeat(?:ed|s|ing)?)\s+(?:a\s+)?paragraph|paragraph\s+(?:is\s+)?(?:duplicate|repeat)/i.test(item.message)))) return false;
    return true;
  });
}

export function qaPolicyPrompt(story: Story): string {
  const disabled = story.qaPolicy.disabledCategories;
  const duplicate = story.qaPolicy.disabledRules.includes("duplicateParagraph");
  if (!disabled.length && !duplicate) return "";
  return `STORY QA POLICY: Do not report findings in these disabled categories: ${disabled.join(", ") || "none"}.${duplicate ? " Repeated paragraphs are expected in this story; do not flag duplicate paragraphs solely for repetition." : ""} Continue checking all other issues normally.`;
}
