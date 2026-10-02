import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WfxsSource, parseWfxsUrl } from "../src/source/wfxs/wfxs-source.js";
import { WebHttpClient } from "../src/source/web/http-client.js";
import { SourceProviderRegistry } from "../src/source/registry.js";
import { importSource, loadImportedChapters } from "../src/source/importer.js";
import { applySourceMetadata } from "../src/source/story-metadata.js";
import { loadEnvironment } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";

const base = "https://m.wfxs.tw"; const bookUrl = `${base}/xiaoshuo/8076783/`;
const directoryUrl = `${base}/booklist/8076783.html`;
const chapterUrl = `${bookUrl}82047261/`;
const link = (n: number, id: string) => `<a href="${bookUrl}${id}/">第${n}章 正文</a>`;
const directory = (links: string, extra = "", count = 3) => `<span id="bh_chat_count">${count}</span><ul id="html_box">${links}</ul>${extra}`;
const bookHtml = `<meta property="og:novel:book_name" content="亡靈召喚師殺瘋了，你卻說他弱？"><meta property="og:novel:author" content="七月八月打醬油"><a>共3章</a>`;
function setup(pages: Record<string, string>, options = {}) {
  const fetcher = vi.fn(async (input: string | URL | Request) => pages[String(input)] === undefined ? new Response("missing", { status: 404 }) : new Response(pages[String(input)]));
  return { fetcher, source: new WfxsSource(new WebHttpClient({ fetcher: fetcher as typeof fetch, allowedHosts: ["m.wfxs.tw"], requestDelayMs: 0, maxRetries: 0, ...options })) };
}
const fixture = () => readFile(new URL("./fixtures/novel-providers/wfxs/chapter-593.html", import.meta.url), "utf8");

