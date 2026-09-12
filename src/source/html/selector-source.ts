import { load } from "cheerio";
import type { CheerioAPI } from "cheerio";
import { validateWebChapter, ValidationOptions } from "../chapter-validation.js";
import { inspectNovelProvider } from "../novel-inspection.js";
import { FetchedNovelChapter, NovelBook, NovelChapterRef, NovelProviderDescriptor, NovelSearchResult, NovelSourceProvider } from "../novel-provider.js";
import { SourceInspectOptions, SourceInspection, StorySourceProvider } from "../types.js";
import { WebHttpClient } from "../web/http-client.js";

export type SelectorSourceConfig = {
  descriptor: NovelProviderDescriptor;
  baseUrl: string;
  parseUrl(input: URL): { bookId: string; chapterId?: string } | undefined;
  bookUrl(bookId: string): string;
  chapterUrl(bookId: string, chapterId: string, page?: number): string;
  selectors: {
    title: string; author?: string; description?: string; cover?: string;
    directory: string; chapterTitle: string; content: string;
  };
  parseChapterHref(url: URL, bookId: string): string | undefined;
  catalogPageUrls?: (bookId: string, firstHtml: string, $: CheerioAPI) => string[];
  nextChapterPage?: (ref: NovelChapterRef, page: number, html: string, $: CheerioAPI) => string | undefined;
  cleanLine?: (line: string, title?: string) => string | undefined;
  validation?: ValidationOptions;
  search?: {
    url(query: string): string; result: string; link: string; author?: string; latest?: string;
    method?: "GET" | "POST_FORM"; fields?: (query: string) => Record<string, string>; headers?: Record<string, string>;
  };
  discoveryIndex?: { landingPath: string; writerPath: RegExp; authorPath: RegExp; fallbackWriterPaths: string[]; ttlMs?: number };
};

