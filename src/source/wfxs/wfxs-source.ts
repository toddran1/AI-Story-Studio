import { load } from "cheerio";
import { fingerprint } from "../../utils/hash.js";
import { validateWebChapter } from "../chapter-validation.js";
import { SourceInputError, SourceUpstreamError } from "../errors.js";
import { inspectNovelProvider } from "../novel-inspection.js";
import type { FetchedNovelChapter, NovelBook, NovelChapterRef, NovelProviderDescriptor, NovelSourceProvider } from "../novel-provider.js";
import type { SourceInspectOptions, SourceWarning, StorySourceProvider } from "../types.js";
import { WebHttpClient } from "../web/http-client.js";

const BASE = "https://m.wfxs.tw";
const MAX_PAGES = 500;
export function parseWfxsUrl(input: string) {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.hostname !== "m.wfxs.tw" || url.port || url.username || url.password) throw new SourceInputError("WFXS supports HTTPS URLs on m.wfxs.tw only");
  const chapter = /^\/xiaoshuo\/(\d+)\/(\d+)\/?$/.exec(url.pathname);
  const book = /^\/xiaoshuo\/(\d+)\/?$/.exec(url.pathname) ?? /^\/booklist\/(\d+)(?:\.html|\/\d+\.html)$/.exec(url.pathname);
  if (!chapter && !book) throw new SourceInputError("Unsupported WFXS book, directory, or chapter URL");
  return { bookId: (chapter ?? book)![1]!, chapterId: chapter?.[2], url: chapter ? `${BASE}/xiaoshuo/${chapter[1]}/${chapter[2]}/` : `${BASE}/xiaoshuo/${book![1]}/` };
}

