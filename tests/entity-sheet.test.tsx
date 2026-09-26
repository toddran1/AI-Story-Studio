/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, CanonicalEntitySheet, EntityDetailAccordion, EntityHistorySection, EntityUsageSection } from "../apps/web/src/App.js";

function fillRemovalReason(page: HTMLElement, value: string) {
  const input = page.querySelector<HTMLInputElement>('input[aria-label="Reason for removal"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Story Bible entity detail accordion", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = undefined;
    host?.remove();
    host = undefined;
    vi.unstubAllGlobals();
  });

  it("starts collapsed, mounts its content on demand, and toggles accessibly", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<EntityDetailAccordion id="management" title="Entity Management" badge="2 duplicate candidates"><p>Advanced controls</p></EntityDetailAccordion>));

    const trigger = host.querySelector<HTMLButtonElement>("button[aria-controls='entity-section-management']")!;
    const panel = host.querySelector<HTMLElement>("#entity-section-management")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);
    expect(panel.textContent).toBe("");
    expect(host.textContent).toContain("2 duplicate candidates");

    act(() => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain("Advanced controls");

    act(() => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);
    // Once loaded, content is retained while collapsed rather than refetched/remounted.
    expect(panel.textContent).toContain("Advanced controls");
  });

  it("remounts entity-local sheet state when the selected entity changes", () => {
    const makeDetail = (id: string, canonicalName: string) => ({
      entity: {
        id, type: "character", canonicalName, originalName: canonicalName, aliases: [], aliasNarrationRules: [],
        canonicalNameLocked: false, status: "alive", notes: "", description: "A long description. ".repeat(30),
        origin: "automatic", firstAppearance: 1, lastKnownAppearance: 2, provenance: [], mergedFromIds: [],
      },
      timeline: [], relationships: [], relatedNames: {}, relatedReferences: [], issues: [], merges: [],
      duplicateSuggestions: [], namingCollisions: [], readiness: [], visualProfileExists: false,
    });
    const props = { slug: "story", navigate: () => undefined, onClose: () => undefined, onUndo: () => undefined, onEdit: () => undefined, onDemote: () => undefined, onSuppress: () => undefined, onMerge: () => undefined };
    function Harness() {
      const [selected, setSelected] = useState({ detail: makeDetail("entity-a", "Entity A"), management: true });
      return <>
        <button type="button" onClick={() => setSelected({ detail: makeDetail("entity-b", "Entity B"), management: false })}>Select B</button>
        <CanonicalEntitySheet key={selected.detail.entity.id} detail={selected.detail} {...props} managementInitiallyOpen={selected.management} />
      </>;
    }

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Harness />));
    // Open the long-description disclosure to create entity-specific local UI state.
    const more = [...host.querySelectorAll("button")].find((button) => button.textContent === "Show more")!;
    act(() => more.click());
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Show less")).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('button[aria-controls="entity-section-entity-management"]')?.getAttribute("aria-expanded")).toBe("true");

    act(() => [...host.querySelectorAll("button")].find((button) => button.textContent === "Select B")!.click());
    expect(host.textContent).toContain("Entity B");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Show less")).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('button[aria-controls="entity-section-entity-management"]')?.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps Story Information open while Timeline is a separate collapsed accordion", () => {
    const detail = {
      entity: { id: "entity-timeline", type: "character", canonicalName: "Timeline Entity", originalName: "Timeline Entity", aliases: [], aliasNarrationRules: [], canonicalNameLocked: false, status: "alive", notes: "", description: "", origin: "automatic", firstAppearance: 1, lastKnownAppearance: 4, provenance: [], mergedFromIds: [] },
      timeline: [{ id: "current-event", chapter: 4, type: "appearance", summary: "Current timeline event" }],
      relationships: [], relatedNames: {}, relatedReferences: [], issues: [], merges: [], duplicateSuggestions: [], namingCollisions: [], readiness: [], visualProfileExists: false,
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<CanonicalEntitySheet detail={detail} slug="story" navigate={() => undefined} onClose={() => undefined} onUndo={() => undefined} onEdit={() => undefined} />));
    expect(host.querySelector<HTMLButtonElement>('button[aria-controls="entity-section-story-information"]')?.getAttribute("aria-expanded")).toBe("true");
    const timeline = host.querySelector<HTMLButtonElement>('button[aria-controls="entity-section-timeline"]')!;
    expect(timeline.getAttribute("aria-expanded")).toBe("false");
    expect(timeline.textContent).toContain("1 event");
    expect(host.textContent).not.toContain("Current timeline event");
    act(() => timeline.click());
    expect(host.textContent).toContain("Current timeline event");
    expect([...host.querySelectorAll<HTMLButtonElement>(".entity-history button")].some((button) => button.textContent?.includes("Ch. 4"))).toBe(true);
    act(() => timeline.click());
    expect(host.querySelector<HTMLElement>("#entity-section-timeline")?.hidden).toBe(true);
  });

  it("keeps Relationships and Issues & Review separate and closed by default", () => {
    const detail = {
      entity: { id: "entity-relations", type: "character", canonicalName: "Mara", originalName: "Mara", aliases: [], aliasNarrationRules: [], canonicalNameLocked: false, status: "alive", notes: "A note", description: "", origin: "automatic", firstAppearance: 1, lastKnownAppearance: 2, provenance: [], mergedFromIds: [] },
      timeline: [], relationships: [{ id: "relation-1", sourceEntityId: "entity-relations", targetEntityId: "friend", type: "friend", startChapter: 1 }], relatedNames: { friend: "Lena" }, relatedReferences: [], issues: [{ id: "issue-1" }], merges: [], duplicateSuggestions: [], namingCollisions: [{ id: "collision-1", hasMergeRelationship: false, reason: "The name Sue is used by two entities.", entities: [{ id: "friend", canonicalName: "Lena", type: "character", field: "preferred narration name" }] }], readiness: [], visualProfileExists: false,
    };
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<CanonicalEntitySheet detail={detail} slug="story" navigate={() => undefined} onClose={() => undefined} onUndo={() => undefined} onEdit={() => undefined} />));
    const relationships = host.querySelector<HTMLButtonElement>('button[aria-controls="entity-section-relationships"]')!;
    const issues = host.querySelector<HTMLButtonElement>('button[aria-controls="entity-section-issues-review"]')!;
    expect(relationships.getAttribute("aria-expanded")).toBe("false"); expect(relationships.textContent).toContain("1 relationship");
    expect(issues.getAttribute("aria-expanded")).toBe("false"); expect(issues.textContent).toContain("2 items");
    expect(host.querySelector("#entity-section-story-information")?.textContent).not.toContain("Lena");
    expect(host.textContent).not.toContain("Lena");
    act(() => relationships.click());
    expect(host.querySelector("#entity-section-relationships")?.textContent).toContain("Lena");
    act(() => issues.click());
    expect(host.querySelector("#entity-section-issues-review")?.textContent).toContain("1 continuity issues");
    expect(host.querySelector("#entity-section-issues-review")?.textContent).toContain("The name Sue is used by two entities.");
  });

  it("uses historical timeline entries and omits the accordion when no timeline exists", () => {
    const detail = {
      entity: { id: "entity-history", type: "character", canonicalName: "History Entity", originalName: "History Entity", aliases: [], aliasNarrationRules: [], canonicalNameLocked: false, status: "alive", notes: "", description: "", origin: "automatic", firstAppearance: 1, lastKnownAppearance: 4, provenance: [], mergedFromIds: [] },
      timeline: [{ id: "current-event", chapter: 4, type: "appearance", summary: "Current event only" }],
      relationships: [], relatedNames: {}, relatedReferences: [], issues: [], merges: [], duplicateSuggestions: [], namingCollisions: [], readiness: [], visualProfileExists: false,
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const base = { slug: "story", navigate: () => undefined, onClose: () => undefined, onUndo: () => undefined, onEdit: () => undefined };
    act(() => root!.render(<CanonicalEntitySheet detail={detail} {...base} historyView={{ chapter: 2, exists: true, entity: detail.entity, timeline: [{ id: "historical-event", chapter: 2, type: "appearance", summary: "Historical event only" }], relationships: [], relatedNames: {}, provenance: [], currentOverrides: [], warnings: [], firstAppearanceKnown: true }} />));
    const timeline = host.querySelector<HTMLButtonElement>('button[aria-controls="entity-section-timeline"]')!;
    expect(timeline.textContent).toContain("1 event");
    expect(timeline.getAttribute("aria-expanded")).toBe("false");
    act(() => timeline.click());
    expect(host.textContent).toContain("Historical event only");
    expect(host.textContent).not.toContain("Current event only");

    const withoutTimeline = { ...detail, entity: { ...detail.entity, id: "entity-no-timeline" }, timeline: [] };
    act(() => root!.render(<CanonicalEntitySheet detail={withoutTimeline} {...base} />));
    expect(host.querySelector('button[aria-controls="entity-section-timeline"]')).toBeNull();
  });

  it("defines a shared drawer, modal, and dialog overlay contract", () => {
    const css = readFileSync("apps/web/src/overlay-layers.css", "utf8");
    expect(css).toContain("--z-drawer: 30");
    expect(css).toContain("--z-modal: 50");
    expect(css).toContain("--z-dialog: 60");
    const level = (name: string) => Number(css.match(new RegExp(`--z-${name}: (\\d+)`))?.[1]);
    expect(level("drawer")).toBeLessThan(level("modal"));
    expect(level("modal")).toBeLessThan(level("dialog"));
    expect(css).toContain(".editor-sheet.entity-sheet");
    expect(css).toContain(".editor-sheet:not(.entity-sheet)");
    expect(css).toContain(".entity-impact-dialog");
    const scenes = readFileSync("apps/web/src/scenes.css", "utf8");
    expect(scenes.match(/\.modal-backdrop \{[^}]*z-index:/)).toBeNull();
    expect(scenes.match(/\.reference-viewer-backdrop \{[^}]*z-index:/)).toBeNull();
  });

  it("offers explicit retries for failed lazy usage and history loads without looping", async () => {
    const counts = { usage: 0, audit: 0 };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const isUsage = String(input).includes("/usage?");
      const key = isUsage ? "usage" : "audit";
      counts[key]++;
      if (counts[key] === 1) return new Response(JSON.stringify({ error: "Temporary service error" }), { status: 503, headers: { "content-type": "application/json" } });
      const payload = isUsage
        ? { summary: { sourceChapters: [1, 2], translationChapters: 2, narrationChapters: 1, qaFindings: 0, continuityFindings: 0, scenes: 0, visualProfile: false }, uses: [], total: 0, page: 1, pageSize: 25 }
        : { entries: [], historical: [], total: 0, page: 1, pageSize: 25 };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<><EntityUsageSection slug="story" entityId="entity-a" navigate={() => undefined} expandedByDefault /><EntityHistorySection slug="story" entityId="entity-a" expandedByDefault /></>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(counts).toEqual({ usage: 1, audit: 1 });
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect([...host.querySelectorAll("button")].filter((button) => button.textContent === "Retry")).toHaveLength(2);

    await act(async () => {
      for (const retry of [...host.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent === "Retry")) retry.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(counts).toEqual({ usage: 2, audit: 2 });
    expect(host.textContent).toContain("2 translated");
    expect(host.textContent).toContain("No recorded changes yet.");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(counts).toEqual({ usage: 2, audit: 2 });
  });

  it("retains a successful lazy section while its accordion is collapsed and reopened", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      requests++;
      return new Response(JSON.stringify({ summary: { sourceChapters: [1, 2], translationChapters: 2, narrationChapters: 1, qaFindings: 0, continuityFindings: 0, scenes: 0, visualProfile: false }, uses: [], total: 0, page: 1, pageSize: 25 }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<EntityDetailAccordion id="usage" title="Where Used"><EntityUsageSection slug="story" entityId="entity-a" navigate={() => undefined} expandedByDefault /></EntityDetailAccordion>);
    });
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-controls="entity-section-usage"]')!;
    await act(async () => {
      toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(requests).toBe(1);
    expect(host.textContent).toContain("2 translated");
    act(() => toggle.click());
    expect(host.querySelector<HTMLElement>("#entity-section-usage")?.hidden).toBe(true);
    act(() => toggle.click());
    expect(host.querySelector<HTMLElement>("#entity-section-usage")?.hidden).toBe(false);
    expect(requests).toBe(1);
  });

  it("discards merge-search results when the query changes during an outstanding request", async () => {
    let resolveA!: (response: Response) => void;
    const candidate = (id: string, canonicalName: string) => ({ id, canonicalName, type: "character", firstAppearance: 1, lastKnownAppearance: 2 });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("q=A")) return new Promise<Response>((resolve) => { resolveA = resolve; });
      return Promise.resolve(new Response(JSON.stringify({ items: [candidate("entity-b", "Candidate B")] }), { status: 200, headers: { "content-type": "application/json" } }));
    }));
    const detail = {
      entity: { id: "entity-current", type: "character", canonicalName: "Current", originalName: "Current", aliases: [], aliasNarrationRules: [], canonicalNameLocked: false, status: "alive", notes: "", description: "", origin: "automatic", firstAppearance: 1, lastKnownAppearance: 2, provenance: [], mergedFromIds: [] },
      timeline: [], relationships: [], relatedNames: {}, relatedReferences: [], issues: [], merges: [], duplicateSuggestions: [], namingCollisions: [], readiness: [], visualProfileExists: false,
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<CanonicalEntitySheet detail={detail} slug="story" navigate={() => undefined} onClose={() => undefined} onUndo={() => undefined} onEdit={() => undefined} onDemote={() => undefined} onSuppress={() => undefined} onMerge={() => undefined} managementInitiallyOpen />));
    const input = host.querySelector<HTMLInputElement>("#merge-entity-search")!;
    const setInputValue = (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      setInputValue("A");
      [...host!.querySelectorAll("button")].find((button) => button.textContent === "Find")!.click();
      await Promise.resolve();
    });
    await act(async () => {
      setInputValue("B");
    });
    expect(host.textContent).not.toContain("Candidate A");
    await act(async () => {
      resolveA(new Response(JSON.stringify({ items: [candidate("entity-a", "Candidate A")] }), { status: 200, headers: { "content-type": "application/json" } }));
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain("Candidate A");
    await act(async () => {
      [...host!.querySelectorAll("button")].find((button) => button.textContent === "Find")!.click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain("Candidate B");
  });
});

