import { load } from "cheerio";
import { validateWebChapter } from "../chapter-validation.js";
import { inspectNovelProvider } from "../novel-inspection.js";
import { FetchedNovelChapter, NovelBook, NovelChapterRef, NovelDownloadReference, NovelProviderDescriptor, NovelSearchResult, NovelSourceProvider } from "../novel-provider.js";
import { SourceInspectOptions, SourceInspection, StorySourceProvider } from "../types.js";
import { WebHttpClient } from "../web/http-client.js";
import { decodeNovelTextDownload } from "../bulk-download.js";
import { parseShuhaigeUrl, shuhaigeBookUrl, shuhaigeChapterUrl } from "./shuhaige-url.js";

const VERSION = "shuhaige-v2"; const BASE = "https://www.shuhaige.net"; const MAX_PAGES = 50;

export class ShuhaigeSource implements StorySourceProvider, NovelSourceProvider {
  readonly type = "web" as const; readonly id = "shuhaige" as const; readonly displayName = "Shuhaige";
  readonly capabilities = { search: true, download: true, authentication: "none" as const, multiPageChapters: true, acquisition: ["html", "bulk-download"] as Array<"html" | "bulk-download">, bulkFormats: ["txt"] as Array<"txt"> };
  readonly descriptor: NovelProviderDescriptor = { id: this.id, displayName: this.displayName, domains: ["shuhaige.net", "www.shuhaige.net", "m.shuhaige.net", "*.shuhaige.net"], languages: ["zh-CN"], priority: 90, reliability: "preferred", enabledByDefault: true, capabilities: this.capabilities, rateLimit: { minimumDelayMs: 700, maximumConcurrency: 2 } };
  constructor(private readonly http = new WebHttpClient({ allowedHosts: ["shuhaige.net", "www.shuhaige.net", "m.shuhaige.net", "*.shuhaige.net"], maintainCookies: true, solveBrowserChallenge: true })) {}
  supportsUrl(input: string) { try { parseShuhaigeUrl(input); return true; } catch { return false; } }
  async healthCheck() { await this.http.getText(`${BASE}/`, { refresh: true }); }
  inspect(path: string, options?: SourceInspectOptions): Promise<SourceInspection> { return inspectNovelProvider(this, path, options, VERSION); }

  async search(query: string, limit = 20): Promise<NovelSearchResult[]> {
    if (!query.trim()) return [];
    const html = await this.http.postForm(`${BASE}/search.html`, { searchtype: "all", searchkey: query.trim() }, { headers: { Origin: BASE, Referer: `${BASE}/` } });
    const $ = load(html); const results: NovelSearchResult[] = []; const seen = new Set<string>();
    $("#sitembox dl").each((_, element) => {
      const link = $(element).find("h3 a, dt a").first(); const href = link.attr("href") ?? ""; const id = /\/(\d+)\/?$/.exec(new URL(href, BASE).pathname)?.[1];
      if (!id || seen.has(id)) return; seen.add(id); const title = clean(link.text() || $(element).find("img").first().attr("alt") || ""); if (!title) return;
      results.push({ provider: this.id, bookId: id, url: shuhaigeBookUrl(id), title, author: optional($(element).find(".book_other span").first().text()),
        latestChapter: optional($(element).find(".book_other a").last().text()), coverUrl: absolute($(element).find("img").first().attr("src"), BASE) });
    });
    return results.slice(0, Math.max(0, limit));
  }

  async getBook(input: string): Promise<NovelBook> {
    const parsed = parseShuhaigeUrl(input); const url = shuhaigeBookUrl(parsed.bookId); const html = await this.http.getText(url); const $ = load(html);
    assertNotInterstitial(html, "Shuhaige book page"); const title = clean($("#info h1, h1").first().text()); if (!title) throw new Error("Shuhaige book page is missing its title");
    const authorLine = clean($("#info p").filter((_, element) => /作者/u.test($(element).text())).first().text());
    return { provider: this.id, bookId: parsed.bookId, url, title, author: optional($("#info p a").first().text() || authorLine.replace(/^.*?作者[:：]?/u, "")),
      description: optional($("#intro p, #intro").first().text()), coverUrl: absolute($("#fmimg img").first().attr("src"), url), language: "zh-CN", metadata: { directoryHtml: html, downloadPages: downloadPageCandidates($, url, parsed.bookId) } };
  }

  async getChapterList(book: NovelBook): Promise<NovelChapterRef[]> {
    const html = typeof book.metadata?.directoryHtml === "string" ? book.metadata.directoryHtml : await this.http.getText(book.url); const $ = load(html); const refs: NovelChapterRef[] = []; const seen = new Set<string>();
    $("#list a[href]").each((_, element) => {
      const href = $(element).attr("href") ?? ""; const url = new URL(href, book.url); const match = /^\/(\d+)\/(\d+)(?:_\d+)?\.html$/.exec(url.pathname);
      if (!match || match[1] !== book.bookId || seen.has(match[2]!)) return; seen.add(match[2]!);
      const title = optional($(element).text()); refs.push({ provider: this.id, bookId: book.bookId, chapterId: match[2]!, chapter: chapterNumber(title) ?? refs.length + 1, title, url: shuhaigeChapterUrl(book.bookId, match[2]!) });
    });
    if (!refs.length) throw new Error("Shuhaige chapter directory was not found"); return refs;
  }

