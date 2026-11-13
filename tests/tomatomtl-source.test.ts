import { expect, it, vi } from "vitest";
import { SourceProviderRegistry } from "../src/source/registry.js";
import { SourceAuthenticationRequiredError } from "../src/source/errors.js";
import { WebHttpClient } from "../src/source/web/http-client.js";

it("uses a signed-in TomatoMTL session and imports English chapters without caching private pages", async () => {
  const bookUrl = "https://tomatomtl.com/book/7048976903398493199";
  const chapterUrl = `${bookUrl}/7049129595244642823`;
  const text = "The training yard was already full when the bell sounded. Every student turned toward the door to see who had arrived so early. The teacher motioned for the group to follow.";
  const cache = { get: vi.fn(), set: vi.fn() };
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith("/catalog/")) return Response.json([{ id: "7049129595244642823", title: "第1章 全民御兽" }]);
    if (String(input) === bookUrl) return new Response('<meta property="og:novel:book_name" content="Test book">');
    expect(String(input)).toBe(chapterUrl);
    return new Response(new Headers(init?.headers).get("cookie") === "session=verified"
      ? `<h1 id="chapter_title">Chapter 1 Beast Taming for All</h1><div id="chapter_content"><p>${text}</p><aside><p>Advertisement</p></aside></div>`
      : "<title>Login Required | </title>");
  };
  const http = new WebHttpClient({ fetcher, cache, maintainCookies: true, requestDelayMs: 0 });
  const registry = new SourceProviderRegistry(undefined, http);
  const { provider } = await registry.resolve(chapterUrl);
  await expect(registry.inspect(provider, bookUrl, { probe: 1 })).rejects.toBeInstanceOf(SourceAuthenticationRequiredError);
  await http.seedCookies("tomatomtl.com", { session: "verified" });
  const result = await registry.inspect(provider, bookUrl, { probe: 1 });
  expect(result.language).toBe("en-US");
  expect(result.chapters[0]).toMatchObject({ text, ref: { chapter: 1, originalTitle: "Chapter 1 Beast Taming for All", metadata: { provider: "tomatomtl" } } });
  expect(cache.get).not.toHaveBeenCalled();
  expect(cache.set).not.toHaveBeenCalled();
});
