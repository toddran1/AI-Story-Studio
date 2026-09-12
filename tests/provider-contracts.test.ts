import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { builtinSelectorSources } from "../src/source/html/builtin-selector-sources.js";
import { NovelProviderId, NovelSourceProvider, novelProviderIdSchema } from "../src/source/novel-provider.js";
import { ProviderCircuitBreaker } from "../src/source/provider-catalog.js";
import { SourceProviderRegistry } from "../src/source/registry.js";
import { SourceInspection, StorySourceProvider } from "../src/source/types.js";
import { WebHttpClient } from "../src/source/web/http-client.js";

const fixtureRoot = join(import.meta.dirname, "fixtures", "novel-providers");
const cases = [
  { id: "biquge5", host: "www.biquge5.com", bookUrl: "https://www.biquge5.com/123/", chapterUrl: "https://www.biquge5.com/123/1001.html" },
  { id: "fsshu", host: "www.fsshu.com", bookUrl: "https://www.fsshu.com/biquge/abc/", chapterUrl: "https://www.fsshu.com/biquge/abc/c1.html" },
  { id: "biquge345", host: "www.xbiquge345.com", bookUrl: "https://www.xbiquge345.com/book/337742/", chapterUrl: "https://www.xbiquge345.com/chapter/337742/9001.html" },
  { id: "tianyabooks", host: "www.tianyabooks.com", bookUrl: "https://www.tianyabooks.com/book/sample/", chapterUrl: "https://www.tianyabooks.com/book/sample/1.html" },
] as const;

describe("novel provider adapter contracts", () => {
  for (const item of cases) it(`${item.id} resolves a book, ordered directory, complete chapter, and provenance identity`, async () => {
    const bookHtml = await readFile(join(fixtureRoot, item.id, "book.html"), "utf8");
    const chapterHtml = await readFile(join(fixtureRoot, item.id, "chapter.html"), "utf8");
    const fetcher = vi.fn(async (input: string | URL | Request) => new Response(String(input) === item.chapterUrl ? chapterHtml : bookHtml));
    const http = new WebHttpClient({ fetcher: fetcher as typeof fetch, allowedHosts: [item.host], requestDelayMs: 0, maxRetries: 0 });
    const provider = builtinSelectorSources(http).find((candidate) => candidate.id === item.id)!;
    const book = await provider.getBook(item.bookUrl); const chapters = await provider.getChapterList(book);
    expect(provider.supportsUrl(item.bookUrl)).toBe(true); expect(book.title).toBeTruthy(); expect(chapters.length).toBeGreaterThan(0);
    const chapter = await provider.getChapter(chapters[0]!); const validation = provider.validateChapter(chapter);
    expect(chapter.provider).toBe(item.id); expect(chapter.bookId).toBe(book.bookId); expect(validation.status).toBe("COMPLETE");
    expect(validation.evidence.extractedCharacters).toBeGreaterThan(120);
  });

  it("accepts extension IDs but rejects unsafe provider identifiers", () => {
    expect(novelProviderIdSchema.parse("custom-reader-2")).toBe("custom-reader-2");
    expect(novelProviderIdSchema.safeParse("Custom Reader").success).toBe(false);
  });

  it("isolates a cooling-down provider while a healthy provider still returns variants", async () => {
    const breaker = new ProviderCircuitBreaker(1, 60_000); const failing = fakeProvider("failing-source", true); const healthy = fakeProvider("healthy-source", false);
    const registry = new SourceProviderRegistry([failing as StorySourceProvider, healthy as StorySourceProvider], undefined, breaker);
    const first = await registry.searchNovels("story", undefined, 20);
    expect(first.results).toEqual([expect.objectContaining({ provider: "healthy-source" })]); expect(first.warnings[0]?.provider).toBe("failing-source");
    expect(registry.listNovelProviders().find((provider) => provider.id === "failing-source")?.health.status).toBe("cooldown");
    const second = await registry.searchNovels("story", undefined, 20);
    expect(second.results).toHaveLength(1); expect(second.warnings[0]?.message).toMatch(/cooling down/);
  });
});

function fakeProvider(id: NovelProviderId, fail: boolean): NovelSourceProvider & StorySourceProvider {
  return { id, type: "web", displayName: id, capabilities: { search: true, download: true, authentication: "none" },
    descriptor: { id, displayName: id, domains: [`${id}.example`], languages: ["zh-CN"], priority: 100, reliability: "standard", enabledByDefault: true, capabilities: { search: true, download: true, authentication: "none" }, rateLimit: { minimumDelayMs: 0, maximumConcurrency: 1 } },
    supportsUrl: () => false, inspect: async () => ({} as SourceInspection), search: async () => { if (fail) throw new Error("temporary source failure"); return [{ provider: id, bookId: "1", url: `https://${id}.example/book/1`, title: "Story" }]; },
    getBook: async () => { throw new Error("unused"); }, getChapterList: async () => [], getChapter: async () => { throw new Error("unused"); }, validateChapter: () => ({ status: "INVALID", evidence: { extractedCharacters: 0, contentContainerFound: false, indicators: [], reasons: ["unused"] } }) };
}