describe("WFXS", () => {
  it("recognizes and normalizes only verified mobile book, directory and chapter URLs", async () => {
    const registry = new SourceProviderRegistry();
    for (const url of [bookUrl, directoryUrl, `${base}/booklist/8076783/20.html`, chapterUrl]) expect(registry.novelProviderIdForUrl(url)).toBe("wfxs");
    expect(parseWfxsUrl(`${chapterUrl}?tracking=1#part`)).toEqual({ bookId: "8076783", chapterId: "82047261", url: chapterUrl });
    for (const url of ["http://m.wfxs.tw/xiaoshuo/8076783/", "https://www.wfxs.tw/xiaoshuo/8076783/", "https://evil.test/xiaoshuo/8076783/", "https://user@m.wfxs.tw/xiaoshuo/8076783/", `${base}/s/`]) expect(registry.novelProviderIdForUrl(url)).toBeUndefined();
    expect(registry.getNovelProvider("wfxs").capabilities).toMatchObject({ search: false, acquisition: ["html"] });
    expect(registry.listNovelProviders().find(p => p.id === "wfxs")).toMatchObject({ displayName: "WFXS / 微風小說網", domains: ["m.wfxs.tw"], languages: ["zh-TW"] });
  });
  it("crawls explicit range links, orders numeric titles and deduplicates opaque IDs", async () => {
    const { source, fetcher } = setup({ [bookUrl]: bookHtml, [directoryUrl]: directory(link(2,"800") + link(1,"900") + link(1,"900"), `<a href="/booklist/8076783/1.html">1~30章</a><a href="/booklist/8076783/2.html">31~60章</a><a href="https://evil.test/booklist/8076783/3.html">other</a>`), [`${base}/booklist/8076783/2.html`]: directory(link(3,"700"), `<a href="/booklist/8076783/1.html">back</a>`) });
    const book = await source.getBook(bookUrl); const refs = await source.getChapterList(book);
    expect(refs.map(r => [r.chapter,r.chapterId])).toEqual([[1,"900"],[2,"800"],[3,"700"]]);
    expect(fetcher).toHaveBeenCalledTimes(3); expect(book.directoryMetadata).toMatchObject({ complete: true, discoveredCount: 3, pagesRetrieved: 2 });
  });
  it("reports gaps, stale counts, conflicting numbers, repeated pages and failed pages", async () => {
    const { source } = setup({ [bookUrl]: bookHtml, [directoryUrl]: directory(link(1,"a"), "") });
    // Numeric URL IDs are required; malformed links cannot become chapters.
    await expect(source.getChapterList(await source.getBook(bookUrl))).rejects.toThrow("missing chapter links");
    const root = directory(link(1,"100") + link(3,"300") + link(3,"301"), [2,3,4].map(n=>`<a href="/booklist/8076783/${n}.html">range</a>`).join(""), 1670);
    const test = setup({ [bookUrl]: bookHtml, [directoryUrl]: root, [`${base}/booklist/8076783/2.html`]: directory(link(1,"100") + link(3,"300") + link(3,"301")), [`${base}/booklist/8076783/3.html`]: directory(link(5,"500")) });
    const book = await test.source.getBook(bookUrl); await test.source.getChapterList(book);
    expect(book.directoryMetadata).toMatchObject({ complete: false, advertisedCounts: [3,1670] });
    expect(book.directoryWarnings?.map(w=>w.message).join(" ")).toMatch(/conflicting Chapter 3.*repeated directory page.*page failed.*missing chapters 2-2.*advertised counts/s);
  });
  it("preserves Chapter 593 numbers, punctuation and Traditional Chinese through inspection and import", async () => {
    const html = await fixture(); const { source, fetcher } = setup({ [bookUrl]: bookHtml, [directoryUrl]: directory(link(593,"82047261"), "", 1), [chapterUrl]: html });
    const inspection = await source.inspect(chapterUrl);
    const text = inspection.chapters[0]!.text;
    for (const value of ["2000000", "20000000", "32000000", "320900138/60000000", "40000000", "40→60", "30→60", "蘇銘", "【亞瑟王】"]) expect(text).toContain(value);
    expect(text.match(/20000000/g)).toHaveLength(3); expect(text.match(/32000000/g)).toHaveLength(2);
    expect(text).not.toMatch(/廣告|broken|返回目錄|評論|下一章|網頁朗讀/);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(inspection.chapters[0]!.ref.metadata).toMatchObject({ provider: "wfxs", sourceChapterId: "82047261", validation: { status: "COMPLETE" } });
    const root = await mkdtemp(join(tmpdir(),"wfxs-import-")); await importSource(root,"sovereign-ashes",inspection);
    const imported = await loadImportedChapters(root,"sovereign-ashes"); expect(await readFile(imported.chapters[0]!.path, "utf8")).toContain("320900138/60000000");
    const story = defaultStory("sovereign-ashes", loadEnvironment({}));
    const associated = applySourceMetadata(story,inspection,false); expect(associated.title).toBe(story.title); expect(associated.sourceLanguage).toBe(story.sourceLanguage); expect(associated.sources[0]?.provider).toBe("wfxs");
  });
  it.each([
    ["<title>Just a moment...</title><p>Enable JavaScript and cookies</p>", "CHALLENGE_REQUIRED"],
    ["<h1 class='title'>第593章 正文</h1><div id='read_conent_box'>短</div>", "TRUNCATED"],
    ["<h1 class='title'>第594章 正文</h1><div id='read_conent_box'>" + "正文".repeat(100) + "</div>", "INVALID"],
    ["<h1 class='title'>第593章 正文</h1>", "INVALID"],
    ["<h1 class='title'>第593章 正文</h1><div id='read_conent_box'>" + "正文".repeat(100) + "</div><a href='/xiaoshuo/8076783/82047262/'>下一頁</a>", "TRUNCATED"],
  ])("rejects unavailable chapter payloads (%s)", async (html, status) => {
    const { source, fetcher } = setup({ [chapterUrl]: html }); const chapter = await source.getChapter({ provider:"wfxs", bookId:"8076783", chapterId:"82047261", chapter:593, url:chapterUrl });
    expect(source.validateChapter(chapter).status).toBe(status); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds directory pagination and reports an incomplete result", async () => {
    const links = Array.from({ length: 501 }, (_, n) => `<a href="/booklist/8076783/${n + 1}.html">range</a>`).join("");
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input); const page = Number(/\/(\d+)\.html$/.exec(url)?.[1] ?? 1);
      return new Response(url === directoryUrl ? directory(link(1,"100"), links, 501) : directory(link(page,String(page * 100)), "", 501));
    });
    const source = new WfxsSource(new WebHttpClient({ fetcher:fetcher as typeof fetch, requestDelayMs:0, maxRetries:0 }));
    const book = { provider:"wfxs", bookId:"8076783", url:bookUrl, title:"Book" };
    await source.getChapterList(book);
    expect(fetcher).toHaveBeenCalledTimes(500);
    expect((book as import("../src/source/novel-provider.js").NovelBook).directoryWarnings?.map(w=>w.message).join(" ")).toContain("exceeds 500 pages");
  });
  it("does not cache Cloudflare verification content", async () => {
    const cache = { get:vi.fn(async () => undefined), set:vi.fn(async () => {}) };
    const { source } = setup({ [bookUrl]:"<title>Just a moment...</title><div id='cf-chl-widget'>Enable JavaScript and cookies</div>" },{cache});
    await expect(source.getBook(bookUrl)).rejects.toThrow("CHALLENGE_REQUIRED"); expect(cache.set).not.toHaveBeenCalled();
  });
  it("uses refresh controls to bypass stale cached pages", async () => {
    const cache = { get: vi.fn(async () => ({ body: bookHtml.replace("共3章", "共1632章"), fetchedAt: new Date().toISOString(), url:bookUrl })), set: vi.fn(async () => {}) };
    const { source, fetcher } = setup({ [bookUrl]:bookHtml }, { cache });
    expect((await source.getBook(bookUrl)).chapterCount).toBe(1632); expect(fetcher).not.toHaveBeenCalled();
    expect((await source.getBook(bookUrl,{refresh:true})).chapterCount).toBe(3); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("WFXS integration", () => {
  it("shared client permits only the registered WFXS host and rejects external redirects", async () => {
    const { createWebHttpClient } = await import("../src/source/web/create-client.js");
    const fetcher = vi.fn(async () => new Response("OK")); vi.stubGlobal("fetch",fetcher);
    try {
      const root = await mkdtemp(join(tmpdir(),"wfxs-web-")); const http = createWebHttpClient(root,loadEnvironment({ WEB_REQUEST_DELAY_MS:"0" }));
      expect(await http.getText(bookUrl)).toBe("OK");
      await expect(http.getText("https://unknown.wfxs.tw/xiaoshuo/8076783/")).rejects.toThrow();
      fetcher.mockImplementation(async () => new Response("", { status:302, headers:{location:"https://evil.test/"} }));
      await expect(http.getText(directoryUrl)).rejects.toThrow();
    } finally { vi.unstubAllGlobals(); }
  });
  it("sends WEB_USER_AGENT instead of the built-in User-Agent when configured", async () => {
    const { createWebHttpClient } = await import("../src/source/web/create-client.js");
    const fetcher = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response("OK")); vi.stubGlobal("fetch",fetcher);
    try {
      const root = await mkdtemp(join(tmpdir(),"wfxs-web-")); const http = createWebHttpClient(root,loadEnvironment({ WEB_REQUEST_DELAY_MS:"0", WEB_USER_AGENT:"Mozilla/5.0 seeded-browser" }));
      expect(await http.getText(bookUrl)).toBe("OK");
      const headers = fetcher.mock.calls[0]![1]!.headers as Record<string,string>;
      expect(headers["User-Agent"]).toBe("Mozilla/5.0 seeded-browser");
    } finally { vi.unstubAllGlobals(); }
  });
  it("rejects redirects to another otherwise allowlisted source host", async () => {
    const fetcher = vi.fn(async () => new Response("",{status:302,headers:{location:"https://www.shuhaige.net/126726/"}}));
    const source = new WfxsSource(new WebHttpClient({ fetcher:fetcher as typeof fetch, allowedHosts:["m.wfxs.tw","www.shuhaige.net"], requestDelayMs:0,maxRetries:0 }));
    await expect(source.getBook(bookUrl)).rejects.toThrow("Redirect host is not allowed for this source"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("capability-driven import controls offer URL acquisition without search or Full TXT", async () => {
    const { providerForUrl, supportsFullTxt } = await import("../apps/web/src/ChapterImportPage.js");
    const providers = new SourceProviderRegistry().listNovelProviders(); const selected = providerForUrl(providers,bookUrl);
    expect(selected?.id).toBe("wfxs"); expect(selected?.capabilities.search).toBe(false); expect(supportsFullTxt(selected)).toBe(false);
    expect(supportsFullTxt(providerForUrl(providers,"https://www.shuhaige.net/126726/"))).toBe(true);
  });
  it("adds an edition to an existing story without altering text, language, title or naming preferences", async () => {
    const { StudioOperations } = await import("../apps/server/operations.js");
    const { JobManager } = await import("../apps/server/job-manager.js");
    const { atomicWriteJson, atomicWrite } = await import("../src/storage/atomic-write.js");
    const { storyPaths } = await import("../src/storage/paths.js");
    const env = loadEnvironment({}); const root = await mkdtemp(join(tmpdir(),"wfxs-association-"));
    const story = defaultStory("sovereign-ashes",env); const paths = storyPaths(root,story.slug,593);
    await atomicWriteJson(paths.storyConfig,story); await atomicWrite(paths.original,"Existing original 2000000"); await atomicWrite(paths.english,"Manual narration");
    const { source } = setup({ [bookUrl]:bookHtml }); const ops = new StudioOperations(root,env,new JobManager(),{registry:new SourceProviderRegistry([source])});
    try {
      const before = await readFile(paths.storyConfig,"utf8"); const attached = await ops.attachNovelSource(story.slug,{url:bookUrl});
      expect(attached).toEqual({ ...JSON.parse(before), sources:[expect.objectContaining({provider:"wfxs",bookId:"8076783",title:"亡靈召喚師殺瘋了，你卻說他弱？"})] });
      expect(await readFile(paths.original,"utf8")).toBe("Existing original 2000000"); expect(await readFile(paths.english,"utf8")).toBe("Manual narration");
      expect((await ops.attachNovelSource(story.slug,{url:bookUrl})).sources).toHaveLength(1);
      expect((await ops.updateNovelSourcePriorities(story.slug,{sources:[{provider:"wfxs",bookId:"8076783",priority:10,enabled:false}]})).sources[0]).toMatchObject({priority:10,enabled:false});
    } finally { await ops.close(); }
  });
});
