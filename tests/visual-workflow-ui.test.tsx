/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { SceneCreatureGroups } from "../apps/web/src/SceneCreatureGroups.js";
import { VisualReviewQueue } from "../apps/web/src/VisualReviewQueue.js";
import { sceneSchema } from "../src/scenes/types.js";
const entityId = "ent_0123456789abcdef01234567";
const catalog = [{ id: entityId, name: "Goblin", type: "creature", baseReferenceIds: [], tasks: [{ key: "zombie", kind: "form", scopeId: "zombie", label: "Zombie", needsSheet: true }], profile: { references: [{ id: "candidate", approved: false }], creatureForms: [{ id: "zombie", name: "Zombie", state: "zombie", status: "draft", appearance: "Gray flesh", referenceIds: ["candidate"] }] } }];
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
it("shows reviewed candidates and sends the exact form scope on batch approval", async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => { calls.push({ url: String(url), body: init?.body }); return json(String(url).endsWith("/approve") ? catalog[0]!.profile : catalog); }));
  await act(async () => root.render(<VisualReviewQueue slug="test" onReview={() => undefined} />));
  expect(host.querySelector("img")?.getAttribute("src")).toContain(`${entityId}/references/candidate`);
  await act(async () => (host.querySelector('input[type="radio"]') as HTMLInputElement).click());
  const approve = [...host.querySelectorAll("button")].find(button => button.textContent?.startsWith("Approve selected"))!;
  await act(async () => approve.click());
  const call = calls.find(call => call.url.endsWith("/approve"));
  expect(JSON.parse(call!.body!)).toMatchObject({ primary: true, creatureFormId: "zombie" });
  expect(host.textContent).toContain("1 succeeded, 0 need attention");
});
it("offers approved forms, keeps exact form IDs, and displays their approved references", async () => {
  const approved = structuredClone(catalog); approved[0]!.profile.creatureForms[0]!.status = "approved"; approved[0]!.profile.references[0]!.approved = true;
  vi.stubGlobal("fetch", vi.fn(async () => json(approved)));
  const groups = sceneSchema.parse({ id: "scene-001", startSeconds: 0, endSeconds: 5, summary: "Goblins", visualPrompt: "Goblins", creatureGroups: [{ id: "g", entity: entityId, label: "Zombies", state: "zombie", appearance: "" }] }).creatureGroups!;
  const change = vi.fn(); await act(async () => root.render(<SceneCreatureGroups slug="test" groups={groups} onChange={change} />));
  expect(host.querySelector('input[list]')?.getAttribute("value")).toBe("Goblin");
  expect(host.querySelector("img")?.getAttribute("src")).toContain("candidate");
  const select = [...host.querySelectorAll("select")].find(select => [...select.options].some(option => option.value === "zombie" && option.text === "Zombie"))!;
  await act(async () => { select.value = "zombie"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(change.mock.calls[0]![0][0].formId).toBe("zombie");
});
it("offers retry for a finished batch with failed entries and shows completed progress", async () => {
  const { VisualWorkflowJob } = await import("../apps/web/src/VisualWorkflowJob.js");
  const retry = vi.fn();
  const job = { id: "test", story: "test", type: "visualWorkflow", status: "completed", progress: { total: 2, index: 2 }, result: { status: "completed_with_errors", outcomes: [{ key: "one", status: "generated" }, { key: "two", status: "failed", error: "Provider unavailable" }] } };
  await act(async () => root.render(<VisualWorkflowJob job={job as any} onRetry={retry} />));
  expect(host.querySelector("progress")?.value).toBe(2);
  expect(host.textContent).toContain("Provider unavailable");
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Preview remaining work")!.click());
  expect(retry).toHaveBeenCalledWith(job);
});
it("makes unscoped candidate sheets reviewable in the base-reference queue", async () => {
  const base = structuredClone(catalog); base[0]!.tasks = [{ key: "base", kind: "reference", label: "Missing approved reference", needsSheet: true }] as any;
  base[0]!.profile.creatureForms = [];
  const calls: Array<{ url: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => { calls.push({ url: String(url), body: init?.body }); return json(String(url).endsWith("/approve") ? base[0]!.profile : base); }));
  await act(async () => root.render(<VisualReviewQueue slug="test-base" onReview={() => undefined} />));
  expect(host.textContent).toContain("I reviewed this base sheet");
  await act(async () => (host.querySelector('input[type="radio"]') as HTMLInputElement).click());
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.startsWith("Approve selected"))!.click());
  const call = calls.find(call => call.url.endsWith("/approve"));
  expect(JSON.parse(call!.body!)).toEqual({ primary: true });
});
