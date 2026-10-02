import { describe, expect, it, vi } from "vitest";
import { WebHttpClient, WebHttpError } from "../src/source/web/http-client.js";
import { createErrorDiagnostic } from "../src/errors/diagnostic.js";
import { SourceUpstreamError } from "../src/source/errors.js";
import { ProviderCircuitBreaker, ProviderCooldownError } from "../src/source/provider-catalog.js";
import { formatApiError } from "../apps/web/src/api.js";

describe("novel website access failures", () => {
  it("preserves the website failure during cooldown, explains retry, and clears the pause automatically",()=>{
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-01T21:13:08.429Z"));
      const breaker=new ProviderCircuitBreaker(3,60_000);
      for(let i=0;i<3;i++) breaker.failure("wfxs",new Error("The source website requires browser verification (403)"));
      let error:unknown;try{breaker.assertAvailable("wfxs");}catch(cause){error=cause;}
      expect(error).toBeInstanceOf(ProviderCooldownError);
      const diagnostic=createErrorDiagnostic(error);
      expect(diagnostic).toMatchObject({code:"SOURCE_COOLDOWN",category:"rate_limit",retryable:true,provider:"wfxs"});
      expect(diagnostic.recommendedAction).toContain("retry inspection manually");
      const formatted=formatApiError((error as Error).message,diagnostic);
      expect(formatted.match(/Novel provider/g)).toHaveLength(1);expect(formatted).not.toContain("21:14:08.429Z");expect(formatted).toContain("browser verification");
      vi.advanceTimersByTime(60_000);expect(()=>breaker.assertAvailable("wfxs")).not.toThrow();
    }finally{vi.useRealTimers();}
  });
  it.each([
    ["<title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/cf-chl-test'></script>", { "cf-mitigated":"challenge" }, "CHALLENGE_REQUIRED"],
    ["<title>Just a moment...</title>", {}, "CHALLENGE_REQUIRED"],
    ["Forbidden", {}, "BLOCKED"],
  ])("reports 403 website access correctly without storing challenge content", async (html, headers, code) => {
    const fetcher=vi.fn(async()=>new Response(html,{status:403,headers})); const cache={get:vi.fn(async()=>undefined),set:vi.fn(async()=>{})};
    const client=new WebHttpClient({fetcher:fetcher as typeof fetch,requestDelayMs:0,maxRetries:2,cache});
    let failure:unknown;
    try{await client.getText("https://m.wfxs.tw/xiaoshuo/8076783/");}catch(error){failure=error;}
    expect(failure).toMatchObject({status:403,code});
    expect(fetcher).toHaveBeenCalledTimes(1);expect(cache.set).not.toHaveBeenCalled();
    const diagnostic=createErrorDiagnostic(failure);
    expect(diagnostic).toMatchObject({category:"permanent",retryable:false,provider:"wfxs",code});
    expect(diagnostic.recommendedAction).not.toContain("Check provider credentials");
    expect(diagnostic.recommendedAction).toContain("another enabled source");
  });
  it("applies seeded cookies and a verified User-Agent to outgoing requests and persists them", async () => {
    const requests: Array<Record<string, string>> = [];
    const fetcher = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => { requests.push(init?.headers ?? {}); return new Response("ok", { status: 200 }); });
    const stored: Record<string, Record<string, string>> = {};
    const cookieStore = { get: vi.fn(async () => undefined), set: vi.fn(async (host: string, cookies: Record<string, string>) => { stored[host] = cookies; }) };
    const client = new WebHttpClient({ fetcher: fetcher as unknown as typeof fetch, requestDelayMs: 0, maintainCookies: true, cookieStore });
    await client.getText("https://m.wfxs.tw/xiaoshuo/8076783/");
    expect(requests[0]?.["User-Agent"]).toBe("AI-Story-Studio/0.1"); expect(requests[0]?.Cookie).toBeUndefined();
    client.setUserAgent("Mozilla/5.0 VerifiedBrowser/1.0");
    await client.seedCookies("m.wfxs.tw", { cf_clearance: "clearance-token", other: "1" });
    await client.getText("https://m.wfxs.tw/xiaoshuo/8076783/chapter.html");
    expect(requests[1]?.["User-Agent"]).toBe("Mozilla/5.0 VerifiedBrowser/1.0");
    expect(requests[1]?.Cookie).toBe("cf_clearance=clearance-token; other=1");
    expect(stored["m.wfxs.tw"]).toEqual({ cf_clearance: "clearance-token", other: "1" });
    expect(cookieStore.set).toHaveBeenCalledTimes(1);
    expect(() => client.setUserAgent("  ")).toThrow();
  });
  it("recognizes challenge responses served with 503 without retry storms", async()=>{
    const fetcher=vi.fn(async()=>new Response("Just a moment",{status:503,headers:{"cf-mitigated":"challenge"}}));
    const client=new WebHttpClient({fetcher:fetcher as typeof fetch,requestDelayMs:0,maxRetries:2});
    await expect(client.getText("https://m.wfxs.tw/xiaoshuo/8076783/")).rejects.toMatchObject({code:"CHALLENGE_REQUIRED"});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("handles legacy and wrapped source 403s and leaves genuine API authentication guidance intact",()=>{
    const blocked=new WebHttpError("Web request failed (403) for https://m.wfxs.tw/xiaoshuo/8076783/",403);
    expect(createErrorDiagnostic(new SourceUpstreamError("Source operation failed",{cause:blocked})).recommendedAction).not.toContain("Check provider credentials");
    expect(createErrorDiagnostic(new SourceUpstreamError("WFXS CHALLENGE_REQUIRED: browser verification")).category).toBe("permanent");
    const api=Object.assign(new Error("OpenAI invalid_api_key"),{status:403});
    expect(createErrorDiagnostic(api).recommendedAction).toBe("Check provider credentials in Studio Settings or .env.");
  });
});
