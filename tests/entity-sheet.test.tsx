/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalEntitySheet, EntityDetailAccordion, EntityHistorySection, EntityUsageSection } from "../apps/web/src/App.js";

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
