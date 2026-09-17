import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App, chapterPageSize, EntityStatusField, paginateRows, QaFindingCard, QaResolvedFindings, shouldRefreshAfterJob } from "../apps/web/src/App.js";
import type { QaFinding } from "../apps/web/src/api.js";
import { pretty } from "../apps/web/src/format.js";
import { ChapterImportPage, savedStorySourceUrl } from "../apps/web/src/ChapterImportPage.js";
import { SummariesPage } from "../apps/web/src/SummariesPage.js";
import { NamesLocalizationPage } from "../apps/web/src/NamesLocalizationPage.js";
import { defaultLocale, LanguageSelect } from "../apps/web/src/languages.js";
import { PronunciationFields, PronunciationPanel } from "../apps/web/src/PronunciationPanel.js";

describe("web UI", () => {
  it("exposes pronunciation mode, language dropdown, protected settings and a management desk", () => {
    const html = renderToStaticMarkup(<PronunciationFields value={{ mode: "custom", customPronunciation: "Jyang Yweh", sourceLanguage: "zh-CN", locked: true }} onChange={() => undefined} />);
    expect(html).toContain("Original-language pronunciation"); expect(html).toContain("Custom spoken form"); expect(html).toContain("Lock pronunciation"); expect(html).toContain("Chinese · Simplified"); expect(html).toContain("Advanced pronunciation");
    const desk = renderToStaticMarkup(<PronunciationPanel slug="demo-story" />);
    expect(desk).toContain("Missing"); expect(desk).toContain("✨ Enrich missing pronunciations"); expect(desk).toContain("Low confidence"); expect(desk).toContain("Needs review");
  });
  it("uses readable labels for pipeline identifiers", () => {
    expect(pretty("storyBible")).toBe("Story Bible"); expect(pretty("narrationFidelity")).toBe("Narration Fidelity"); expect(pretty("qa")).toBe("QA"); expect(pretty("tts")).toBe("TTS");
  });
  it("uses the shared curated language selector and maps legacy display names to locales", () => {
    const html = renderToStaticMarkup(<LanguageSelect value="en-US" onChange={() => undefined} />);
    expect(html).toContain("Chinese · Simplified"); expect(html).toContain("English"); expect(html).toContain("Portuguese · Brazil");
    expect(defaultLocale("English")).toBe("en-US"); expect(defaultLocale("zh-CN")).toBe("zh-CN"); expect(defaultLocale("unrecognized")).toBe("en-US");
  });
  it("uses 50 chapters per page by default and permits the supported page sizes", () => {
    expect(chapterPageSize("")).toBe(50); expect(chapterPageSize("?pageSize=10")).toBe(10); expect(chapterPageSize("?pageSize=100")).toBe(100); expect(chapterPageSize("?pageSize=75")).toBe(50);
  });
  it("paginates chapter masters with an accurate row and page count", () => {
    const result = paginateRows(Array.from({ length: 51 }, (_, index) => index + 1), 2, 50);
    expect(result).toMatchObject({ page: 2, pages: 2, total: 51 }); expect(result.items).toEqual([51]);
  });
  it("renders standardized statuses and preserves legacy values through the custom field", () => {
    const standard = renderToStaticMarkup(<EntityStatusField type="character" value="Alive" onChange={() => undefined} />);
    expect(standard).toContain('value="alive" selected=""'); expect(standard).toContain("Spirit / Ghost");
    const legacy = renderToStaticMarkup(<EntityStatusField type="character" value="Trapped in temporal stasis" onChange={() => undefined} />);
    expect(legacy).toContain("Custom…"); expect(legacy).toContain('value="Trapped in temporal stasis"');
    const location = renderToStaticMarkup(<EntityStatusField type="location" value="under-siege" onChange={() => undefined} />);
    expect(location).toContain("Occupied by enemy"); expect(location).not.toContain("Spirit / Ghost");
  });
  const qaFinding = (overrides: Partial<QaFinding>): QaFinding => ({
    id: "qaf_0123456789abcdef01234567", category: "dialogue", severity: "warn", message: "A threat is softened", evidence: "The intent remains intact.",
    status: "open", origin: "llm", fingerprint: "fp", ...overrides,
  });
  it("shows QA severity and both human resolution actions", () => {
    const html = renderToStaticMarkup(<QaFindingCard finding={qaFinding({})} busy="" expanded={[]} onToggle={() => undefined} onFixAi={() => undefined} onEdit={() => undefined} onResolve={() => undefined} onDismiss={() => undefined} />);
    expect(html).toContain("Warning"); expect(html).toContain("Dialogue"); expect(html).toContain("Fix with AI"); expect(html).toContain("Edit manually"); expect(html).toContain("Mark resolved"); expect(html).toContain("Dismiss");
  });
  it("keeps dismissed QA findings visible without a selectable checkbox", () => {
    const html = renderToStaticMarkup(<QaResolvedFindings defaultOpen busy="" expanded={[`resolved:qaf_0123456789abcdef01234567`]} onToggle={() => undefined} onReopen={() => undefined} findings={[qaFinding({ status: "dismissed", resolution: { action: "dismiss", reason: "Intentional softening", resolvedAt: "2026-09-16T14:00:00.000Z" } })]} />);
    expect(html).toContain("Dismissed"); expect(html).toContain("Resolved issues (1)"); expect(html).toContain("reason: Intentional softening"); expect(html).not.toContain('type="checkbox"');
  });
  it("keeps manually fixed QA findings as a non-selectable audit record", () => {
    const html = renderToStaticMarkup(<QaResolvedFindings defaultOpen busy="" expanded={[`resolved:qaf_0123456789abcdef01234567`]} onToggle={() => undefined} onReopen={() => undefined} findings={[qaFinding({ category: "numbers", severity: "fail", message: "A number changed", evidence: "The editor restored it.", status: "fixed_manual", resolution: { action: "manual_fix", resolvedAt: "2026-09-16T14:00:00.000Z" } })]} />);
    expect(html).toContain("Fixed manually"); expect(html).toContain("resolved"); expect(html).toContain("Reopen"); expect(html).not.toContain('type="checkbox"');
  });
  it("refreshes the current workspace once when a web job becomes terminal", () => {
    const running = { id: "job-1", type: "batch", story: "demo", status: "running" } as any;
    expect(shouldRefreshAfterJob(running, { ...running, status: "completed" })).toBe(true);
    expect(shouldRefreshAfterJob({ ...running, status: "completed" }, { ...running, status: "completed" })).toBe(false);
    expect(shouldRefreshAfterJob(undefined, running)).toBe(false);
    const preview = { ...running, type: "voicePreview" };
    expect(shouldRefreshAfterJob(preview, { ...preview, status: "completed" })).toBe(false);
    const suggestions = { ...running, type: "entityLocalizationSuggestions" };
    expect(shouldRefreshAfterJob(suggestions, { ...suggestions, status: "completed" })).toBe(false);
    const summary = { ...running, type: "summary" };
    expect(shouldRefreshAfterJob(summary, { ...summary, status: "completed" })).toBe(false);
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
    expect(html).toContain("Chapter folder"); expect(html).toContain("Manuscript file"); expect(html).toContain("Novel search"); expect(html).toContain("Web range");
    expect(html).toContain("Adding Chapters 29–40 does not remove Chapters 1–3");
  });
  it("prefers a story's persisted source URL and supports older manifest-only projects", () => {
    const base = { source: undefined } as any;
    expect(savedStorySourceUrl({ ...base, story: { source: { url: " https://example.com/book/7 " } } })).toBe("https://example.com/book/7");
    expect(savedStorySourceUrl({ story: { source: {} }, source: { origin: { url: "https://example.com/legacy/7" } } } as any)).toBe("https://example.com/legacy/7");
  });
  it("renders the Summary Library creation and empty-state workflow", () => {
    const html = renderToStaticMarkup(<SummariesPage slug="demo-story" onJob={() => undefined} />);
    expect(html).toContain("Summary library");
    expect(html).toContain("Search summaries");
    expect(html).toContain("All summary types");
    expect(html).toContain("All statuses");
    expect(html).toContain("Create your first summary");
  });
  it("renders the entity localization workspace", () => {
    Object.defineProperty(globalThis, "location", { value: { pathname: "/stories/demo-story/names", search: "" }, configurable: true });
    const html = renderToStaticMarkup(<NamesLocalizationPage slug="demo-story" onJob={() => undefined} navigate={() => undefined} />);
    expect(html).toContain("Names / Localization"); expect(html).toContain("Search any name"); expect(html).toContain("Select an entity to localize"); expect(html).toContain("Open Story Bible");
  });
});
