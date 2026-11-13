import { load } from "cheerio";
import { z } from "zod";
import { validateWebChapter } from "../chapter-validation.js";
import { SourceAuthenticationRequiredError, SourceInputError, SourceValidationError } from "../errors.js";
import { inspectNovelProvider } from "../novel-inspection.js";
import type { FetchedNovelChapter, NovelBook, NovelChapterRef, NovelProviderDescriptor, NovelSearchResult, NovelSourceProvider } from "../novel-provider.js";
import type { SourceInspectOptions, StorySourceProvider } from "../types.js";
import { WebHttpClient, WebHttpError } from "../web/http-client.js";

const BASE = "https://tomatomtl.com";
const HOSTS = ["tomatomtl.com", "www.tomatomtl.com"];
const catalogSchema = z.array(z.object({ id: z.string().regex(/^\d{1,24}$/u), title: z.string().trim().min(1) })).min(1).max(20_000);

function parseUrl(input: string) {
  const url = new URL(input);
  const match = /^\/book\/(\d{1,24})(?:\/(\d{1,24}))?\/?$/u.exec(url.pathname);
  if (url.protocol !== "https:" || url.port || url.username || url.password || !HOSTS.includes(url.hostname) || !match) {
    throw new SourceInputError("Use a TomatoMTL HTTPS book or chapter URL.");
  }
  return { bookId: match[1]!, chapterId: match[2] };
}

export class TomatoMtlSource implements NovelSourceProvider, StorySourceProvider {
  readonly type = "web" as const;
  readonly id = "tomatomtl";
  readonly displayName = "TomatoMTL";
  readonly capabilities = { search: false, download: true, authentication: "required" as const, acquisition: ["html" as const] };
  readonly descriptor: NovelProviderDescriptor = {
    id: this.id, displayName: this.displayName, domains: HOSTS, languages: ["en-US"], priority: 950, reliability: "limited",
    enabledByDefault: false, capabilities: this.capabilities, rateLimit: { minimumDelayMs: 1000, maximumConcurrency: 1 },
  };

  private chapterReader?: (url: string, signal?: AbortSignal) => Promise<string>;
  setChapterReader(reader: (url: string, signal?: AbortSignal) => Promise<string>) { this.chapterReader = reader; }

  constructor(private readonly http = new WebHttpClient({ allowedHosts: HOSTS, maintainCookies: true, requestDelayMs: 1000 })) {}
  supportsUrl(input: string) { try { parseUrl(input); return true; } catch { return false; } }
  async search(): Promise<NovelSearchResult[]> { return []; }
  async getBook(input: string, options: SourceInspectOptions = {}): Promise<NovelBook> {
    const { bookId } = parseUrl(input);
    const url = `${BASE}/book/${bookId}`;
    const $ = load(await this.http.getText(url, { ...options, allowedHosts: HOSTS, noCache: true }));
    const title = $("meta[property='og:novel:book_name']").attr("content")?.trim();
    if (!title || /^error:/iu.test(title)) throw new SourceValidationError("TomatoMTL did not return usable book metadata.");
    return { provider: this.id, bookId, url, title, author: $("#book_author_link a").first().text().trim() || undefined, language: "en-US", description: $("#description").text().trim() || undefined };
  }
  async getChapterList(book: NovelBook, options: SourceInspectOptions = {}): Promise<NovelChapterRef[]> {
    const { bookId } = parseUrl(book.url);
    const catalog = catalogSchema.parse(JSON.parse(await this.http.getText(`${BASE}/catalog/${bookId}`, { ...options, allowedHosts: HOSTS, noCache: true })));
    if (new Set(catalog.map(row => row.id)).size !== catalog.length) throw new SourceValidationError("TomatoMTL returned duplicate chapter IDs.");
    return catalog.map((row, index) => ({ provider: this.id, bookId, chapterId: row.id, chapter: index + 1, title: row.title, url: `${BASE}/book/${bookId}/${row.id}` }));
  }
  async getChapter(ref: NovelChapterRef, options: SourceInspectOptions = {}): Promise<FetchedNovelChapter> {
    const { bookId, chapterId } = parseUrl(ref.url);
    if (bookId !== ref.bookId || chapterId !== ref.chapterId) throw new SourceValidationError("TomatoMTL chapter URL does not match its catalog entry.");
    let html: string;
    const chapterUrl = `${BASE}/book/${bookId}/${chapterId}`;
    try { html = this.chapterReader ? await this.chapterReader(chapterUrl, options.signal) : await this.http.getText(chapterUrl, { ...options, allowedHosts: HOSTS, noCache: true }); }
    catch (error) { if (error instanceof WebHttpError && error.status === 401) throw new SourceAuthenticationRequiredError("TomatoMTL sign-in required. Sign in through Story Studio’s verification window and retry."); throw error; }
    const $ = load(html);
    if (/login required|^login$/iu.test($("title").text().trim()) || $("#loginForm").length) {
      throw new SourceAuthenticationRequiredError("TomatoMTL sign-in required. Sign in through Story Studio’s verification window and retry.");
    }
    const content = $("#chapter_content").first();
    content.find("script,style,aside,iframe,[hidden],.adsbygoogle").remove();
    const text = content.find("p").map((_, p) => $(p).text().trim()).get().filter(Boolean).join("\n\n");
    const extractedTitle = $("#chapter_title").first().text().trim();
    const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
    const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
    if (!extractedTitle || !text || !latin || han > latin) throw new SourceValidationError("TomatoMTL did not return an English chapter body in the signed-in response.");
    return { ...ref, extractedTitle, text, contentLocated: true, acquisitionTransport: "html", retrievedAt: new Date().toISOString() };
  }
  validateChapter(chapter: FetchedNovelChapter) { return validateWebChapter(chapter); }
  inspect(input: string, options: SourceInspectOptions = {}) { return inspectNovelProvider(this, input, options, "tomatomtl-v1"); }
}