describe("Story Bible entity deep-link integration", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let host: HTMLDivElement | undefined;
  let originalScrollTo: typeof window.scrollTo;

  const entities = [
    { id: "entity-a", canonicalName: "Entity A" },
    { id: "entity-b", canonicalName: "Entity B" },
  ];
  const detail = (entity: { id: string; canonicalName: string }) => ({
    entity: { ...entity, type: "character", originalName: entity.canonicalName, aliases: [], aliasNarrationRules: [], canonicalNameLocked: false, status: "alive", notes: "", description: "", origin: "automatic", firstAppearance: 1, lastKnownAppearance: 2, provenance: [], mergedFromIds: [] },
    timeline: [], relationships: [], relatedNames: {}, relatedReferences: [], issues: [], merges: [], duplicateSuggestions: [], namingCollisions: [], readiness: [], visualProfileExists: false,
  });
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  const bibleList = { items: entities.map((entity) => ({ ...entity, type: "character", originalName: entity.canonicalName, aliases: [], firstAppearance: 1, lastKnownAppearance: 2, origin: "automatic", readiness: [] })), total: 2, page: 1, pages: 1, counts: { character: 2 }, duplicateSuggestions: [] };

  beforeEach(() => {
    originalScrollTo = window.scrollTo;
    window.scrollTo = vi.fn();
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = undefined;
    host?.remove();
    host = undefined;
    window.scrollTo = originalScrollTo;
    vi.unstubAllGlobals();
  });

  function mount(initialSearch = "") {
    history.replaceState({}, "", `/stories/demo/bible${initialSearch}`);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<App initialRoute={{ page: "bible", story: "demo" }} />));
    return host;
  }

  function installApi(
    detailRequest: (id: string) => Promise<Response> = async (id) => json(detail(entities.find((entity) => entity.id === id)!)),
    overrideRequest?: (url: string, init?: RequestInit) => Response | undefined,
  ) {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const override = overrideRequest?.(url, init);
      if (override) return Promise.resolve(override);
      if (url === "/api/stories") return Promise.resolve(json({ stories: [] }));
      if (url.endsWith("/jobs/active")) return Promise.resolve(json({ job: null }));
      if (url.includes("/story-bible/entities?") || url.includes("/story-bible/entities?")) return Promise.resolve(json(bibleList));
      if (url.endsWith("/story-bible/suppressions")) return Promise.resolve(json([]));
      if (url.endsWith("/story-bible/health")) return Promise.resolve(json({}));
      if (url.includes("/story-bible/review?")) return Promise.resolve(json({ items: [], openTotal: 0 }));
      if (url.endsWith("/pronunciation")) return Promise.resolve(json({ entities: [], suggestions: {} }));
      const entityId = url.match(/\/story-bible\/entities\/([^/?]+)/)?.[1];
      if (entityId) return detailRequest(decodeURIComponent(entityId));
      return Promise.resolve(json({}));
    }));
  }

  it("uses browser Back and Forward as authoritative entity-sheet navigation while preserving filters", async () => {
    installApi();
    const page = mount("?type=character&q=Qiang&page=2");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => {
      page.querySelector<HTMLElement>(".entity-row.selectable:not(.heading)")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(location.search).toContain("entity=entity-a");
    expect(location.search).toContain("type=character");
    expect(location.search).toContain("q=Qiang");
    expect(location.search).toContain("page=2");
    expect(page.textContent).toContain("Entity A");

    await act(async () => {
      history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(new URLSearchParams(location.search).has("entity")).toBe(false);
    expect(page.querySelector(".entity-sheet")).toBeNull();
    expect(location.search).toContain("q=Qiang");

    await act(async () => {
      history.forward();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(new URLSearchParams(location.search).get("entity")).toBe("entity-a");
    expect(page.textContent).toContain("Entity A");
  });

  it("opens the management section from a deep link and restores it through Back/Forward", async () => {
    installApi();
    const filters = "tab=review&type=character&q=Qiang&sort=first&readiness=attention&page=2";
    history.replaceState({}, "", `/stories/demo/bible?entity=entity-a&${filters}`);
    history.pushState({}, "", `/stories/demo/bible?entity=entity-a&section=management&${filters}`);
    const page = mount(`?entity=entity-a&section=management&${filters}`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const management = () => page.querySelector<HTMLButtonElement>('button[aria-controls="entity-section-entity-management"]');
    expect(management()?.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      management()!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(management()?.getAttribute("aria-expanded")).toBe("false");
    expect(new URLSearchParams(location.search).get("entity")).toBe("entity-a");
    expect(new URLSearchParams(location.search).get("section")).toBeNull();
    for (const [key, value] of new URLSearchParams(filters)) expect(new URLSearchParams(location.search).get(key)).toBe(value);

    await act(async () => {
      management()!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(management()?.getAttribute("aria-expanded")).toBe("true");
    expect(new URLSearchParams(location.search).get("entity")).toBe("entity-a");
    expect(new URLSearchParams(location.search).get("section")).toBe("management");
    for (const [key, value] of new URLSearchParams(filters)) expect(new URLSearchParams(location.search).get(key)).toBe(value);

    await act(async () => { history.back(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(new URLSearchParams(location.search).get("section")).toBeNull();
    expect(new URLSearchParams(location.search).get("entity")).toBe("entity-a");
    expect(management()?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => { history.forward(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(new URLSearchParams(location.search).get("section")).toBe("management");
    expect(new URLSearchParams(location.search).get("entity")).toBe("entity-a");
    expect(management()?.getAttribute("aria-expanded")).toBe("true");
  });

  it("ignores a late detail response after browser navigation closes the sheet", async () => {
    let resolveDetail!: (response: Response) => void;
    installApi((id) => id === "entity-a" ? new Promise<Response>((resolve) => { resolveDetail = resolve; }) : Promise.resolve(json(detail(entities.find((entity) => entity.id === id)!))));
    const page = mount();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    act(() => page.querySelector<HTMLElement>(".entity-row.selectable:not(.heading)")!.click());
    await act(async () => { history.back(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    await act(async () => {
      resolveDetail(json(detail(entities[0])));
      await Promise.resolve();
    });
    expect(page.querySelector(".entity-sheet")).toBeNull();
    expect(new URLSearchParams(location.search).has("entity")).toBe(false);
  });

  it("keeps the newest selection when an earlier entity request resolves last", async () => {
    let resolveA!: (response: Response) => void;
    installApi((id) => id === "entity-a" ? new Promise<Response>((resolve) => { resolveA = resolve; }) : Promise.resolve(json(detail(entities[1]))));
    const page = mount();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const rows = page.querySelectorAll<HTMLElement>(".entity-row.selectable:not(.heading)");
    act(() => rows[0].click());
    await act(async () => {
      page.querySelectorAll<HTMLElement>(".entity-row.selectable:not(.heading)")[1].click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(page.textContent).toContain("Entity B");
    await act(async () => { resolveA(json(detail(entities[0]))); await Promise.resolve(); });
    expect(new URLSearchParams(location.search).get("entity")).toBe("entity-b");
    expect(page.querySelector(".entity-sheet")?.textContent).toContain("Entity B");
    expect(page.querySelector(".entity-sheet")?.textContent).not.toContain("Entity A");
  });

  it("clears entity and management URL state after a successful suppress mutation", async () => {
    installApi(undefined, (url, init) => {
      if (url.endsWith("/entities/entity-a/impact")) return json({ affectedChapters: [], narrationAffected: 0, qaAffected: 0, ttsAffected: 0, audioAffected: 0, scenePlanningAffected: 0, artworkAffected: 0, videoAffected: 0, manualNarrationChapters: [], visualProfileAffected: false, continuityAffected: 0, warnings: [] });
      if (url.endsWith("/entities/entity-a/suppress") && init?.method === "POST") return json({});
      return undefined;
    });
    const page = mount("?entity=entity-a&section=management");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => {
      [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove canonical entity…")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => fillRemovalReason(page, "duplicate record"));
    await act(async () => {
      [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove entity")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(new URLSearchParams(location.search).has("entity")).toBe(false);
    expect(new URLSearchParams(location.search).has("section")).toBe(false);
    expect(page.querySelector(".entity-sheet")).toBeNull();
  });

  it("removes the suppressed entity from the visible list and shows its restoration audit", async () => {
    let suppressed = false;
    installApi(undefined, (url, init) => {
      if (url.includes("/story-bible/entities?")) return json({ ...bibleList, items: suppressed ? bibleList.items.filter((item) => item.id !== "entity-b") : bibleList.items, total: suppressed ? 1 : 2 });
      if (url.endsWith("/story-bible/suppressions")) return json(suppressed ? [{ entityId: "entity-b", name: "Entity B", type: "character", reason: "duplicate", suppressedAt: new Date().toISOString() }] : []);
      if (url.endsWith("/entities/entity-b/impact")) return json({ affectedChapters: [], warnings: [] });
      if (url.endsWith("/entities/entity-b/suppress") && init?.method === "POST") { suppressed = true; return json({ status: "suppressed" }); }
      return undefined;
    });
    const page = mount("?entity=entity-b&section=management");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove canonical entity…")!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    act(() => fillRemovalReason(page, "duplicate"));
    await act(async () => { [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove entity")!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(page.querySelector(".entity-sheet")).toBeNull();
    expect(new URLSearchParams(location.search).has("entity")).toBe(false);
    expect([...page.querySelectorAll(".entity-row.selectable")].some((row) => row.textContent?.includes("Entity B"))).toBe(false);
    expect(page.textContent).toContain("removed canonical records");
    expect(page.textContent).toContain("Restore entity");
  });

  it("keeps the entity sheet open when suppression fails", async () => {
    installApi(undefined, (url, init) => {
      if (url.endsWith("/entities/entity-a/impact")) return json({ affectedChapters: [], warnings: [] });
      if (url.endsWith("/entities/entity-a/suppress") && init?.method === "POST") return new Response(JSON.stringify({ error: "Suppression failed" }), { status: 500, headers: { "content-type": "application/json" } });
      return undefined;
    });
    const page = mount("?entity=entity-a&section=management");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove canonical entity…")!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    act(() => fillRemovalReason(page, "duplicate"));
    await act(async () => { [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove entity")!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(page.querySelector(".entity-sheet")).not.toBeNull();
    expect(new URLSearchParams(location.search).get("entity")).toBe("entity-a");
    expect(page.textContent).not.toContain('Removed "Entity A" from the effective Story Bible');
    expect(page.textContent).toContain("Suppression failed");
    expect(page.querySelector('[role="dialog"][aria-label="Review estimated impact"] [role="alert"]')?.textContent).toContain("Suppression failed");
  });

  it("clears the entity URL when the user manually closes the sheet", async () => {
    installApi();
    const page = mount("?entity=entity-a&section=management&type=character");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    act(() => page.querySelector<HTMLButtonElement>('button[aria-label="Close entity"]')!.click());
    expect(page.querySelector(".entity-sheet")).toBeNull();
    expect(new URLSearchParams(location.search).has("entity")).toBe(false);
    expect(new URLSearchParams(location.search).has("section")).toBe(false);
    expect(new URLSearchParams(location.search).get("type")).toBe("character");
  });

  it("keeps editor focus and cursor through typing, spaces, and textarea edits", async () => {
    installApi();
    const page = mount("?entity=entity-a&section=management");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    act(() => [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit entity")!.click());
    const name = page.querySelector<HTMLInputElement>(".editor-sheet[aria-label='Edit canonical record'] input:not([type='checkbox'])")!;
    const write = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    };
    expect(document.activeElement).toBe(name);
    for (const value of ["J", "Jo", "John", "John ", "John Smith"]) {
      act(() => write(name, value));
      expect(document.activeElement).toBe(name);
      expect(page.querySelector(".editor-sheet")).not.toBeNull();
    }
    expect(name.value).toBe("John Smith");
    act(() => name.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    expect(page.querySelector(".editor-sheet")).not.toBeNull();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => name.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(false);
    const notes = page.querySelector<HTMLTextAreaElement>(".editor-sheet textarea")!;
    act(() => { notes.focus(); write(notes, "First note with space"); });
    expect(notes.value).toBe("First note with space"); expect(document.activeElement).toBe(notes);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(page.querySelector(".editor-sheet[aria-label='Edit canonical record']")).toBeNull();
  });

  it("clears the deep link after a successful edit save that closes the sheet", async () => {
    installApi(undefined, (url, init) => url.endsWith("/entities/entity-a") && init?.method === "PUT"
      ? json({ invalidation: { affectedChapters: [], manualNarrationChapters: [] } })
      : undefined);
    const page = mount("?entity=entity-a&section=management");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    act(() => [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit entity")!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(page.querySelector(".editor-sheet.naming-editor")).not.toBeNull();
    expect(page.querySelector(".editor-sheet.naming-editor")?.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(page.querySelector(".editor-sheet[aria-label='Edit canonical record'] input:not([type='checkbox'])"));
    expect(page.querySelector(".entity-sheet")?.hasAttribute("inert")).toBe(true);
    expect(page.querySelector(".entity-sheet")?.getAttribute("aria-hidden")).toBe("true");
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(page.querySelector(".editor-sheet.naming-editor")).toBeNull();
    expect(page.querySelector(".entity-sheet")?.hasAttribute("inert")).toBe(false);
    expect(new URLSearchParams(location.search).get("entity")).toBe("entity-a");
    act(() => [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit entity")!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => {
      [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save protected record")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(page.querySelector(".entity-sheet")).toBeNull();
    expect(new URLSearchParams(location.search).has("entity")).toBe(false);
    expect(new URLSearchParams(location.search).has("section")).toBe(false);
  });

  it("clears the deep link after a successful demote mutation", async () => {
    installApi(undefined, (url, init) => {
      if (url.endsWith("/entities/entity-a/impact")) return json({ affectedChapters: [], narrationAffected: 0, qaAffected: 0, ttsAffected: 0, audioAffected: 0, scenePlanningAffected: 0, artworkAffected: 0, videoAffected: 0, manualNarrationChapters: [], visualProfileAffected: false, continuityAffected: 0, warnings: [] });
      if (url.endsWith("/entities/entity-a/demote") && init?.method === "POST") return json({});
      return undefined;
    });
    const page = mount("?entity=entity-a&section=management");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => {
      [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Convert to minor reference")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      page.querySelector<HTMLButtonElement>(".entity-impact-dialog button.primary")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(page.querySelector(".entity-sheet")).toBeNull();
    expect(new URLSearchParams(location.search).has("entity")).toBe(false);
    expect(new URLSearchParams(location.search).has("section")).toBe(false);
  });

  it("clears the merged source deep link after a successful merge", async () => {
    const duplicateDetail: any = detail(entities[1]);
    duplicateDetail.duplicateSuggestions = [{ id: "dup-a-b", entityIds: ["entity-a", "entity-b"], entities: [{ id: "entity-a", name: "Entity A", type: "character" }, { id: "entity-b", name: "Entity B", type: "character" }], reason: "matching aliases" }];
    installApi(async (id) => json(id === "entity-b" ? duplicateDetail : detail(entities[0])), (url, init) => {
      if (url.endsWith("/entities/entity-b/impact")) return json({ affectedChapters: [], narrationAffected: 0, qaAffected: 0, ttsAffected: 0, audioAffected: 0, scenePlanningAffected: 0, artworkAffected: 0, videoAffected: 0, manualNarrationChapters: [], visualProfileAffected: false, continuityAffected: 0, warnings: [] });
      if (url.endsWith("/story-bible/merges") && init?.method === "POST") return json({});
      return undefined;
    });
    const page = mount("?entity=entity-b&section=management");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => {
      [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Compare & merge")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      [...page.querySelectorAll<HTMLButtonElement>(".editor-sheet-actions button")].find((button) => button.textContent === "Confirm merge")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      page.querySelector<HTMLButtonElement>(".entity-impact-dialog button.primary")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(page.querySelector(".entity-sheet")).toBeNull();
    expect(new URLSearchParams(location.search).has("entity")).toBe(false);
    expect(new URLSearchParams(location.search).has("section")).toBe(false);
  });
});