export class SelectorNovelSource implements StorySourceProvider, NovelSourceProvider {
  readonly type = "web" as const; readonly id; readonly displayName; readonly capabilities; readonly descriptor;
  private readonly http: WebHttpClient;
  private discoveryCache?: { expiresAt: number; results: NovelSearchResult[] };
  constructor(private readonly config: SelectorSourceConfig, http?: WebHttpClient) {
    this.http = http ?? new WebHttpClient({ allowedHosts: config.descriptor.domains, maintainCookies: true });
    this.id = config.descriptor.id; this.displayName = config.descriptor.displayName; this.capabilities = config.descriptor.capabilities; this.descriptor = config.descriptor;
  }
  supportsUrl(input: string) { try { const url = new URL(input); return this.config.descriptor.domains.includes(url.hostname.toLowerCase()) && Boolean(this.config.parseUrl(url)); } catch { return false; } }
  inspect(path: string, options?: SourceInspectOptions): Promise<SourceInspection> { return inspectNovelProvider(this, path, options, `${this.id}-selector-v2`); }
  async healthCheck() { await this.http.getText(this.config.baseUrl, { refresh: true }); }
  async search(query: string, limit = 20): Promise<NovelSearchResult[]> {
    if (!query.trim()) return [];
    if (this.config.discoveryIndex) return this.searchDiscoveryIndex(query.trim(), limit);
    const search = this.config.search; if (!search) return [];
    const html = search.method === "POST_FORM" ? await this.http.postForm(search.url(query.trim()), search.fields?.(query.trim()) ?? {}, { headers: search.headers }) : await this.http.getText(search.url(query.trim())); const $ = load(html); const results: NovelSearchResult[] = []; const seen = new Set<string>();
    $(search.result).each((_, element) => {
      const link = $(element).find(search.link).first(); const href = link.attr("href"); if (!href) return;
      const url = new URL(href, this.config.baseUrl); const parsed = this.config.parseUrl(url); const title = clean(link.text()); if (!parsed?.bookId || !title || seen.has(parsed.bookId)) return; seen.add(parsed.bookId);
      results.push({ provider: this.id, bookId: parsed.bookId, url: this.config.bookUrl(parsed.bookId), title,
        author: search.author ? optional($(element).find(search.author).first().text()) : undefined,
        latestChapter: search.latest ? optional($(element).find(search.latest).first().text()) : undefined });
    });
    return results.slice(0, Math.max(0, limit));
  }
  async getBook(input: string): Promise<NovelBook> {
    const parsed = this.parse(input); const url = this.config.bookUrl(parsed.bookId); const html = await this.http.getText(url); assertPage(html, this.displayName);
    const $ = load(html); const title = first($, this.config.selectors.title) || meta($, "og:novel:book_name") || meta($, "og:title"); if (!title) throw new Error(`${this.displayName} book page is missing its title`);
    return { provider: this.id, bookId: parsed.bookId, url, title, author: optional(first($, this.config.selectors.author) || meta($, "og:novel:author")),
      description: optional(first($, this.config.selectors.description) || meta($, "og:description")), coverUrl: absolute(attribute($, this.config.selectors.cover, "src") || meta($, "og:image"), url),
      language: this.descriptor.languages[0], metadata: { firstHtml: html } };
  }
  async getChapterList(book: NovelBook): Promise<NovelChapterRef[]> {
    const firstHtml = typeof book.metadata?.firstHtml === "string" ? book.metadata.firstHtml : await this.http.getText(book.url); const firstDocument = load(firstHtml);
    const urls = this.config.catalogPageUrls?.(book.bookId, firstHtml, firstDocument) ?? [book.url]; if (!urls.length || urls.length > 500) throw new Error(`${this.displayName} catalog page count is outside the 1-500 safety limit`);
    const normalizedUrls = [...new Set(urls)]; if (normalizedUrls.length !== urls.length) throw new Error(`${this.displayName} catalog pagination contains duplicate page URLs`);
    const pages = [firstHtml];
    for (const url of normalizedUrls) if (url !== book.url) { const html = await this.http.getText(url); const page = load(html); if (!page(this.config.selectors.directory).length) throw new Error(`${this.displayName} catalog page ${url} did not contain a chapter directory`); pages.push(html); }
    const refs: NovelChapterRef[] = []; const seen = new Set<string>();
    for (const html of pages) { const $ = load(html); $(this.config.selectors.directory).each((_, element) => {
      const href = $(element).attr("href"); if (!href) return; const url = new URL(href, book.url); const chapterId = this.config.parseChapterHref(url, book.bookId); if (!chapterId || seen.has(chapterId)) return; seen.add(chapterId);
      const title = optional($(element).text()); refs.push({ provider: this.id, bookId: book.bookId, chapterId, chapter: explicitChapterNumber(title) ?? refs.length + 1, title, url: this.config.chapterUrl(book.bookId, chapterId) });
    }); }
    if (!refs.length) throw new Error(`${this.displayName} chapter directory was not found`); return refs;
  }
  async getChapter(ref: NovelChapterRef): Promise<FetchedNovelChapter> {
    const pages: string[] = []; const paragraphs: string[] = []; let extractedTitle: string | undefined; let contentContainerFound = false; const visited = new Set<string>(); let next = ref.url;
    for (let page = 1; page <= 50; page++) {
      if (visited.has(next)) throw new Error(`${this.displayName} chapter pagination loop detected`); visited.add(next);
      const html = await this.http.getText(next); pages.push(html); const $ = load(html); extractedTitle ??= optional(first($, this.config.selectors.chapterTitle)); const containers = $(this.config.selectors.content); if (page > 1 && !containers.length) throw new Error(`${this.displayName} continuation page ${page} did not contain chapter content`); contentContainerFound ||= containers.length > 0;
      containers.each((_, element) => { const node = $(element).clone(); node.find("script,style,noscript,nav,.ads,.ad").remove(); const paragraphNodes = node.find("p"); if (!paragraphNodes.length) node.find("br").replaceWith("\n"); const pieces = paragraphNodes.length ? paragraphNodes.toArray().map((item) => $(item).text()) : node.text().split(/\r?\n/); for (const raw of pieces) { const line = this.clean(raw, extractedTitle); if (line) paragraphs.push(line); } });
      const candidate = this.config.nextChapterPage?.(ref, page, html, $); if (!candidate) break; next = candidate;
      if (page === 50) throw new Error(`${this.displayName} chapter exceeds the 50-page safety limit`);
    }
    return { ...ref, rawHtml: pages.join("\n<!-- page -->\n"), text: dedupe(paragraphs).join("\n\n"), contentContainerFound, extractedTitle, acquisitionTransport: "html", retrievedAt: new Date().toISOString() };
  }
  validateChapter(chapter: FetchedNovelChapter) { return validateWebChapter(chapter, this.config.validation); }
  private async searchDiscoveryIndex(query: string, limit: number) {
    const config = this.config.discoveryIndex!; const now = Date.now(); let results = this.discoveryCache?.expiresAt && this.discoveryCache.expiresAt > now ? this.discoveryCache.results : undefined;
    if (!results) {
      let writerPaths = config.fallbackWriterPaths; try { const html = await this.http.getText(new URL(config.landingPath, this.config.baseUrl).href); writerPaths = internalPaths(html, this.config.baseUrl, config.writerPath); } catch { /* The fixed writer index remains a safe fallback. */ }
      if (!writerPaths.length) writerPaths = config.fallbackWriterPaths; if (writerPaths.length > 50) throw new Error(`${this.displayName} writer index exceeds the 50-page safety limit`);
      const authorPaths = new Set<string>(); for (const path of writerPaths) { try { for (const item of internalPaths(await this.http.getText(new URL(path, this.config.baseUrl).href), this.config.baseUrl, config.authorPath)) authorPaths.add(item); } catch { /* One stale writer page must not discard the remaining index. */ } }
      if (!authorPaths.size) throw new Error(`${this.displayName} author discovery index was not found`); if (authorPaths.size > 2_000) throw new Error(`${this.displayName} author index exceeds the 2,000-page safety limit`);
      const found: NovelSearchResult[] = []; const seen = new Set<string>();
      for (const path of authorPaths) { let html: string; try { html = await this.http.getText(new URL(path, this.config.baseUrl).href); } catch { continue; } const $ = load(html); const author = clean($("h1").first().text()).replace(/^作者[:：]?/u, "").replace(/作品全集$/u, "").trim();
        $("tr").each((_, row) => { const links = $(row).find("a[href]").toArray(); for (const link of links) { const href = $(link).attr("href"); if (!href) continue; const url = new URL(href, this.config.baseUrl); const parsed = this.config.parseUrl(url); const title = clean($(link).text()).replace(/[《》]/gu, ""); if (!parsed?.bookId || !title || seen.has(parsed.bookId)) continue; seen.add(parsed.bookId); found.push({ provider: this.id, bookId: parsed.bookId, url: this.config.bookUrl(parsed.bookId), title, author: optional(author), description: optional($(row).text().replace($(link).text(), "")) }); break; } }); }
      results = found; this.discoveryCache = { results, expiresAt: now + (config.ttlMs ?? 24 * 60 * 60 * 1000) };
    }
    const needle = query.toLocaleLowerCase(); return results.filter((item) => `${item.title}\n${item.author ?? ""}\n${item.description ?? ""}`.toLocaleLowerCase().includes(needle)).slice(0, Math.max(0, limit));
  }
  private parse(input: string) { let url: URL; try { url = new URL(input); } catch (error) { throw new Error(`Invalid ${this.displayName} URL`, { cause: error }); } const parsed = this.config.parseUrl(url); if (!parsed) throw new Error(`Unsupported ${this.displayName} URL: ${input}`); return parsed; }
  private clean(value: string, title?: string) { const line = clean(value); if (!line) return undefined; return this.config.cleanLine?.(line, title) ?? line; }
}

