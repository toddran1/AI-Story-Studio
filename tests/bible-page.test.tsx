/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BiblePage, bibleQueryString, createRequestGate, parseBibleQuery, performNavigateScroll, shouldShowDuplicateStrip } from "../apps/web/src/App.js";
import { api, ApiError } from "../apps/web/src/api.js";

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const entityRow = (id: string, name: string) => ({
  id, canonicalName: name, type: "character", aliases: [], originalName: name,
  firstAppearance: 1, lastKnownAppearance: 3, origin: "automatic", conflictCount: 0,
  readiness: [], canonicalNameLocked: false,
});

const entitiesPayload = (items: any[], extra: Record<string, unknown> = {}) => ({
  items, page: 1, pages: 1, total: items.length, counts: { character: items.length }, duplicateSuggestions: [], ...extra,
});

const healthPayload = () => ({ totals: { canonicalEntities: 5, minorReferences: 1, needsAttention: 0 }, issues: {} });

function installFetch(handler: FetchHandler) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }));
  return calls;
}

const entityRequests = (calls: Array<{ url: string }>) => calls.filter((call) => call.url.includes("/story-bible/entities?"));

describe("Story Bible page loading", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let host: HTMLDivElement | undefined;
  let navigate: ReturnType<typeof vi.fn>;

  const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };

  const renderBible = async (path = "/stories/story/bible") => {
    history.pushState({}, "", path);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    navigate = vi.fn();
    await act(async () => { root!.render(<BiblePage slug="story" navigate={navigate} locationSearch={location.search} />); });
    await flush();
  };

  const typeSearch = async (value: string) => {
    const input = host!.querySelector<HTMLInputElement>("input.search")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = undefined;
    host?.remove();
    host = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders the entity list independently of health, review summary, and suppressions failures", async () => {
    let healthAttempts = 0;
    installFetch((url) => {
      if (url.includes("/story-bible/entities?")) return json(entitiesPayload([entityRow("e1", "Qain Yi")]));
      if (url.includes("/story-bible/health")) { healthAttempts++; return healthAttempts === 1 ? json({ error: "boom" }, 503) : json(healthPayload()); }
      if (url.includes("/story-bible/review")) return json({ error: "boom" }, 503);
      if (url.includes("/story-bible/suppressions")) return json({ error: "boom" }, 503);
      if (url.includes("/pronunciation")) return json({ entities: [], suggestions: {} });
      return json({});
    });
    await renderBible();

    // The entity table renders even though health, review, and suppressions all failed.
    expect(host!.textContent).toContain("Qain Yi");
    expect(host!.textContent).toContain("Health summary unavailable");
    // Review badge stays unset without breaking the page.
    expect(host!.textContent).toContain("Review");

    const retry = [...host!.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
    await act(async () => { retry.click(); });
    await flush();
    expect(healthAttempts).toBe(2);
    expect(host!.textContent).toContain("5");
    expect(host!.textContent).not.toContain("Health summary unavailable");
    expect(host!.textContent).toContain("Qain Yi");
  });

  it("shows a list-specific retry when the initial entity request fails", async () => {
    let attempts = 0;
    installFetch((url) => {
      if (url.includes("/story-bible/entities?")) { attempts++; return attempts === 1 ? json({ error: "list boom" }, 500) : json(entitiesPayload([entityRow("e1", "Recovered")])) }
      if (url.includes("/story-bible/health")) return json(healthPayload());
      if (url.includes("/story-bible/review")) return json({ openTotal: 3 });
      if (url.includes("/story-bible/suppressions")) return json([]);
      if (url.includes("/pronunciation")) return json({ entities: [], suggestions: {} });
      return json({});
    });
    await renderBible();
    expect(host!.textContent).toContain("list boom");
    expect(host!.textContent).not.toContain("Recovered");
    const retry = [...host!.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
    await act(async () => { retry.click(); });
    await flush();
    expect(attempts).toBe(2);
    expect(host!.textContent).toContain("Recovered");
  });

  it("debounces typing into a single effective search request", async () => {
    const calls = installFetch((url) => {
      if (url.includes("/story-bible/entities?")) return json(entitiesPayload([entityRow("e1", "Qain Yi")]));
      if (url.includes("/story-bible/health")) return json(healthPayload());
      if (url.includes("/story-bible/review")) return json({ openTotal: 0 });
      if (url.includes("/story-bible/suppressions")) return json([]);
      if (url.includes("/pronunciation")) return json({ entities: [], suggestions: {} });
      return json({});
    });
    await renderBible();
    expect(entityRequests(calls)).toHaveLength(1);

    await typeSearch("Qain");
    await typeSearch("Qain Yi");
    // No request fires before the debounce window elapses.
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(entityRequests(calls)).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    const searches = entityRequests(calls);
    expect(searches).toHaveLength(2);
    expect(searches[1].url).toContain("q=Qain%20Yi");
    expect(searches[1].url).toContain("page=1");
  });

  it("ignores stale search responses, keeps prior rows while searching, and gates the empty state", async () => {
    const pending = new Map<string, (value: Response) => void>();
    installFetch((url) => {
      if (url.includes("/story-bible/entities?")) {
        const q = new URL(url, "http://localhost").searchParams.get("q") ?? "";
        if (!q) return json(entitiesPayload([entityRow("e1", "Alpha")]));
        return new Promise<Response>((resolve) => pending.set(q, resolve));
      }
      if (url.includes("/story-bible/health")) return json(healthPayload());
      if (url.includes("/story-bible/review")) return json({ openTotal: 0 });
      if (url.includes("/story-bible/suppressions")) return json([]);
      if (url.includes("/pronunciation")) return json({ entities: [], suggestions: {} });
      return json({});
    });
    await renderBible();
    expect(host!.textContent).toContain("Alpha");

    await typeSearch("aaa");
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    // While the first search is in flight the prior rows stay visible with an indicator.
    expect(host!.textContent).toContain("Alpha");
    expect(host!.textContent).toContain("Searching…");
    expect(host!.textContent).not.toContain("No matching canonical entities");

    await typeSearch("bbb");
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(pending.has("aaa")).toBe(true);
    expect(pending.has("bbb")).toBe(true);

    // The newer request resolves first and updates the table.
    await act(async () => { pending.get("bbb")!(json(entitiesPayload([entityRow("e2", "Beta")]))); });
    await flush();
    expect(host!.textContent).toContain("Beta");
    expect(host!.textContent).not.toContain("Searching…");

    // A stale older response resolving later must not overwrite the newer view.
    await act(async () => { pending.get("aaa")!(json(entitiesPayload([entityRow("e3", "Stale")]))); });
    await flush();
    expect(host!.textContent).toContain("Beta");
    expect(host!.textContent).not.toContain("Stale");

    // A latest request completing with zero results shows the empty state.
    await typeSearch("zzz");
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    await act(async () => { pending.get("zzz")!(json(entitiesPayload([]))); });
    await flush();
    expect(host!.textContent).toContain("No matching canonical entities");
  });

  it("resets to page 1 when the search query changes", async () => {
    const calls = installFetch((url) => {
      if (url.includes("/story-bible/entities?")) return json(entitiesPayload([entityRow("e1", "Alpha")], { page: 2, pages: 3, total: 120 }));
      if (url.includes("/story-bible/health")) return json(healthPayload());
      if (url.includes("/story-bible/review")) return json({ openTotal: 0 });
      if (url.includes("/story-bible/suppressions")) return json([]);
      if (url.includes("/pronunciation")) return json({ entities: [], suggestions: {} });
      return json({});
    });
    await renderBible("/stories/story/bible?page=2");
    expect(entityRequests(calls)[0].url).toContain("page=2");

    await typeSearch("anything");
    // The debounce is still pending: no intermediate page=1 request with the
    // stale query may fire.
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(entityRequests(calls)).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    const searches = entityRequests(calls);
    // Exactly one post-debounce request: page=1 plus the newest query.
    expect(searches).toHaveLength(2);
    expect(searches[1].url).toContain("page=1");
    expect(searches[1].url).toContain("q=anything");
  });

  it("issues a prompt entity request for type, readiness, and sort changes", async () => {
    const calls = installFetch((url) => {
      if (url.includes("/story-bible/entities?")) return json(entitiesPayload([entityRow("e1", "Alpha")]));
      if (url.includes("/story-bible/health")) return json(healthPayload());
      if (url.includes("/story-bible/review")) return json({ openTotal: 0 });
      if (url.includes("/story-bible/suppressions")) return json([]);
      if (url.includes("/pronunciation")) return json({ entities: [], suggestions: {} });
      return json({});
    });
    await renderBible();
    expect(entityRequests(calls)).toHaveLength(1);

    const changeSelect = async (select: HTMLSelectElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(select, value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };

    const selects = [...host!.querySelectorAll<HTMLSelectElement>(".canonical-toolbar select")];
    expect(selects.length).toBeGreaterThanOrEqual(3);
    // No debounce is pending (query is empty), so each filter change fires
    // an entity request immediately, without advancing timers.
    await changeSelect(selects[0], "character");
    expect(entityRequests(calls)).toHaveLength(2);
    expect(entityRequests(calls)[1].url).toContain("type=character");

    await changeSelect(host!.querySelector<HTMLSelectElement>("select[aria-label='Readiness filter']")!, "needs-attention");
    expect(entityRequests(calls)).toHaveLength(3);
    expect(entityRequests(calls)[2].url).toContain("readiness=needs-attention");

    await changeSelect(selects[2], "name");
    expect(entityRequests(calls)).toHaveLength(4);
    expect(entityRequests(calls)[3].url).toContain("sort=name");
  });

  it("loads the review badge from /review/summary and tolerates its failure", async () => {
    const calls = installFetch((url) => {
      if (url.includes("/story-bible/entities?")) return json(entitiesPayload([entityRow("e1", "Qain Yi")]));
      if (url.includes("/story-bible/health")) return json(healthPayload());
      if (url.includes("/story-bible/review/summary")) return json({ openTotal: 7, counts: { merge: 4, conflict: 3 } });
      if (url.includes("/story-bible/review")) return json({ openTotal: 7 });
      if (url.includes("/story-bible/suppressions")) return json([]);
      if (url.includes("/pronunciation")) return json({ entities: [], suggestions: {} });
      return json({});
    });
    await renderBible();
    const summaries = calls.filter((call) => call.url.includes("/story-bible/review/summary"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].url).toContain("/stories/story/story-bible/review/summary");
    expect(host!.textContent).toContain("Review (7)");
    act(() => root!.unmount());
    root = undefined;
    host!.remove();
    host = undefined;

    // A 503 on the summary endpoint leaves the entity rows rendered.
    installFetch((url) => {
      if (url.includes("/story-bible/entities?")) return json(entitiesPayload([entityRow("e1", "Qain Yi")]));
      if (url.includes("/story-bible/health")) return json(healthPayload());
      if (url.includes("/story-bible/review")) return json({ error: "boom" }, 503);
      if (url.includes("/story-bible/suppressions")) return json([]);
      if (url.includes("/pronunciation")) return json({ entities: [], suggestions: {} });
      return json({});
    });
    await renderBible();
    expect(host!.textContent).toContain("Qain Yi");
    expect(host!.textContent).not.toContain("Review (");
  });

  it("hides the duplicate strip while a canonical search is active and restores it when cleared", async () => {
    const suggestion = { id: "s1", entityIds: [], confidence: 0.9, reason: "Similar names", supportingChapters: [1], entities: [{ name: "A" }, { name: "B" }] };
    const calls = installFetch((url) => {
      if (url.includes("/story-bible/entities?")) {
        const q = new URL(url, "http://localhost").searchParams.get("q") ?? "";
        return q ? json(entitiesPayload([entityRow("e1", "Alpha")], { duplicateSuggestions: [suggestion] })) : json(entitiesPayload([entityRow("e1", "Alpha")], { duplicateSuggestions: [suggestion] }));
      }
      if (url.includes("/story-bible/health")) return json(healthPayload());
      if (url.includes("/story-bible/review")) return json({ openTotal: 0 });
      if (url.includes("/story-bible/suppressions")) return json([]);
      if (url.includes("/pronunciation")) return json({ entities: [], suggestions: {} });
      return json({});
    });
    await renderBible();
    expect(host!.textContent).toContain("suggestions need approval");

    await typeSearch("Alpha");
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(host!.textContent).toContain("Alpha");
    expect(host!.textContent).not.toContain("suggestions need approval");

    await typeSearch("");
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(host!.textContent).toContain("suggestions need approval");
    expect(entityRequests(calls).length).toBeGreaterThanOrEqual(3);
  });

  it("opens an entity with scroll-preserving navigation", async () => {
    installFetch((url) => {
      if (url.includes("/story-bible/entities?")) return json(entitiesPayload([entityRow("entity-1", "Alpha")]));
      if (url.includes("/story-bible/health")) return json(healthPayload());
      if (url.includes("/story-bible/review")) return json({ openTotal: 0 });
      if (url.includes("/story-bible/suppressions")) return json([]);
      if (url.includes("/pronunciation")) return json({ entities: [], suggestions: {} });
      return json({});
    });
    await renderBible();
    const row = host!.querySelector<HTMLElement>(".entity-row.selectable:not(.heading)")!;
    await act(async () => { row.click(); });
    expect(navigate).toHaveBeenCalledTimes(1);
    const [href, options] = navigate.mock.calls[0];
    expect(href).toBe("/stories/story/bible?entity=entity-1");
    expect(options).toEqual({ scroll: "preserve" });
  });
});

