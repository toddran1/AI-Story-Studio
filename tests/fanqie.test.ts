import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseFanqieBook } from "../src/source/fanqie/book-parser.js";
import { decodeFanqieText, FanqieLockedChapterError, parseFanqieChapter } from "../src/source/fanqie/chapter-parser.js";
import { FanqieSource } from "../src/source/fanqie/fanqie-source.js";
import { parseFanqieUrl } from "../src/source/fanqie/fanqie-url.js";
import { importSource, loadImportedChapters } from "../src/source/importer.js";
import { compareRemoteDirectory } from "../src/source/refresh.js";
import { SourceManifest } from "../src/source/types.js";
import { WebHttpClient } from "../src/source/web/http-client.js";
import { discoveredChapterSchema } from "../src/batch/types.js";

const bookUrl = "https://fanqienovel.com/page/1234567890123456789";
const chapterUrl = (id: number) => `https://fanqienovel.com/reader/${9000 + id}`;

describe("Fanqie source", () => {
  it("validates and normalizes book and chapter URLs", () => {
    expect(parseFanqieUrl(`${bookUrl}/`)).toMatchObject({ kind: "book", id: "1234567890123456789", url: bookUrl });
    expect(parseFanqieUrl(chapterUrl(1))).toMatchObject({ kind: "chapter", id: "9001" });
    expect(() => parseFanqieUrl("http://fanqienovel.com/page/123")).toThrow(/Unsupported/);
    expect(() => parseFanqieUrl("https://example.com/page/123")).toThrow(/Unsupported/);
  });

  it("parses metadata and preserves directory ordering", () => {
    const parsed = parseFanqieBook(bookHtml(3), bookUrl, "1234567890123456789");
    expect(parsed).toMatchObject({ title: "虚构星河", author: "测试作者", description: "一部虚构作品。", status: "连载中", chapterCount: 3 });
    expect(parsed.coverUrl).toBe("https://images.example/cover.jpg");
    expect(parsed.directory.map((ref) => [ref.chapter, ref.sourceId, ref.originalTitle])).toEqual([
      [1, "9001", "第1章 起点"], [2, "9002", "第2章 回声"], [3, "9003", "番外 星光"],
    ]);
  });

  it("extracts paragraph boundaries and decodes known private-use glyphs", () => {
    expect(decodeFanqieText(String.fromCodePoint(58_611))).toBe("的");
    const parsed = parseFanqieChapter(chapterHtml("第1章 起点", `第一段${String.fromCodePoint(58_611)}文字`, "第二段。"));
    expect(parsed.text).toBe("第一段的文字\n\n第二段。");
  });

  it("rejects a Fanqie login preview instead of treating it as a complete chapter", () => {
    const html = lockedChapterHtml("第1501章 你可听闻大世界", "这是仅供预览的开头。", 2104);
    expect(() => parseFanqieChapter(html)).toThrow(FanqieLockedChapterError);
  });

  it("reports locked chapters as unavailable and never returns their preview text", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input); if (url === bookUrl) return new Response(bookHtml(2));
      if (url === chapterUrl(1)) return new Response(chapterHtml("第1章 起点", "Full first chapter. ".repeat(20)));
      if (url === chapterUrl(2)) return new Response(lockedChapterHtml("第2章 回声", "Only a preview.", 1800));
      return new Response("missing", { status: 404 });
    });
    const result = await fanqieSource(fetcher).inspect(bookUrl, { from: 1, to: 2 });
    expect(result.chapters.map((item) => item.ref.chapter)).toEqual([1]);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unavailable_chapter", sourceId: "9002" })]));
  });

  it("inspects only the directory unless probes or ranges request bodies", async () => {
    const fetcher = fixtureFetcher(3); const source = fanqieSource(fetcher);
    const directory = await source.inspect(bookUrl);
    expect(directory.directory).toHaveLength(3); expect(directory.chapters).toHaveLength(0); expect(fetcher).toHaveBeenCalledTimes(1);
    const probed = await source.inspect(bookUrl, { probe: 2 });
    expect(probed.chapters.map((item) => item.ref.chapter)).toEqual([1, 2]);
    await expect(source.inspect(bookUrl, { from: 1, to: 4 })).rejects.toThrow(/exceeds the 3 exposed/);
  });

  it("supports additive, overlapping, and changed range imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "fanqie-import-")); const bodies = new Map([[1, "One"], [2, "Two"], [3, "Three"]]);
    const source = fanqieSource(fixtureFetcher(3, bodies));
    const first = await importSource(root, "stars", await source.inspect(bookUrl, { from: 1, to: 2 }));
    expect(first.added).toEqual([1, 2]);
    const second = await importSource(root, "stars", await source.inspect(bookUrl, { from: 2, to: 3 }));
    expect(second.added).toEqual([3]); expect(second.modified).toEqual([]);
    const loaded = await loadImportedChapters(root, "stars");
    expect(loaded.chapters.map((item) => item.chapter)).toEqual([1, 2, 3]);
    expect(() => discoveredChapterSchema.parse(loaded.chapters[0])).not.toThrow();
    const unchanged = await importSource(root, "stars", await source.inspect(bookUrl, { from: 2, to: 3 }));
    expect(unchanged.status).toBe("unchanged");
    bodies.set(2, "Two revised");
    const overlap = await importSource(root, "stars", await source.inspect(bookUrl, { from: 2, to: 2 }));
    expect(overlap.modified).toEqual([2]);
    expect(await readFile(join(root, "stories/stars/source/chapters/0002.txt"), "utf8")).toContain("Two revised");
  });

  it("detects new and retitled chapters during refresh", async () => {
    const source = fanqieSource(fixtureFetcher(2)); const initial = await source.inspect(bookUrl, { from: 1, to: 1 });
    const root = await mkdtemp(join(tmpdir(), "fanqie-refresh-"));
    const imported = await importSource(root, "stars", initial); const current = await fanqieSource(fixtureFetcher(3, undefined, new Map([[2, "第2章 新回声"]]))).inspect(bookUrl);
    const result = compareRemoteDirectory(imported.manifest as SourceManifest, current);
    expect(result.added.map((ref) => ref.chapter)).toEqual([3]);
    expect(result.retitled).toEqual([{ chapter: 2, before: "第2章 回声", after: "第2章 新回声" }]);
  });
});

