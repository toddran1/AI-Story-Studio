import { fingerprint } from "../../utils/hash.js";
import { RawChapter, SourceInspectOptions, SourceInspection, SourceWarning, StorySourceProvider } from "../types.js";
import { WebHttpClient } from "../web/http-client.js";
import { parseFanqieBook } from "./book-parser.js";
import { bookIdFromChapterPage, FanqieLockedChapterError, parseFanqieChapter } from "./chapter-parser.js";
import { fanqieBookUrl, parseFanqieUrl } from "./fanqie-url.js";
import { validateWebChapter } from "../chapter-validation.js";
import { chapterProvenance, FetchedNovelChapter, NovelBook, NovelChapterRef, NovelProviderDescriptor, NovelSearchResult, NovelSourceProvider } from "../novel-provider.js";

const ADAPTER_VERSION = "fanqie-v1";

export class FanqieSource implements StorySourceProvider, NovelSourceProvider {
  readonly type = "fanqie" as const;
  readonly id = "fanqie" as const; readonly displayName = "Fanqie";
  readonly capabilities = { search: false, download: true, authentication: "optional" as const, acquisition: ["html", "json-api"] as Array<"html" | "json-api"> };
  readonly descriptor: NovelProviderDescriptor = { id: this.id, displayName: this.displayName, domains: ["fanqienovel.com", "www.fanqienovel.com"], languages: ["zh-CN"], priority: 900, reliability: "limited", enabledByDefault: false, capabilities: this.capabilities, rateLimit: { minimumDelayMs: 1_000, maximumConcurrency: 1 } };
  constructor(private readonly http = new WebHttpClient({ allowedHosts: ["fanqienovel.com", "www.fanqienovel.com"] })) {}

  supportsUrl(input: string) { try { parseFanqieUrl(input); return true; } catch { return false; } }
  async healthCheck() { await this.http.getText("https://fanqienovel.com/", { refresh: true }); }
  async search(_query: string, _limit?: number): Promise<NovelSearchResult[]> { return []; }
  async getBook(input: string): Promise<NovelBook> {
    const parsed = parseFanqieUrl(input); let bookId = parsed.id;
    if (parsed.kind === "chapter") bookId = bookIdFromChapterPage(await this.http.getText(parsed.url));
    const url = fanqieBookUrl(bookId); const book = parseFanqieBook(await this.http.getText(url), url, bookId);
    return { provider: this.id, bookId, url, title: book.title, author: book.author, description: book.description, coverUrl: book.coverUrl,
      status: book.status, chapterCount: book.chapterCount, language: "zh-CN", metadata: { directory: book.directory } };
  }
  async getChapterList(book: NovelBook): Promise<NovelChapterRef[]> {
    const raw = book.metadata?.directory;
    const directory = Array.isArray(raw) ? raw : parseFanqieBook(await this.http.getText(book.url), book.url, book.bookId).directory;
    return directory.map((item, index) => {
      const ref = item as { sourceId?: unknown; originalTitle?: unknown; metadata?: Record<string, unknown> };
      const chapterId = String(ref.sourceId ?? ""); if (!/^\d+$/.test(chapterId)) throw new Error("Fanqie directory contains an invalid chapter ID");
      return { provider: this.id, bookId: book.bookId, chapterId, chapter: index + 1, title: typeof ref.originalTitle === "string" ? ref.originalTitle : undefined,
        url: typeof ref.metadata?.url === "string" ? ref.metadata.url : `https://fanqienovel.com/reader/${chapterId}` };
    });
  }
  async getChapter(ref: NovelChapterRef): Promise<FetchedNovelChapter> {
    const html = await this.http.getText(ref.url);
    try {
      const parsed = parseFanqieChapter(html); return { ...ref, rawHtml: html, text: parsed.text, contentContainerFound: true, extractedTitle: parsed.title, acquisitionTransport: "html", retrievedAt: new Date().toISOString() };
    } catch (error) {
      if (!(error instanceof FanqieLockedChapterError)) throw error;
      return { ...ref, rawHtml: html, text: "", contentContainerFound: /muye-reader-content/u.test(html), extractedTitle: ref.title,
        advertisedCharacters: error.advertisedCharacters, indicators: ["isChapterLock/login preview"], acquisitionTransport: "html", retrievedAt: new Date().toISOString() };
    }
  }
  validateChapter(chapter: FetchedNovelChapter) { return validateWebChapter(chapter); }

