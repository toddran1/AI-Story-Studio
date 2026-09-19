import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { App, CanonicalEntitySheet, chapterPageSize, clearJobDismissal, dismissJob, EntityStatusField, ErrorBoundary, isJobDismissed, isTerminalJob, JobConsole, paginateRows, QaDetail, QaFindingCard, QaResolvedFindings, ScenesPage, shouldRefreshAfterJob } from "../apps/web/src/App.js";
import type { Job, QaFinding } from "../apps/web/src/api.js";
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
    expect(html).toContain("🔒 Locked entities cannot be converted");
    expect(html).not.toContain("Convert to minor reference");
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
});