describe("Story Bible navigation scroll behavior", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("scrolls to top by default and for 'top', and preserves position for 'preserve'", () => {
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    performNavigateScroll();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    performNavigateScroll("top");
    expect(scrollTo).toHaveBeenCalledTimes(2);
    performNavigateScroll("preserve");
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });
});

describe("Story Bible list helpers", () => {
  it("request gate only honors the latest request", () => {
    const gate = createRequestGate();
    const first = gate.next();
    const second = gate.next();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(second)).toBe(false);
    expect(gate.isCurrent(gate.next())).toBe(true);
  });

  it("duplicate strip visibility follows the trimmed search query", () => {
    expect(shouldShowDuplicateStrip("", [{ id: 1 }])).toBe(true);
    expect(shouldShowDuplicateStrip("   ", [{ id: 1 }])).toBe(true);
    expect(shouldShowDuplicateStrip("qain", [{ id: 1 }])).toBe(false);
    expect(shouldShowDuplicateStrip("", [])).toBe(false);
    expect(shouldShowDuplicateStrip("", undefined)).toBe(false);
  });

  it("round-trips bible query state through the query string", () => {
    const state = { tab: "canonical" as const, type: "character", q: "Qain Yi", sort: "name", readiness: "needs-attention", page: 3, entity: "e1", section: "management" as const };
    expect(parseBibleQuery(bibleQueryString(state))).toEqual({ type: "character", q: "Qain Yi", sort: "name", readiness: "needs-attention", page: 3, entity: "e1", section: "management", tab: undefined });
  });
});

describe("api abort propagation", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("passes AbortSignal through to fetch", async () => {
    const calls = installFetch(() => json({ ok: true }));
    const controller = new AbortController();
    await api("/stories/story/story-bible/entities?page=1", { signal: controller.signal });
    expect(calls[0].init?.signal).toBe(controller.signal);
  });

  it("rethrows AbortError instead of wrapping it as a connectivity failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation was aborted.", "AbortError"); }));
    const rejection = await api("/stories/story/story-bible/entities?page=1").then(() => undefined, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(DOMException);
    expect((rejection as Error).name).toBe("AbortError");
    expect(rejection).not.toBeInstanceOf(ApiError);
  });
});
