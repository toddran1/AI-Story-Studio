import { describe, expect, it, vi } from "vitest";
import { XiaoshuoSource } from "../src/source/xiaoshuo/xiaoshuo-source.js";
import { WebHttpClient } from "../src/source/web/http-client.js";
import { SourceProviderRegistry } from "../src/source/registry.js";

const base = "https://www.xiaoshuo.com.tw";
const body = "這是測試正文。".repeat(40);
function fixture() {
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${base}/886340/`) return new Response(`<meta property="og:novel:author" content="測試作者"><script src="https://static.cloudflareinsights.com/beacon.min.js"></script><h1 class="bookTitle">測試小說</h1><p id="bookIntro">簡介</p><div id="list-chapterAll"><dd><a href="/886340/100.html" title="第2章 錯誤提示">第1章 開始</a></dd><dd><a href="/886340/200.html">第2章 繼續</a></dd><dd><a href="https://evil.example/886340/300.html">第3章 不可信</a></dd></div><a href="/modules/article/txtarticle.php?id=886340">TXT下載</a>`);
    if (url === `${base}/886340/100.html`) return new Response(`<script src="https://static.cloudflareinsights.com/beacon.min.js"></script><h1 class="readTitle">第1章 開始</h1><div id="htmlContent">${body}<br>【成長進度：196/10000】<br>下一章<script>noise()</script></div>`);
    if (url === `${base}/modules/article/txtarticle.php?id=886340`) return new Response(`第1章 开始\n${body}\n【成长进度：196/10000】\n第2章 继续\n${body}`, { headers: { "content-type": "text/plain" } });
    throw new Error(`Unexpected URL: ${url}`);
  });
  const http = new WebHttpClient({ fetcher: fetcher as typeof fetch, allowedHosts: ["www.xiaoshuo.com.tw"], maxRetries: 0, requestDelayMs: 0 });
  return { source: new XiaoshuoSource(http), fetcher };
}

describe("Xiaoshuo source", () => {
  it("registers direct book/chapter URLs and rejects untrusted or insecure URLs", async () => {
    const registry = new SourceProviderRegistry();
    expect((await registry.resolve(`${base}/886340/`)).provider).toBeInstanceOf(XiaoshuoSource);
    const { source } = fixture();
    expect(source.supportsUrl(`${base}/886340/100.html`)).toBe(true);
    for (const url of ["http://www.xiaoshuo.com.tw/886340/", "https://evil.example/886340/", "https://www.xiaoshuo.com.tw:444/886340/", "https://user@www.xiaoshuo.com.tw/886340/"]) {
      expect(source.supportsUrl(url)).toBe(false);
      await expect(source.getBook(url)).rejects.toThrow(/Unsupported/);
    }
    expect(source.capabilities).toMatchObject({ search: false, bulkFormats: ["txt"] });
  });

  it("extracts the real catalog link text, metadata, HTML chapters, and full TXT ranges", async () => {
    const { source, fetcher } = fixture();
    const book = await source.getBook(`${base}/886340/`);
    expect(book).toMatchObject({ title: "測試小說", author: "測試作者" });
    const refs = await source.getChapterList(book);
    expect(refs.map(ref => ref.chapter)).toEqual([1, 2]);
    expect(refs[0]!.title).toBe("第1章 開始");
    const chapter = await source.getChapter(refs[0]!);
    expect(chapter.text).toContain("196/10000");
    expect(chapter.text).not.toMatch(/noise|下一章/);
    expect(source.validateChapter(chapter).status).toBe("COMPLETE");
    const inspection = await source.inspect(`${base}/886340/`, { from: 1, to: 2, acquisition: "bulk-download" });
    expect(inspection.chapters).toHaveLength(2);
    expect(inspection.chapters[0]!.text).toContain("196/10000");
    expect(inspection.chapters[0]!.ref.metadata.acquisitionTransport).toBe("bulk-download");
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("txtarticle"))).toHaveLength(1);
  });

  it("does not follow forged TXT references or mistake an error page for a manuscript", async () => {
    const { source, fetcher } = fixture();
    const [ref] = await source.getBulkDownloads(await source.getBook(`${base}/886340/`));
    await expect(source.fetchBulkDownload({ ...ref!, url: `${base}/admin.php` })).rejects.toThrow(/does not match/);
    await expect(source.fetchBulkDownload({ ...ref!, bookId: "42" })).rejects.toThrow(/does not match/);
    fetcher.mockImplementation(async () => new Response("<!doctype html><html>Error</html>"));
    await expect(source.fetchBulkDownload(ref!)).rejects.toThrow(/not a numbered chapter manuscript/);
  });

  it("decodes GBK HTML declared in a meta tag and GBK TXT without corrupting digits", async () => {
    const gbkText = new Uint8Array([0xb2, 0xe2, 0xca, 0xd4]); // 测试
    const fetcher = vi.fn(async () => new Response(Buffer.concat([Buffer.from('<meta charset="gbk"><h1>'), gbkText, Buffer.from('</h1><p>196/10000</p>')])));
    const client = new WebHttpClient({ fetcher: fetcher as typeof fetch, allowedHosts: ["www.xiaoshuo.com.tw"], requestDelayMs: 0, maxRetries: 0 });
    expect(await client.getText(`${base}/886340/`)).toContain("测试</h1><p>196/10000");
    fetcher.mockImplementation(async () => new Response(Buffer.concat([Buffer.from("\xb5\xda1\xd5\xc2 ", "latin1"), gbkText, Buffer.from("\n196/10000")])));
    const source = new XiaoshuoSource(client);
    const payload = await source.fetchBulkDownload({ provider: "xiaoshuo", bookId: "886340", format: "txt", url: `${base}/modules/article/txtarticle.php?id=886340` });
    expect(payload.text).toContain("第1章 测试");
    expect(payload.text).toContain("196/10000");
  });
});
