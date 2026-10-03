/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SummaryMusicExports } from "../apps/web/src/SummaryMusicExports.js";
import type { StorySummary } from "../apps/web/src/api.js";

it.each(["audio", "video"] as const)("exports selected summary %s music and shows only the relevant controls", async (kind) => {
  localStorage.clear();
  vi.useFakeTimers();
  const onJob = vi.fn();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const id = "sum_12345678-1234-1234-1234-123456789abc";
  const trackId = "mus_123456789012345678901234";
  const requests: Array<{ url: string; body?: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: String(url), body });
    const value = String(url).endsWith("/music-export") ? { id: "job-1", status: "running" }
      : String(url).endsWith("/jobs/job-1") ? { id: "job-1", status: "completed", result: { edition: "bg-123456789abc", manifest: { kind } } }
      : String(url).endsWith("/music/tracks") ? { tracks: [{ id: trackId, title: "Ambient", tags: [], durationSeconds: 60 }] }
      : String(url).endsWith("/music-exports") ? { editions: [] }
      : String(url).endsWith("/music/beds") ? { beds: [] } : {};
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  }));
  try {
    await act(async () => { root.render(<SummaryMusicExports kind={kind} slug="demo-story" onJob={onJob} summary={{ id, audio: { outputFingerprint: "audio" }, video: { outputFingerprint: "video" } } as StorySummary} />); });
    const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(text))!;
    await act(async () => { button("Background music").click(); });
    const select = host.querySelector<HTMLSelectElement>(".music-controls select")!;
    await act(async () => { select.value = `track:${trackId}`; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.textContent).not.toContain("Mix preview chapter");
    expect(host.textContent).not.toContain(`Export summary ${kind === "audio" ? "MP4" : "MP3"}`);
    expect(host.textContent).toContain("Preview 30-second mix");
    await act(async () => { button(`Export summary ${kind === "audio" ? "MP3" : "MP4"}`).click(); });
    expect(requests.find((item) => item.url.endsWith("/music-export"))).toEqual({ url: `/api/stories/demo-story/summaries/${id}/music-export`, body: { kind, music: { mode: "track", trackId }, musicOverrides: {} } });
    expect(onJob).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }));
    expect(JSON.parse(localStorage.getItem(`summary-music:demo-story:${id}`)!)).toMatchObject({ music: { mode: "track", trackId } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(host.querySelector<HTMLAnchorElement>("a[download]")?.href).toContain(`/summaries/${id}/${kind}-exports/bg-123456789abc.${kind === "audio" ? "mp3" : "mp4"}`);
  } finally { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});
