import { Story } from "../domain/story.js";
import { SourceInspection } from "./types.js";

export function applySourceMetadata(story: Story, inspection: SourceInspection, isNew: boolean): Story {
  return {
    ...story,
    title: isNew && inspection.title ? inspection.title : story.title,
    author: story.author ?? inspection.author,
    sourceLanguage: isNew && inspection.language ? normalizeLanguage(inspection.language) : story.sourceLanguage,
    source: inspection.origin
      ? { type: inspection.sourceType, path: "source", url: inspection.origin.url, externalId: inspection.origin.bookId }
      : { type: inspection.sourceType, path: "source" },
  };
}

function normalizeLanguage(language: string) {
  const normalized = language.trim().replace(/_/g, "-");
  if (normalized.toLowerCase() === "en") return "en-US";
  if (normalized.toLowerCase() === "zh") return "zh-CN";
  return normalized;
}
