import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateWebChapter } from "../src/source/chapter-validation.js";
import { NovelFallbackRetriever } from "../src/source/fallback.js";
import { Ixdzs8Source } from "../src/source/ixdzs8/ixdzs8-source.js";
import { NovelBook, NovelChapterRef, NovelSourceProvider } from "../src/source/novel-provider.js";
import { SourceProviderRegistry } from "../src/source/registry.js";
import { ShuhaigeSource } from "../src/source/shuhaige/shuhaige-source.js";
import { importSource, loadImportedChapters } from "../src/source/importer.js";
import { SourceInspection } from "../src/source/types.js";
import { WebHttpClient } from "../src/source/web/http-client.js";

const longText = (label: string) => `${label}。`.repeat(90);

describe("Milestone 17 novel providers", () => {
  it("registers all built-in providers and resolves their URLs", async () => {
    const registry = new SourceProviderRegistry();
    expect(registry.listNovelProviders().map((item) => item.id)).toEqual(expect.arrayContaining(["fanqie", "ixdzs8", "shuhaige", "biquge5", "fsshu", "biquge345", "tianyabooks"]));
    expect(registry.listNovelProviders().at(-1)).toMatchObject({ id: "fanqie", priority: 900, enabledByDefault: false });
    expect((await registry.resolve("https://ixdzs8.com/read/568509/")).provider).toBeInstanceOf(Ixdzs8Source);
    expect((await registry.resolve("https://www.shuhaige.net/126726/")).provider).toBeInstanceOf(ShuhaigeSource);
  });

  it("classifies challenge, lock, truncation, invalid HTML, ads, and identity mismatches", () => {
    const base = { provider: "ixdzs8" as const, bookId: "1", chapterId: "p1", chapter: 1, title: "第1章 起点", url: "https://ixdzs8.com/read/1/p1.html", retrievedAt: new Date().toISOString() };
    expect(validateWebChapter({ ...base, rawHtml: "<title>正在验证浏览器</title><script>challenge=1</script>", text: "", contentContainerFound: false }).status).toBe("CHALLENGE_REQUIRED");
    expect(validateWebChapter({ ...base, rawHtml: "会员登录后阅读", text: "预览", contentContainerFound: true }).status).toBe("LOCKED");
    expect(validateWebChapter({ ...base, rawHtml: "<article/>", text: "短预览", contentContainerFound: true, advertisedCharacters: 1800 }).status).toBe("TRUNCATED");
    expect(validateWebChapter({ ...base, rawHtml: "<html/>", text: "", contentContainerFound: false }).status).toBe("INVALID");
    expect(validateWebChapter({ ...base, rawHtml: "<article/>", text: "最新网址\n返回目录\n点击下一页", contentContainerFound: true }).status).toBe("INVALID");
    expect(validateWebChapter({ ...base, rawHtml: "<article/>", text: longText("正文"), contentContainerFound: true, extractedTitle: "第2章 错误" }).status).toBe("INVALID");
  });

  it("parses ixdzs8 book metadata, catalog JSON, chapters, ads, and search results", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://ixdzs8.com/read/568509/") return new Response(`<head><meta property="og:novel:book_name" content="亡灵天灾"><meta property="og:novel:author" content="作者甲"><meta property="og:description" content="简介"></head><a href="https://down7.ixdzs8.com/txt/568509.txt">TXT下载</a>`);
      if (url === "https://ixdzs8.com/novel/clist/" && init?.method === "POST") return new Response(JSON.stringify({ data: [{ ordernum: 1499, title: "第1章 起点", ctype: "0" }, { ordernum: 1500, title: "第2章 延续", ctype: 0 }, { ordernum: 9999, title: "广告", ctype: "1" }] }), { headers: { "content-type": "application/json" } });
      if (url === "https://ixdzs8.com/read/568509/p1499.html") return new Response(`<article class="page-content"><div class="page-d-top"><h1>第1章 起点</h1></div><section><p>ixdzs8.com</p><p>${longText("正文")}</p><p>本章完</p></section></article>`);
      if (url === "https://down7.ixdzs8.com/txt/568509.txt") return new Response(`第1章 起点\n${longText("下载正文")}`, { headers: { "content-type": "text/plain; charset=utf-8" } });
      if (url.startsWith("https://ixdzs8.com/bsearch")) return new Response(`<ul><li class="burl" data-url="/read/568509/"><h3 class="bname"><a href="/read/568509/">亡灵天灾</a></h3><span class="bauthor">作者甲</span><span class="l-chapter">第1500章</span></li></ul>`);
      return new Response("missing", { status: 404 });
    });
    const source = new Ixdzs8Source(client(fetcher, ["ixdzs8.com", "*.ixdzs8.com"])); const book = await source.getBook("https://ixdzs8.com/read/568509/"); const list = await source.getChapterList(book);
    expect(book).toMatchObject({ bookId: "568509", title: "亡灵天灾", author: "作者甲" }); expect(list.map((item) => item.chapterId)).toEqual(["p1499", "p1500"]);
    expect(await source.getBulkDownloads(book)).toEqual([expect.objectContaining({ format: "txt", url: "https://down7.ixdzs8.com/txt/568509.txt" })]);
    const download = (await source.getBulkDownloads(book))[0]!; expect((await source.fetchBulkDownload(download)).text).toContain("下载正文");
    const chapter = await source.getChapter(list[0]!); expect(chapter.text).not.toContain("ixdzs8.com"); expect(source.validateChapter(chapter).status).toBe("COMPLETE");
    expect(await source.search("亡灵")).toEqual([expect.objectContaining({ provider: "ixdzs8", bookId: "568509", title: "亡灵天灾" })]);
  });

  it("rejects the normal ixdzs8 browser-verification response without bypassing it", async () => {
    const fetcher = vi.fn(async () => new Response(`<title>正在验证浏览器</title><p>正在进行安全验证</p><script>let token="abc";location.href="?challenge="+token</script>`));
    const source = new Ixdzs8Source(client(fetcher, ["ixdzs8.com"]));
    await expect(source.getBook("https://ixdzs8.com/read/568509/")).rejects.toThrow(/blocked by a browser-verification interstitial/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("assembles Shuhaige multi-page chapters without duplicate boundary text", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://www.shuhaige.net/126726/") return new Response(`<div id="info"><h1>测试书</h1><p>作者：<a>作者乙</a></p></div><div id="intro"><p>简介</p></div><div id="list"><dl><dt>正文</dt><dd><a href="/126726/996145.html">第1章 开局</a></dd></dl></div>`);
      if (url === "https://www.shuhaige.net/126726/996145.html") return new Response(`<div class="bookname"><h1>第1章 开局</h1></div><div id="content"><p>${longText("第一部分")}</p><p>边界句</p></div><a href="/126726/996145_2.html">下一页</a>`);
      if (url === "https://www.shuhaige.net/126726/996145_2.html") return new Response(`<div id="content"><p>边界句</p><p>${longText("第二部分")}</p><p>www.shuhaige.net</p></div>`);
      return new Response("missing", { status: 404 });
    });
    const source = new ShuhaigeSource(client(fetcher, ["www.shuhaige.net"])); const book = await source.getBook("https://www.shuhaige.net/126726/"); const refs = await source.getChapterList(book); const chapter = await source.getChapter(refs[0]!);
    expect(chapter.text.match(/边界句/g)).toHaveLength(1); expect(chapter.text).not.toContain("shuhaige.net"); expect(source.validateChapter(chapter).status).toBe("COMPLETE");
  });

  it("falls back after a locked provider and selects the first complete chapter", async () => {
    const locked = mockProvider("fanqie", "LOCKED"); const complete = mockProvider("ixdzs8", "COMPLETE");
    const retriever = new NovelFallbackRetriever(new Map([["fanqie", locked], ["ixdzs8", complete]]));
    const result = await retriever.retrieve(1500, [book("fanqie"), book("ixdzs8")]);
    expect(result.attempts.map((item) => item.validation.status)).toEqual(["LOCKED", "COMPLETE"]); expect(result.accepted?.provider).toBe("ixdzs8");
  });

  it("preserves mixed-source provenance in one normalized chapter collection", async () => {
    const root = await mkdtemp(join(tmpdir(), "multi-source-"));
    await importSource(root, "mixed", inspection("fanqie", 1499, "f-1499", "Fanqie text"));
    await importSource(root, "mixed", inspection("ixdzs8", 1500, "p1500", "ixdzs8 text"));
    const loaded = await loadImportedChapters(root, "mixed");
    expect(loaded.chapters.map((item) => item.chapter)).toEqual([1499, 1500]);
    expect(loaded.manifest.chapters.map((item) => item.ref.metadata.provider)).toEqual(["fanqie", "ixdzs8"]);
    expect(loaded.manifest.chapters[1]!.ref.metadata.validation).toMatchObject({ status: "COMPLETE" });
  });
});