describe("web HTTP client", () => {
  it("retries transient failures and returns the successful response", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const client = new WebHttpClient({ fetcher, maxRetries: 1, requestDelayMs: 0, sleep: async () => {}, allowedHosts: ["example.com"] });
    await expect(client.getText("https://example.com/book")).resolves.toBe("ok"); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries network errors and revalidates cached ETags", async () => {
    const networkFetcher = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(new Response("recovered"));
    const network = new WebHttpClient({ fetcher: networkFetcher, maxRetries: 1, requestDelayMs: 0, sleep: async () => {}, allowedHosts: ["example.com"] });
    await expect(network.getText("https://example.com/book")).resolves.toBe("recovered");
    const cache = { get: vi.fn(async () => ({ url: "https://example.com/book", body: "cached", etag: '"v1"', fetchedAt: new Date(0).toISOString() })), set: vi.fn() };
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("if-none-match")).toBe('"v1"'); return new Response(null, { status: 304 });
    });
    const client = new WebHttpClient({ fetcher: fetcher as typeof fetch, cache, maxRetries: 0, requestDelayMs: 0, allowedHosts: ["example.com"] });
    await expect(client.getText("https://example.com/book")).resolves.toBe("cached");
  });

  it("enforces response limits and validates redirect destinations", async () => {
    const oversized = new WebHttpClient({ fetcher: vi.fn(async () => new Response("too large", { headers: { "content-length": "9" } })) as typeof fetch, maxResponseBytes: 5, requestDelayMs: 0, allowedHosts: ["example.com"] });
    await expect(oversized.getText("https://example.com/book")).rejects.toThrow(/exceeds 5 bytes/);
    const redirect = new WebHttpClient({ fetcher: vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/book" } })) as typeof fetch, requestDelayMs: 0, allowedHosts: ["example.com"] });
    await expect(redirect.getText("https://example.com/book")).rejects.toThrow(/host is not allowed/);
  });

  it("maintains ordinary host-scoped session cookies without caching challenge pages", async () => {
    const cache = { get: vi.fn(async () => undefined), set: vi.fn(async () => undefined) }; let calls = 0;
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1; const cookie = new Headers(init?.headers).get("cookie");
      if (calls === 1) { expect(cookie).toBeNull(); return new Response("session ready", { headers: { "set-cookie": "reader_session=ok; Path=/; Secure; HttpOnly" } }); }
      expect(cookie).toBe("reader_session=ok"); return new Response("<title>正在验证浏览器</title><script>challenge=1</script>");
    });
    const client = new WebHttpClient({ fetcher: fetcher as typeof fetch, cache, maintainCookies: true, requestDelayMs: 0, maxRetries: 0, allowedHosts: ["example.com"] });
    await client.getText("https://example.com/book", { refresh: true }); await client.getText("https://example.com/chapter", { refresh: true });
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it("solves JS redirect challenges with the session cookie when enabled", async () => {
    const token = Buffer.from("1789251833:fa25c4c0ab34243cc95857cf2e179b3b8d5df454f9cdfd48255a04defd9a9110").toString("base64");
    const challenge = `<html><head><title>正在验证浏览器</title></head><body><script>let token = "${token}"; window.location.href = location.pathname + "?challenge=" + encodeURIComponent(token);</script></body></html>`;
    const seen: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); seen.push(url); const cookie = new Headers(init?.headers).get("cookie");
      if (seen.length === 1) return new Response(challenge, { headers: { "set-cookie": "PHPSESSID=abc; Path=/" } });
      expect(cookie).toBe("PHPSESSID=abc");
      if (new URL(url).searchParams.get("challenge")) return new Response(null, { status: 302, headers: { location: "https://example.com/read/1/p1.html" } });
      return new Response("<html><body>chapter text</body></html>");
    });
    const client = new WebHttpClient({ fetcher: fetcher as typeof fetch, maintainCookies: true, solveBrowserChallenge: true, requestDelayMs: 0, maxRetries: 0, allowedHosts: ["example.com"] });
    await expect(client.getText("https://example.com/read/1/p1.html")).resolves.toContain("chapter text");
    expect(seen).toHaveLength(4); expect(new URL(seen[1]!).searchParams.get("challenge")).toBe(token);
  });

  it("solves challenges on form posts and binary downloads", async () => {
    const token = Buffer.from("1789251834:fa25c4c0ab34243cc95857cf2e179b3b8d5df454f9cdfd48255a04defd9a9110").toString("base64");
    const challenge = `<title>正在验证浏览器</title><script>let token = "${token}"; window.location.href = location.pathname + "?challenge=" + encodeURIComponent(token);</script>`;
    let cleared = false; const posts: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.searchParams.get("challenge") === token) { cleared = true; return new Response(null, { status: 302, headers: { location: url.pathname } }); }
      if (!cleared) return new Response(challenge, { headers: { "set-cookie": "PHPSESSID=abc; Path=/" } });
      if (init?.method === "POST") { posts.push(String(init.body)); return new Response(JSON.stringify({ data: [1, 2] })); }
      return new Response(new TextEncoder().encode("txt payload"));
    });
    const client = new WebHttpClient({ fetcher: fetcher as typeof fetch, maintainCookies: true, solveBrowserChallenge: true, requestDelayMs: 0, maxRetries: 0, allowedHosts: ["example.com"] });
    await expect(client.postForm("https://example.com/novel/clist/", { bid: "1" })).resolves.toBe(JSON.stringify({ data: [1, 2] }));
    expect(posts).toEqual(["bid=1"]);
    const download = await client.getBinary("https://example.com/d/1.txt");
    expect(new TextDecoder().decode(download.bytes)).toBe("txt payload");
  });

  it("restores persisted cookies in a fresh client and saves new ones", async () => {
    const stored: Record<string, Record<string, string>> = { "example.com": { PHPSESSID: "restored" } };
    const cookieStore = {
      get: vi.fn(async (host: string) => stored[host]), set: vi.fn(async (host: string, cookies: Record<string, string>) => { stored[host] = cookies; }),
    };
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const cookie = new Headers(init?.headers).get("cookie");
      return cookie?.includes("PHPSESSID=restored") ? new Response("ok", { headers: { "set-cookie": "clearance=done; Path=/" } }) : new Response("no cookie", { status: 403 });
    });
    const client = new WebHttpClient({ fetcher: fetcher as typeof fetch, cookieStore, maintainCookies: true, requestDelayMs: 0, maxRetries: 0, allowedHosts: ["example.com"] });
    await expect(client.getText("https://example.com/book")).resolves.toBe("ok");
    expect(cookieStore.get).toHaveBeenCalledWith("example.com");
    await new Promise((resolve) => setImmediate(resolve));
    expect(cookieStore.set).toHaveBeenCalledWith("example.com", { PHPSESSID: "restored", clearance: "done" });
  });

  it("returns challenge pages untouched when solving is disabled or loops forever", async () => {
    const challenge = `<title>正在验证浏览器</title><script>let token = "abcdefghijklmnop"; window.location.href = location.pathname + "?challenge=" + encodeURIComponent(token);</script>`;
    const passive = new WebHttpClient({ fetcher: vi.fn(async () => new Response(challenge)) as typeof fetch, maintainCookies: true, requestDelayMs: 0, maxRetries: 0, allowedHosts: ["example.com"] });
    await expect(passive.getText("https://example.com/read/1/p1.html")).resolves.toContain("正在验证浏览器");
    const fetcher = vi.fn(async () => new Response(challenge));
    const looping = new WebHttpClient({ fetcher: fetcher as typeof fetch, maintainCookies: true, solveBrowserChallenge: true, requestDelayMs: 0, maxRetries: 0, allowedHosts: ["example.com"] });
    await expect(looping.getText("https://example.com/read/1/p1.html")).resolves.toContain("正在验证浏览器");
    expect(fetcher).toHaveBeenCalledTimes(7);
  });
});

