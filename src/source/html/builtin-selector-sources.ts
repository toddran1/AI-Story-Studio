import { NovelProviderDescriptor } from "../novel-provider.js";
import { SelectorNovelSource, SelectorSourceConfig } from "./selector-source.js";
import { WebHttpClient } from "../web/http-client.js";

const descriptor = (id: string, displayName: string, domains: string[], priority: number, search: boolean, multiPageChapters = false, enabledByDefault = true): NovelProviderDescriptor => ({
  id, displayName, domains, languages: ["zh-CN"], priority, reliability: "standard", enabledByDefault,
  capabilities: { search, download: true, authentication: "none", multiPageChapters, acquisition: ["html"] }, rateLimit: { minimumDelayMs: 700, maximumConcurrency: 2 },
});

export function builtinSelectorSources(http?: WebHttpClient) {
  return [
    new SelectorNovelSource(biquge5, http), new SelectorNovelSource(fsshu, http),
    new SelectorNovelSource(b345, http), new SelectorNovelSource(tianyabooks, http),
  ];
}

const pagedIndex = (base: string, prefix = "") => (bookId: string, html: string) => {
  let maximum = 1; for (const match of html.matchAll(/index_(\d+)\.html/gu)) maximum = Math.max(maximum, Number(match[1]));
  if (!Number.isSafeInteger(maximum) || maximum > 500) throw new Error(`Catalog advertises an unsafe page count: ${maximum}`);
  const root = `${base}/${prefix ? `${prefix}/` : ""}${bookId}/`; return Array.from({ length: maximum }, (_, index) => index === 0 ? root : `${root}index_${index + 1}.html`);
};
const pagedNext = (url: (book: string, chapter: string, page?: number) => string) => (ref: { bookId: string; chapterId: string; url: string }, page: number, _html: string, $: import("cheerio").CheerioAPI) => {
  const expected = new URL(url(ref.bookId, ref.chapterId, page + 1)); const found = $("a[href]").toArray().some((element) => { try { return new URL($(element).attr("href") ?? "", ref.url).href === expected.href; } catch { return false; } });
  return found ? expected.href : undefined;
};
const removeCommonNoise = (line: string, title?: string) => /笔趣阁|最新网址|加入书签|返回目录|第\(.*页/u.test(line) || line === title ? undefined : line;

const biquge5Base = "https://www.biquge5.com";
const biquge5Url = (book: string, chapter?: string, page = 1) => `${biquge5Base}/${book}/${chapter ? `${chapter}${page > 1 ? `_${page}` : ""}.html` : ""}`;
const biquge5: SelectorSourceConfig = {
  descriptor: descriptor("biquge5", "Biquge5", ["biquge5.com", "www.biquge5.com"], 120, true, true), baseUrl: biquge5Base,
  parseUrl: (url) => { const match = /^\/(\d+)(?:\/(\d+)(?:_\d+)?\.html)?\/?$/.exec(url.pathname); return match ? { bookId: match[1]!, chapterId: match[2] } : undefined; },
  bookUrl: (id) => biquge5Url(id), chapterUrl: biquge5Url,
  selectors: { title: "meta[property='og:novel:book_name']", author: "meta[property='og:novel:author']", description: "#intro_pc", cover: "meta[property='og:image']", directory: ".book_list2 a[href]", chapterTitle: "h1", content: "article" },
  parseChapterHref: (url, book) => new RegExp(`^/${book}/(\\d+)(?:_\\d+)?\\.html$`).exec(url.pathname)?.[1], catalogPageUrls: pagedIndex(biquge5Base), nextChapterPage: pagedNext(biquge5Url), cleanLine: removeCommonNoise,
  search: { url: (query) => `${biquge5Base}/search.php?q=${encodeURIComponent(query)}&p=1`, result: "dl", link: "h3 a", author: ".book_other:nth-of-type(1)", latest: ".book_other a" },
};

const fsshuBase = "https://www.fsshu.com";
const fsshuUrl = (book: string, chapter?: string, page = 1) => `${fsshuBase}/biquge/${book}/${chapter ? `${chapter}${page > 1 ? `_${page}` : ""}.html` : ""}`;
const fsshu: SelectorSourceConfig = {
  descriptor: descriptor("fsshu", "Fsshu", ["fsshu.com", "www.fsshu.com"], 130, true, true), baseUrl: fsshuBase,
  parseUrl: (url) => { const match = /^\/biquge\/([^/]+)(?:\/([^/]+?)(?:_\d+)?\.html)?\/?$/.exec(url.pathname); return match ? { bookId: match[1]!, chapterId: match[2] } : undefined; },
  bookUrl: (id) => fsshuUrl(id), chapterUrl: fsshuUrl,
  selectors: { title: "meta[property='og:novel:book_name']", author: "meta[property='og:novel:author']", description: "meta[property='og:description']", cover: "meta[property='og:image']", directory: ".book_list2 a[href]", chapterTitle: "h1", content: "article" },
  parseChapterHref: (url, book) => new RegExp(`^/biquge/${book}/([^/]+?)(?:_\\d+)?\\.html$`).exec(url.pathname)?.[1], catalogPageUrls: pagedIndex(fsshuBase, "biquge"), nextChapterPage: pagedNext(fsshuUrl), cleanLine: removeCommonNoise,
  search: { url: (query) => `${fsshuBase}/search.php?q=${encodeURIComponent(query)}`, result: "dl", link: "h3 a", author: ".book_other:nth-of-type(1)", latest: ".book_other a" },
};

const b345Base = "https://www.xbiquge345.com";
const b345: SelectorSourceConfig = {
  descriptor: descriptor("biquge345", "Biquge345", ["xbiquge345.com", "www.xbiquge345.com"], 110, true), baseUrl: b345Base,
  parseUrl: (url) => { const book = /^\/(?:book|shu)\/(\d+)\/?$/.exec(url.pathname); const chapter = /^\/chapter\/(\d+)\/(\d+)\.html$/.exec(url.pathname); return chapter ? { bookId: chapter[1]!, chapterId: chapter[2] } : book ? { bookId: book[1]! } : undefined; },
  bookUrl: (id) => `${b345Base}/book/${id}/`, chapterUrl: (book, chapter) => `${b345Base}/chapter/${book}/${chapter}.html`,
  selectors: { title: ".right_border h1", author: ".x1 a, a.x1", description: ".x3", cover: ".zhutu img", directory: "ul.info a[href*='/chapter/']", chapterTitle: "#neirong h1", content: "#txt, .txt" },
  parseChapterHref: (url, book) => new RegExp(`^/chapter/${book}/(\\d+)\\.html$`).exec(url.pathname)?.[1], cleanLine: removeCommonNoise,
  validation: {
    lockedIndicators: [/VIP\s*(?:章节|內容|内容)|会员.*(?:阅读|加载)|登录后.*(?:阅读|加载)/iu],
    truncatedIndicators: [/正在手打中|本章正在手打|内容正在获取中|內容正在獲取中|稍候重试|稍候重試/iu],
    invalidIndicators: [/VIP\s*(?:内容|內容)?加载失败|VIP\s*(?:内容|內容)?載入失敗/iu],
  },
  search: { url: () => `${b345Base}/s.php`, method: "POST_FORM", fields: (query) => ({ type: "articlename", s: query, submit: "" }), headers: { Referer: `${b345Base}/` }, result: "ul.search > li:not(.fen)", link: ".name a", author: ".zuo a", latest: ".jie a" },
};

const tianyaBase = "https://www.tianyabooks.com";
const tianyabooks: SelectorSourceConfig = {
  descriptor: descriptor("tianyabooks", "Tianya Books", ["tianyabooks.com", "www.tianyabooks.com"], 140, true, false, false), baseUrl: tianyaBase,
  parseUrl: (url) => { const chapter = /^\/([^/]+\/[^/]+)\/(\d+)\.html$/.exec(url.pathname); const book = /^\/([^/]+\/[^/]+)\/$/.exec(url.pathname); return chapter ? { bookId: chapter[1]!, chapterId: chapter[2] } : book ? { bookId: book[1]! } : undefined; },
  bookUrl: (id) => `${tianyaBase}/${id}/`, chapterUrl: (book, chapter) => `${tianyaBase}/${book}/${chapter}.html`,
  selectors: { title: ".catalog h1, .book h1", author: ".catalog .info, .book h2", description: ".intro, .description", cover: ".catalog img", directory: ".idx-list a[href], .mulu-list a[href], .book dl dd a[href]", chapterTitle: ".article h2, #main h1", content: ".article, #main" },
  parseChapterHref: (url, book) => new RegExp(`^/${book}/(\\d+)\\.html$`).exec(url.pathname)?.[1], cleanLine: (line, title) => /返回目录|加入书签|天涯书库/u.test(line) || line === title ? undefined : line,
  discoveryIndex: { landingPath: "/author.html", writerPath: /^\/writer\d+\.html$/u, authorPath: /^\/author\/[^/]+\.html$/u,
    fallbackWriterPaths: ["/writer01.html", "/writer02.html", "/writer03.html", "/writer04.html", "/writer05.html", "/writer06.html", "/writer07.html", "/writer08.html", "/writer10.html", "/writer11.html"] },
};
