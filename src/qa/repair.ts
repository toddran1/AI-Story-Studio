import { QaResult } from "../domain/qa.js";

export function selectRepairStage(qa: QaResult): "translation" | "narration" {
  const translationCategories = new Set(["completeness", "names", "numbers", "terminology", "dialogue"]);
  return qa.issues.some((issue) => translationCategories.has(issue.category)) ? "translation" : "narration";
}