function fanqieSource(fetcher: ReturnType<typeof vi.fn>) {
  return new FanqieSource(new WebHttpClient({ fetcher: fetcher as typeof fetch, requestDelayMs: 0, maxRetries: 0, allowedHosts: ["fanqienovel.com"] }));
}
function fixtureFetcher(count: number, bodies = new Map<number, string>(), titles = new Map<number, string>()) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === bookUrl) return new Response(bookHtml(count, titles), { status: 200 });
    const id = Number(/\/reader\/(\d+)/.exec(url)?.[1]) - 9000;
    if (id >= 1 && id <= count) return new Response(chapterHtml(titles.get(id) ?? defaultTitle(id), `${bodies.get(id) ?? `Body ${id}`}. `.repeat(30)), { status: 200 });
    return new Response("missing", { status: 404 });
  });
}
function defaultTitle(number: number) { return number === 1 ? "第1章 起点" : number === 2 ? "第2章 回声" : number === 3 ? "番外 星光" : `第${number}章`; }
function bookHtml(count: number, titles = new Map<number, string>()) {
  const chapters = Array.from({ length: count }, (_, index) => `<div class="chapter-item"><a class="chapter-item-title" href="/reader/${9001 + index}">${titles.get(index + 1) ?? defaultTitle(index + 1)}</a></div>`).join("");
  return `<html><body><div class="page-header-info"><h1>虚构星河</h1><div class="info-label">连载中 科幻</div><div class="author-name-text">测试作者</div><div class="page-abstract-content">一部虚构作品。</div><div class="page-cover"><img src="//images.example/cover.jpg"></div></div><h3>目录${count}章</h3><div class="chapter">${chapters}</div></body></html>`;
}
function chapterHtml(title: string, ...paragraphs: string[]) { return `<html><body><h1 class="muye-reader-title">${title}</h1><div class="muye-reader-content">${paragraphs.map((value) => `<p>${value}</p>`).join("")}</div></body></html>`; }
function lockedChapterHtml(title: string, preview: string, advertisedCharacters: number) { return `<html><body><h1 class="muye-reader-title">${title}</h1><div class="muye-reader-content"><p>${preview}</p></div><p>会员登录后，可在网页畅读全文</p><p>扫码下载APP免费读</p><script>window.__INITIAL_STATE__={"reader":{"chapterData":{"isChapterLock":true,"chapterWordNumber":"${advertisedCharacters}","content":"${preview}"}}}</script></body></html>`; }
