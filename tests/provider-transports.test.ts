import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { builtinSelectorSources } from "../src/source/html/builtin-selector-sources.js";
import { ShuhaigeSource } from "../src/source/shuhaige/shuhaige-source.js";
import { WebHttpClient } from "../src/source/web/http-client.js";

const fixtureRoot = join(import.meta.dirname, "fixtures", "novel-providers");
const fixture = (provider: string, name: string) => readFile(join(fixtureRoot, provider, name), "utf8");
const longText = (label: string) => `${label}是一段用于验证完整章节正文的内容。`.repeat(30);

describe("provider acquisition transports and defensive adapters", () => {
  it("discovers, safely opens, and imports Shuhaige's official full-TXT ZIP with bulk provenance", async () => {
    const landing = await fixture("shuhaige", "download.html");
    const manuscript = `第1章 开端\n${longText("第一章")}\n第2章 延续\n${longText("第二章")}`;
    const archive = zipSync({ "测试书全文.txt": strToU8(manuscript) });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://www.shuhaige.net/126726/") return new Response(`<div id="info"><h1>测试书</h1></div><div id="list"><a href="/126726/1.html">第1章 开端</a><a href="/126726/2.html">第2章 延续</a></div><a href="https://m.shuhaige.net/txt_126726.html">TXT下载</a>`);
      if (url === "https://m.shuhaige.net/txt_126726.html") return new Response(landing);
      if (url === "https://files.shuhaige.net/all/test-book.zip") return new Response(archive, { headers: { "content-type": "application/zip" } });
      return new Response("missing", { status: 404 });
    });
    const source = new ShuhaigeSource(client(fetcher, ["www.shuhaige.net", "m.shuhaige.net", "*.shuhaige.net"], true));
    const book = await source.getBook("https://www.shuhaige.net/126726/");
    expect(await source.getBulkDownloads(book)).toEqual([expect.objectContaining({ format: "txt", container: "zip", url: "https://files.shuhaige.net/all/test-book.zip" })]);
    const inspection = await source.inspect(book.url, { from: 1, to: 2, acquisition: "bulk-download" });
    expect(inspection.chapters).toHaveLength(2);
    expect(inspection.metadata).toMatchObject({ acquisitionTransport: "bulk-download", bulkDownloadUrl: "https://files.shuhaige.net/all/test-book.zip" });
    expect(inspection.chapters[0]!.ref.metadata).toMatchObject({ acquisitionTransport: "bulk-download", acquisitionUrl: "https://files.shuhaige.net/all/test-book.zip", validation: { status: "COMPLETE" } });
  });

  it("uses Biquge345 POST search with an ordinary reusable session cookie", async () => {
    const search = await fixture("biquge345", "search.html"); const book = await fixture("biquge345", "book.html");
    let bookCookie = "";
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/s.php")) { expect(init?.method).toBe("POST"); expect(String(init?.body)).toContain("type=articlename"); return new Response(search, { headers: { "set-cookie": "PHPSESSID=test-session; Path=/; HttpOnly" } }); }
      if (url.endsWith("/book/337742/")) { bookCookie = new Headers(init?.headers).get("cookie") ?? ""; return new Response(book); }
      return new Response("missing", { status: 404 });
    });
    const source = adapter("biquge345", client(fetcher, ["www.xbiquge345.com"], true));
    expect(await source.search("亡灵")).toEqual([expect.objectContaining({ provider: "biquge345", bookId: "337742", title: "亡灵天灾" })]);
    await source.getBook("https://www.xbiquge345.com/book/337742/");
    expect(bookCookie).toContain("PHPSESSID=test-session");
  });

  it("rejects Biquge345 placeholders, VIP failures, and challenge pages", async () => {
    const templates = [
      ["placeholder.html", "TRUNCATED"], ["vip-failure.html", "LOCKED"], ["challenge.html", "CHALLENGE_REQUIRED"],
    ] as const;
    for (const [name, status] of templates) {
      const html = await fixture("biquge345", name); const fetcher = vi.fn(async () => new Response(html));
      const source = adapter("biquge345", client(fetcher, ["www.xbiquge345.com"]));
      const chapter = await source.getChapter({ provider: "biquge345", bookId: "337742", chapterId: "1500", chapter: 1500, title: "第1500章", url: "https://www.xbiquge345.com/chapter/337742/1500.html" });
      expect(source.validateChapter(chapter).status).toBe(status);
    }
  });

  for (const item of [
    { id: "biquge5", host: "www.biquge5.com", url: "https://www.biquge5.com/123/", provider: "biquge5" },
    { id: "fsshu", host: "www.fsshu.com", url: "https://www.fsshu.com/biquge/abc/", provider: "fsshu" },
  ] as const) it(`${item.id} refuses an incomplete paginated catalog`, async () => {
    const first = await fixture(item.id, "paged-book.html"); const missing = await fixture(item.id, "missing-catalog.html");
    const fetcher = vi.fn(async (input: string | URL | Request) => new Response(String(input) === item.url ? first : missing));
    const source = adapter(item.provider, client(fetcher, [item.host])); const book = await source.getBook(item.url);
    await expect(source.getChapterList(book)).rejects.toThrow(/did not contain a chapter directory/);
  });

  it("builds Tianya's opt-in author discovery index once and reuses the cache", async () => {
    const pages = new Map([
      ["https://www.tianyabooks.com/author.html", await fixture("tianyabooks", "author-index.html")],
      ["https://www.tianyabooks.com/writer01.html", await fixture("tianyabooks", "writer.html")],
      ["https://www.tianyabooks.com/author/test-author.html", await fixture("tianyabooks", "author.html")],
    ]);
    const fetcher = vi.fn(async (input: string | URL | Request) => new Response(pages.get(String(input)) ?? "missing", { status: pages.has(String(input)) ? 200 : 404 }));
    const source = adapter("tianyabooks", client(fetcher, ["www.tianyabooks.com"]));
    expect(source.descriptor?.enabledByDefault).toBe(false);
    expect(await source.search("测试小说")).toEqual([expect.objectContaining({ provider: "tianyabooks", bookId: "net/test-book", title: "测试小说", author: "测试作者" })]);
    expect(await source.search("测试作者")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

function client(fetcher: ReturnType<typeof vi.fn>, allowedHosts: string[], maintainCookies = false) {
  return new WebHttpClient({ fetcher: fetcher as typeof fetch, allowedHosts, maintainCookies, requestDelayMs: 0, maxRetries: 0 });
}
function adapter(id: string, http: WebHttpClient) { const result = builtinSelectorSources(http).find((candidate) => candidate.id === id); if (!result) throw new Error(`Missing test provider ${id}`); return result; }
