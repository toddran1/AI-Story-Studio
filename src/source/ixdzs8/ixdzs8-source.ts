import { load } from "cheerio";
import { validateWebChapter } from "../chapter-validation.js";
import { inspectNovelProvider } from "../novel-inspection.js";
import { FetchedNovelChapter, NovelBook, NovelChapterRef, NovelDownloadReference, NovelProviderDescriptor, NovelSearchResult, NovelSourceProvider } from "../novel-provider.js";
import { SourceInspectOptions, SourceInspection, StorySourceProvider } from "../types.js";
import { WebHttpClient } from "../web/http-client.js";
import { ixdzs8BookUrl, ixdzs8ChapterUrl, parseIxdzs8Url } from "./ixdzs8-url.js";
import { JsonCatalogTransport } from "../api/json-catalog.js";
import { decodeNovelTextDownload } from "../bulk-download.js";

const VERSION = "ixdzs8-v1";

export class Ixdzs8Source implements StorySourceProvider, NovelSourceProvider {
  readonly type = "web" as const; readonly id = "ixdzs8" as const; readonly displayName = "ixdzs8";
  readonly capabilities = { search: true, download: true, authentication: "none" as const, acquisition: ["html", "json-api", "bulk-download"] as Array<"html" | "json-api" | "bulk-download">, bulkFormats: ["txt"] as Array<"txt"> };
  readonly descriptor: NovelProviderDescriptor = { id: this.id, displayName: this.displayName, domains: ["ixdzs8.com", "www.ixdzs8.com", "*.ixdzs8.com"], languages: ["zh-CN"], priority: 100, reliability: "preferred", enabledByDefault: true, capabilities: this.capabilities, rateLimit: { minimumDelayMs: 700, maximumConcurrency: 2 } };
  constructor(private readonly http = new WebHttpClient({ allowedHosts: ["ixdzs8.com", "www.ixdzs8.com", "*.ixdzs8.com"], maintainCookies: true })) {}
  supportsUrl(input: string) { try { parseIxdzs8Url(input); return true; } catch { return false; } }
  async healthCheck() { await this.http.getText("https://ixdzs8.com/", { refresh: true }); }
  inspect(path: string, options?: SourceInspectOptions): Promise<SourceInspection> { return inspectNovelProvider(this, path, options, VERSION); }

  async search(query: string, limit = 20): Promise<NovelSearchResult[]> {
    if (!query.trim()) return [];
    const html = await this.http.getText(`https://ixdzs8.com/bsearch?q=${encodeURIComponent(query.trim())}`); assertNotChallenge(html, "ixdzs8 search");
    const $ = load(html); const results: NovelSearchResult[] = []; const seen = new Set<string>();
    $("li.burl").each((_, element) => {
      const link = $(element).find(".bname a").first(); const href = link.attr("href") ?? $(element).attr("data-url") ?? ""; const id = /\/read\/(\d+)/.exec(href)?.[1];
      if (!id || seen.has(id)) return; seen.add(id);
      results.push({ provider: this.id, bookId: id, url: ixdzs8BookUrl(id), title: clean(link.text()), author: optional($(element).find(".bauthor").first().text()),
        description: optional($(element).find(".l-p2").first().text()), latestChapter: optional($(element).find(".l-chapter").first().text()), coverUrl: absolute($(element).find("img").first().attr("src"), "https://ixdzs8.com") });
    });
    return results.slice(0, Math.max(0, limit));
  }

  async getBook(input: string): Promise<NovelBook> {
    const parsed = parseIxdzs8Url(input); const url = ixdzs8BookUrl(parsed.bookId); const html = await this.http.getText(url); assertNotChallenge(html, "ixdzs8 book page");
    const $ = load(html); const title = meta($, "og:novel:book_name") || clean($(".n-text h1, h1").first().text());
    if (!title) throw new Error("ixdzs8 book page is missing its title");
    const downloads = $("a[href]").toArray().flatMap((element) => /TXT\s*下载|TXT\s*下載/iu.test($(element).text()) ? [absolute($(element).attr("href"), url)] : []).filter((value): value is string => Boolean(value));
    return { provider: this.id, bookId: parsed.bookId, url, title, author: optional(meta($, "og:novel:author") || $(".bauthor").first().text()),
      description: optional(meta($, "og:description")), coverUrl: absolute(meta($, "og:image") || $(".n-img img").first().attr("src"), url), language: "zh-CN", metadata: { downloads } };
  }

