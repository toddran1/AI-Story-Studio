/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { it, expect, vi } from "vitest";
import { ContinuityPage } from "../apps/web/src/App.js";
it("dismisses inline, exposes action failures beside the finding, and routes merges to entity management", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const navigate = vi.fn(); let fail = true; const mutations: any[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (init?.method === "PUT") { mutations.push(JSON.parse(init.body)); return fail ? json({ error: "Story is busy. Retry shortly." }, 409) : json({}); }
    if (String(url).includes("/summary")) return json({ counts: { open: 1, resolved: 0 } });
    return json({ items: [{ id: "ctf_test", type: "identity_alias_ambiguity", severity: "warning", entityIds: ["ent_test"], explanation: "Shared alias", chapters: [1], supportingFacts: [], status: "open" }], names: { ent_test: "Feixue" }, page: 1, pages: 1, total: 1 });
  }));
  try {
    await act(async () => root.render(<ContinuityPage slug="test" navigate={navigate} />));
    const click = async (label: string) => act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === label)!.click());
    await click("Review merge in Story Bible →"); expect(navigate).toHaveBeenCalledWith("/stories/test/bible?entity=ent_test&section=management");
    await click("Dismiss false positive"); expect(host.querySelector("textarea")).not.toBeNull(); expect(mutations).toHaveLength(0);
    await click("Confirm dismissal"); expect(host.querySelector("article [role=alert]")?.textContent).toContain("Story is busy");
    fail = false; await click("Confirm dismissal"); expect(mutations[1]).toMatchObject({ resolution: "dismissed" }); expect(host.textContent).toContain("Finding dismissed.");
  } finally { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