/** Range links and coverage diagnostics exceed SelectorNovelSource's static catalog contract. */
export class WfxsSource implements NovelSourceProvider, StorySourceProvider {
  readonly type = "web" as const;
  readonly id = "wfxs";
  readonly displayName = "WFXS / 微風小說網";
  readonly capabilities = { search: false, download: true, authentication: "none" as const, multiPageChapters: false, acquisition: ["html" as const] };
  readonly descriptor: NovelProviderDescriptor = { id: this.id, displayName: this.displayName, domains: ["m.wfxs.tw"], languages: ["zh-TW"], priority: 95, reliability: "standard", enabledByDefault: true, capabilities: this.capabilities, rateLimit: { minimumDelayMs: 700, maximumConcurrency: 1 } };
  constructor(private readonly http = new WebHttpClient({ allowedHosts: ["m.wfxs.tw"], maintainCookies: true, solveBrowserChallenge: true })) {}
  supportsUrl(input: string) { try { parseWfxsUrl(input); return true; } catch { return false; } }
  async search() { return []; }
  async inspect(input: string, options: SourceInspectOptions = {}) {
    const parsed = parseWfxsUrl(input);
    // Keep request-specific refresh state local, including concurrent inspections.
    const provider: NovelSourceProvider = {
      id: this.id, displayName: this.displayName, capabilities: this.capabilities,
      supportsUrl: (url) => this.supportsUrl(url), search: () => this.search(),
      getBook: (url) => this.getBook(url, options), getChapterList: (book) => this.getChapterList(book, options),
      getChapter: (ref) => this.getChapter(ref, options), validateChapter: (chapter) => this.validateChapter(chapter),
    };
    if (parsed.chapterId && options.chapter === undefined && !options.chapters && options.from === undefined && options.to === undefined && !options.probe) {
      const book = await provider.getBook(input); const directory = await provider.getChapterList(book);
      const ref = directory.find((item) => item.chapterId === parsed.chapterId);
      if (!ref) throw new SourceInputError("Requested WFXS chapter URL is absent from the directory");
      provider.getBook = async () => book; provider.getChapterList = async () => directory;
      options = { ...options, chapters: [ref.chapter] };
    }
    return inspectNovelProvider(provider, input, options.chapter === undefined ? options : { ...options, chapters: [options.chapter] }, "wfxs-v1");
  }
  async getBook(input: string, options: SourceInspectOptions = {}): Promise<NovelBook> {
    const parsed = parseWfxsUrl(input); const html = await this.http.getText(`${BASE}/xiaoshuo/${parsed.bookId}/`, { ...options, allowedHosts: ["m.wfxs.tw"] });
    assertPage(html); const $ = load(html);
    const meta = (name: string) => $(`meta[property='${name}']`).attr("content");
    const title = meta("og:novel:book_name") ?? $("h1").first().text().trim();
    if (!title) throw new SourceUpstreamError("WFXS book page is missing its title");
    const count = /共\s*(\d+)\s*章/u.exec($.text())?.[1];
    return { provider: this.id, bookId: parsed.bookId, url: `${BASE}/xiaoshuo/${parsed.bookId}/`, title, author: meta("og:novel:author"), description: meta("og:description"), coverUrl: meta("og:image"), status: meta("og:novel:status"), language: "zh-TW", chapterCount: count ? Number(count) : undefined };
  }
  async getChapterList(book: NovelBook, options: SourceInspectOptions = {}): Promise<NovelChapterRef[]> {
    const root = `${BASE}/booklist/${book.bookId}.html`; const pending = [root]; const visited = new Set<string>(); const signatures = new Set<string>();
    const refs = new Map<number, NovelChapterRef>(); const ids = new Map<string, number>(); const warnings: SourceWarning[] = []; const counts = new Set<number>();
    if (book.chapterCount) counts.add(book.chapterCount);
    const warn = (code: SourceWarning["code"], message: string) => warnings.push({ code, message });
    while (pending.length) {
      options.signal?.throwIfAborted();
      const url = pending.shift()!; if (visited.has(url)) continue;
      if (visited.size >= MAX_PAGES) { warn("unavailable_chapter", `WFXS directory exceeds ${MAX_PAGES} pages`); break; } visited.add(url);
      try {
        const html = await this.http.getText(url, { ...options, allowedHosts: ["m.wfxs.tw"] }); assertPage(html); const $ = load(html); const pageRefs: NovelChapterRef[] = [];
        const count = $("#bh_chat_count").text().trim(); if (/^\d+$/.test(count)) counts.add(Number(count));
        $("a[href]").each((_, element) => {
          const href = $(element).attr("href")!; let link: URL; try { link = new URL(href, url); } catch { return; }
          if (link.origin !== BASE) return;
          const range = new RegExp(`^/booklist/${book.bookId}/([1-9]\\d*)\\.html$`).exec(link.pathname);
          if (range) {
            // Page 1 aliases the root; normalize to avoid fetching identical content twice.
            const next = range[1] === "1" ? root : `${BASE}${link.pathname}`;
            if (!visited.has(next) && !pending.includes(next)) pending.push(next); return;
          }
          let parsed; try { parsed = parseWfxsUrl(link.href); } catch { return; }
          const title = $(element).text().trim(); const chapter = chapterNumber(title);
          if (parsed.bookId !== book.bookId || !parsed.chapterId || chapter === undefined) return;
          if (!$(element).closest("#html_box").length) return;
          pageRefs.push({ provider: this.id, bookId: book.bookId, chapterId: parsed.chapterId, chapter, title, url: parsed.url });
        });
        if (!pageRefs.length) throw new Error("missing chapter links");
        const signature = fingerprint([...new Set(pageRefs.map((ref) => ref.chapterId))].sort());
        if (signatures.has(signature)) { warn("unavailable_chapter", `WFXS repeated directory page: ${url}`); continue; } signatures.add(signature);
        for (const ref of pageRefs) {
          const previous = refs.get(ref.chapter); const previousNumber = ids.get(ref.chapterId);
          if ((previous && previous.chapterId !== ref.chapterId) || (previousNumber !== undefined && previousNumber !== ref.chapter)) {
            warn("duplicate_chapter_number", `WFXS conflicting Chapter ${ref.chapter} / ID ${ref.chapterId} at ${url}`);
            warn("unavailable_chapter", `WFXS ambiguous chapter identity prevents safe import: ${ref.chapter}`); continue;
          }
          refs.set(ref.chapter, ref); ids.set(ref.chapterId, ref.chapter);
        }
      } catch (error) { options.signal?.throwIfAborted(); warn("unavailable_chapter", `WFXS directory page failed: ${url}: ${error instanceof Error ? error.message : String(error)}`); }
      options.onProgress?.({ phase: "directory", provider: this.id, pagesChecked: visited.size });
    }
    const sorted = [...refs.values()].sort((a, b) => a.chapter - b.chapter);
    let previous = 0; for (const ref of sorted) { if (ref.chapter > previous + 1) warn("chapter_number_gap", `WFXS directory is missing chapters ${previous + 1}-${ref.chapter - 1}`); previous = ref.chapter; }
    if (!counts.size) warn("missing_metadata", "WFXS did not advertise a chapter count; directory completeness cannot be confirmed");
    if ([...counts].some((count) => count !== sorted.length)) warn("chapter_number_gap", `WFXS discovered ${sorted.length} chapters; advertised counts: ${[...counts].join(", ")}. Refresh the source to revalidate cached pages.`);
    book.directoryWarnings = warnings; book.directoryMetadata = { complete: warnings.length === 0, discoveredCount: sorted.length, advertisedCounts: [...counts], pagesRetrieved: signatures.size, pagesAttempted: visited.size };
    if (!sorted.length) throw new SourceUpstreamError(warnings.map((item) => item.message).join("; ") || "WFXS directory is empty");
    return sorted;
  }
  async getChapter(ref: NovelChapterRef, options: SourceInspectOptions = {}): Promise<FetchedNovelChapter> {
    const parsed = parseWfxsUrl(ref.url);
    if (ref.provider !== this.id || parsed.bookId !== ref.bookId || parsed.chapterId !== ref.chapterId) throw new SourceInputError("WFXS chapter reference identity mismatch");
    const html = await this.http.getText(parsed.url, { ...options, allowedHosts: ["m.wfxs.tw"] }); const $ = load(html); const title = $("h1.title").first().text().trim(); const container = $("#read_conent_box").first().clone();
    container.find("script,style,noscript,iframe,nav,button,input,.ad,.ads,[id^='cmt-'],.tts-controls").remove();
    container.find("br").replaceWith("\n");
    const paragraphs = container.find("p"); const lines = paragraphs.length ? paragraphs.toArray().flatMap((element) => $(element).text().split(/\r?\n/u)) : container.text().split(/\r?\n/u);
    const text = lines.map((line) => line.replace(/\u00a0/gu, " ").trim()).filter(Boolean).join("\n\n");
    const result: FetchedNovelChapter = { ...ref, title: ref.title ?? `第${ref.chapter}章`, text, rawHtml: html, contentContainerFound: container.length > 0 && chapterNumber(title) === ref.chapter, extractedTitle: title, acquisitionTransport: "html", retrievedAt: new Date().toISOString() };
    // The observed site serves whole chapters. Never follow a next-chapter link;
    // unimplemented continuation layouts remain visibly truncated.
    if ($("a[href]").toArray().some((element) => /下一頁|下页|下一页/u.test($(element).text()))) result.indicators = ["WFXS continuation page requires support"];
    return result;
  }
  validateChapter(chapter: FetchedNovelChapter) {
    return validateWebChapter(chapter.indicators?.includes("WFXS continuation page requires support") ? { ...chapter, rawContent: `${chapter.rawHtml}\nWFXS continuation page requires support` } : chapter, { blockedIndicators: [/just a moment|enable javascript and cookies/iu], truncatedIndicators: [/本章未完|本章尚未完|下一頁|下一页|正在手打|內容正在/u, /WFXS continuation page requires support/u] });
  }
}
function chapterNumber(title: string) { const value = /第\s*(\d+)\s*章/u.exec(title)?.[1]; const number = Number(value); return value && Number.isSafeInteger(number) && number > 0 ? number : undefined; }
function assertPage(html: string) { if (/just a moment|cf-chl-|checking your browser|enable javascript and cookies|安全驗證/iu.test(html)) throw new SourceUpstreamError("WFXS CHALLENGE_REQUIRED: Cloudflare or browser verification blocked acquisition"); }