  async getChapterList(book: NovelBook): Promise<NovelChapterRef[]> {
    return new JsonCatalogTransport(this.http, {
      label: "ixdzs8 catalog", request: { method: "POST_FORM", url: () => "https://ixdzs8.com/novel/clist/", fields: (value) => ({ bid: value.bookId }), headers: (value) => ({ Referer: value.url, Origin: "https://ixdzs8.com", "X-Requested-With": "XMLHttpRequest" }) },
      items: (payload) => { const data = (payload as { data?: unknown } | null)?.data; return Array.isArray(data) ? data : undefined; }, detectChallenge: challengeIndicators,
      chapter: (item, index, value) => { const row = item as { ordernum?: unknown; title?: unknown; ctype?: unknown }; if (row.ctype !== undefined && String(row.ctype) !== "0") return undefined; const order = String(row.ordernum ?? "").trim(); if (!/^\d+$/.test(order)) return undefined; const title = typeof row.title === "string" ? clean(row.title) : undefined; const chapterId = `p${order}`; return { provider: this.id, bookId: value.bookId, chapterId, chapter: chapterNumber(title) ?? index + 1, title, url: ixdzs8ChapterUrl(value.bookId, chapterId) }; },
    }).getChapterList(book);
  }

  async getChapter(ref: NovelChapterRef): Promise<FetchedNovelChapter> {
    const html = await this.http.getText(ref.url); const $ = load(html); const page = $(".page-content").first(); const container = page.find("section").first();
    const extractedTitle = optional(page.find(".page-d-top h1, h1, h3").first().text()); const paragraphs: string[] = [];
    const content = container.length ? container : page; content.find("p").each((_, element) => { if ($(element).hasClass("abg")) return; const text = clean($(element).text()); if (text && !isAd(text) && text !== "本章完") paragraphs.push(text); });
    if (!paragraphs.length && content.length) { const clone = content.clone(); clone.find("script,style,.abg").remove(); clone.find("br").replaceWith("\n"); for (const part of clone.text().split(/\r?\n/u)) { const text = clean(part); if (text && !isAd(text) && text !== "本章完" && text !== extractedTitle) paragraphs.push(text); } }
    const contentLocated = content.length > 0;
    return { ...ref, rawContent: html, rawHtml: html, text: paragraphs.join("\n\n"), contentLocated, contentContainerFound: contentLocated, extractedTitle, acquisitionTransport: "html", retrievedAt: new Date().toISOString(), indicators: challengeIndicators(html) };
  }
  async getBulkDownloads(book: NovelBook) { const urls = Array.isArray(book.metadata?.downloads) ? book.metadata.downloads.filter((value): value is string => typeof value === "string" && safeDownloadHost(value)) : []; return urls.map((url) => ({ provider: this.id, bookId: book.bookId, format: "txt" as const, url, label: "TXT download", container: /\.zip(?:$|[?#])/iu.test(url) ? "zip" as const : "plain" as const })); }
  async fetchBulkDownload(reference: NovelDownloadReference) { if (reference.provider !== this.id || reference.bookId.trim() === "") throw new Error("ixdzs8 bulk download reference does not belong to this provider"); const response = await this.http.getBinary(reference.url, { maxBytes: 100 * 1024 * 1024 }); return { reference, text: decodeNovelTextDownload(reference, response), retrievedAt: new Date().toISOString() }; }
  validateChapter(chapter: FetchedNovelChapter) { return validateWebChapter(chapter); }
}

function assertNotChallenge(html: string, context: string) { const indicators = challengeIndicators(html); if (indicators.length) throw new Error(`${context} is blocked by a browser-verification interstitial (${indicators.join(", ")})`); }
function challengeIndicators(value: string) { return [/正在验证浏览器|正在進行安全驗證|安全验证/iu, /challenge\s*=/iu].flatMap((pattern) => pattern.test(value) ? [pattern.source] : []); }
function clean(value: string) { return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
function optional(value: string) { return clean(value) || undefined; }
function meta($: ReturnType<typeof load>, property: string) { return clean($(`meta[property='${property}']`).attr("content") ?? ""); }
function absolute(value: string | undefined, base: string) { if (!value) return undefined; try { return new URL(value.startsWith("//") ? `https:${value}` : value, base).href; } catch { return undefined; } }
function isAd(value: string) { return /ixdzs8|最新网址|手机用户请|加入书签|返回目录/iu.test(value); }
function chapterNumber(title?: string) { const match = title ? /第\s*(\d+)\s*(?:章|话|話|节|節)/u.exec(title) : undefined; return match ? Number(match[1]) : undefined; }
function safeDownloadHost(value: string) { try { const host = new URL(value).hostname.toLowerCase(); return host === "ixdzs8.com" || host.endsWith(".ixdzs8.com"); } catch { return false; } }
