import { z } from "zod";

export const novelProviderIdSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Provider IDs must be lowercase kebab-case");
export type NovelProviderId = z.infer<typeof novelProviderIdSchema>;

export const acquisitionTransportSchema = z.enum(["html", "json-api", "bulk-download"]);
export type AcquisitionTransport = z.infer<typeof acquisitionTransportSchema>;

export const chapterValidationStatusSchema = z.enum(["COMPLETE", "TRUNCATED", "LOCKED", "CHALLENGE_REQUIRED", "BLOCKED", "INVALID"]);
export type ChapterValidationStatus = z.infer<typeof chapterValidationStatusSchema>;

export const chapterValidationEvidenceSchema = z.object({
  extractedCharacters: z.number().int().nonnegative(),
  expectedCharacters: z.number().int().positive().optional(),
  contentContainerFound: z.boolean(),
  expectedChapterIdentity: z.string().optional(),
  extractedChapterIdentity: z.string().optional(),
  indicators: z.array(z.string()).default([]),
  reasons: z.array(z.string()).min(1),
});
export type ChapterValidationEvidence = z.infer<typeof chapterValidationEvidenceSchema>;

export const chapterValidationSchema = z.object({
  status: chapterValidationStatusSchema,
  evidence: chapterValidationEvidenceSchema,
});
export type ChapterValidation = z.infer<typeof chapterValidationSchema>;

export type NovelProviderCapabilities = {
  search: boolean;
  download: boolean;
  authentication: "none" | "optional" | "required";
  multiPageChapters?: boolean;
  acquisition?: AcquisitionTransport[];
  bulkFormats?: Array<"txt" | "epub" | "html">;
};

export const providerReliabilitySchema = z.enum(["preferred", "standard", "limited", "legacy"]);
export type NovelProviderDescriptor = {
  id: NovelProviderId;
  displayName: string;
  domains: string[];
  languages: string[];
  priority: number;
  reliability: z.infer<typeof providerReliabilitySchema>;
  enabledByDefault: boolean;
  capabilities: NovelProviderCapabilities;
  rateLimit: { minimumDelayMs: number; maximumConcurrency: number };
};

export type NovelSearchResult = {
  provider: NovelProviderId;
  bookId: string;
  url: string;
  title: string;
  author?: string;
  description?: string;
  coverUrl?: string;
  latestChapter?: string;
  chapterCount?: number;
};

export type NovelBook = NovelSearchResult & {
  status?: string;
  language?: string;
  metadata?: Record<string, unknown>;
};

export type NovelChapterRef = {
  provider: NovelProviderId;
  bookId: string;
  chapterId: string;
  chapter: number;
  title?: string;
  url: string;
  expectedCharacters?: number;
};

export type FetchedNovelChapter = NovelChapterRef & {
  text: string;
  /** Raw transport response retained for diagnostics. Providers may return HTML, JSON, or decoded download content. */
  rawContent?: string;
  /** Backward-compatible HTML-specific diagnostic field. */
  rawHtml?: string;
  contentLocated?: boolean;
  /** Backward-compatible HTML-specific location field. */
  contentContainerFound?: boolean;
  extractedTitle?: string;
  advertisedCharacters?: number;
  indicators?: string[];
  acquisitionTransport?: AcquisitionTransport;
  acquisitionUrl?: string;
  retrievedAt: string;
};

export type NovelDownloadReference = {
  provider: NovelProviderId;
  bookId: string;
  format: "txt" | "epub" | "html";
  url: string;
  label?: string;
  container?: "plain" | "zip";
};

export type NovelDownloadPayload = {
  reference: NovelDownloadReference;
  text: string;
  retrievedAt: string;
};

export interface NovelSourceProvider {
  readonly id: NovelProviderId;
  readonly displayName: string;
  readonly capabilities: NovelProviderCapabilities;
  readonly descriptor?: NovelProviderDescriptor;
  supportsUrl(input: string): boolean;
  search(query: string, limit?: number): Promise<NovelSearchResult[]>;
  getBook(input: string): Promise<NovelBook>;
  getChapterList(book: NovelBook): Promise<NovelChapterRef[]>;
  getChapter(chapter: NovelChapterRef): Promise<FetchedNovelChapter>;
  validateChapter(chapter: FetchedNovelChapter): ChapterValidation;
  getBulkDownloads?(book: NovelBook): Promise<NovelDownloadReference[]>;
  fetchBulkDownload?(reference: NovelDownloadReference): Promise<NovelDownloadPayload>;
  healthCheck?(): Promise<void>;
}

export const storyNovelSourceSchema = z.object({
  provider: novelProviderIdSchema,
  bookId: z.string().min(1),
  url: z.url(),
  title: z.string().optional(),
  author: z.string().optional(),
  addedAt: z.iso.datetime(),
  lastInspectedAt: z.iso.datetime().optional(),
  priority: z.number().int().min(0).max(10_000).default(100),
  enabled: z.boolean().default(true),
});
export type StoryNovelSource = z.infer<typeof storyNovelSourceSchema>;

export function chapterProvenance(chapter: FetchedNovelChapter, validation: ChapterValidation) {
  return {
    provider: chapter.provider,
    sourceBookId: chapter.bookId,
    sourceChapterId: chapter.chapterId,
    sourceUrl: chapter.url,
    retrievedAt: chapter.retrievedAt,
    validation: chapterValidationSchema.parse(validation),
    characterCount: [...chapter.text].length,
    acquisitionTransport: chapter.acquisitionTransport ?? "html",
    ...(chapter.acquisitionUrl ? { acquisitionUrl: chapter.acquisitionUrl } : {}),
  };
}
