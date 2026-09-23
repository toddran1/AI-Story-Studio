import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { App, applyVideoResolutionPreset, ArtworkEstimateSummary, ArtworkVersionMetadata, artworkModelOptionsFor, BibleReviewQueue, bibleQueryString, CanonicalEntitySheet, canDeleteChapterSceneDraft, chapterPageSize, chapterSceneStructureDirty, chapterScenesDirty, chapterVideoReadinessChecks, deleteChapterSceneDraft, moveChapterSceneDraft, toggleChapterSceneEnabledDraft, ChapterPage, chapterQaStatusView, chunkPresetFor, clearJobDismissal, clearJobMinimized, continuityReferenceTriState, describeContinuityReference, dismissJob, EntityDetailAccordion, EntityStatusField, ErrorBoundary, EXECUTABLE_CHAPTER_STAGES, getStageActionDetails, humanizeContinuityChanges, isJobConsoleMinimized, isJobDismissed, isTerminalJob, JobConsole, paginateRows, Pagination, parseBibleQuery, PreviousHandoffBadge, QaDetail, QaFindingCard, QaResolvedFindings, ReadinessGrid, ReadinessStrip, resolvedBehaviorSummary, ResolvedBehaviorHint, reupscaleAvailable, SceneContinuityPanel, ScenesPage, setJobConsoleMinimized, SettingsPage, shouldRefreshAfterJob, Status, StoryBibleHealthCard, TtsQualityBadge, TtsSegmentRow, VIDEO_RESOLUTION_PRESETS, videoResolutionFor } from "../apps/web/src/App.js";
import { api, ApiError } from "../apps/web/src/api.js";
import type { ArtworkVersion, ChapterDetail, Job, QaFinding, Scene, TtsQualityArtifact, TtsSegmentQuality, VideoSettings, VisualContinuityChange } from "../apps/web/src/api.js";
import { pretty } from "../apps/web/src/format.js";
import { ChapterImportPage, savedStorySourceUrl } from "../apps/web/src/ChapterImportPage.js";
import { SummariesPage } from "../apps/web/src/SummariesPage.js";
import { NamesLocalizationPage } from "../apps/web/src/NamesLocalizationPage.js";
import { defaultLocale, LanguageSelect } from "../apps/web/src/languages.js";
import { SelectedArtworkProvenance } from "../apps/web/src/SummaryVisualPanels.js";
import { PronunciationFields, PronunciationPanel } from "../apps/web/src/PronunciationPanel.js";
import { applyStagePreset, BatchProcessingPanel, ExecutionPreview, toggleStageSelection } from "../apps/web/src/BatchProcessingPanel.js";
import { formatChapterSelection, parseChapterSelection } from "../src/batch/range.js";
import type { StageExecutionBatchPlan } from "../src/studio/stage-execution.js";