function clean(value: string) { return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim(); }
function optional(value: string) { return clean(value) || undefined; }
function first($: CheerioAPI, selector?: string) { return selector ? clean($(selector).first().text()) : ""; }
function attribute($: CheerioAPI, selector: string | undefined, name: string) { return selector ? $(selector).first().attr(name) ?? "" : ""; }
function meta($: CheerioAPI, property: string) { return clean($(`meta[property='${property}']`).attr("content") ?? ""); }
function internalPaths(html: string, base: string, pattern: RegExp) { const $ = load(html); const paths = new Set<string>(); $("a[href]").each((_, element) => { try { const url = new URL($(element).attr("href") ?? "", base); const baseHost = new URL(base).hostname.replace(/^www\./u, ""); if (url.hostname.replace(/^www\./u, "") === baseHost && pattern.test(url.pathname)) paths.add(url.pathname); } catch { /* Ignore malformed external links. */ } }); return [...paths].sort(); }
function absolute(value: string | undefined, base: string) { if (!value) return undefined; try { return new URL(value.startsWith("//") ? `https:${value}` : value, base).href; } catch { return undefined; } }
function explicitChapterNumber(title?: string) { const match = title ? /第\s*(\d+)\s*(?:章|话|話|节|節)/u.exec(title) : undefined; return match ? Number(match[1]) : undefined; }
function dedupe(values: string[]) { return values.filter((value, index) => index === 0 || value !== values[index - 1]); }
function assertPage(html: string, provider: string) { if (/captcha|cloudflare|正在验证|安全验证|checking your browser|challenge=/iu.test(html)) throw new Error(`${provider} requires an authorized browser challenge before access`); }
