/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { EntityDetailAccordion } from "../apps/web/src/App.js";

describe("Story Bible entity detail accordion", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = undefined;
    host?.remove();
    host = undefined;
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
});