  async inspect(sourcePath: string, options: SourceInspectOptions = {}): Promise<SourceInspection> {
    const parsed = parseFanqieUrl(sourcePath); let bookId = parsed.id;
    if (parsed.kind === "chapter") bookId = bookIdFromChapterPage(await this.http.getText(parsed.url, { refresh: options.refresh }));
    const sourceUrl = fanqieBookUrl(bookId); const book = parseFanqieBook(await this.http.getText(sourceUrl, { refresh: options.refresh }), sourceUrl, bookId);
    if (options.from && options.to && options.from > options.to) throw new Error("--from cannot be greater than --to");
    let requested = options.chapters ? new Set(options.chapters) : undefined; let selected;
    if (!requested && (options.from !== undefined || options.to !== undefined)) {
      const from = options.from ?? 1; const to = options.to ?? book.directory.length;
      if (from > book.directory.length || to > book.directory.length) throw new Error(`Requested range ${from}-${to} exceeds the ${book.directory.length} exposed Fanqie chapters`);
      selected = book.directory.filter((ref) => ref.chapter >= from && ref.chapter <= to);
    }
    if (!requested && !selected && options.probe) selected = book.directory.slice(0, options.probe);
    selected ??= requested ? book.directory.filter((ref) => requested!.has(ref.chapter)) : [];
    if (requested && selected.length !== requested.size) {
      const found = new Set(selected.map((ref) => ref.chapter)); const missing = [...requested].filter((chapter) => !found.has(chapter));
      throw new Error(`Requested chapters are not present in the Fanqie directory: ${missing.join(", ")}`);
    }
    const chapters: RawChapter[] = [];
    const warnings: SourceWarning[] = book.chapterCount !== book.directory.length ? [{ code: "unavailable_chapter", message: `Fanqie reports ${book.chapterCount} chapters but exposes ${book.directory.length}` }] : [];
    for (const ref of selected) {
      try {
        const novelRef: NovelChapterRef = { provider: this.id, bookId, chapterId: ref.sourceId, chapter: ref.chapter, title: ref.originalTitle, url: String(ref.metadata.url) };
        const fetched = await this.getChapter(novelRef); const validation = this.validateChapter(fetched);
        if (validation.status !== "COMPLETE") {
          warnings.push({ code: "unavailable_chapter", sourceId: ref.sourceId, message: validationMessage(ref.chapter, validation.status, validation.evidence.extractedCharacters, validation.evidence.expectedCharacters, validation.evidence.reasons) });
          continue;
        }
        chapters.push({ ref: { ...ref, originalTitle: fetched.extractedTitle ?? ref.originalTitle, metadata: { ...ref.metadata, ...chapterProvenance(fetched, validation) } }, text: fetched.text });
      } catch (error) {
        warnings.push({ code: "unavailable_chapter", sourceId: ref.sourceId, message: `Chapter ${ref.chapter} · Fanqie · INVALID: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    const now = new Date().toISOString(); const metadata = { provider: this.id, title: book.title, author: book.author, description: book.description,
      coverUrl: book.coverUrl, status: book.status, bookId, sourceUrl };
    return {
      sourcePath: sourceUrl, sourceType: this.type, title: book.title, author: book.author, language: "zh-CN",
      fingerprint: fingerprint({ adapter: ADAPTER_VERSION, metadata, directory: book.directory }), chapters, directory: book.directory,
      unnumberedSections: [], warnings,
      origin: { url: sourceUrl, bookId }, metadata, remote: { lastInspectedAt: now, chapterCountAtInspection: book.chapterCount }, additive: true,
      adapterVersion: ADAPTER_VERSION,
    };
  }
}

function validationMessage(chapter: number, status: string, extracted: number, expected: number | undefined, reasons: string[]) {
  return `Chapter ${chapter} · Fanqie · ${status} · ${extracted}${expected ? ` / ~${expected}` : ""} characters: ${reasons.join("; ")}`;
}