function client(fetcher: ReturnType<typeof vi.fn>, allowedHosts: string[]) { return new WebHttpClient({ fetcher: fetcher as typeof fetch, allowedHosts, requestDelayMs: 0, maxRetries: 0 }); }
function book(provider: "fanqie" | "ixdzs8"): NovelBook { return { provider, bookId: "book", url: provider === "fanqie" ? "https://fanqienovel.com/page/1" : "https://ixdzs8.com/read/1/", title: "Book" }; }
function mockProvider(id: "fanqie" | "ixdzs8", status: "LOCKED" | "COMPLETE"): NovelSourceProvider {
  const ref: NovelChapterRef = { provider: id, bookId: "book", chapterId: "1500", chapter: 1500, title: "第1500章", url: `https://${id}.example/1500` };
  return { id, displayName: id, capabilities: { search: false, download: true, authentication: "none" }, supportsUrl: () => false, search: async () => [], getBook: async () => book(id), getChapterList: async () => [ref],
    getChapter: async () => ({ ...ref, rawHtml: "<article/>", text: status === "COMPLETE" ? longText("正文") : "preview", contentContainerFound: true, retrievedAt: new Date().toISOString() }),
    validateChapter: (chapter) => ({ status, evidence: { extractedCharacters: [...chapter.text].length, contentContainerFound: true, indicators: status === "LOCKED" ? ["lock"] : [], reasons: [status] } }) };
}
function inspection(provider: "fanqie" | "ixdzs8", chapter: number, chapterId: string, text: string): SourceInspection {
  const sourceType = provider === "fanqie" ? "fanqie" : "web"; const url = provider === "fanqie" ? "https://fanqienovel.com/page/1" : "https://ixdzs8.com/read/1/";
  const validation = { status: "COMPLETE", evidence: { extractedCharacters: [...text].length, contentContainerFound: true, indicators: [], reasons: ["complete"] } };
  const ref = { chapter, sourceId: chapterId, sourceType, metadata: { provider, sourceBookId: "1", sourceChapterId: chapterId, sourceUrl: url, retrievedAt: new Date().toISOString(), validation, characterCount: [...text].length } } as const;
  return { sourcePath: url, sourceType, fingerprint: `${provider}-${chapter}`.padEnd(64, "0").slice(0, 64), chapters: [{ ref, text }], directory: [ref], warnings: [], unnumberedSections: [], origin: { url, bookId: "1" }, remote: { lastInspectedAt: new Date().toISOString(), chapterCountAtInspection: 1 }, metadata: { provider, bookId: "1" }, additive: true, adapterVersion: `${provider}-test` };
}