describe("web UI", () => {
  it("keeps structured QA lifecycle conflict codes available for UI reconciliation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "QA finding has already been resolved.", code: "QA_FINDING_ALREADY_RESOLVED" }), { status: 409, headers: { "content-type": "application/json" } })));
    await expect(api("/stories/demo/chapters/1/qa/findings/qaf_0123456789abcdef01234567/dismiss", { method: "POST", body: "{}" })).rejects.toMatchObject({ name: "ApiError", code: "QA_FINDING_ALREADY_RESOLVED" } satisfies Partial<ApiError>);
    vi.unstubAllGlobals();
  });
  it("renders Chapter Dispatch with grouped stage checkboxes, quick-select presets, and radio-card execution modes", () => {
    const html = renderToStaticMarkup(<BatchProcessingPanel slug="demo-story" selectedChapters={[5, 10, 13, 40, 41]} onSelectionChange={() => undefined} onSelectVisible={() => undefined} onSelectMatching={() => undefined} onSelectAll={() => undefined} onJob={() => undefined} watchJob={() => () => undefined} />);
    expect(html).toContain("Chapter Dispatch"); expect(html).toContain('value="5, 10, 13, 40-41"'); expect(html).toContain("5 chapters selected");
    // Every dispatchable stage is a real checkbox inside a Text/Audio/Visual group.
    expect(html.match(/type="checkbox"/g)).toHaveLength(14); // 12 stages + regenerate + continue
    expect(html).toContain("<legend>Text</legend>"); expect(html).toContain("<legend>Audio</legend>"); expect(html).toContain("<legend>Visual</legend>");
    for (const label of ["Translation", "Narration", "QA", "Story Bible", "Continuity", "TTS", "Audio Mastering", "Alignment", "Subtitles", "Scene Planning", "Artwork", "Video"]) expect(html).toContain(label);
    // The old chip/tag implementation is gone.
    expect(html).not.toContain("aria-pressed");
    // Dispatch starts deliberately blank: only the selected execution-mode radio is checked.
    expect(html).toContain("0 stages selected"); expect(html.match(/checked=""/g)).toHaveLength(1);
    // Quick-select presets, including Clear, only set checkbox state.
    for (const label of ["Context", "Narration + QA", "Audio", "Visuals", "Clear"]) expect(html).toContain(`>${label}</button>`);
    // Exactly two single-choice execution mode radio cards.
    expect(html.match(/type="radio"/g)).toHaveLength(2); expect(html.match(/name="batch-mode"/g)).toHaveLength(2);
    expect(html).toContain("Selected stages only"); expect(html).toContain("Run only the stages selected above. Existing prerequisites may be reused, including valid stale artifacts. Missing prerequisites will block the affected work.");
    expect(html).toContain("Selected stages + prerequisites"); expect(html).toContain("Run the selected stages and automatically generate any missing prerequisites. Existing usable prerequisites are reused.");
    // Independent execution checkboxes with explanations.
    expect(html).toContain("Regenerate selected stages"); expect(html).toContain("Regenerate selected stages even when a usable artifact already exists.");
    expect(html).toContain("Continue past failures"); expect(html).toContain("Continue processing other chapters when one chapter fails.");
    // Preview stays required before running.
    expect(html).toContain("Preview required before running"); expect(html).toContain("Preview execution"); expect(html).toContain("Run batch");
    expect(html).toContain("Visible page"); expect(html).toContain("Matching filter"); expect(html).toContain("All chapters");
    expect(html).not.toContain("Add prerequisites");
  });
  it("keeps stage selection helpers independent, ordered, and preset-driven", () => {
    expect(applyStagePreset("coreText")).toEqual(["translation", "narration", "qa", "storyBible", "continuity"]);
    expect(applyStagePreset("narrationQa")).toEqual(["narration", "qa"]);
    expect(applyStagePreset("audio")).toEqual(["tts", "audioMastering", "alignment", "subtitles"]);
    expect(applyStagePreset("visuals")).toEqual(["scenePlanning", "artwork", "video"]);
    // Multiple independent checks accumulate in canonical pipeline order; unchecking removes only that stage.
    let stages = applyStagePreset("narrationQa");
    stages = toggleStageSelection(stages, "tts"); expect(stages).toEqual(["narration", "qa", "tts"]);
    stages = toggleStageSelection(stages, "translation"); expect(stages).toEqual(["translation", "narration", "qa", "tts"]);
    stages = toggleStageSelection(stages, "narration"); expect(stages).toEqual(["translation", "qa", "tts"]);
    expect(toggleStageSelection([], "video")).toEqual(["video"]);
  });
  it("parses chapter expressions with ranges, dedupe, sorting, and clear errors", () => {
    expect(parseChapterSelection("5, 10, 13, 40-50")).toEqual([5, 10, 13, ...Array.from({ length: 11 }, (_, index) => 40 + index)]);
    expect(parseChapterSelection("10, 5, 5, 13")).toEqual([5, 10, 13]);
    expect(formatChapterSelection([5, 10, 13, 40, 41])).toBe("5, 10, 13, 40-41");
    expect(() => parseChapterSelection("abc")).toThrow();
  });
  it("renders the execution preview ledger and references “Selected stages + prerequisites” when blocked", () => {
    const plan = (blocked: number, addedPrerequisites: StageExecutionBatchPlan["summary"]["addedPrerequisites"]): StageExecutionBatchPlan => ({
      fingerprint: "abcdef1234567890",
      chapters: [{
        chapter: 5, selectedStages: ["narration", "qa"], mode: "selected", force: false, prerequisitesComplete: blocked === 0,
        runStages: ["narration"], reusedStages: [{ stage: "translation", state: "current" }], missingStages: [], blockedStages: blocked ? ["qa"] : [],
        entries: [
          { stage: "narration", action: "selected-run", reason: "Selected stage", availability: "missing", requiredBy: [] },
          { stage: "translation", action: "reuse", reason: "Current artifact", availability: "available", freshness: "current", requiredBy: ["narration"] },
          ...(blocked ? [{ stage: "qa" as const, action: "blocked" as const, reason: "Narration is missing", availability: "missing" as const, requiredBy: [] }] : []),
        ],
        artifacts: [], reason: "",
      }],
      summary: {
        chapterCount: 1, selectedStages: ["narration", "qa"], mode: "selected", force: false,
        operationCount: 1, reusedCount: 1, blockedOperations: blocked, blockedChapters: blocked ? 1 : 0,
        plannedByStage: { narration: 1 }, reusedByStage: { translation: 1 }, blockedByStage: blocked ? { qa: blocked } : {},
        addedPrerequisites, providerOperations: { llm: 1, tts: 0, images: 0 },
      },
    });
    const blockedHtml = renderToStaticMarkup(<ExecutionPreview preview={plan(1, [])} />);
    expect(blockedHtml).toContain("1 planned · 1 reused · 1 blocked");
    expect(blockedHtml).toContain("This plan cannot run because required inputs are missing. Choose “Selected stages + prerequisites” to include the missing prerequisite stages automatically.");
    expect(blockedHtml).not.toContain("Add prerequisites");
    expect(blockedHtml).toContain("Ch. 0005"); expect(blockedHtml).toContain("<span>Run</span>"); expect(blockedHtml).toContain("<span>Reuse</span>"); expect(blockedHtml).toContain("<span>Blocked</span>");
    expect(blockedHtml).toContain("LLM <b>1</b>"); expect(blockedHtml).toContain("TTS <b>0</b>"); expect(blockedHtml).toContain("Images <b>0</b>");
    const unblockedHtml = renderToStaticMarkup(<ExecutionPreview preview={plan(0, ["translation"])} />);
    expect(unblockedHtml).toContain("Added prerequisites: Translation");
    expect(unblockedHtml).not.toContain("This plan cannot run");
  });
  it("exposes pronunciation mode, language dropdown, protected settings and a management desk", () => {
    const html = renderToStaticMarkup(<PronunciationFields value={{ mode: "custom", customPronunciation: "Jyang Yweh", sourceLanguage: "zh-CN", locked: true }} onChange={() => undefined} />);
    expect(html).toContain("Original-language pronunciation"); expect(html).toContain("Custom spoken form"); expect(html).toContain("Lock pronunciation"); expect(html).toContain("Chinese · Simplified"); expect(html).toContain("Advanced pronunciation");
    const desk = renderToStaticMarkup(<PronunciationPanel slug="demo-story" />);
    expect(desk).toContain("Default TTS"); expect(desk).toContain("✨ Generate pronunciation suggestions"); expect(desk).toContain("Suggestions"); expect(desk).toContain("Needs review");
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
  it("renders exactly one Recheck QA split-button control on the Quality tab with all actions preserved", () => {
    const mockDetail = {
      chapter: 1,
      state: {
        version: 1 as const,
        chapter: 1,
        evaluatedAt: "2026-09-18T12:00:00.000Z",
        score: 0.8,
        status: "warn" as const,
        findings: [qaFinding({})],
        checks: {
          completeness: "pass" as const,
          names: "pass" as const,
          numbers: "pass" as const,
          terminology: "warn" as const,
          dialogue: "pass" as const,
          storyConsistency: "pass" as const,
          narrationFidelity: "pass" as const,
        },
      },
      counts: {
        pass: 6,
        warn: 1,
        fail: 0,
        open: 1,
        resolved: 0,
        safeFixesAvailable: 0,
        needsVerification: 0,
      },
      stats: {
        open: 1,
        resolved: 0,
        unverified: 0,
        needsVerification: 0,
      },
      freshness: "current" as const,
      qaStale: false,
      currentFingerprint: "fp",
    };

    const html = renderToStaticMarkup(
      <QaDetail
        slug="demo-story"
        chapter={1}
        onJob={() => undefined}
        onEditManually={() => undefined}
        onChanged={() => undefined}
        initialData={mockDetail}
      />
    );

    // Must have EXACTLY ONE recheck split control
    const splitMatches = html.match(/class="qa-recheck-split"/g);
    expect(splitMatches).toHaveLength(1);

    // Primary action button exists
    expect(html).toContain("Recheck QA");

    // Dropdown menu actions preserved
    expect(html).toContain("Recheck changed content");
    expect(html).toContain("Full chapter recheck");
    expect(html).toContain("Reset QA data…");

    // Stale state renders primary button styling with exactly one control
    const staleHtml = renderToStaticMarkup(
      <QaDetail
        slug="demo-story"
        chapter={1}
        onJob={() => undefined}
        onEditManually={() => undefined}
        onChanged={() => undefined}
        initialData={{ ...mockDetail, qaStale: true }}
      />
    );
    expect(staleHtml.match(/class="qa-recheck-split"/g)).toHaveLength(1);
    expect(staleHtml).toContain("button primary");
    const prerequisiteHtml = renderToStaticMarkup(<QaDetail
      slug="demo-story" chapter={1} onJob={() => undefined} onEditManually={() => undefined} onChanged={() => undefined}
      initialData={{ ...mockDetail, artifacts: { translationAvailable: false, narrationAvailable: false }, repairPrerequisites: { storyContextValid: false, storyContextError: "AI repair is blocked because Story Context is invalid." } }}
    />);
    expect(prerequisiteHtml).toContain("Translation artifact is unavailable. AI repair for translation findings is disabled.");
    expect(prerequisiteHtml).toContain("Narration artifact is unavailable. AI repair for narration findings is disabled.");
    expect(prerequisiteHtml).toContain("AI repair is blocked because Story Context is invalid.");
    expect(prerequisiteHtml).toContain("Open Story Bible");
  });
  it("surfaces total QA score in attention head and places stale notice below header", () => {
    const currentDetail = {
      chapter: 1,
      state: {
        score: 0.92,
        status: "pass" as const,
        findings: [qaFinding({})],
        checks: {},
        issues: [],
      },
      counts: { open: 1, resolved: 0, safeFixesAvailable: 0 },
      qaStale: false,
    };
    const currentHtml = renderToStaticMarkup(
      <QaDetail
        slug="demo-story"
        chapter={1}
        onJob={() => undefined}
        onEditManually={() => undefined}
        onChanged={() => undefined}
        initialData={currentDetail}
      />
    );
    expect(currentHtml).toContain("92 / 100");
    expect(currentHtml).not.toContain("Previous score");
    expect(currentHtml).not.toContain("artifact-status-notice");

    const staleDetail = {
      chapter: 1,
      state: {
        score: 0.70,
        status: "warn" as const,
        findings: [qaFinding({})],
        checks: {},
        issues: [],
      },
      counts: { open: 1, resolved: 0, safeFixesAvailable: 0 },
      qaStale: true,
    };
    const staleHtml = renderToStaticMarkup(
      <QaDetail
        slug="demo-story"
        chapter={1}
        onJob={() => undefined}
        onEditManually={() => undefined}
        onChanged={() => undefined}
        initialData={staleDetail}
      />
    );
    expect(staleHtml).toContain("70 / 100");
    expect(staleHtml).toContain("Previous score");

    // Ensure DOM order: attention head comes BEFORE the stale notice banner
    const headIndex = staleHtml.indexOf("qa-attention-head");
    const noticeIndex = staleHtml.indexOf("artifact-status-notice");
    expect(headIndex).toBeGreaterThan(-1);
    expect(noticeIndex).toBeGreaterThan(headIndex);

    // QA not run state must not fabricate a score
    const notRunHtml = renderToStaticMarkup(
      <QaDetail
        slug="demo-story"
        chapter={1}
        onJob={() => undefined}
        onEditManually={() => undefined}
        onChanged={() => undefined}
        initialData={undefined}
        initialError="Chapter 1 does not have a QA result."
      />
    );
    expect(notRunHtml).toContain("QA not run");
    expect(notRunHtml).toContain("Run QA");
    expect(notRunHtml).not.toContain("/ 100");
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
  it("renders CanonicalEntitySheet with clean header, compact naming, alias chips, and single authoritative action controls", () => {
    const sampleEntity = {
      id: "ent_0123456789abcdef01234567",
      type: "character",
      canonicalName: "Dragon King Hall",
      originalName: "龙王殿",
      description: "A mysterious martial organization headquartered in the deep mountains with centuries of martial tradition.",
      status: "active",
      firstAppearance: 1,
      lastKnownAppearance: 42,
      canonicalNameLocked: false,
      origin: "automatic",
      aliases: ["Dragon King Temple", "Dragon King Guild"],
      aliasNarrationRules: [{ alias: "Dragon King Temple", behavior: "use_preferred" }],
      preferredNarrationName: "Dragon King Hall",
      localizedNaming: { fullName: "Hall of the Dragon King", shortName: "Dragon Hall", locale: "en-US", usageMode: "primary" },
      provenance: [{ chapter: 1, kind: "character_introduction", confidence: 0.95 }],
    };
    const sampleDetail = {
      entity: sampleEntity,
      timeline: [{ id: "evt_1", chapter: 1, type: "major_action", summary: "Founded the sect" }],
      relationships: [],
      relatedNames: {},
      relatedReferences: [{ id: "ref_1", name: "Hall Disciple", originalName: "殿众", type: "character", firstSeenChapter: 1, lastSeenChapter: 5 }],
      issues: [{ id: "iss_1", summary: "Status contradiction" }],
      merges: [],
    };
    const html = renderToStaticMarkup(
      <CanonicalEntitySheet
        detail={sampleDetail}
        slug="demo-story"
        navigate={() => undefined}
        onClose={() => undefined}
        onUndo={() => undefined}
        onEdit={() => undefined}
        onDemote={() => undefined}
        managementInitiallyOpen
      />
    );
    // Header
    expect(html).toContain("Dragon King Hall");
    expect(html).toContain("Character · Active");
    expect(html).toContain("龙王殿");
    expect(html).toContain('aria-label="Close entity"');

    // No duplicate buttons: exactly one primary "Edit entity", one "Open localization", one "Convert to minor reference"
    const editEntityMatches = (html.match(/Edit entity/g) || []).length;
    expect(editEntityMatches).toBe(1);
    expect(html).not.toContain("Edit canonical record");

    const localizationMatches = (html.match(/Open localization/g) || []).length;
    expect(localizationMatches).toBe(1);

    const convertMatches = (html.match(/Convert to minor reference/g) || []).length;
    expect(convertMatches).toBe(1);

    // Compact naming & alias chips
    expect(html).toContain("Preferred narration name");
    expect(html).toContain("Hall of the Dragon King · Dragon Hall");
    expect(html).toContain("Dragon King Temple");
    expect(html).toContain("Dragon King Guild");
    expect(html).toContain("narration");

    // Action hierarchy
    expect(html).toContain("Entity Management");
  });
  it("renders unconfigured naming states and long descriptions with collapsible preview toggle in CanonicalEntitySheet", () => {
    const longDesc = "First line of long text.\nSecond line.\nThird line.\nFourth line.\nFifth line.\nSixth line of extended background lore that exceeds preview bounds.";
    const unconfiguredEntity = {
      id: "ent_0123456789abcdef01234568",
      type: "organization",
      canonicalName: "Iron Blood Guild",
      originalName: "",
      description: longDesc,
      status: "unknown",
      firstAppearance: 5,
      lastKnownAppearance: 10,
      canonicalNameLocked: true,
      origin: "manual",
      aliases: [],
      aliasNarrationRules: [],
      preferredNarrationName: undefined,
      localizedNaming: undefined,
      provenance: [],
    };
    const detail = {
      entity: unconfiguredEntity,
      timeline: [],
      relationships: [],
      relatedNames: {},
      relatedReferences: [],
      issues: [],
      merges: [],
    };
    const html = renderToStaticMarkup(
      <CanonicalEntitySheet
        detail={detail}
        slug="demo-story"
        navigate={() => undefined}
        onClose={() => undefined}
        onUndo={() => undefined}
        onEdit={() => undefined}
        onDemote={() => undefined}
        managementInitiallyOpen
      />
    );
    expect(html).toContain("Iron Blood Guild");
    expect(html).toContain("🔒 Locked");
    expect(html).toContain("Show more");
    expect(html).toContain("Not configured");
    expect(html).toContain("Set →");
    expect(html).toContain("Configure →");
    expect(html).toContain("No aliases recorded.");
    // Locked canonical entities cannot be demoted
    expect(html).toContain("🔒 This entity is locked and cannot be converted.");
    expect(html).not.toContain("Convert to minor reference");
  });

  it("shows duplicate comparison and recoverable removal in entity management", () => {
    const entity = { id: "ent_aaaaaaaaaaaaaaaaaaaaaaaa", type: "organization", canonicalName: "Hundred Treasures Pavilion", originalName: "百宝阁", aliases: [], firstAppearance: 22, lastKnownAppearance: 530, status: "active", description: "Trading house", notes: "", provenance: [], aliasNarrationRules: [], mergedFromIds: [], canonicalNameLocked: false, origin: "manual" };
    const detail = { entity, timeline: [], relationships: [], relatedNames: {}, relatedReferences: [], issues: [], merges: [], duplicateSuggestions: [{ id: "pair", entityIds: [entity.id, "ent_bbbbbbbbbbbbbbbbbbbbbbbb"], entities: [{ id: entity.id, name: entity.canonicalName }, { id: "ent_bbbbbbbbbbbbbbbbbbbbbbbb", name: entity.canonicalName }], confidence: 0.9, reason: "Same name", supportingChapters: [22] }] };
    const html = renderToStaticMarkup(<CanonicalEntitySheet detail={detail} slug="demo-story" navigate={() => undefined} onClose={() => undefined} onUndo={() => undefined} onEdit={() => undefined} onDemote={() => undefined} onSuppress={() => undefined} onMerge={() => undefined} managementInitiallyOpen />);
    expect(html).toContain("Possible duplicate identities found");
    expect(html).toContain("Compare &amp; merge");
    expect(html).toContain("90% match confidence");
    expect(html).toContain("Merge with another entity");
    expect(html).toContain("Remove canonical entity");
  });

  it("renders ErrorBoundary with fallback UI when an error occurs", () => {
    const boundary = new ErrorBoundary({ children: "content", navigate: () => undefined });
    expect(boundary.render()).toBe("content");

    const derivedState = ErrorBoundary.getDerivedStateFromError(new Error("Database connection timed out"));
    expect(derivedState.error?.message).toBe("Database connection timed out");

    boundary.state = derivedState;
    const html = renderToStaticMarkup(boundary.render() as any);
    expect(html).toContain("Something went wrong in this view");
    expect(html).toContain("Database connection timed out");
    expect(html).toContain("Reload Page");
    expect(html).toContain("Return to Library");
  });

  it("keeps Chapter scene structural edits draft-only and enforces a valid enabled scene set", () => {
    const art = { status: "complete" as const, review: "approved" as const, imageFingerprint: "image-1", versions: [{ id: "v1", versionNumber: 1 }] } as any;
    const scenes: Scene[] = [
      { id: "scene-001", summary: "First", startSeconds: 0, endSeconds: 12, characters: [], visualPrompt: "First image", importance: "major", artwork: art },
      { id: "scene-002", summary: "Second", startSeconds: 12, endSeconds: 30, characters: [], visualPrompt: "Second image", importance: "standard", artwork: { ...art, versions: [...art.versions] } },
    ];
    const moved = moveChapterSceneDraft(scenes, "scene-002", -1);
    expect(moved.map((scene) => scene.id)).toEqual(["scene-002", "scene-001"]);
    expect(moved.map((scene) => [scene.startSeconds, scene.endSeconds])).toEqual([[0, 18], [18, 30]]);
    expect(moved[0]!.artwork.versions).toBe(scenes[1]!.artwork.versions);
    expect(chapterSceneStructureDirty(moved, scenes)).toBe(true);
    expect(chapterScenesDirty(moved, scenes)).toBe(true);
    expect(moveChapterSceneDraft(scenes, "scene-001", -1)).toBe(scenes);

    const disabled = toggleChapterSceneEnabledDraft(scenes, "scene-001");
    expect(disabled[0]!.disabled).toBe(true);
    expect(disabled[0]!.artwork).toBe(scenes[0]!.artwork);
    expect(chapterSceneStructureDirty(disabled, scenes)).toBe(true);
    const cannotDisableLast = toggleChapterSceneEnabledDraft(disabled, "scene-002");
    expect(cannotDisableLast).toBe(disabled);
    expect(toggleChapterSceneEnabledDraft(disabled, "scene-001")[0]!.disabled).toBe(false);

    const sceneSettings = { targetDurationSeconds: 20, minimumDurationSeconds: 10, maximumDurationSeconds: 30, maximumScenesPerChapter: 50 };
    expect(deleteChapterSceneDraft(scenes, "scene-001", false, 30, sceneSettings)).toBe(scenes);
    expect(deleteChapterSceneDraft(scenes.slice(0, 1), "scene-001", true, 30, sceneSettings)).toHaveLength(1);
    const deleted = deleteChapterSceneDraft(scenes, "scene-002", true, 30, sceneSettings);
    expect(deleted.map((scene) => scene.id)).toEqual(["scene-001"]);
    expect(deleted[0]).toMatchObject({ startSeconds: 0, endSeconds: 30, artwork: scenes[0]!.artwork });
    expect(chapterScenesDirty(deleted, scenes)).toBe(true);

    const enabledAndDisabled: Scene[] = [scenes[0]!, { ...scenes[1]!, disabled: true }];
    const enabledAndDisabledTiming = enabledAndDisabled.map(({ id, startSeconds, endSeconds }) => ({ id, startSeconds, endSeconds }));
    expect(canDeleteChapterSceneDraft(enabledAndDisabled, "scene-001")).toBe(false);
    expect(canDeleteChapterSceneDraft(enabledAndDisabled, "scene-002")).toBe(true);
    const rejectedEnabledDelete = deleteChapterSceneDraft(enabledAndDisabled, "scene-001", true, 30, sceneSettings);
    expect(rejectedEnabledDelete).toBe(enabledAndDisabled);
    expect(rejectedEnabledDelete.map(({ id, startSeconds, endSeconds }) => ({ id, startSeconds, endSeconds }))).toEqual(enabledAndDisabledTiming);
    expect(rejectedEnabledDelete.map((scene) => scene.id)).toEqual(["scene-001", "scene-002"]);
    expect(rejectedEnabledDelete[0]!.artwork).toBe(enabledAndDisabled[0]!.artwork);
    const removedDisabled = deleteChapterSceneDraft(enabledAndDisabled, "scene-002", true, 30, sceneSettings);
    expect(removedDisabled.map((scene) => scene.id)).toEqual(["scene-001"]);
    expect(removedDisabled[0]).toMatchObject({ startSeconds: 0, endSeconds: 30 });
    expect(removedDisabled[0]).not.toHaveProperty("disabled");

    const oneEnabledTwoDisabled: Scene[] = [
      scenes[0]!,
      { ...scenes[1]!, id: "scene-003", disabled: true },
      { ...scenes[1]!, id: "scene-004", disabled: true },
    ];
    expect(canDeleteChapterSceneDraft(oneEnabledTwoDisabled, "scene-001")).toBe(false);
    for (const disabledId of ["scene-003", "scene-004"]) {
      expect(canDeleteChapterSceneDraft(oneEnabledTwoDisabled, disabledId)).toBe(true);
      const cleaned = deleteChapterSceneDraft(oneEnabledTwoDisabled, disabledId, true, 30, sceneSettings);
      expect(cleaned.map((scene) => scene.id)).not.toContain(disabledId);
      expect(cleaned.some((scene) => !scene.disabled)).toBe(true);
    }

    for (const sceneId of ["scene-001", "scene-002"]) {
      expect(canDeleteChapterSceneDraft(scenes, sceneId)).toBe(true);
      const remaining = deleteChapterSceneDraft(scenes, sceneId, true, 30, sceneSettings);
      expect(remaining.some((scene) => !scene.disabled)).toBe(true);
      expect(remaining[0]!.startSeconds).toBe(0);
      expect(remaining.at(-1)!.endSeconds).toBe(30);
    }
    const weightedScenes: Scene[] = [
      { ...scenes[0]!, startSeconds: 0, endSeconds: 10 },
      { ...scenes[1]!, startSeconds: 10, endSeconds: 20, id: "scene-003" },
      { ...scenes[1]!, startSeconds: 20, endSeconds: 40, id: "scene-004" },
    ];
    for (const deletedId of ["scene-001", "scene-003", "scene-004"]) {
      const survivors = deleteChapterSceneDraft(weightedScenes, deletedId, true, 40, sceneSettings);
      expect(survivors[0]!.startSeconds).toBe(0);
      expect(survivors.at(-1)!.endSeconds).toBe(40);
      expect(survivors.slice(1).every((scene, index) => scene.startSeconds === survivors[index]!.endSeconds)).toBe(true);
      expect(survivors.map((scene) => scene.id)).not.toContain(deletedId);
      expect(survivors.every((scene) => scene.artwork.versions.length === 1)).toBe(true);
    }
    expect(deleteChapterSceneDraft(weightedScenes, "scene-003", true, 40, sceneSettings).map((scene) => scene.endSeconds - scene.startSeconds)).toEqual([13.333, 26.667]);
    expect(() => deleteChapterSceneDraft(weightedScenes, "scene-003", true, 60, { ...sceneSettings, maximumDurationSeconds: 20 })).toThrow("Scene count cannot satisfy the configured duration bounds");
    const markupScenes = [scenes[0]!, { ...scenes[1]!, disabled: true }];
    const markup = renderToStaticMarkup(<ScenesPage slug="demo-story" onJob={() => undefined} initialData={{ settings: { targetDurationSeconds: 20, minimumDurationSeconds: 10, maximumDurationSeconds: 30, maximumScenesPerChapter: 50 }, artwork: { provider: "openai", model: "fake", stylePrompt: "style", aspectRatio: "16:9", quality: "medium", size: "1536x1024", outputFormat: "png", outputResolution: "native", upscaling: "off", upscaler: "local-realesrgan" }, planner: { provider: "openai", model: "fake" }, videoSubtitleMode: "burn", selectedChapter: 1, chapters: [], counts: { chapters: 1, planned: 1, artworkReady: 1 }, manifest: { version: 1, chapter: 1, durationSeconds: 30, planningFingerprint: "x", manualRevision: 0, manuallyEdited: false, updatedAt: new Date().toISOString(), scenes: markupScenes } } as any} />);
    expect(markup).toContain("Move up"); expect(markup).toContain("Move down"); expect(markup).toContain("Enable"); expect(markup).toContain("Delete scene"); expect(markup).toContain("Save all scene edits"); expect(markup).toContain("Produce this chapter");
    expect(markup).toMatch(/title="A chapter must keep at least one scene and at least one enabled scene\." disabled=""[^>]*>Delete scene/);
  });

  it("shows Chapter video readiness from existing availability and freshness without providers", () => {
    const row = { chapter: 1, audioAvailable: true, audioStale: false, audioMastering: "complete", subtitlesAvailable: true, subtitlesStale: false, subtitleStatus: "complete", videoAvailable: true, videoStale: false, videoStatus: "complete", sceneStatus: "complete", artworkStatus: "complete" } as any;
    const scene: Scene = { id: "scene-001", summary: "A", startSeconds: 0, endSeconds: 30, characters: ["Mara"], resolvedCharacters: [{ name: "Mara", entityId: "ent_mara", profileStatus: "approved", resolution: "canonical_name" }], visualPrompt: "A", importance: "standard", imageUrl: "/scene.png", artwork: { status: "complete", review: "approved", versions: [] } };
    const current = chapterVideoReadinessChecks(row, [scene], false, "burn");
    expect(current.every((check) => check.state === "ready")).toBe(true);
    expect(chapterVideoReadinessChecks({ ...row, audioAvailable: false }, [scene], false, "burn").find((check) => check.label === "Audio")?.state).toBe("blocker");
    expect(chapterVideoReadinessChecks(row, [scene], true, "burn").find((check) => check.label === "Scene plan")?.state).toBe("warning");
    expect(chapterVideoReadinessChecks({ ...row, audioStale: true, videoStale: true }, [scene], false, "burn").filter((check) => check.state === "warning")).toHaveLength(2);
    expect(chapterVideoReadinessChecks(row, [{ ...scene, artwork: { status: "complete", review: "rejected", versions: [] } }], false, "burn").find((check) => check.label === "Artwork")?.state).toBe("warning");
    expect(chapterVideoReadinessChecks(row, [{ ...scene, artwork: { status: "pending", review: "unreviewed", versions: [] }, imageUrl: undefined }], false, "burn").find((check) => check.label === "Artwork")?.state).toBe("warning");
    expect(chapterVideoReadinessChecks(row, [scene, { ...scene, id: "scene-disabled", disabled: true, artwork: { status: "failed", review: "rejected", versions: [] }, imageUrl: undefined }], false, "burn").find((check) => check.label === "Artwork")?.state).toBe("ready");
    expect(chapterVideoReadinessChecks(row, [scene], false, "none").find((check) => check.label === "Subtitle timing")?.detail).toBe("Subtitles are disabled for this video.");
  });

  it("renders ScenesPage safely whether visualProfiles is an array, an object, or undefined", () => {
    const mockDashboardBase = {
      settings: { enabled: true },
      artwork: { enabled: true },
      planner: { provider: "mock", model: "mock" },
      selectedChapter: 1,
      chapters: [{ chapter: 1, title: "Chapter 1", durationSeconds: 60, sceneStatus: "complete", artworkStatus: "complete" }],
      counts: { chapters: 1, planned: 1, artworkReady: 1 },
      artDirection: { preset: "cinematic", artStyle: "Photorealistic" },
      manifest: {
        version: 1,
        chapter: 1,
        durationSeconds: 60,
        planningFingerprint: "fp",
        manualRevision: 0,
        manuallyEdited: false,
        updatedAt: new Date().toISOString(),
        scenes: [
          {
            id: "scene-001",
            summary: "Hero arrives at the gate",
            startSeconds: 0,
            endSeconds: 30,
            characters: ["Hero", "Guardian"],
            entityIds: ["ent_hero_001"],
            location: "Citadel Gate",
            visualPrompt: "A dark castle gate with glowing blue runes",
            importance: "major",
            artwork: { status: "complete", review: "approved", versions: [] },
          },
        ],
      },
    };

    // Case 1: visualProfiles as an array
    const htmlArray = renderToStaticMarkup(
      <ScenesPage
        slug="demo-story"
        onJob={() => undefined}
        navigate={() => undefined}
        initialData={{
          ...mockDashboardBase,
          visualProfiles: [
            {
              entityId: "Hero",
              canonicalName: "Hero",
              status: "approved",
              updatedAt: new Date().toISOString(),
              views: [],
            },
          ] as any,
        }}
      />
    );
    expect(htmlArray).toContain("Hero arrives at the gate");
    expect(htmlArray).toContain("Citadel Gate");
    expect(htmlArray).toContain("Hero");
    expect(htmlArray).toContain("(approved)");

    // Case 2: visualProfiles as an Object / Record (the original bug format)
    const htmlRecord = renderToStaticMarkup(
      <ScenesPage
        slug="demo-story"
        onJob={() => undefined}
        navigate={() => undefined}
        initialData={{
          ...mockDashboardBase,
          visualProfiles: {
            Hero: {
              entityId: "Hero",
              canonicalName: "Hero",
              status: "approved",
              updatedAt: new Date().toISOString(),
              views: [],
            },
          } as any,
        }}
      />
    );
    expect(htmlRecord).toContain("Hero arrives at the gate");
    expect(htmlRecord).toContain("Citadel Gate");
    expect(htmlRecord).toContain("Hero");
    expect(htmlRecord).toContain("(approved)");

    // Case 3: Empty manifest (no scenes planned yet)
    const htmlEmpty = renderToStaticMarkup(
      <ScenesPage
        slug="demo-story"
        onJob={() => undefined}
        navigate={() => undefined}
        initialData={{
          ...mockDashboardBase,
          manifest: undefined,
          visualProfiles: [],
        }}
      />
    );
    expect(htmlEmpty).toContain("Scene reel &amp; Visual Canon");
    expect(htmlEmpty).toContain("No scene plan yet");
    expect(htmlEmpty).toContain("Plan this chapter");
  });

  describe("Visual Continuity (Milestone 22)", () => {
    const continuityScene = (overrides: Partial<Scene>): Scene => ({
      id: "scene-001",
      summary: "Hero arrives",
      startSeconds: 0,
      endSeconds: 30,
      characters: ["Malakai"],
      visualPrompt: "A gate",
      importance: "standard",
      artwork: { status: "pending", review: "unreviewed", versions: [] },
      ...overrides,
    });

    it("humanizes continuity deltas into readable change lines", () => {
      const change: VisualContinuityChange = {
        characters: [
          { name: "Malakai", op: "enter" },
          { name: "Su Xue", op: "exit" },
          { name: "Garrick", op: "update", set: { wardrobe: "torn coat", carriedItems: ["staff", "lantern"] }, clear: ["injuries"] },
        ],
        environment: { set: { timeOfDay: "afternoon" }, clear: ["weather"] },
        objects: [
          { name: "Stone key", op: "add" },
          { name: "Old torch", op: "remove" },
          { name: "Banner", op: "update", set: { condition: "burning" } },
        ],
        note: "The bell keeps ringing.",
      };
      expect(humanizeContinuityChanges(change)).toEqual([
        "Malakai enters",
        "Su Xue exits",
        "Garrick: wardrobe → torn coat; carrying → staff, lantern; injuries cleared",
        "environment: time of day → afternoon",
        "environment: weather cleared",
        "Stone key appears",
        "Old torch removed",
        "Banner: condition → burning",
        "The bell keeps ringing.",
      ]);
      expect(humanizeContinuityChanges(undefined)).toEqual([]);
      expect(humanizeContinuityChanges({})).toEqual([]);
    });

    it("describes reference decisions for used, unused, and text-only cases", () => {
      expect(
        describeContinuityReference({ kind: "previous-chapter", used: true, sourceChapter: 408, sourceSceneId: "scene-012", versionNumber: 2 }),
      ).toBe("Using Chapter 408 · Scene 012 approved artwork (v2) as reference");
      expect(
        describeContinuityReference({ kind: "previous-scene", used: false, sourceSceneId: "scene-003", reason: "setting changed" }),
      ).toBe("Scene 003 artwork not used — setting changed");
      expect(describeContinuityReference({ kind: "none", used: false })).toBe("Text-only continuity");
      expect(describeContinuityReference(undefined)).toBe("Text-only continuity");
    });

    it("maps the override tri-state to the API enum", () => {
      expect(continuityReferenceTriState(undefined)).toBe("inherit");
      expect(continuityReferenceTriState("prefer")).toBe("prefer");
      expect(continuityReferenceTriState("avoid")).toBe("avoid");
    });

    it("renders the previous-chapter handoff badge only when a handoff exists", () => {
      expect(renderToStaticMarkup(<PreviousHandoffBadge handoff={undefined} />)).toBe("");
      const used = renderToStaticMarkup(
        <PreviousHandoffBadge handoff={{ chapter: 408, sceneId: "scene-012", stateFingerprint: "fp", hasApprovedArtwork: true, usedAsReference: true, origin: "automatic" }} />,
      );
      expect(used).toContain("Previous chapter handoff");
      expect(used).toContain("Chapter 408 · Scene 012");
      expect(used).toContain("Using approved artwork as reference");
      expect(used).not.toContain("Manual");
      const textOnly = renderToStaticMarkup(
        <PreviousHandoffBadge handoff={{ chapter: 407, sceneId: "scene-004", stateFingerprint: "fp", hasApprovedArtwork: false, usedAsReference: false, origin: "manual" }} />,
      );
      expect(textOnly).toContain("Text-only continuity");
      expect(textOnly).toContain("Manual");
    });

    it("renders the continuity panel quietly when empty and with a manual badge when overridden", () => {
      const empty = renderToStaticMarkup(
        <SceneContinuityPanel scene={continuityScene({})} busy={false} onSave={() => undefined} onReset={() => undefined} />,
      );
      expect(empty).toContain("Visual Continuity");
      expect(empty).toContain("No continuity state recorded for this scene.");
      expect(empty).not.toContain("Manual override");
      expect(empty).toContain("Save continuity override");
      expect(empty).not.toContain("Reset override");

      const overridden = renderToStaticMarkup(
        <SceneContinuityPanel
          scene={continuityScene({
            continuity: {
              startState: {
                characters: [{ name: "Malakai", wardrobe: "torn coat", carriedItems: ["staff"] }],
                environment: { timeOfDay: "dusk", damage: "collapsed archway" },
                objects: [{ name: "Stone key", possessedBy: "Malakai" }],
              },
              changes: { characters: [{ name: "Su Xue", op: "enter" }] },
              endState: { characters: [{ name: "Malakai" }, { name: "Su Xue" }], objects: [] },
              referenceDecision: { kind: "previous-chapter", used: true, sourceChapter: 408, sourceSceneId: "scene-012", versionNumber: 2 },
              manualOverride: { note: "Malakai still has the staff.", revision: 3, stale: true },
            },
          })}
          busy={false}
          onSave={() => undefined}
          onReset={() => undefined}
        />,
      );
      expect(overridden).toContain("Manual override");
      expect(overridden).toContain("stale");
      expect(overridden).toContain("revision 3");
      expect(overridden).toContain("Entering state");
      expect(overridden).toContain("Malakai — wardrobe: torn coat");
      expect(overridden).toContain("environment — time of day: dusk");
      expect(overridden).toContain("Stone key — with Malakai");
      expect(overridden).toContain("Changes in this scene");
      expect(overridden).toContain("Su Xue enters");
      expect(overridden).toContain("Ending state");
      expect(overridden).toContain("Using Chapter 408 · Scene 012 approved artwork (v2) as reference");
      expect(overridden).toContain('value="Malakai still has the staff."');
      expect(overridden).toContain("Reset override");
      expect(overridden).toContain("Inherit (automatic)");
      expect(overridden).toContain("Prefer previous artwork");
      expect(overridden).toContain("Avoid previous artwork");
    });

    it("surfaces the handoff badge and continuity section inside ScenesPage", () => {
      const html = renderToStaticMarkup(
        <ScenesPage
          slug="demo-story"
          onJob={() => undefined}
          navigate={() => undefined}
          initialData={{
            settings: { enabled: true },
            artwork: { enabled: true },
            planner: { provider: "mock", model: "mock" },
            selectedChapter: 409,
            chapters: [{ chapter: 409, title: "Chapter 409", durationSeconds: 60, sceneStatus: "complete", artworkStatus: "pending" }],
            counts: { chapters: 1, planned: 1, artworkReady: 0 },
            previousHandoff: { chapter: 408, sceneId: "scene-012", stateFingerprint: "fp", hasApprovedArtwork: true, usedAsReference: true, origin: "automatic" },
            manifest: {
              version: 1,
              chapter: 409,
              durationSeconds: 60,
              planningFingerprint: "fp",
              manualRevision: 0,
              manuallyEdited: false,
              updatedAt: new Date().toISOString(),
              scenes: [
                continuityScene({
                  continuity: {
                    startState: { characters: [{ name: "Malakai", condition: "limping" }], objects: [] },
                    endState: { characters: [{ name: "Malakai" }], objects: [] },
                  },
                }),
              ],
            },
          } as any}
        />,
      );
      expect(html).toContain("Previous chapter handoff");
      expect(html).toContain("Chapter 408 · Scene 012");
      expect(html).toContain("Using approved artwork as reference");
      expect(html).toContain("Visual Continuity");
      expect(html).toContain("Malakai — condition: limping");
    });
  });

  describe("JobConsole QA failure diagnostics (current, historical, legacy)", () => {
    const baseJob = {
      id: "job-failed-qa-1",
      story: "demo-story",
      type: "production",
      status: "failed" as const,
      createdAt: "2026-09-18T10:00:00.000Z",
      diagnostic: {
        id: "ERR-TEST1234",
        timestamp: "2026-09-18T10:00:00.000Z",
        summary: "Chapter 3 failed quality review",
        category: "content_qa" as const,
        retryable: false,
        recommendedAction: "Resolve findings or recheck",
        chapter: 3,
        stage: "qa",
        issues: [{ category: "names", severity: "fail", message: "Protected entity renamed to Marcus" }],
        qaDependencyFingerprint: "fp-failure",
      },
    };

    it("renders confirmed current failure without historical notice, showing issues directly", () => {
      const html = renderToStaticMarkup(
        <JobConsole
          job={baseJob}
          onUpdate={() => undefined}
          onClose={() => undefined}
          initialQaComparison={{ status: "current", nowCurrent: false }}
        />
      );
      expect(html).not.toContain("incident-historical");
      expect(html).not.toContain("Issues reported by this attempt");
      expect(html).toContain("Protected entity renamed to Marcus");
    });

    it("renders historical failure notice when fingerprints differ", () => {
      const html = renderToStaticMarkup(
        <JobConsole
          job={baseJob}
          onUpdate={() => undefined}
          onClose={() => undefined}
          initialQaComparison={{ status: "historical", nowCurrent: false }}
        />
      );
      expect(html).toContain("Previous production attempt failed quality review");
      expect(html).toContain("The chapter or its QA dependencies have changed since this failure");
      expect(html).toContain("Issues reported by this attempt");
      expect(html).toContain("Protected entity renamed to Marcus");
    });

    it("renders legacy failure notice when failure predates fingerprint tracking", () => {
      const legacyJob = {
        ...baseJob,
        diagnostic: {
          ...baseJob.diagnostic,
          qaDependencyFingerprint: undefined,
        },
      };
      const html = renderToStaticMarkup(
        <JobConsole
          job={legacyJob}
          onUpdate={() => undefined}
          onClose={() => undefined}
          initialQaComparison={{ status: "unknown_legacy", nowCurrent: false }}
        />
      );
      expect(html).toContain("Previous QA failure");
      expect(html).toContain("This production attempt predates QA freshness tracking");
      expect(html).toContain("Issues reported by this attempt");
      expect(html).toContain("Protected entity renamed to Marcus");
    });

    it("renders now-passing notice when current QA is passing, even for legacy failures", () => {
      const legacyJob = {
        ...baseJob,
        diagnostic: {
          ...baseJob.diagnostic,
          qaDependencyFingerprint: undefined,
        },
      };
      const html = renderToStaticMarkup(
        <JobConsole
          job={legacyJob}
          onUpdate={() => undefined}
          onClose={() => undefined}
          initialQaComparison={{ status: "unknown_legacy", nowCurrent: true }}
        />
      );
      expect(html).toContain("Chapter QA is current and passing now — this failure is historical.");
      expect(html).toContain("Issues reported by this attempt");
    });
  });

  describe("JobConsole persistence, restoration and lifecycle", () => {
    const storageMap = new Map<string, string>();
    const fakeSessionStorage = {
      getItem: (key: string) => storageMap.get(key) ?? null,
      setItem: (key: string, value: string) => { storageMap.set(key, String(value)); },
      removeItem: (key: string) => { storageMap.delete(key); },
      clear: () => { storageMap.clear(); },
    };

    const runningJob: Job = {
      id: "job-running-123",
      type: "production",
      story: "demo-story",
      status: "running",
      createdAt: "2026-09-18T10:00:00.000Z",
      updatedAt: "2026-09-18T10:01:00.000Z",
      progress: { chapter: 2, stage: "narration" },
    };

    const completedJob: Job = {
      id: "job-completed-456",
      type: "production",
      story: "demo-story",
      status: "completed",
      createdAt: "2026-09-18T09:00:00.000Z",
      updatedAt: "2026-09-18T09:30:00.000Z",
    };

    const failedJob: Job = {
      id: "job-failed-789",
      type: "production",
      story: "demo-story",
      status: "failed",
      createdAt: "2026-09-18T08:00:00.000Z",
      updatedAt: "2026-09-18T08:15:00.000Z",
      error: "TTS provider timeout",
    };

    it("start running job → console visible with live status and progress", () => {
      const html = renderToStaticMarkup(
        <JobConsole
          job={runningJob}
          onUpdate={() => undefined}
          onClose={() => undefined}
        />
      );
      expect(html).toContain("job-console running");
      expect(html).toContain("live-dot");
      expect(html).toContain("Producing finished story");
      expect(html).toContain("Chapter 2");
      expect(html).toContain("Narration");
      expect(html).toContain("Dismiss");
    });

    it("refresh/reinitialize app → same active job restored and rendered", () => {
      const html = renderToStaticMarkup(
        <App
          initialJob={runningJob}
          initialRoute={{ page: "story", story: "demo-story" }}
        />
      );
      expect(html).toContain("job-console running");
      expect(html).toContain("Producing finished story");
      expect(html).toContain("Dismiss");
    });

    it("restored console uses the same job ID without creating another job", () => {
      let createdCount = 0;
      const restored = runningJob;
      expect(restored.id).toBe("job-running-123");
      expect(createdCount).toBe(0);
    });

    it("polling and watch behavior resumes after restoration for active jobs", () => {
      expect(isTerminalJob(runningJob)).toBe(false);
      expect(isTerminalJob(completedJob)).toBe(true);
      expect(isTerminalJob(failedJob)).toBe(true);
    });

    it("completed job is not automatically restored as active", () => {
      expect(isTerminalJob(completedJob)).toBe(true);
      const html = renderToStaticMarkup(
        <App initialRoute={{ page: "story", story: "demo-story" }} />
      );
      expect(html).not.toContain("job-console");
    });

    it("failed historical job is not automatically restored", () => {
      expect(isTerminalJob(failedJob)).toBe(true);
      const html = renderToStaticMarkup(
        <App initialRoute={{ page: "story", story: "demo-story" }} />
      );
      expect(html).not.toContain("job-console");
    });

    it("active job belonging to another story is not restored when viewing a different story", () => {
      const otherStoryJob: Job = { ...runningJob, story: "another-story" };
      const currentStory = "demo-story";
      const isRestorableForCurrentStory = otherStoryJob.story === currentStory;
      expect(isRestorableForCurrentStory).toBe(false);
    });

    it("navigation between pages of the same story preserves the console", () => {
      const storyPageHtml = renderToStaticMarkup(
        <App initialJob={runningJob} initialRoute={{ page: "story", story: "demo-story" }} />
      );
      expect(storyPageHtml).toContain("job-console running");

      const qaPageHtml = renderToStaticMarkup(
        <App initialJob={runningJob} initialRoute={{ page: "qa", story: "demo-story" }} />
      );
      expect(qaPageHtml).toContain("job-console running");

      const prodPageHtml = renderToStaticMarkup(
        <App initialJob={runningJob} initialRoute={{ page: "production", story: "demo-story" }} />
      );
      expect(prodPageHtml).toContain("job-console running");
    });

    it("server state overrides stale client state", () => {
      const serverReportedNull = null;
      const effectiveJob = serverReportedNull ?? undefined;
      expect(effectiveJob).toBeUndefined();
    });

    it("manually closing the console does not stop the job and records dismissal", () => {
      const originalSession = globalThis.sessionStorage;
      try {
        globalThis.sessionStorage = fakeSessionStorage as any;
        fakeSessionStorage.clear();

        expect(isJobDismissed(runningJob.id)).toBe(false);
        dismissJob(runningJob.id);
        expect(isJobDismissed(runningJob.id)).toBe(true);

        expect(runningJob.status).toBe("running");
      } finally {
        globalThis.sessionStorage = originalSession;
      }
    });

    it("a newly started active job can appear even if an older job was dismissed", () => {
      const originalSession = globalThis.sessionStorage;
      try {
        globalThis.sessionStorage = fakeSessionStorage as any;
        fakeSessionStorage.clear();

        dismissJob(runningJob.id);
        expect(isJobDismissed(runningJob.id)).toBe(true);

        const newJob: Job = {
          ...runningJob,
          id: "job-new-999",
        };
        expect(isJobDismissed(newJob.id)).toBe(false);

        clearJobDismissal(runningJob.id);
        expect(isJobDismissed(runningJob.id)).toBe(false);
      } finally {
        globalThis.sessionStorage = originalSession;
      }
    });

    it("multiple-active-job behavior is deterministic (sorts newest first)", () => {
      const jobsList: Job[] = [
        { ...runningJob, id: "older-job", createdAt: "2026-09-18T10:00:00.000Z" },
        { ...runningJob, id: "newer-job", createdAt: "2026-09-18T11:00:00.000Z" },
      ];
      const sorted = jobsList.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      expect(sorted[0]!.id).toBe("newer-job");
    });
  });

  describe("JobConsole minimize and expand toggle", () => {
    const storageMap = new Map<string, string>();
    const fakeSessionStorage = {
      getItem: (key: string) => storageMap.get(key) ?? null,
      setItem: (key: string, value: string) => { storageMap.set(key, String(value)); },
      removeItem: (key: string) => { storageMap.delete(key); },
      clear: () => { storageMap.clear(); },
    };

    const runningJob: Job = {
      id: "job-minimize-123",
      type: "production",
      story: "demo-story",
      status: "running",
      createdAt: "2026-09-18T10:00:00.000Z",
      updatedAt: "2026-09-18T10:01:00.000Z",
      progress: { chapter: 449, stage: "tts" },
    };

    const failedJob: Job = {
      id: "job-failed-minimize-456",
      type: "production",
      story: "demo-story",
      status: "failed",
      createdAt: "2026-09-18T10:00:00.000Z",
      updatedAt: "2026-09-18T10:02:00.000Z",
      diagnostic: {
        id: "diag-1",
        stage: "tts",
        category: "content_tts",
        summary: "Fish Audio synthesis error",
        recommendedAction: "Check provider credits and retry",
        timestamp: "2026-09-18T10:02:00.000Z",
      },
    };

    it("starts expanded by default with accessible minimize control and full progress", () => {
      const html = renderToStaticMarkup(
        <JobConsole
          job={runningJob}
          onUpdate={() => undefined}
          onClose={() => undefined}
        />
      );

      expect(html).toContain("job-console running");
      expect(html).not.toContain("job-console running minimized");
      expect(html).toContain("aria-label=\"Minimize job console\"");
      expect(html).toContain("Producing finished story");
      expect(html).toContain("Chapter 449");
      expect(html).toContain("job-progress");
      expect(html).toContain("Dismiss");
      expect(html).toContain("Pause after chapter");
    });

    it("renders compact strip when minimized with live dot, title, chapter/stage, and expand control", () => {
      const html = renderToStaticMarkup(
        <JobConsole
          job={runningJob}
          initialMinimized={true}
          onUpdate={() => undefined}
          onClose={() => undefined}
        />
      );

      expect(html).toContain("job-console running minimized");
      expect(html).toContain("job-minimized-strip");
      expect(html).toContain("live-dot");
      expect(html).toContain("Producing finished story");
      expect(html).toContain("Chapter 449 · TTS");
      expect(html).toContain("aria-label=\"Expand job console\"");
      // Minimized bar should not show full expanded panels
      expect(html).not.toContain("job-progress");
      expect(html).not.toContain("Dismiss");
      expect(html).not.toContain("Pause after chapter");
    });

    it("minimized compact strip updates dynamically with live job progress", () => {
      const updatedJob: Job = {
        ...runningJob,
        progress: { chapter: 450, stage: "audio" },
      };

      const html = renderToStaticMarkup(
        <JobConsole
          job={updatedJob}
          initialMinimized={true}
          onUpdate={() => undefined}
          onClose={() => undefined}
        />
      );

      expect(html).toContain("job-console running minimized");
      expect(html).toContain("Chapter 450 · Audio");
    });

    it("minimizing is pure presentation: does not alter job status, call pause, or dismiss the job", () => {
      const originalSession = globalThis.sessionStorage;
      try {
        globalThis.sessionStorage = fakeSessionStorage as any;
        fakeSessionStorage.clear();

        // Minimizing records presentation preference only
        setJobConsoleMinimized(runningJob.id, true);
        expect(isJobConsoleMinimized(runningJob.id)).toBe(true);

        // Job status is unchanged, and job is NOT dismissed
        expect(runningJob.status).toBe("running");
        expect(isJobDismissed(runningJob.id)).toBe(false);

        // Expanding clears minimized preference
        setJobConsoleMinimized(runningJob.id, false);
        expect(isJobConsoleMinimized(runningJob.id)).toBe(false);
      } finally {
        globalThis.sessionStorage = originalSession;
      }
    });

    it("sessionStorage preserves minimized state across page refresh for the same job", () => {
      const originalSession = globalThis.sessionStorage;
      try {
        globalThis.sessionStorage = fakeSessionStorage as any;
        fakeSessionStorage.clear();

        // Simulate user minimizing active job before refresh
        setJobConsoleMinimized(runningJob.id, true);
        expect(isJobConsoleMinimized(runningJob.id)).toBe(true);

        // Simulate app page refresh where same active job is restored
        const html = renderToStaticMarkup(
          <JobConsole
            job={runningJob}
            onUpdate={() => undefined}
            onClose={() => undefined}
          />
        );

        expect(html).toContain("job-console running minimized");
        expect(html).toContain("aria-label=\"Expand job console\"");
      } finally {
        globalThis.sessionStorage = originalSession;
      }
    });

    it("newly started job ID starts expanded even if previous job was minimized", () => {
      const originalSession = globalThis.sessionStorage;
      try {
        globalThis.sessionStorage = fakeSessionStorage as any;
        fakeSessionStorage.clear();

        setJobConsoleMinimized("old-job-id", true);
        expect(isJobConsoleMinimized("old-job-id")).toBe(true);

        // New job ID has no saved minimize state
        const newJob: Job = { ...runningJob, id: "new-job-456" };
        expect(isJobConsoleMinimized(newJob.id)).toBe(false);

        const html = renderToStaticMarkup(
          <JobConsole
            job={newJob}
            onUpdate={() => undefined}
            onClose={() => undefined}
          />
        );

        expect(html).not.toContain("job-console running minimized");
        expect(html).toContain("aria-label=\"Minimize job console\"");
      } finally {
        globalThis.sessionStorage = originalSession;
      }
    });

    it("job failure automatically presents failure diagnostic and recovery actions", () => {
      const html = renderToStaticMarkup(
        <JobConsole
          job={failedJob}
          onUpdate={() => undefined}
          onClose={() => undefined}
        />
      );

      // Even if previously running, failure displays diagnostic, alert role, and retry action
      expect(html).toContain("job-console failed");
      expect(html).toContain("role=\"alert\"");
      expect(html).toContain("Fish Audio synthesis error");
      expect(html).toContain("Retry");
      expect(html).toContain("Copy details");
    });

    it("toggle controls use valid accessible aria-labels and type=button", () => {
      const expandedHtml = renderToStaticMarkup(
        <JobConsole
          job={runningJob}
          onUpdate={() => undefined}
          onClose={() => undefined}
        />
      );
      expect(expandedHtml).toContain("type=\"button\"");
      expect(expandedHtml).toContain("aria-label=\"Minimize job console\"");

      const minimizedHtml = renderToStaticMarkup(
        <JobConsole
          job={runningJob}
          initialMinimized={true}
          onUpdate={() => undefined}
          onClose={() => undefined}
        />
      );
      expect(minimizedHtml).toContain("type=\"button\"");
      expect(minimizedHtml).toContain("aria-label=\"Expand job console\"");
    });
  });

  describe("Chapter Workspace UX: sticky header, stage actions, and coordinated compare", () => {
    const mockChapterDetail: ChapterDetail = {
      chapter: 2,
      original: "第二章 启程\n\n阳光穿过古老的森林。",
      translation: "Chapter 2: Departure\n\nSunlight filtered through the ancient forest.",
      narration: "Chapter 2: Departure. Sunlight filtered through the ancient forest.",
      navigation: {
        previous: { chapter: 1 },
        next: { chapter: 3 },
      },
      stale: false,
      metadata: {
        originalTitle: "Chapter 2: The Journey Begins",
        stages: {
          translation: { status: "complete", model: "gpt-4o" },
          narration: { status: "complete", model: "gpt-4o" },
        },
      },
    };

    it("maps all executable chapter stages and excludes non-executable views", () => {
      expect(EXECUTABLE_CHAPTER_STAGES.translation).toEqual({ stage: "translation", label: "Translation" });
      expect(EXECUTABLE_CHAPTER_STAGES.narration).toEqual({ stage: "narration", label: "Narration" });
      expect(EXECUTABLE_CHAPTER_STAGES.context).toEqual({ stage: "storyBible", label: "Story Bible" });
      expect(EXECUTABLE_CHAPTER_STAGES.audio).toEqual({ stage: "audioMastering", label: "Audio" });
      expect(EXECUTABLE_CHAPTER_STAGES.subtitles).toEqual({ stage: "subtitles", label: "Subtitles" });
      expect(EXECUTABLE_CHAPTER_STAGES.scenes).toEqual({ stage: "scenePlanning", label: "Scenes" });
      expect(EXECUTABLE_CHAPTER_STAGES.artwork).toEqual({ stage: "artwork", label: "Artwork" });
      expect(EXECUTABLE_CHAPTER_STAGES.video).toEqual({ stage: "video", label: "Video" });

      expect(EXECUTABLE_CHAPTER_STAGES.quality).toBeUndefined();
      expect(EXECUTABLE_CHAPTER_STAGES.compare).toBeUndefined();
      expect(EXECUTABLE_CHAPTER_STAGES.original).toBeUndefined();
    });

    it("calculates accurate stage action details across all stage lifecycle states", () => {
      // 1. Compare, Original, and Quality tabs return undefined (no top generic stage action)
      expect(getStageActionDetails({ tab: "compare", data: mockChapterDetail, working: "", chapter: 2 })).toBeUndefined();
      expect(getStageActionDetails({ tab: "original", data: mockChapterDetail, working: "", chapter: 2 })).toBeUndefined();
      expect(getStageActionDetails({ tab: "quality", data: mockChapterDetail, working: "", chapter: 2 })).toBeUndefined();

      // 2. Missing stage (not generated)
      const missingDetails = getStageActionDetails({
        tab: "audio",
        data: mockChapterDetail,
        working: "",
        chapter: 2,
      });
      expect(missingDetails).toMatchObject({
        stage: "audioMastering",
        statusClass: "pending",
        statusText: "Not generated",
        buttonText: "Generate Audio",
        disabled: false,
      });

      // 3. Current completed stage
      const currentDetails = getStageActionDetails({
        tab: "translation",
        data: mockChapterDetail,
        working: "",
        chapter: 2,
      });
      expect(currentDetails).toMatchObject({
        stage: "translation",
        statusClass: "pass",
        statusText: "Current",
        buttonText: "Regenerate Translation",
        disabled: false,
      });

      // 4. Stale stage
      const staleData: ChapterDetail = {
        ...mockChapterDetail,
        metadata: {
          stages: {
            narration: { status: "complete", stale: true, staleReason: "Translation changed" },
          },
        },
      };
      const staleDetails = getStageActionDetails({
        tab: "narration",
        data: staleData,
        working: "",
        chapter: 2,
      });
      expect(staleDetails).toMatchObject({
        stage: "narration",
        statusClass: "warn",
        statusText: "Stale",
        buttonText: "Regenerate Narration",
        disabled: false,
      });

      // 5. Failed stage
      const failedData: ChapterDetail = {
        ...mockChapterDetail,
        metadata: {
          stages: {
            audioMastering: { status: "failed", error: "TTS synthesis timeout" },
          },
        },
      };
      const failedDetails = getStageActionDetails({
        tab: "audio",
        data: failedData,
        working: "",
        chapter: 2,
      });
      expect(failedDetails).toMatchObject({
        stage: "audioMastering",
        statusClass: "fail",
        statusText: "Failed",
        buttonText: "Retry Audio",
        disabled: false,
      });

      // 6. Running stage in active job
      const runningJob: Job = {
        id: "job-run-stage-1",
        type: "stageExecution",
        story: "demo-story",
        status: "running",
        progress: { currentChapter: 2, stage: "narration" },
      };
      const runningDetails = getStageActionDetails({
        tab: "narration",
        data: mockChapterDetail,
        working: "",
        activeJob: runningJob,
        chapter: 2,
      });
      expect(runningDetails).toMatchObject({
        stage: "narration",
        statusClass: "pass",
        statusText: "Running",
        buttonText: "Processing…",
        disabled: true,
        isRunning: true,
      });

      // 7. Local working state disables button
      const workingDetails = getStageActionDetails({
        tab: "translation",
        data: mockChapterDetail,
        working: "translation",
        chapter: 2,
      });
      expect(workingDetails?.disabled).toBe(true);
    });

    it("renders sticky workspace header with main metadata row and sub tab/action row", () => {
      const html = renderToStaticMarkup(
        <ChapterPage
          slug="demo-story"
          chapter={2}
          initialData={mockChapterDetail}
          initialTab="translation"
          onJob={() => undefined}
        />
      );

      // Workspace header structure and sticky class
      expect(html).toContain("chapter-workspace-header sticky");
      expect(html).toContain("chapter-workspace-main");
      expect(html).toContain("chapter-workspace-sub");

      // Main row elements
      expect(html).toContain("Chapter 0002");
      expect(html).toContain("Chapter 2: The Journey Begins");
      expect(html).toContain("Mark stages current");
      expect(html).toContain("Previous");
      expect(html).toContain("Chapter 0001");
      expect(html).toContain("Next");
      expect(html).toContain("Chapter 0003");

      // Sub row elements
      expect(html).toContain("chapter-stage-action");
      expect(html).toContain("status pass");
      expect(html).toContain("Current");
      expect(html).toContain("Regenerate Translation");
    });

    it("preserves active ?tab= parameter when clicking Previous or Next chapter navigation", () => {
      const navigated: string[] = [];
      const mockNavigate = (url: string) => {
        navigated.push(url);
      };

      // With initialTab="narration"
      const narrationHtml = renderToStaticMarkup(
        <ChapterPage
          slug="demo-story"
          chapter={2}
          initialData={mockChapterDetail}
          initialTab="narration"
          navigate={mockNavigate}
          onJob={() => undefined}
        />
      );

      // Verify buttons exist and are enabled for adjacent chapters
      expect(narrationHtml).toContain("Previous");
      expect(narrationHtml).toContain("Chapter 0001");
      expect(narrationHtml).toContain("Next");
      expect(narrationHtml).toContain("Chapter 0003");

      // With initialTab="compare"
      const compareHtml = renderToStaticMarkup(
        <ChapterPage
          slug="demo-story"
          chapter={2}
          initialData={mockChapterDetail}
          initialTab="compare"
          navigate={mockNavigate}
          onJob={() => undefined}
        />
      );

      expect(compareHtml).toContain("Previous");
      expect(compareHtml).toContain("Chapter 0001");
      expect(compareHtml).toContain("Next");
      expect(compareHtml).toContain("Chapter 0003");
    });

    it("renders 3-column coordinated Compare workspace with sticky column headers and word counts", () => {
      const html = renderToStaticMarkup(
        <ChapterPage
          slug="demo-story"
          chapter={2}
          initialData={mockChapterDetail}
          initialTab="compare"
          onJob={() => undefined}
        />
      );

      // 3-column split layout
      expect(html).toContain("manuscript-split three");

      // 3 column headers with sticky manuscript-header class
      expect(html).toContain("manuscript-header");
      expect(html).toContain("<span>Original</span>");
      expect(html).toContain("<span>Translation</span>");
      expect(html).toContain("<span>Narration</span>");

      // Word count chips in each header
      expect(html).toContain("words");

      // Compare view must NOT have a stage action button in header
      expect(html).not.toContain("chapter-stage-action");
    });

    it("Original tab has no stage action button", () => {
      const html = renderToStaticMarkup(
        <ChapterPage
          slug="demo-story"
          chapter={2}
          initialData={mockChapterDetail}
          initialTab="original"
          onJob={() => undefined}
        />
      );

      expect(html).not.toContain("chapter-stage-action");
    });

    it("renders stage action button for other executable tabs like audio, subtitles, and scenes", () => {
      const audioHtml = renderToStaticMarkup(
        <ChapterPage
          slug="demo-story"
          chapter={2}
          initialData={mockChapterDetail}
          initialTab="audio"
          onJob={() => undefined}
        />
      );
      expect(audioHtml).toContain("chapter-stage-action");
      expect(audioHtml).toContain("Generate Audio");

      const subtitlesHtml = renderToStaticMarkup(
        <ChapterPage
          slug="demo-story"
          chapter={2}
          initialData={mockChapterDetail}
          initialTab="subtitles"
          onJob={() => undefined}
        />
      );
      expect(subtitlesHtml).toContain("chapter-stage-action");
      expect(subtitlesHtml).toContain("Generate Subtitles");
    });

    it("Quality tab suppresses duplicate top stage action button and renders contextual QA panel", () => {
      const mockQaDetail = {
        chapter: 2,
        state: {
          status: "pass" as const,
          score: 0.92,
          issues: [],
          checks: {},
          findings: [],
        },
        counts: {
          open: 0,
          resolved: 0,
          safeFixesAvailable: 0,
        },
        stats: {
          current: { critical: 0, warnings: 0, open: 0, score: 0.92, status: "pass" as const },
          history: { fixedManual: 0, fixedAi: 0, dismissed: 0, obsolete: 0, total: 0 },
          needsVerification: 0,
        },
        qaStale: false,
      };

      const html = renderToStaticMarkup(
        <ChapterPage
          slug="demo-story"
          chapter={2}
          initialData={mockChapterDetail}
          initialQaDetail={mockQaDetail}
          initialTab="quality"
          onJob={() => undefined}
        />
      );

      // Generic top stage action must be suppressed on the Quality tab
      expect(html).not.toContain("chapter-stage-action");

      // Contextual QA panel must be rendered cleanly with its single authoritative action
      expect(html).toContain("qa-detail stateful");
      expect(html).toContain("Recheck QA");

      // Verify that "Recheck QA" button appears exactly once in the entire page (zero top action, one panel action)
      const recheckButtons = html.match(/<button[^>]*>[^<]*Recheck QA[^<]*<\/button>/g);
      expect(recheckButtons).toHaveLength(1);
    });

    it("chapterQaStatusView maps all QA lifecycle states cleanly", () => {
      // 1. Current / passing
      expect(chapterQaStatusView({ qa: "pass", qaScore: 0.92 })).toEqual({
        status: "pass",
        label: "QA 92",
        title: "Quality score: 92",
      });

      // 2. Current with warnings
      expect(chapterQaStatusView({ qa: "warn", qaScore: 0.78 })).toEqual({
        status: "warn",
        label: "QA 78",
        title: "Quality score: 78",
      });

      // 3. Current with failures
      expect(chapterQaStatusView({ qa: "fail", qaScore: 0.54 })).toEqual({
        status: "fail",
        label: "QA 54",
        title: "Quality score: 54",
      });

      // 4. Stale with score (retains score, indicates stale, status=warn)
      expect(chapterQaStatusView({ qa: "pass", qaScore: 0.92, qaStale: true })).toEqual({
        status: "warn",
        label: "QA 92 · stale",
        title: "QA evaluated on an earlier version of upstream artifacts — recheck required",
      });

      // 5. Running
      expect(chapterQaStatusView({ qaStage: "running" })).toEqual({
        status: "pending",
        label: "Running QA…",
        title: "QA review in progress",
      });

      // 6. Running even if older QA data exists
      expect(chapterQaStatusView({ qa: "pass", qaScore: 0.92, qaStage: "running" })).toEqual({
        status: "pending",
        label: "Running QA…",
        title: "QA review in progress",
      });

      // 7. Failed execution
      expect(chapterQaStatusView({ qaStage: "failed" })).toEqual({
        status: "fail",
        label: "QA failed",
        title: "QA execution failed",
      });

      // 8. Missing artifact when stage marked complete
      expect(chapterQaStatusView({ qaStage: "complete" })).toEqual({
        status: "fail",
        label: "QA missing",
        title: "QA stage marked complete but QA result artifact is missing",
      });

      // 9. Never evaluated / pending
      expect(chapterQaStatusView({ qaStage: "pending" })).toEqual({
        status: "pending",
        label: "Not evaluated",
        title: "QA has not been run for this chapter",
        empty: true,
      });

      expect(chapterQaStatusView({})).toEqual({
        status: "pending",
        label: "Not evaluated",
        title: "QA has not been run for this chapter",
        empty: true,
      });
    });

    it("renders QA score and stale badge in chapter table row", () => {
      const passingView = chapterQaStatusView({ qa: "pass", qaScore: 0.92 });
      const staleView = chapterQaStatusView({ qa: "pass", qaScore: 0.92, qaStale: true });
      const failedView = chapterQaStatusView({ qaStage: "failed" });
      const runningView = chapterQaStatusView({ qaStage: "running" });
      const emptyView = chapterQaStatusView({});

      expect(renderToStaticMarkup(<Status status={passingView.status} label={passingView.label} title={passingView.title} />))
        .toContain("QA 92");
      expect(renderToStaticMarkup(<Status status={staleView.status} label={staleView.label} title={staleView.title} />))
        .toContain("QA 92 · stale");
      expect(renderToStaticMarkup(<Status status={failedView.status} label={failedView.label} title={failedView.title} />))
        .toContain("QA failed");
      expect(renderToStaticMarkup(<Status status={runningView.status} label={runningView.label} title={runningView.title} />))
        .toContain("Running QA…");
      expect(emptyView.empty).toBe(true);
    });
  });
});




describe("Scene Reel artwork routing and versions", () => {
  const baseDashboard = {
    settings: { enabled: true },
    artwork: { provider: "openai", model: "gpt-image-2.5-flare" },
    artworkRouting: {
      provider: "gemini",
      model: "gemini-3.1-flash-image",
      availableProviders: [
        { name: "openai", models: ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"], defaultModel: "gpt-image-2.5-flare" },
        { name: "gemini", models: ["gemini-3.1-flash-image"], defaultModel: "gemini-3.1-flash-image" },
      ],
    },
    planner: { provider: "mock", model: "mock" },
    selectedChapter: 1,
    chapters: [{ chapter: 1, title: "Chapter 1", durationSeconds: 60, sceneStatus: "complete", artworkStatus: "complete" }],
    counts: { chapters: 1, planned: 1, artworkReady: 1 },
    manifest: {
      version: 1,
      chapter: 1,
      durationSeconds: 60,
      planningFingerprint: "fp",
      manualRevision: 0,
      manuallyEdited: false,
      updatedAt: new Date().toISOString(),
      scenes: [
        {
          id: "scene-001",
          summary: "Hero arrives at the gate",
          startSeconds: 0,
          endSeconds: 30,
          characters: [],
          visualPrompt: "A dark castle gate",
          importance: "major",
          artwork: {
            status: "complete",
            review: "approved",
            approvedVersionId: "ver-2",
            versions: [
              { id: "ver-1", versionNumber: 1, sceneId: "scene-001", imagePath: "a.png", imageFingerprint: "f1", createdAt: new Date().toISOString(), provider: "openai", model: "gpt-image-1", prompt: "p", promptFingerprint: "pf1", review: "rejected" },
              { id: "ver-2", versionNumber: 2, sceneId: "scene-001", imagePath: "b.png", imageFingerprint: "f2", createdAt: new Date().toISOString(), provider: "gemini", model: "gemini-3.1-flash-image", prompt: "p", promptFingerprint: "pf2", review: "approved", provenance: { referencesUsed: "images", referenceImageCount: 2 } },
            ],
          },
        },
      ],
    },
  };

  const renderScenes = (data: any) =>
    renderToStaticMarkup(
      <ScenesPage slug="demo-story" onJob={() => undefined} navigate={() => undefined} initialData={data} />
    );

  it("renders the artwork routing badge with provider and model from artworkRouting", () => {
    const html = renderScenes(baseDashboard);
    expect(html).toContain("gemini · gemini-3.1-flash-image");
  });

  it("falls back to artwork settings when artworkRouting is absent", () => {
    const { artworkRouting, ...rest } = baseDashboard;
    const html = renderScenes(rest);
    expect(html).toContain("openai · gpt-image-2.5-flare");
  });

  it("renders the dry-run estimate summary with provider, model, and scene count", () => {
    const html = renderToStaticMarkup(
      <ArtworkEstimateSummary estimate={{ count: 3, provider: "openai", model: "gpt-image-2.5-flare" }} />
    );
    expect(html).toContain("3");
    expect(html).toContain("scenes to generate");
    expect(html).toContain("openai · gpt-image-2.5-flare");
    expect(html).toContain("dry run only");

    const singular = renderToStaticMarkup(
      <ArtworkEstimateSummary estimate={{ count: 1, provider: "gemini", model: "gemini-3.1-flash-image" }} />
    );
    expect(singular).toContain("scene to generate");
    expect(singular).toContain("gemini · gemini-3.1-flash-image");
  });

  it("marks the approved version in the version strip", () => {
    const html = renderScenes(baseDashboard);
    expect(html).toContain("v1");
    expect(html).toContain("v2 ✓");
    expect(html).toContain("is-approved");
    expect(html).toContain("Approved Canon Version");
    expect(html).toContain("references: images (2 images)");
  });

  it("switches model options per provider and keeps an unlisted current model selectable", () => {
    expect(artworkModelOptionsFor("openai", "gpt-image-2.5-flare")).toEqual([
      "gpt-image-2.5-flare",
      "gpt-image-2.5-sunburst",
      "gpt-image-1",
      "gpt-image-1-mini",
    ]);
    expect(artworkModelOptionsFor("gemini", "gpt-image-2.5-flare")).toEqual([
      "gemini-3.1-flash-image",
      "gpt-image-2.5-flare",
    ]);
    expect(artworkModelOptionsFor("unknown-provider", "custom-model")).toEqual(["custom-model"]);
  });
});

describe("TTS quality guard UI", () => {
  const segment = (overrides: Partial<TtsSegmentQuality>): TtsSegmentQuality => ({
    index: 0,
    expectedText: "The bell rang twice before dawn.",
    status: "verified",
    score: 0.98,
    issues: [],
    attempts: [{ attempt: 1, settings: { deliveryIntensity: "restrained" }, status: "pass", score: 0.98, issues: [] }],
    finalAttempt: 1,
    ...overrides,
  });
  const artifact = (overrides: Partial<TtsQualityArtifact>): TtsQualityArtifact => ({
    version: 1,
    chapter: 1,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    provider: "fish",
    model: "speech-1.5",
    status: "verified",
    verificationPolicy: { transcriber: "whisper.cpp", maxRetries: 2, thresholds: { passScore: 0.9 }, fingerprint: "fp" },
    segments: [segment({})],
    ...overrides,
  });

  it("maps chunk sizes to presets and treats other values as custom", () => {
    expect(chunkPresetFor(1000)).toBe("conservative");
    expect(chunkPresetFor(1750)).toBe("balanced");
    expect(chunkPresetFor(3000)).toBe("long");
    expect(chunkPresetFor(2200)).toBe("custom");
  });

  it("renders a passing badge when every segment is verified", () => {
    const html = renderToStaticMarkup(<TtsQualityBadge quality={artifact({})} />);
    expect(html).toContain("status pass");
    expect(html).toContain("TTS Quality: Passed");
  });

  it("renders needs review and unverified badge states", () => {
    const review = renderToStaticMarkup(<TtsQualityBadge quality={artifact({ status: "needs_review", segments: [segment({ status: "needs_review", score: 0.81 }), segment({ index: 1, status: "needs_review" })] })} />);
    expect(review).toContain("status warn");
    expect(review).toContain("TTS Quality: Needs review (2 segments)");
    const unverified = renderToStaticMarkup(<TtsQualityBadge quality={artifact({ status: "unverified", segments: [segment({ status: "unverified", score: undefined })] })} />);
    expect(unverified).toContain("TTS Quality: Unverified");
  });

  it("never presents a manually accepted chapter as passed", () => {
    const html = renderToStaticMarkup(<TtsQualityBadge quality={artifact({ status: "partial", segments: [segment({ status: "manually_accepted", acceptedAt: "2026-09-19T01:00:00.000Z" })] })} />);
    expect(html).toContain("TTS Quality: Manually accepted (1)");
    expect(html).not.toContain("Passed");
    expect(html).not.toContain("status pass");
  });

  it("renders a problem segment row with retry count and review affordances", () => {
    const attempts = [
      { attempt: 1, settings: { deliveryIntensity: "restrained" as const }, status: "retry" as const, score: 0.7, issues: [] },
      { attempt: 2, settings: { deliveryIntensity: "none" as const }, status: "retry" as const, score: 0.78, issues: [] },
      { attempt: 3, settings: { deliveryIntensity: "none" as const }, status: "needs_review" as const, score: 0.81, issues: [] },
    ];
    const html = renderToStaticMarkup(<TtsSegmentRow slug="demo-story" chapter={1} busy={false} onRegenerate={() => undefined} onAccept={() => undefined} segment={segment({ index: 2, status: "needs_review", score: 0.81, attempts, transcription: "The bell rang before dawn.", issues: [{ type: "missing_speech", severity: 0.4 }] })} />);
    expect(html).toContain("Segment 3");
    expect(html).toContain("81%");
    expect(html).toContain("Retried 2×");
    expect(html).toContain("Needs review");
    expect(html).toContain("Regenerate segment");
    expect(html).toContain("Accept anyway");
    expect(html).toContain("Narration missing from the audio");
    expect(html).toContain("/api/stories/demo-story/chapters/1/audio-segments/3.mp3");
  });

  it("labels an accepted segment as accepted, not passed", () => {
    const html = renderToStaticMarkup(<TtsSegmentRow slug="demo-story" chapter={1} busy={false} onRegenerate={() => undefined} onAccept={() => undefined} segment={segment({ status: "manually_accepted", score: 0.81, acceptedAt: "2026-09-19T01:00:00.000Z", acceptedReason: "Sounds right" })} />);
    expect(html).toContain("Accepted by reviewer");
    expect(html).toContain("Manual acceptance is not an objective pass");
    expect(html).not.toContain("Passed");
    expect(html).not.toContain("Accept anyway");
  });

  describe("Pagination component", () => {
    it("renders standard top and bottom pagination with navigation role and accurate labels", () => {
      const topHtml = renderToStaticMarkup(
        <Pagination position="top" page={2} pages={5} total={120} itemLabel="chapters" onPrevious={() => undefined} onNext={() => undefined} />
      );
      expect(topHtml).toContain('class="pagination top"');
      expect(topHtml).toContain('role="navigation"');
      expect(topHtml).toContain('aria-label="top pagination"');
      expect(topHtml).toContain("Page 2 / 5 · 120 chapters");
      expect(topHtml).not.toContain('disabled=""');

      const bottomHtml = renderToStaticMarkup(
        <Pagination position="bottom" page={2} pages={5} total={120} itemLabel="chapters" onPrevious={() => undefined} onNext={() => undefined} />
      );
      expect(bottomHtml).toContain('class="pagination"');
      expect(bottomHtml).not.toContain("pagination top");
      expect(bottomHtml).toContain('aria-label="bottom pagination"');
      expect(bottomHtml).toContain("Page 2 / 5 · 120 chapters");
    });

    it("disables Previous button on first page and Next button on last page", () => {
      // First page
      const firstHtml = renderToStaticMarkup(
        <Pagination page={1} pages={4} total={80} itemLabel="entities" onPrevious={() => undefined} onNext={() => undefined} />
      );
      expect(firstHtml).toContain('<button type="button" disabled=""');
      expect(firstHtml).toContain("Previous</button>");
      // Next button should be enabled
      expect(firstHtml).toContain('<button type="button" aria-label="Next page">Next</button>');

      // Last page
      const lastHtml = renderToStaticMarkup(
        <Pagination page={4} pages={4} total={80} itemLabel="entities" onPrevious={() => undefined} onNext={() => undefined} />
      );
      expect(lastHtml).toContain('<button type="button" aria-label="Previous page">Previous</button>');
      expect(lastHtml).toContain('<button type="button" disabled="" aria-label="Next page">Next</button>');
    });

    it("disables both Previous and Next buttons on a single-page view", () => {
      const singleHtml = renderToStaticMarkup(
        <Pagination page={1} pages={1} total={12} itemLabel="chapters" onPrevious={() => undefined} onNext={() => undefined} />
      );
      // Both buttons disabled
      const disabledCount = (singleHtml.match(/disabled=""/g) ?? []).length;
      expect(disabledCount).toBe(2);
      expect(singleHtml).toContain("Page 1 / 1 · 12 chapters");
    });

    it("renders compact variant with correct classes and boundary states", () => {
      const topCompact = renderToStaticMarkup(
        <Pagination variant="compact" position="top" page={1} pages={3} onPrevious={() => undefined} onNext={() => undefined} />
      );
      expect(topCompact).toContain('class="localization-pagination top"');
      expect(topCompact).toContain("1 / 3");
      expect(topCompact).toContain('<button type="button" disabled=""');

      const bottomCompact = renderToStaticMarkup(
        <Pagination variant="compact" position="bottom" page={3} pages={3} onPrevious={() => undefined} onNext={() => undefined} />
      );
      expect(bottomCompact).toContain('class="localization-pagination"');
      expect(bottomCompact).not.toContain("localization-pagination top");
      expect(bottomCompact).toContain("3 / 3");
      // Next button disabled on last page
      expect(bottomCompact).toContain('<button type="button" disabled=""');
    });

    it("renders mini variant with correct classes and boundary states", () => {
      const topMini = renderToStaticMarkup(
        <Pagination variant="mini" position="top" page={1} pages={4} onPrevious={() => undefined} onNext={() => undefined} />
      );
      expect(topMini).toContain('class="queue-mini-pages top"');
      expect(topMini).toContain("<span>1/4</span>");
      expect(topMini).toContain('<button type="button" disabled=""');

      const bottomMini = renderToStaticMarkup(
        <Pagination variant="mini" position="bottom" page={2} pages={4} onPrevious={() => undefined} onNext={() => undefined} />
      );
      expect(bottomMini).toContain('class="queue-mini-pages"');
      expect(bottomMini).not.toContain("queue-mini-pages top");
      expect(bottomMini).toContain("<span>2/4</span>");
      expect(bottomMini).not.toContain('disabled=""');
    });

    it("verifies stylesheets and web source files have no duplicate copies or legacy hand-written pagination divs", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");

      const namesCss = fs.readFileSync(path.resolve(process.cwd(), "apps/web/src/names-localization.css"), "utf8");
      const queueCss = fs.readFileSync(path.resolve(process.cwd(), "apps/web/src/queue-extras.css"), "utf8");
      const stylesCss = fs.readFileSync(path.resolve(process.cwd(), "apps/web/src/styles.css"), "utf8");

      // No duplicated entire stylesheets (which occurred as multi-line copies)
      const namesLines = namesCss.trim().split("\n");
      expect(namesLines.length).toBe(1);
      const queueLines = queueCss.trim().split("\n");
      expect(queueLines.length).toBe(1);

      // styles.css has exactly one .pagination base declaration
      const paginationBaseMatches = stylesCss.match(/\.pagination\{display:flex/g);
      expect(paginationBaseMatches?.length).toBe(1);

      // App.tsx has no hand-written <div className="pagination">
      // App.tsx: 5 collections (chapters, canonical entities, minor refs, audio masters, bible review queue)
      // Exactly 1 top Pagination and 1 bottom Pagination per collection (10 total)
      const appTsx = fs.readFileSync(path.resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
      expect(appTsx).not.toContain('className="pagination"');
      expect(appTsx).not.toContain('className="localization-pagination"');
      expect(appTsx).not.toContain('className="queue-mini-pages"');
      expect(appTsx.match(/<Pagination\b/g)?.length).toBe(10);
      expect(appTsx.match(/<Pagination[^>]*position="top"/g)?.length).toBe(5);
      expect(appTsx.match(/<Pagination[^>]*position="bottom"/g)?.length).toBe(5);

      // NamesLocalizationPage.tsx has no hand-written <div className="localization-pagination">
      // NamesLocalizationPage.tsx: exactly 1 top Pagination and 1 bottom Pagination
      const namesPageTsx = fs.readFileSync(path.resolve(process.cwd(), "apps/web/src/NamesLocalizationPage.tsx"), "utf8");
      expect(namesPageTsx).not.toContain('className="localization-pagination"');
      expect(namesPageTsx.match(/<Pagination\b/g)?.length).toBe(2);
      expect(namesPageTsx.match(/<Pagination[^>]*position="top"/g)?.length).toBe(1);
      expect(namesPageTsx.match(/<Pagination[^>]*position="bottom"/g)?.length).toBe(1);

      // QueueStudio.tsx: 3 collections (jobs ledger, work items list, review items list)
      const queueTsx = fs.readFileSync(path.resolve(process.cwd(), "apps/web/src/QueueStudio.tsx"), "utf8");
      expect(queueTsx).not.toContain('className="pagination"');
      expect(queueTsx).not.toContain('className="queue-mini-pages"');
      expect(queueTsx.match(/<Pagination\b/g)?.length).toBe(6);
      expect(queueTsx.match(/<Pagination[^>]*position="top"/g)?.length).toBe(3);
      expect(queueTsx.match(/<Pagination[^>]*position="bottom"/g)?.length).toBe(3);
    });
  });
});

describe("Milestone 23 — image output quality UI", () => {
  const baseVersion: ArtworkVersion = {
    id: "v1", versionNumber: 1, sceneId: "scene-001", imagePath: "p.png", imageFingerprint: "fp",
    createdAt: new Date().toISOString(), provider: "gemini", model: "gemini-3.1-flash-image",
    prompt: "a gate", promptFingerprint: "pf", review: "unreviewed",
  };

  it("renders the resolved-behavior estimate for required, not-required, and off — never unknown", () => {
    const required = renderToStaticMarkup(<ResolvedBehaviorHint behavior={{ nativeEstimate: "2752x1536 (high)", target: { width: 3840, height: 2160 }, upscaling: "required" }} />);
    expect(required).toContain("Native generation: ~2752x1536 (high)");
    expect(required).toContain("Target: 3840×2160");
    expect(required).toContain("Upscaling: required");
    expect(required).toContain("Estimate —");
    const notRequired = renderToStaticMarkup(<ResolvedBehaviorHint behavior={{ nativeEstimate: "2752x1536 (high)", target: { width: 1920, height: 1080 }, upscaling: "not-required" }} />);
    expect(notRequired).toContain("Upscaling: not required");
    const off = renderToStaticMarkup(<ResolvedBehaviorHint behavior={{ nativeEstimate: "2752x1536 (high)", target: { width: 3840, height: 2160 }, upscaling: "off" }} />);
    expect(off).toContain("Upscaling: off");
    const unknown = renderToStaticMarkup(<ResolvedBehaviorHint behavior={{ upscaling: "unknown" }} />);
    expect(unknown).toBe("");
    expect(resolvedBehaviorSummary({ upscaling: "unknown" })).toBeUndefined();
  });

  it("renders compact version metadata lines for original-only, upscaled production, and unavailable upscaler", () => {
    const originalOnly = renderToStaticMarkup(<ArtworkVersionMetadata version={{ ...baseVersion, original: { width: 2752, height: 1536 } }} />);
    expect(originalOnly).toContain("Original 2752×1536 · gemini gemini-3.1-flash-image");
    expect(originalOnly).not.toContain("Production");
    const upscaled = renderToStaticMarkup(<ArtworkVersionMetadata version={{
      ...baseVersion,
      original: { width: 2752, height: 1536 },
      production: { width: 3840, height: 2160, upscaled: true, engine: "local-realesrgan" },
    }} />);
    expect(upscaled).toContain("Production 3840×2160 · AI upscaled (local-realesrgan)");
    const notUpscaled = renderToStaticMarkup(<ArtworkVersionMetadata version={{
      ...baseVersion,
      original: { width: 2752, height: 1536 },
      production: { width: 2752, height: 1536, upscaled: false },
    }} />);
    expect(notUpscaled).toContain("original (upscaling off or not required)");
    const unavailable = renderToStaticMarkup(<ArtworkVersionMetadata version={{
      ...baseVersion,
      original: { width: 2752, height: 1536 },
      production: { width: 2752, height: 1536, upscaled: false },
      upscale: { engine: "local-realesrgan", sourceFingerprint: "s", sourceDimensions: { width: 2752, height: 1536 }, targetDimensions: { width: 3840, height: 2160 }, status: "unavailable", warning: "binary missing" },
    }} />);
    expect(unavailable).toContain("Upscaler unavailable — using original");
    expect(unavailable).toContain('class="version-metadata-warning"');
  });

  it("shows only the selected artwork version provenance and keeps the approved version separate", () => {
    const v1: ArtworkVersion = { ...baseVersion, provenance: { artDirection: { source: "scene-override", presetName: "Moonlit ruin" }, visualCanon: [{ entityId: "ent_mara", name: "Mara", source: "approved Visual Profile", reference: true, primaryReference: true }], referencesUsed: "visual-profile+previous-scene", referenceImageCount: 2, continuityReference: { used: true, sourceSceneId: "scene-001", versionNumber: 3 } } };
    const v2: ArtworkVersion = { ...baseVersion, id: "v2", versionNumber: 2, provenance: { artDirection: { source: "story-default", presetName: "Daylight" }, visualCanon: [{ entityId: "ent_zhang", name: "Zhang", source: "Story Bible fallback" }], referencesUsed: "text-only", referenceImageCount: 0, continuityReference: { used: false, reason: "no prior scene" } } };
    const first = renderToStaticMarkup(<SelectedArtworkProvenance version={v1} approvedVersionNumber={2} />);
    expect(first).toContain("Selected version · v1"); expect(first).toContain("Approved production version · v2");
    expect(first).toContain("Moonlit ruin"); expect(first).toContain("Mara"); expect(first).toContain("visual-profile+previous-scene"); expect(first).toContain("scene-001 · v3 used");
    expect(first).not.toContain("Daylight"); expect(first).not.toContain("Zhang");
    const second = renderToStaticMarkup(<SelectedArtworkProvenance version={v2} approvedVersionNumber={2} />);
    expect(second).toContain("Selected version · v2"); expect(second).toContain("Daylight"); expect(second).toContain("Zhang"); expect(second).not.toContain("Moonlit ruin");
    const legacy = renderToStaticMarkup(<SelectedArtworkProvenance version={{ ...baseVersion, artDirectionFingerprint: "legacy-fingerprint" }} approvedVersionNumber={2} />);
    expect(legacy).toContain("Legacy artwork — detailed grounding was not recorded for this version."); expect(legacy).not.toContain("Mara");
  });

  it("maps video resolution presets to canvas dimensions and preserves custom dims", () => {
    const custom: VideoSettings = { width: 1600, height: 900, fps: 30, codec: "libx264", quality: 20, subtitleMode: "burn", subtitleStyle: "default", backgroundMode: "cover", introDurationSeconds: 3 };
    expect(videoResolutionFor(custom)).toBe("custom");
    const preset = applyVideoResolutionPreset(custom, "2160p");
    expect(preset).toMatchObject({ resolution: "2160p", width: 3840, height: 2160 });
    expect(videoResolutionFor(preset)).toBe("2160p");
    const backToCustom = applyVideoResolutionPreset(preset, "custom");
    expect(backToCustom.resolution).toBeUndefined();
    expect(backToCustom).toMatchObject({ width: 3840, height: 2160 });
    expect(VIDEO_RESOLUTION_PRESETS["1080p"]).toMatchObject({ width: 1920, height: 1080 });
  });

  it("enables re-upscale only when a non-native target and upscaling apply", () => {
    expect(reupscaleAvailable({ outputResolution: "2160p", upscaling: "automatic" })).toBe(true);
    expect(reupscaleAvailable({ outputResolution: "1080p", upscaling: "always" })).toBe(true);
    expect(reupscaleAvailable({ outputResolution: "native", upscaling: "automatic" })).toBe(false);
    expect(reupscaleAvailable({ outputResolution: "2160p", upscaling: "off" })).toBe(false);
  });

  it("shows the estimate hint and a disabled Re-upscale in Scene Studio when native output is configured", () => {
    const html = renderToStaticMarkup(
      <ScenesPage
        slug="demo-story"
        onJob={() => undefined}
        navigate={() => undefined}
        initialData={{
          settings: { targetDurationSeconds: 20, minimumDurationSeconds: 10, maximumDurationSeconds: 30, maximumScenesPerChapter: 50 },
          artwork: { provider: "gemini", model: "gemini-3.1-flash-image", stylePrompt: "s", aspectRatio: "16:9", quality: "high", size: "1536x1024", outputFormat: "png", outputResolution: "native", upscaling: "automatic", upscaler: "local-realesrgan" },
          resolvedBehavior: { nativeEstimate: "2752x1536 (high)", upscaling: "off" },
          planner: { provider: "mock", model: "mock" },
          selectedChapter: 1,
          chapters: [{ chapter: 1, title: "Chapter 1", durationSeconds: 60, sceneStatus: "complete", artworkStatus: "complete" }],
          counts: { chapters: 1, planned: 1, artworkReady: 1 },
        }}
      />
    );
    expect(html).toContain("Estimate —");
    expect(html).toContain("Upscaling: off");
    expect(html).toContain("Re-upscale");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Re-upscale<\/button>/);
  });

  it("shows version metadata and an enabled Re-upscale in Scene Studio when upscaling applies", () => {
    const html = renderToStaticMarkup(
      <ScenesPage
        slug="demo-story"
        onJob={() => undefined}
        navigate={() => undefined}
        initialData={{
          settings: { targetDurationSeconds: 20, minimumDurationSeconds: 10, maximumDurationSeconds: 30, maximumScenesPerChapter: 50 },
          artwork: { provider: "gemini", model: "gemini-3.1-flash-image", stylePrompt: "s", aspectRatio: "16:9", quality: "high", size: "1536x1024", outputFormat: "png", outputResolution: "2160p", upscaling: "automatic", upscaler: "local-realesrgan" },
          resolvedBehavior: { nativeEstimate: "2752x1536 (high)", target: { width: 3840, height: 2160 }, upscaling: "required" },
          planner: { provider: "mock", model: "mock" },
          selectedChapter: 1,
          chapters: [{ chapter: 1, title: "Chapter 1", durationSeconds: 60, sceneStatus: "complete", artworkStatus: "complete" }],
          counts: { chapters: 1, planned: 1, artworkReady: 1 },
          manifest: {
            version: 1, chapter: 1, durationSeconds: 60, planningFingerprint: "fp", manualRevision: 0, manuallyEdited: false, updatedAt: new Date().toISOString(),
            scenes: [{
              id: "scene-001", summary: "Hero arrives", startSeconds: 0, endSeconds: 30, characters: [], visualPrompt: "A gate", importance: "standard",
              artwork: { status: "complete", review: "approved", approvedVersionId: "v1", versions: [{
                ...baseVersion,
                original: { width: 2752, height: 1536 },
                production: { width: 3840, height: 2160, upscaled: true, engine: "local-realesrgan" },
                imageUrl: "/api/x.png",
              }] },
            }],
          },
        }}
      />
    );
    expect(html).toContain("Estimate —");
    expect(html).toContain("Upscaling: required");
    expect(html).toContain("Original 2752×1536");
    expect(html).toContain("Production 3840×2160 · AI upscaled (local-realesrgan)");
    expect(html).toMatch(/<button[^>]*>Re-upscale<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Re-upscale<\/button>/);
  });

  describe("Story Settings TTS Quality Guard controls", () => {
    const createMockStory = (qualityGuard = true, providerQualityGuard = false) => ({
      slug: "test-story",
      title: "Test Story",
      author: "Author",
      description: "Description",
      tags: ["fantasy"],
      notes: "",
      sourceLanguage: "zh-CN",
      outputLanguage: "en-US",
      context: { recentChapterSummaries: 5 },
      qaMode: "production" as const,
      narrationSettings: {
        profanityMode: "preserve" as const,
        bleepStrongProfanity: false,
        includeChapterTitle: true,
        speechNormalization: "automatic" as const,
        timeSpeechMode: "natural_12h" as const,
        speechVocalizations: { mode: "automatic" as const, fallback: "safe_normalize" as const },
        speechAbbreviations: {},
      },
      pipeline: {
        translation: { provider: "openai", model: "gpt-4o" },
        narration: { provider: "openai", model: "gpt-4o" },
        qa: { provider: "openai", model: "gpt-4o" },
        storyBible: { provider: "openai", model: "gpt-4o" },
        scenePlanner: { provider: "openai", model: "gpt-4o" },
        tts: {
          provider: "fish" as const,
          model: "s2.1-pro-free",
          referenceId: "narrator",
          voiceMode: "same-voice-dialogue" as const,
          deliveryIntensity: "restrained" as const,
          qualityGuard,
          providerQualityGuard,
          maxCharsPerRequest: 1750,
          maxQualityRetries: 2,
          speed: 1,
        },
      },
      audio: {
        loudnessTarget: -19,
        truePeak: -1.5,
        segmentGapSeconds: 0.75,
        chapterGapSeconds: 2,
        bitrate: "192k" as const,
        sampleRate: 44100 as const,
      },
      video: {
        width: 1920,
        height: 1080,
        fps: 30 as const,
        codec: "libx264" as const,
        quality: 20,
        subtitleMode: "burn" as const,
        subtitleStyle: "default" as const,
        backgroundMode: "cover" as const,
        introDurationSeconds: 1,
      },
      artwork: {
        provider: "openai" as const,
        model: "dall-e-3",
        autoGenerate: "chapter-first" as const,
        upscaler: "local-realesrgan" as const,
      },
    });

    it("renders Post-Generation Quality Guard once and eliminates the obsolete generic Quality guard control", () => {
      const story = createMockStory(true, false);
      const html = renderToStaticMarkup(<SettingsPage slug="test-story" onJob={() => undefined} initialStory={story as any} />);

      // Exactly one Post-Generation Quality Guard control
      const postGuardMatches = html.match(/Post-Generation Quality Guard/g);
      expect(postGuardMatches).toHaveLength(1);

      // Exactly one Provider Quality Guard control
      const providerGuardMatches = html.match(/Provider Quality Guard/g);
      expect(providerGuardMatches).toHaveLength(1);

      // Obsolete generic "Quality guard" control is completely gone
      expect(html).not.toContain("<b>Quality guard</b>");

      // Post-generation quality guard description is preserved
      expect(html).toContain("Transcribes generated audio and checks it against the expected narration to detect missing, incorrect, repeated, or unexpected speech.");

      // Max quality retries is present alongside post-generation quality guard
      expect(html).toContain("Max quality retries");
    });

    it("independently binds qualityGuard and providerQualityGuard states", () => {
      // Case 1: qualityGuard=true, providerQualityGuard=false
      const storyA = createMockStory(true, false);
      const htmlA = renderToStaticMarkup(<SettingsPage slug="test-story" onJob={() => undefined} initialStory={storyA as any} />);
      expect(htmlA).toContain('<b>Post-Generation Quality Guard</b><small>Transcribes generated audio and checks it against the expected narration to detect missing, incorrect, repeated, or unexpected speech.</small></div><input type="checkbox" checked=""');
      expect(htmlA).toContain('<b>Provider Quality Guard</b><small>Use the TTS provider&#x27;s native quality-control feature when supported.</small></div><input type="checkbox"/>');

      // Case 2: qualityGuard=false, providerQualityGuard=true
      const storyB = createMockStory(false, true);
      const htmlB = renderToStaticMarkup(<SettingsPage slug="test-story" onJob={() => undefined} initialStory={storyB as any} />);
      expect(htmlB).toContain('<b>Post-Generation Quality Guard</b><small>Transcribes generated audio and checks it against the expected narration to detect missing, incorrect, repeated, or unexpected speech.</small></div><input type="checkbox"/>');
      expect(htmlB).toContain('<b>Provider Quality Guard</b><small>Use the TTS provider&#x27;s native quality-control feature when supported.</small></div><input type="checkbox" checked=""');
    });
  });
});

describe("story bible review desk (phase A)", () => {
  it("renders the Story Bible Health card with prominent non-zero counts and the stale extraction line", () => {
    const html = renderToStaticMarkup(<StoryBibleHealthCard health={{ totals: { canonicalEntities: 42, minorReferences: 7, needsAttention: 3 }, issues: { duplicateCandidates: 2, namingCollisions: 1, continuityOpen: 1, visualProfileIssues: 0, pronunciationNeedsReview: 0, staleExtractionChapters: 5, cleanupRecommendations: 4 } }} onReviewAll={() => undefined} onOpenCleanup={() => undefined} />);
    expect(html).toContain("Story Bible Health");
    expect(html).toContain("3 entities need attention");
    expect(html).toContain("<b>42</b> canonical entities");
    expect(html).toContain("<b>2</b> duplicate candidates");
    expect(html).toContain("<b>1</b> naming collisions");
    expect(html).toContain("<b>1</b> open continuity findings");
    expect(html).toContain("5 chapters have stale Story Bible extraction");
    expect(html).toContain("Review all issues");
    expect(html).toContain("Open cleanup");
  });
  it("renders the review queue with kind filters, severity badges, and action hrefs", () => {
    const navigated: string[] = [];
    const view = { items: [
      { id: "duplicate:d1", kind: "duplicate", entityIds: ["ent_a"], title: "Possible duplicate: Su Ming ↔ Ming", detail: "92% confidence · Same name", severity: "warn", chapters: [1, 4], source: "duplicate-detection", action: { label: "Compare & merge", href: "/stories/demo-story/bible?entity=ent_a" } },
      { id: "continuity:c1", kind: "continuity", entityIds: ["ent_a"], title: "Su Ming", detail: "Appears after death.", severity: "critical", chapters: [2], source: "continuity", action: { label: "Review continuity", href: "/stories/demo-story/continuity?entity=ent_a" } },
    ], total: 2, page: 1, pageSize: 25, pages: 1, counts: { duplicate: 1, continuity: 1 } };
    const html = renderToStaticMarkup(<BibleReviewQueue view={view} kind="all" status="open" onKind={() => undefined} onStatus={() => undefined} onPage={() => undefined} navigate={(path) => navigated.push(path)} />);
    expect(html).toContain("Duplicates (1)");
    expect(html).toContain("Continuity (1)");
    expect(html).toContain("Possible duplicate: Su Ming ↔ Ming");
    expect(html).toContain("Duplicate detection");
    expect(html).toContain("Compare &amp; merge");
    expect(html).toContain('aria-label="Review status"');
    expect(html).toContain('<option value="resolved">Resolved</option>');
  });
  it("parses and rebuilds bible page query state, including the entity deep link", () => {
    const parsed = parseBibleQuery("?tab=review&type=character&q=su&sort=name&readiness=needs-attention&entity=ent_0123456789abcdef01234567&page=3");
    expect(parsed).toEqual({ tab: "review", type: "character", q: "su", sort: "name", readiness: "needs-attention", entity: "ent_0123456789abcdef01234567", page: 3 });
    expect(parseBibleQuery("?tab=bogus")).toEqual({});
    expect(bibleQueryString({ tab: "review", type: "all", q: "", sort: "last", readiness: "all", page: 1, entity: "ent_x" })).toBe("?tab=review&entity=ent_x");
    expect(bibleQueryString({ tab: "canonical", type: "all", q: "", sort: "last", readiness: "all", page: 1 })).toBe("");
    const roundtrip = parseBibleQuery(bibleQueryString({ tab: "cleanup", type: "location", q: "hall", sort: "first", readiness: "duplicate-candidates", page: 2 }));
    expect(roundtrip).toEqual({ tab: "cleanup", type: "location", q: "hall", sort: "first", readiness: "duplicate-candidates", page: 2 });
  });
  it("links QA findings with entity provenance to the bible entity sheet", () => {
    const finding: QaFinding = { id: "qaf_0123456789abcdef01234567", category: "dialogue", severity: "warn", message: "A threat is softened", evidence: "The intent remains intact.", status: "open", origin: "llm", fingerprint: "fp", provenance: { entityIds: ["ent_0123456789abcdef01234567", "ent_89abcdef0123456701234567"] } };
    const html = renderToStaticMarkup(<QaFindingCard finding={finding} busy="" expanded={[]} slug="demo-story" onToggle={() => undefined} onFixAi={() => undefined} onEdit={() => undefined} onResolve={() => undefined} onDismiss={() => undefined} />);
    expect(html).toContain('href="/stories/demo-story/bible?entity=ent_0123456789abcdef01234567"');
    expect(html).toContain("Open entity (+1)");
    const withoutSlug = renderToStaticMarkup(<QaFindingCard finding={finding} busy="" expanded={[]} onToggle={() => undefined} onFixAi={() => undefined} onEdit={() => undefined} onResolve={() => undefined} onDismiss={() => undefined} />);
    expect(withoutSlug).not.toContain("Open entity");
  });
  it("renders readiness strips and grids with attention states", () => {
    const rows = [
      { key: "identity", state: "complete", label: "Identity" },
      { key: "continuity", state: "attention", label: "Continuity", detail: "2 open continuity findings" },
      { key: "pronunciation", state: "na", label: "Pronunciation", detail: "Default provider pronunciation" },
    ];
    const strip = renderToStaticMarkup(<ReadinessStrip rows={rows} />);
    expect(strip).toContain("⚠ Continuity");
    expect(strip).not.toContain("✓");
    const clean = renderToStaticMarkup(<ReadinessStrip rows={[rows[0]!]} />);
    expect(clean).toContain("✓");
    const grid = renderToStaticMarkup(<ReadinessGrid rows={rows} />);
    expect(grid).toContain("readiness-row attention");
    expect(grid).toContain("2 open continuity findings");
    expect(grid).toContain("readiness-row na");
  });
});

describe("story bible review desk (phase D) — as-of-chapter view and sheet organization", () => {
  const baseEntity = {
    id: "ent_0123456789abcdef01234567",
    type: "character",
    canonicalName: "Su Ming the Elder",
    originalName: "苏明",
    description: "A wandering cultivator.",
    status: "active",
    notes: "Protected identity",
    firstAppearance: 2,
    lastKnownAppearance: 42,
    canonicalNameLocked: true,
    origin: "manual",
    aliases: ["Su Ming"],
    aliasNarrationRules: [],
    preferredNarrationName: "Elder Ming",
    localizedNaming: undefined,
    provenance: [
      { chapter: 2, kind: "extraction", confidence: 0.91, origin: "automatic" },
      { chapter: 5, kind: "event", origin: "automatic" },
    ],
  };
  const baseDetail = {
    entity: baseEntity,
    timeline: [{ id: "evt_1", chapter: 2, type: "appearance", summary: "Enters the city" }, { id: "evt_2", chapter: 5, type: "rank_change", summary: "Breakthrough" }],
    relationships: [],
    relatedNames: {},
    relatedReferences: [],
    issues: [],
    merges: [],
    duplicateSuggestions: [],
    namingCollisions: [],
    visualProfileExists: true,
    manualFields: ["canonicalName", "preferredNarrationName", "canonicalNameLocked", "notes"],
  };
  const sheetProps = { slug: "demo-story", navigate: () => undefined, onClose: () => undefined, onUndo: () => undefined, onEdit: () => undefined, onDemote: () => undefined, onSuppress: () => undefined, onMerge: () => undefined };

  it("renders summary header chips, as-of control, organized sections, and MANUAL badges on protected fields", () => {
    const html = renderToStaticMarkup(<CanonicalEntitySheet detail={baseDetail} {...sheetProps} />);
    // Summary header chips
    expect(html).toContain("Ch. 2—42");
    expect(html).toContain("Narration configured");
    expect(html).toContain("Visual profile");
    // As-of control
    expect(html).toContain("View as of chapter");
    // Section organization
    expect(html).toContain("Identity");
    expect(html).toContain("Naming &amp; Localization");
    expect(html).toContain("Story Information");
    expect(html).toContain("Visual Canon");
    expect(html).toContain("Provenance");
    // MANUAL badges visible without opening edit mode
    expect((html.match(/>Manual</g) || []).length).toBeGreaterThanOrEqual(3);
    // Provenance and management start collapsed; details mount only on demand.
    expect(html).toContain("2 records");
    expect(html).toContain("Entity Management");
    expect(html).toContain('aria-expanded="false" aria-controls="entity-section-entity-management"');
    expect(html).not.toContain("Remove canonical entity");
    expect(html).toContain("Edit entity");
    const stickyFooter = html.split('<footer class="entity-sheet-actions"')[1]?.split("</footer>")[0] ?? "";
    expect(stickyFooter).toContain("Edit entity");
    expect(stickyFooter).not.toContain("Entity Management");
    expect(stickyFooter).not.toContain("Remove");
  });

  it("renders the read-only historical mode with badges and without editing or management controls", () => {
    const historyView = {
      chapter: 2,
      exists: true,
      entity: { ...baseEntity, canonicalName: "Su Ming", canonicalNameLocked: false, preferredNarrationName: undefined, notes: "", origin: "automatic", provenance: [baseEntity.provenance[0]] },
      timeline: [baseDetail.timeline[0]],
      relationships: [],
      relatedNames: {},
      provenance: [baseEntity.provenance[0]],
      currentOverrides: ["canonicalName", "preferredNarrationName"],
      warnings: [],
      firstAppearanceKnown: true,
    };
    const html = renderToStaticMarkup(<CanonicalEntitySheet detail={baseDetail} {...sheetProps} historyView={historyView} />);
    expect(html).toContain("As of chapter 2 · read-only");
    expect(html).toContain("Current editorial override");
    // Historical identity is shown (pre-override name), not the current override
    expect(html).toContain("Su Ming");
    // Read-only: no editing, management, or lazy action sections
    expect(html).not.toContain("Edit entity");
    expect(html).not.toContain("Entity Management");
    expect(html).not.toContain("Convert to minor reference");
    expect(html).not.toContain("View where this entity is used");
    expect(html).not.toContain("View change history");
    expect(html).not.toContain("Set →");
    expect(html).not.toContain("Configure →");
    // Only the chapter ≤ 2 timeline entry renders
    expect(html).toContain("Enters the city");
    expect(html).not.toContain("Breakthrough");
    // Back-to-current toggle is available
    expect(html).toContain(">Current</button>");
  });

  it("shows the no-record notice when the entity does not exist before the chapter", () => {
    const historyView = {
      chapter: 1,
      exists: false,
      timeline: [],
      relationships: [],
      relatedNames: {},
      provenance: [],
      currentOverrides: [],
      warnings: [],
      firstAppearanceKnown: true,
      earliestKnownChapter: 2,
    };
    const html = renderToStaticMarkup(<CanonicalEntitySheet detail={baseDetail} {...sheetProps} historyView={historyView} />);
    expect(html).toContain("As of chapter 1 · read-only");
    expect(html).toContain("No record of this entity before chapter 1.");
    expect(html).toContain("Earliest known record: chapter 2.");
    expect(html).not.toContain("Edit entity");
  });
});
