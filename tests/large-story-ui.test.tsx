// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, AudioPage, VideoPage, OutputsPage, ScenesPage, QaPage, ProductionPage, StoryPage, ContinuityPage } from "../apps/web/src/App.js";
import { SummariesPage } from "../apps/web/src/SummariesPage.js";
import { NamesLocalizationPage } from "../apps/web/src/NamesLocalizationPage.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => undefined;
const json = (value: unknown) => ({ ok: true, json: async () => value }) as Response;
const tick = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
let root: Root | undefined; let container: HTMLDivElement | undefined;
function mount(element: React.ReactNode) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); return act(async () => { root!.render(element); }); }
afterEach(async () => { if (root) await act(async () => root!.unmount()); container?.remove(); root = undefined; container = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("large story pages", () => {
  it("debounces Summary search without reloading context or dashboard", async () => {
    vi.useFakeTimers(); const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url); if (url.endsWith("/summaries/context")) return json({ minChapter: 1, maxChapter: 20 }); return json({ items: [], page: 1, pageSize: 25, pages: 1, total: 0 }); }));
    await mount(<SummariesPage slug="test-story" onJob={() => undefined} />);
    const input = container!.querySelector<HTMLInputElement>('input[aria-label="Search summaries"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "old"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "new phrase"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(calls.filter((url) => url.includes("/summaries?"))).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(calls.filter((url) => url.includes("/summaries?")).at(-1)).toContain("q=new+phrase");
    expect(calls.filter((url) => url.endsWith("/summaries/context"))).toHaveLength(1);
    expect(calls.some((url) => url.endsWith("/dashboard"))).toBe(false);
  });

  it("keeps Continuity rows visible while a status request is pending", async () => {
    let resolveDismissed!: (response: Response) => void; const calls: string[] = [];
    const finding = { id: "ctf_1", type: "status_conflict", severity: "critical", entityIds: ["ent_1"], chapters: [1], explanation: "Visible finding", supportingFacts: [], status: "open" };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url); if (url.endsWith("/continuity/summary")) return json({ counts: { open: 1, resolved: 0, dismissed: 0 }, analyzedThroughChapter: 1, needsReanalysis: false }); if (url.includes("status=dismissed")) return new Promise<Response>((resolve) => { resolveDismissed = resolve; }); return json({ items: [finding], page: 1, pageSize: 25, pages: 1, total: 1, names: { ent_1: "Entity One" } }); }));
    await mount(<ContinuityPage slug="test-story" navigate={() => undefined} />);
    expect(container!.textContent).toContain("Visible finding");
    await act(async () => [...container!.querySelectorAll("button")].find((button) => button.textContent === "Dismissed")!.click());
    expect(container!.textContent).toContain("Visible finding");
    await act(async () => resolveDismissed(json({ items: [], page: 1, pageSize: 25, pages: 1, total: 0, names: {} })));
    expect(container!.textContent).not.toContain("Visible finding");
    expect(calls.filter((url) => url.endsWith("/continuity/summary"))).toHaveLength(1);
  });

  it("debounces Names search and skips an old-query page reset request", async () => {
    vi.useFakeTimers(); const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url); if (url.endsWith("/stories/test-story")) return json({ story: { outputLanguage: "en-US" } }); return json({ items: [], page: 1, pageSize: 50, pages: 1, total: 0 }); }));
    await mount(<NamesLocalizationPage slug="test-story" onJob={() => undefined} navigate={() => undefined} />);
    const input = container!.querySelector<HTMLInputElement>('input[placeholder="Search any name"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Qain Yi"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(calls.filter((url) => url.includes("/story-bible/entities?"))).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(calls.filter((url) => url.includes("/story-bible/entities?"))).toHaveLength(2);
    expect(calls.at(-1)).toContain("q=Qain%20Yi");
  });
  it("loads QA summary separately and ignores an older filter response", async () => {
    let resolveWarn!: (value: Response) => void;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url);
      if (url.endsWith("/qa/summary")) return json({ counts: { pass: 1, warn: 1, fail: 1, needsVerification: 0, totalEvaluated: 3, chapterCount: 3, minChapter: 1, maxChapter: 3 }, categories: {} });
      if (url.includes("/qa-exceptions")) return json({ exceptions: [] });
      if (url.includes("status=warn")) return new Promise<Response>((resolve) => { resolveWarn = resolve; });
      if (url.includes("status=fail")) return json({ items: [{ chapter: 3, status: "fail", score: .5, issues: [], stale: false, needsVerification: 0 }], page: 1, pageSize: 50, pages: 1, total: 1 });
      return json({ items: [], page: 1, pageSize: 50, pages: 1, total: 0 });
    }));
    await mount(<QaPage slug="test-story" navigate={() => undefined} />);
    expect(container!.textContent).toContain("Quality review");
    const buttons = [...container!.querySelectorAll("button")];
    await act(async () => buttons.find((button) => button.textContent === "Warn")!.click());
    await act(async () => [...container!.querySelectorAll("button")].find((button) => button.textContent === "Fail")!.click());
    expect(container!.textContent).toContain("CH 0003");
    await act(async () => resolveWarn(json({ items: [{ chapter: 2, status: "warn", score: .7, issues: [], stale: false, needsVerification: 0 }], page: 1, pageSize: 50, pages: 1, total: 1 })));
    await tick();
    expect(container!.textContent).toContain("CH 0003"); expect(container!.textContent).not.toContain("CH 0002");
    expect(calls.some((url) => url.includes("/qa/summary"))).toBe(true);
  });

  it("debounces chapter search and sends only the latest normalized query", async () => {
    vi.useFakeTimers(); const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url);
      if (url.endsWith("/dashboard")) return json({ story: { title: "Test", author: "A", sourceLanguage: "zh-CN", outputLanguage: "en-US", source: { type: "text" } }, counts: { chapters: 1, pass: 0, warn: 0, fail: 0 }, progress: { processed: 0, audio: 0, artwork: 0, video: 0 }, estimatedRemainingStages: 10 });
      return json({ items: [], page: 1, pageSize: 25, pages: 1, total: 0 });
    }));
    await mount(<StoryPage slug="test-story" navigate={() => undefined} onJob={() => undefined} />);
    const input = container!.querySelector<HTMLInputElement>('input[placeholder="Find chapter or title"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "blue"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "blue lantern"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(calls.filter((url) => url.includes("/chapters?")).length).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(calls.filter((url) => url.includes("/chapters?")).at(-1)).toContain("q=blue%20lantern");
    expect(calls.some((url) => url.includes("q=blue&"))).toBe(false);
  });

  it("reuses the sidebar story list across navigation and refreshes on story changes", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url);
      if (url === "/api/stories") return json({ stories: [{ slug: "test-story", title: "Test Story", sourceLanguage: "zh-CN", outputLanguage: "en-US", importedChapters: 1, processedChapters: 0, sourceType: "text", tags: [], qa: { pass: 0, warn: 0, fail: 0 }, progress: 0 }] });
      if (url.endsWith("/dashboard")) return json({ story: { title: "Test Story", author: "A", sourceLanguage: "zh-CN", outputLanguage: "en-US", source: { type: "text" } }, counts: { chapters: 1, pass: 0, warn: 0, fail: 0 }, progress: { processed: 0, audio: 0, artwork: 0, video: 0 }, estimatedRemainingStages: 10 });
      if (url.includes("/chapters?")) return json({ items: [], page: 1, pageSize: 50, pages: 1, total: 0 });
      if (url.endsWith("/jobs/active")) return json({ job: null });
      if (url.endsWith("/qa/summary")) return json({ counts: { pass: 0, warn: 0, fail: 0, needsVerification: 0, totalEvaluated: 0, chapterCount: 1 }, categories: {} });
      if (url.includes("/qa?")) return json({ items: [], page: 1, pageSize: 50, pages: 1, total: 0 });
      if (url.endsWith("/qa-exceptions")) return json({ exceptions: [] });
      return json({});
    }));
    await mount(<App initialRoute={{ page: "stories" } as any} />);
    expect(calls.filter((url) => url === "/api/stories")).toHaveLength(1);
    const card = [...container!.querySelectorAll("button")].find((button) => button.className.includes("project-spine"))!;
    await act(async () => card.click());
    await act(async () => [...container!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "QA")?.click());
    expect(calls.filter((url) => url === "/api/stories")).toHaveLength(1);
    await act(async () => window.dispatchEvent(new Event("stories:changed")));
    expect(calls.filter((url) => url === "/api/stories")).toHaveLength(2);
  });

  it("loads audio and video summary independently from paged rows", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url);
      if (url.endsWith("/audio/summary")) return json({ settings: { loudnessTarget: -17, truePeak: -1.5 }, counts: { total: 30, mastered: 0, current: 0, stale: 0 }, minChapter: 1, maxChapter: 30, totalDurationSeconds: 0, exports: [] });
      if (url.includes("/audio/chapters")) return json({ items: [], page: Number(new URL(url, location.href).searchParams.get("page")), pages: 2, total: 30 });
      if (url.endsWith("/video/summary")) return json({ settings: { width: 1920, height: 1080, fps: 30, introDurationSeconds: 3, quality: 20, backgroundMode: "gradient", subtitleMode: "burn" }, subtitleSettings: {}, background: { coverAvailable: false, effectiveMode: "fallback" }, counts: { total: 30, mastered: 0, subtitles: 0, videos: 0 }, minChapter: 1, maxChapter: 30, exports: [] });
      if (url.includes("/video/chapters")) return json({ items: [], page: Number(new URL(url, location.href).searchParams.get("page")), pages: 2, total: 30 });
      return json({});
    }));
    await mount(<AudioPage slug="test-story" onJob={() => undefined} />);
    expect(calls.some((url) => url.endsWith("/audio/summary"))).toBe(true);
    await act(async () => [...container!.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.includes("Next"))?.click());
    expect(calls.filter((url) => url.endsWith("/audio/summary"))).toHaveLength(1);
    await act(async () => root!.render(<VideoPage slug="test-story" onJob={() => undefined} />));
    expect(calls.some((url) => url.endsWith("/video/summary"))).toBe(true);
    expect(calls.some((url) => url.includes("/video/chapters?page=1&pageSize=25"))).toBe(true);
  });

  it("does not request artwork outputs until that group is opened", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url); if (url.endsWith("/outputs/summary")) return json({ counts: { chapterAudio: 1 } }); return json({ items: [], page: 1, pages: 1, total: 0 }); }));
    await mount(<OutputsPage slug="test-story" />);
    expect(calls.some((url) => url.includes("group=artwork"))).toBe(false);
    await act(async () => [...container!.querySelectorAll("button")].find((button) => button.textContent?.includes("Artwork"))!.click());
    expect(calls.some((url) => url.includes("group=artwork"))).toBe(true);
  });

  it("includes Artwork in the known-file and group counts", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/outputs/summary") ? json({ counts: { chapterAudio: 2, audiobooks: 1, chapterVideos: 0, combinedVideos: 0, subtitles: 0, artwork: 3 } }) : json({ items: [], page: 1, pages: 1, total: 3 })));
    await mount(<OutputsPage slug="test-story" />);
    expect(container!.textContent).toContain("6 known files");
    const artwork = [...container!.querySelectorAll(".output-group > button")].find((button) => button.textContent?.includes("Artwork"));
    expect(artwork?.textContent).toContain("3");
  });

  it("loads Scenes index once and only chapter detail when switching", async () => {
    const calls: string[] = [];
    const chapters = [1, 2].map((chapter) => ({ chapter, title: `Chapter ${chapter}`, durationSeconds: 0, audioMastering: "pending", audioAvailable: false, audioStale: false, subtitleStatus: "pending", subtitlesAvailable: false, subtitlesStale: false, videoStatus: "pending", videoAvailable: false, videoStale: false, sceneStatus: "pending", artworkStatus: "pending" }));
    const index = { settings: { targetDurationSeconds: 20, minimumDurationSeconds: 10, maximumScenesPerChapter: 50 }, artwork: { provider: "openai", model: "fake", stylePrompt: "style", aspectRatio: "16:9", quality: "medium", size: "1536x1024", outputFormat: "png", outputResolution: "native", upscaling: "off", upscaler: "local-realesrgan" }, planner: { provider: "openai", model: "fake" }, videoSubtitleMode: "burn", selectedChapter: 1, chapters, counts: { chapters: 2, planned: 0, artworkReady: 0 } };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url); if (url.endsWith("/scenes/index")) return json(index); if (url.endsWith("/scenes/1")) return json({ selectedChapter: 1 }); if (url.endsWith("/scenes/2")) return json({ selectedChapter: 2 }); return json({}); }));
    await mount(<ScenesPage slug="test-story" onJob={() => undefined} />);
    const chapterSelect = [...container!.querySelectorAll("select")].find((select) => [...select.options].some((option) => option.value === "2"))!;
    await act(async () => { chapterSelect.value = "2"; chapterSelect.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(calls.filter((url) => url.endsWith("/scenes/index"))).toHaveLength(1);
    expect(calls.some((url) => url.endsWith("/scenes/2"))).toBe(true);
  });

  it("refreshes one Scenes index row after a scene save without reloading workspace settings", async () => {
    const calls: string[] = [];
    const row = { chapter: 1, title: "Chapter 1", durationSeconds: 10, audioMastering: "pending", audioAvailable: false, audioStale: false, subtitleStatus: "pending", subtitlesAvailable: false, subtitlesStale: false, videoStatus: "pending", videoAvailable: false, videoStale: false, sceneStatus: "complete", artworkStatus: "pending" };
    const scene = { id: "scene-001", summary: "Old scene", startSeconds: 0, endSeconds: 10, characters: [], visualPrompt: "A lantern", importance: "standard", artwork: { status: "pending", review: "unreviewed", versions: [] } };
    const manifest = { chapter: 1, durationSeconds: 10, manualRevision: 0, manuallyEdited: false, scenes: [scene] };
    const index = { settings: { targetDurationSeconds: 20, minimumDurationSeconds: 10, maximumScenesPerChapter: 50 }, artwork: { provider: "openai", model: "fake", stylePrompt: "style", aspectRatio: "16:9", quality: "medium", size: "1536x1024", outputFormat: "png", outputResolution: "native", upscaling: "off", upscaler: "local-realesrgan" }, planner: { provider: "openai", model: "fake" }, videoSubtitleMode: "burn", selectedChapter: 1, chapters: [row], counts: { chapters: 1, planned: 1, artworkReady: 0 } };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url); if (url.endsWith("/scenes/index")) return json(index); if (url.endsWith("/scenes/index/1")) return json({ row, counts: index.counts }); if (url.endsWith("/scenes/1")) return json({ selectedChapter: 1, manifest }); return json({}); }));
    await mount(<ScenesPage slug="test-story" onJob={() => undefined} />);
    const summary = container!.querySelector<HTMLTextAreaElement>("#scene-001 .scene-copy textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary, "Changed scene"); summary.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => [...container!.querySelectorAll("button")].find((button) => button.textContent === "Save all scene edits")!.click());
    expect(calls.filter((url) => url.endsWith("/scenes/index"))).toHaveLength(1);
    expect(calls.some((url) => url.endsWith("/scenes/index/1"))).toBe(true);
  });

  it("keeps production setup separate from live status polling", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url);
      if (url.endsWith("/production/status")) return json({ latest: undefined });
      return json({ story: { title: "Test", defaultProductionProfile: "audiobook", productionProfiles: { audiobook: { outputs: ["audiobook"], artwork: false, repairQa: true } } }, counts: { minChapter: 1, maxChapter: 100 } });
    }));
    const job = { id: "j", type: "production", story: "test-story", status: "running" } as any;
    await mount(<ProductionPage slug="test-story" activeJob={job} onJob={() => undefined} navigate={() => undefined} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(calls.filter((url) => url.endsWith("/stories/test-story"))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("/production/status")).length).toBeGreaterThanOrEqual(3);
    await act(async () => root!.render(<ProductionPage slug="test-story" activeJob={{ ...job, status: "completed" }} onJob={() => undefined} navigate={() => undefined} />));
    const count = calls.filter((url) => url.endsWith("/production/status")).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(calls.filter((url) => url.endsWith("/production/status"))).toHaveLength(count);
  });
});