  async getChapter(ref: NovelChapterRef): Promise<FetchedNovelChapter> {
    const pages: string[] = []; let next = ref.url; const visited = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (visited.has(next)) throw new Error("Shuhaige multi-page chapter contains a pagination loop"); visited.add(next);
      const html = await this.http.getText(next); pages.push(html);
      if (/captcha|cloudflare|正在验证|安全验证|访问过于频繁|challenge=/iu.test(html)) break;
      const $ = load(html); const expectedNext = shuhaigeChapterUrl(ref.bookId, ref.chapterId, page + 1);
      const hasNext = $("a[href]").toArray().some((element) => new URL($(element).attr("href") ?? "", next).href === expectedNext);
      if (!hasNext) break; next = expectedNext;
      if (page === MAX_PAGES) throw new Error(`Shuhaige chapter exceeds the ${MAX_PAGES}-page safety limit`);
    }
    let extractedTitle: string | undefined; const paragraphs: string[] = []; let containerFound = false;
    for (const html of pages) {
      const $ = load(html); extractedTitle ??= optional($(".bookname h1, h1").first().text()); const container = $("#content").first(); containerFound ||= container.length > 0;
      container.find("p").each((_, element) => { for (const part of $(element).text().split(/\r?\n|<br\s*\/?\s*>/i)) { const line = clean(part).replace(/\(本章完\)$/u, "").trim(); if (line && !isAd(line)) paragraphs.push(line); } });
      if (!container.find("p").length) for (const part of container.text().split(/\r?\n/)) { const line = clean(part); if (line && !isAd(line)) paragraphs.push(line); }
    }
    return { ...ref, rawHtml: pages.join("\n<!-- page -->\n"), text: dedupeBoundary(paragraphs).join("\n\n"), contentContainerFound: containerFound, extractedTitle, acquisitionTransport: "html", retrievedAt: new Date().toISOString() };
  }
  async getBulkDownloads(book: NovelBook) {
    const pages = Array.isArray(book.metadata?.downloadPages) ? book.metadata.downloadPages.filter((value): value is string => typeof value === "string") : [];
    const candidates = pages.length ? pages : [`https://m.shuhaige.net/txt_${book.bookId}.html`]; const downloads = new Map<string, { url: string; label?: string; container: "plain" | "zip" }>();
    for (const page of candidates.slice(0, 5)) {
      if (/\.(?:txt|zip)(?:$|[?#])/iu.test(page)) { downloads.set(page, { url: page, label: "Full TXT", container: /\.zip(?:$|[?#])/iu.test(page) ? "zip" : "plain" }); continue; }
      let html: string; try { html = await this.http.getText(page); } catch { continue; }
      const $ = load(html); $("a[href]").each((_, element) => {
        const label = clean($(element).text()); const href = $(element).attr("href"); if (!href || !/(?:全文|全集|全本).*(?:txt|下载)|(?:txt|下载).*(?:全文|全集|全本)/iu.test(label)) return;
        const url = safeShuhaigeDownloadUrl(href, page); if (!url) return; downloads.set(url, { url, label, container: /\.zip(?:$|[?#])/iu.test(url) ? "zip" : "plain" });
      });
    }
    return [...downloads.values()].map((item) => ({ provider: this.id, bookId: book.bookId, format: "txt" as const, ...item }));
  }
  async fetchBulkDownload(reference: NovelDownloadReference) {
    if (reference.provider !== this.id || reference.bookId.trim() === "") throw new Error("Shuhaige bulk download reference does not belong to this provider");
    const response = await this.http.getBinary(reference.url, { maxBytes: 100 * 1024 * 1024 }); const text = decodeNovelTextDownload(reference, response);
    return { reference, text, retrievedAt: new Date().toISOString() };
  }
  validateChapter(chapter: FetchedNovelChapter) { return validateWebChapter(chapter); }
}

function assertNotInterstitial(html: string, context: string) { if (/captcha|cloudflare|正在验证|安全验证|访问过于频繁|challenge=/iu.test(html)) throw new Error(`${context} is blocked by a challenge or access interstitial`); }
function clean(value: string) { return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
function optional(value: string) { return clean(value) || undefined; }
function absolute(value: string | undefined, base: string) { if (!value) return undefined; try { return new URL(value, base).href; } catch { return undefined; } }
function isAd(value: string) { return /shuhaige\.net|书海阁|最新网址|点击下一页|加入书签|返回目录/iu.test(value); }
function dedupeBoundary(lines: string[]) { return lines.filter((line, index) => index === 0 || line !== lines[index - 1]); }
function chapterNumber(title?: string) { const match = title ? /第\s*(\d+)\s*(?:章|话|話|节|節)/u.exec(title) : undefined; return match ? Number(match[1]) : undefined; }
function downloadPageCandidates($: ReturnType<typeof load>, base: string, bookId: string) {
  const pages = new Set<string>(); $("a[href]").each((_, element) => { const href = $(element).attr("href"); const label = clean($(element).text()); if (!href || !/txt|下载|下載/iu.test(`${label} ${href}`)) return; const url = safeShuhaigeDownloadUrl(href, base); if (url) pages.add(url); });
  pages.add(`https://m.shuhaige.net/txt_${bookId}.html`); return [...pages];
}
function safeShuhaigeDownloadUrl(value: string, base: string) {
  try { const normalized = value.startsWith("//.shuhaige.net/") ? `https://m.shuhaige.net/${value.slice("//.shuhaige.net/".length)}` : value; const url = new URL(normalized, base); if (url.protocol !== "https:" || !(url.hostname === "shuhaige.net" || url.hostname.endsWith(".shuhaige.net"))) return undefined; return url.href; } catch { return undefined; }
}
