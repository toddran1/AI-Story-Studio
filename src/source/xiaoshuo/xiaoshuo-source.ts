import { load } from "cheerio";
import { SelectorNovelSource, SelectorSourceConfig } from "../html/selector-source.js";
import { NovelBook, NovelDownloadReference } from "../novel-provider.js";
import { decodeNovelTextDownload } from "../bulk-download.js";
import { WebHttpClient } from "../web/http-client.js";

const BASE = "https://www.xiaoshuo.com.tw";
const HOSTS = ["xiaoshuo.com.tw", "www.xiaoshuo.com.tw"];
const bookUrl = (id: string) => `${BASE}/${id}/`;
const downloadUrl = (id: string) => `${BASE}/modules/article/txtarticle.php?id=${id}`;

function parseUrl(url: URL) {
  if (url.protocol !== "https:" || !HOSTS.includes(url.hostname.toLowerCase()) || url.port || url.username || url.password) return undefined;
  const match = /^\/([1-9]\d*)(?:\/([1-9]\d*)\.html)?\/?$/.exec(url.pathname);
  return match ? { bookId: match[1]!, chapterId: match[2] } : undefined;
}

const config: SelectorSourceConfig = {
  descriptor: {
    id: "xiaoshuo", displayName: "繁體小說網 (xiaoshuo.com.tw)", domains: HOSTS, languages: ["zh-TW"],
    priority: 115, reliability: "standard", enabledByDefault: true,
    capabilities: { search: false, download: true, authentication: "none", acquisition: ["html", "bulk-download"], bulkFormats: ["txt"] },
    rateLimit: { minimumDelayMs: 700, maximumConcurrency: 2 },
  },
  baseUrl: BASE, parseUrl, bookUrl,
  chapterUrl: (book, chapter) => `${bookUrl(book)}${chapter}.html`,
  selectors: {
    title: ".bookTitle", author: "meta[property='og:novel:author']", description: "#bookIntro", cover: "meta[property='og:image']",
    directory: "#list-chapterAll dd a[href]", chapterTitle: "h1.readTitle", content: "#htmlContent",
  },
  // The link text contains the correct chapter title; this site's title
  // attributes can refer to the adjacent chapter instead.
  parseChapterHref: (url, book) => { const parsed = parseUrl(url); return parsed?.bookId === book ? parsed.chapterId : undefined; },
  cleanLine: (line, title) => line === title || /^(?:上一章|下一章|章節目錄|加入書架|本章完)$/.test(line) ? "" : line,
};

export class XiaoshuoSource extends SelectorNovelSource {
  constructor(private readonly transport = new WebHttpClient({ allowedHosts: HOSTS, maintainCookies: true, requestDelayMs: 700 })) {
    super(config, transport);
  }

  async getBulkDownloads(book: NovelBook): Promise<NovelDownloadReference[]> {
    if (book.provider !== this.id || !/^[1-9]\d*$/.test(book.bookId)) throw new Error("Xiaoshuo book does not belong to this provider");
    const html = typeof book.metadata?.firstHtml === "string" ? book.metadata.firstHtml : await this.transport.getText(bookUrl(book.bookId));
    const $ = load(html);
    const advertised = $("a[href]").toArray().some((element) => {
      try {
        const url = new URL($(element).attr("href")!, bookUrl(book.bookId));
        return url.protocol === "https:" && HOSTS.includes(url.hostname) && !url.port && !url.username && !url.password
          && url.pathname === "/modules/article/txtarticle.php" && url.searchParams.get("id") === book.bookId;
      } catch { return false; }
    });
    return advertised ? [{ provider: this.id, bookId: book.bookId, format: "txt", url: downloadUrl(book.bookId), container: "plain", label: "Full TXT download" }] : [];
  }

  async fetchBulkDownload(reference: NovelDownloadReference) {
    if (reference.provider !== this.id || !/^[1-9]\d*$/.test(reference.bookId) || reference.format !== "txt" || reference.url !== downloadUrl(reference.bookId)) {
      throw new Error("Xiaoshuo TXT download does not match its book");
    }
    const response = await this.transport.getBinary(reference.url, { maxBytes: 100 * 1024 * 1024 });
    const text = decodeNovelTextDownload(reference, response);
    if (/<(?:!doctype|html|body)\b/iu.test(text.slice(0, 2000)) || !/^\s*第\s*[\d一二三四五六七八九十百千万零〇两]+\s*章/mu.test(text)) {
      throw new Error("Xiaoshuo TXT response is not a numbered chapter manuscript");
    }
    return { reference, text, retrievedAt: new Date().toISOString() };
  }
}
