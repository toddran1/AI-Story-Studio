import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App, shouldRefreshAfterJob } from "../apps/web/src/App.js";
import { pretty } from "../apps/web/src/format.js";
import { ChapterImportPage, savedStorySourceUrl } from "../apps/web/src/ChapterImportPage.js";

describe("web UI", () => {
  it("uses readable labels for pipeline identifiers", () => {
    expect(pretty("storyBible")).toBe("Story Bible"); expect(pretty("narrationFidelity")).toBe("Narration Fidelity"); expect(pretty("qa")).toBe("QA"); expect(pretty("tts")).toBe("TTS");
  });
  it("refreshes the current workspace once when a web job becomes terminal", () => {
    const running = { id: "job-1", type: "batch", story: "demo", status: "running" } as any;
    expect(shouldRefreshAfterJob(running, { ...running, status: "completed" })).toBe(true);
    expect(shouldRefreshAfterJob({ ...running, status: "completed" }, { ...running, status: "completed" })).toBe(false);
    expect(shouldRefreshAfterJob(undefined, running)).toBe(false);
  });
  it("renders the studio shell and accessible navigation", () => {
    Object.defineProperty(globalThis, "location", { value: { pathname: "/" }, configurable: true });
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("Studio navigation"); expect(html).toContain("Your story shelf"); expect(html).toContain("Create your first story"); expect(html).toContain("Nothing calls a paid provider");
  });
  it("renders a story-specific additive chapter intake workspace", () => {
    const story = { slug: "long-story", title: "Long Story", sourceType: "text", importedChapters: 3 } as any;
    const html = renderToStaticMarkup(<ChapterImportPage storySlug="long-story" stories={[story]} navigate={() => undefined} />);
    expect(html).toContain("Add pages to <em>Long Story</em>");
    expect(html).toContain("Chapter folder"); expect(html).toContain("Manuscript file"); expect(html).toContain("Web range");
    expect(html).toContain("Adding Chapters 29–40 does not remove Chapters 1–3");
  });
  it("prefers a story's persisted source URL and supports older manifest-only projects", () => {
    const base = { source: undefined } as any;
    expect(savedStorySourceUrl({ ...base, story: { source: { url: " https://example.com/book/7 " } } })).toBe("https://example.com/book/7");
    expect(savedStorySourceUrl({ story: { source: {} }, source: { origin: { url: "https://example.com/legacy/7" } } } as any)).toBe("https://example.com/legacy/7");
  });
});
