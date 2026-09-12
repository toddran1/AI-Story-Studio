import { Story } from "../domain/story.js";
import { SourceInspection } from "./types.js";
import { StoryNovelSource } from "./novel-provider.js";
import { novelProviderIdSchema } from "./novel-provider.js";

export function applySourceMetadata(story: Story, inspection: SourceInspection, isNew: boolean): Story {
  const parsedProvider = novelProviderIdSchema.safeParse(inspection.metadata?.provider); const provider = parsedProvider.success ? parsedProvider.data : undefined;
  const existing = provider && inspection.origin ? story.sources.find((item) => item.provider === provider && item.bookId === (inspection.origin?.bookId ?? String(inspection.metadata?.bookId ?? ""))) : undefined;
  const novelSource: StoryNovelSource | undefined = inspection.origin && provider ? {
    provider, bookId: inspection.origin.bookId ?? String(inspection.metadata?.bookId ?? ""), url: inspection.origin.url,
    title: inspection.title, author: inspection.author, addedAt: existing?.addedAt ?? new Date().toISOString(), lastInspectedAt: inspection.remote?.lastInspectedAt,
    priority: existing?.priority ?? (provider === "fanqie" ? 900 : 100), enabled: existing?.enabled ?? true,
  } : undefined;
  const sources = novelSource?.bookId ? [...story.sources.filter((item) => !(item.provider === novelSource.provider && item.bookId === novelSource.bookId)), novelSource] : story.sources;
  return {
    ...story,
    title: isNew && inspection.title ? inspection.title : story.title,
    author: story.author ?? inspection.author,
    sourceLanguage: isNew && inspection.language ? normalizeLanguage(inspection.language) : story.sourceLanguage,
    source: inspection.origin
      ? { type: inspection.sourceType, path: "source", url: inspection.origin.url, externalId: inspection.origin.bookId }
      : { type: inspection.sourceType, path: "source" },
    sources,
  };
}

function normalizeLanguage(language: string) {
  const normalized = language.trim().replace(/_/g, "-");
  if (normalized.toLowerCase() === "en") return "en-US";
  if (normalized.toLowerCase() === "zh") return "zh-CN";
  return normalized;
}
