// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AudioRegeneration } from "../apps/web/src/AudioRegeneration.js";
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); vi.unstubAllGlobals(); });
describe("audio regeneration selection UI", () => {
 it("submits mixed full chapter and individual segment selections without duplicates", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
   if (options?.method === "POST") { requests.push({ url, body: JSON.parse(String(options.body)) }); return new Response(JSON.stringify({ id: "test-job", status: "queued" }), { headers: { "content-type": "application/json" } }); }
   const value = url.includes("tts-quality") ? { quality: { segments: [{ index: 0, status: "needs_review", expectedText: "First segment" }, { index: 1, status: "verified", expectedText: "Second segment" }] } } : { items: [{ chapter: 310, title: "Opening" }, { chapter: 322, title: "Battle" }], page: 1, pages: 2, total: 26 };
   return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<AudioRegeneration slug="test-story" onJob={() => undefined} watchJob={() => () => undefined} />));
  await act(async () => (host!.querySelectorAll('.regen-chapter-head input')[0] as HTMLInputElement).click());
  await act(async () => (host!.querySelectorAll('.regen-chapter-head input')[1] as HTMLInputElement).click());
  await act(async () => (host!.querySelectorAll('.regen-chapter-head button')[1] as HTMLButtonElement).click());
  await act(async () => (host!.querySelector('.regen-segment input') as HTMLInputElement).click());
  expect(host.textContent).toContain("1 full chapters · 1 individual segments");
  await act(async () => (host!.querySelector('.regen-selection > .primary') as HTMLButtonElement).click());
  expect(requests).toEqual([{ url: '/api/stories/test-story/jobs/audio-regeneration', body: { selections: [{ chapter: 310 }, { chapter: 322, segments: [1] }], rebuildMasters: true } }]);
 });
 it("quick edits a selected chapter to segment 2 and preserves the selection on cancel", async () => {
  const requests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
   if (options?.method === "POST") { requests.push(JSON.parse(String(options.body))); return Response.json({ id: "test-job", status: "queued" }); }
   return Response.json(url.includes("tts-quality") ? { quality: { segments: [{ index: 0, status: "verified", expectedText: "One" }, { index: 1, status: "verified", expectedText: "Two" }] } } : { items: [{ chapter: 343, title: "Battle" }], page: 1, pages: 2, total: 26 });
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<AudioRegeneration slug="test-story" onJob={() => undefined} watchJob={() => () => undefined} />));
  const click = async (selector: string) => act(async () => (host!.querySelector(selector) as HTMLElement).click());
  await click('.regen-chapter-head input');
  await click('[aria-label="Edit chapter 343 selection"]');
  // Choose the second radio explicitly; each is nested in its own label.
  await act(async () => (host!.querySelectorAll('.regen-edit-mode input')[1] as HTMLInputElement).click());
  expect((host.querySelector('.regen-edit-actions .primary') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => (host!.querySelectorAll('.regen-segment-picks input')[1] as HTMLInputElement).click());
  await click('.regen-edit-actions .primary');
  expect(host.querySelector('.regen-selection-row')?.textContent).toContain("Segments 2");
  await click('[aria-label="Edit chapter 343 selection"]');
  await act(async () => (host!.querySelectorAll('.regen-edit-mode input')[0] as HTMLInputElement).click());
  await click('.regen-edit-actions .button:not(.primary)');
  expect(host.querySelector('.regen-selection-row')?.textContent).toContain("Segments 2");
  await click('.regen-selection > .primary');
  expect(requests).toEqual([{ selections: [{ chapter: 343, segments: [2] }], rebuildMasters: true }]);
 });

});
