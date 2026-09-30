/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { App, JobConsole, summaryJobProgressView } from "../apps/web/src/App.js";
import { SummariesPage } from "../apps/web/src/SummariesPage.js";
import type { Job, StorySummary } from "../apps/web/src/api.js";

class MockEventSource {
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  close = vi.fn();
  onerror = null;
}
vi.stubGlobal("EventSource", MockEventSource);

function makeSummary(overrides: Partial<StorySummary> = {}): StorySummary {
  return {
    id: "sum_test_12345",
    storyId: "undead-disaster",
    title: "Arc 1 Recap",
    chapters: [1, 2, 3],
    chapterRange: { from: 1, to: 3 },
    summaryType: "detailed",
    sourceMode: "translated",
    targetLength: { words: 800 },
    text: "Recap text",
    status: "complete",
    origin: "generated",
    manuallyEdited: false,
    contextEligible: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provenance: {
      model: { provider: "openai", model: "gpt-4o" },
      promptVersion: "1.0",
      chapterSources: [],
      levels: [],
    },
    ...overrides,
  };
}

describe("Summary Job UX — Stage Progress View", () => {
  const baseJob: Job = {
    id: "job-sum-1",
    type: "summary",
    story: "test-story",
    status: "running",
  };

  it("returns undefined for non-summary jobs", () => {
    expect(summaryJobProgressView({ ...baseJob, type: "audio" })).toBeUndefined();
    expect(summaryJobProgressView({ ...baseJob, type: "scenes" })).toBeUndefined();
    expect(summaryJobProgressView({ ...baseJob, type: "production" })).toBeUndefined();
  });

  it("maps generate and regenerate operations and phases", () => {
    const prep = summaryJobProgressView({
      ...baseJob,
      payload: { operation: "generate" },
      progress: {
        type: "summary.progress",
        operation: "generate",
        phase: "preparing",
        detail: "Preparing chapters",
      },
    });
    expect(prep).toEqual({
      title: "Generating summary",
      stageLabel: "Preparing",
      detail: "Preparing chapters",
      completed: undefined,
      total: undefined,
      percent: undefined,
    });

    const summarizing = summaryJobProgressView({
      ...baseJob,
      progress: {
        type: "summary.progress",
        operation: "generate",
        phase: "summarizing",
        completed: 2,
        total: 4,
        detail: "Summarizing batches · 2 of 4",
      },
    });
    expect(summarizing).toEqual({
      title: "Generating summary",
      stageLabel: "Summarizing batches",
      detail: "Summarizing batches · 2 of 4",
      completed: 2,
      total: 4,
      percent: 50,
    });

    const combining = summaryJobProgressView({
      ...baseJob,
      progress: {
        type: "summary.progress",
        operation: "generate",
        phase: "combining",
        completed: 1,
        total: 2,
        detail: "Combining summaries · 1 of 2",
      },
    });
    expect(combining?.stageLabel).toBe("Combining summaries");
    expect(combining?.percent).toBe(50);

    const finalizing = summaryJobProgressView({
      ...baseJob,
      progress: {
        type: "summary.progress",
        operation: "regenerate",
        phase: "finalizing",
        completed: 1,
        total: 1,
        detail: "Finalizing recap · 1 of 1",
      },
    });
    expect(finalizing?.title).toBe("Regenerating summary");
    expect(finalizing?.stageLabel).toBe("Finalizing recap");
    expect(finalizing?.percent).toBe(100);
  });

  it("maps narration operation and sub-phases", () => {
    const narrationPhase = summaryJobProgressView({
      ...baseJob,
      progress: {
        type: "summary.progress",
        operation: "narration",
        phase: "narration",
        detail: "Drafting narration script",
      },
    });
    expect(narrationPhase).toEqual({
      title: "Generating summary narration",
      stageLabel: "Narration",
      detail: "Drafting narration script",
      completed: undefined,
      total: undefined,
      percent: undefined,
    });

    const pronunciationPhase = summaryJobProgressView({
      ...baseJob,
      progress: {
        type: "summary.progress",
        operation: "narration",
        phase: "pronunciation",
        detail: "Enriching pronunciation",
      },
    });
    expect(pronunciationPhase?.stageLabel).toBe("Pronunciation");
    expect(pronunciationPhase?.detail).toBe("Enriching pronunciation");
  });

  it("maps detailed audio generation stages: narration, TTS chunk progress, quality check, retry, and mastering", () => {
    const preTts = summaryJobProgressView({
      ...baseJob,
      progress: {
        type: "summary.progress",
        operation: "audio",
        phase: "narration",
        detail: "Drafting narration script",
      },
    });
    expect(preTts?.title).toBe("Generating summary audio");
    expect(preTts?.stageLabel).toBe("Narration");
    expect(preTts?.percent).toBeUndefined();

    const tts = summaryJobProgressView({
      ...baseJob,
      progress: {
        type: "summary.progress",
        operation: "audio",
        phase: "tts",
        completed: 2,
        total: 5,
        detail: "Synthesizing speech (chunk 3 of 5)",
      },
    });
    expect(tts?.stageLabel).toBe("Speech synthesis");
    expect(tts?.completed).toBe(2);
    expect(tts?.total).toBe(5);
    expect(tts?.percent).toBe(40);
    expect(tts?.detail).toBe("Synthesizing speech (chunk 3 of 5)");

    const qualityCheck = summaryJobProgressView({
      ...baseJob,
      progress: {
        type: "summary.progress",
        operation: "audio",
        phase: "quality_check",
        detail: "Verifying TTS quality",
      },
    });
    expect(qualityCheck?.stageLabel).toBe("Quality verification");
    expect(qualityCheck?.detail).toBe("Verifying TTS quality");
    expect(qualityCheck?.percent).toBeUndefined();

    const retry = summaryJobProgressView({
      ...baseJob,
      progress: {
        type: "summary.progress",
        operation: "audio",
        phase: "retry",
        detail: "Retrying TTS chunk 3",
      },
    });
    expect(retry?.stageLabel).toBe("TTS retry");
    expect(retry?.detail).toBe("Retrying TTS chunk 3");

    const mastering = summaryJobProgressView({
      ...baseJob,
      progress: {
        type: "summary.progress",
        operation: "audio",
        phase: "mastering",
        detail: "Mastering audio with background music",
      },
    });
    expect(mastering?.stageLabel).toBe("Audio mastering");
    expect(mastering?.detail).toBe("Mastering audio with background music");

    const audioComplete = summaryJobProgressView({
      ...baseJob,
      status: "completed",
      progress: {
        type: "summary.progress",
        operation: "audio",
        phase: "complete",
        completed: 5,
        total: 5,
        detail: "Audio mastering complete",
      },
    });
    expect(audioComplete?.stageLabel).toBe("Complete");
    expect(audioComplete?.completed).toBe(5);
    expect(audioComplete?.total).toBe(5);
    expect(audioComplete?.percent).toBe(100);
    expect(audioComplete?.detail).toBe("Audio mastering complete");
  });

  it("maps scene planning, video rendering, produce stages, and artwork events", () => {
    const scenes = summaryJobProgressView({
      ...baseJob,
      progress: {
        type: "summary.progress",
        operation: "scenes",
        phase: "planning",
        detail: "Planning summary scenes",
      },
    });
    expect(scenes?.title).toBe("Planning summary scenes");
    expect(scenes?.stageLabel).toBe("Scene planning");

    const video = summaryJobProgressView({
      ...baseJob,
      progress: {
        type: "summary.progress",
        operation: "video",
        phase: "rendering",
        detail: "Rendering summary video",
      },
    });
    expect(video?.title).toBe("Rendering summary video");
    expect(video?.stageLabel).toBe("Video rendering");

    const produceAudio = summaryJobProgressView({
      ...baseJob,
      progress: {
        type: "summary.progress",
        operation: "produce",
        phase: "audio",
        detail: "Synthesizing summary audio...",
      },
    });
    expect(produceAudio?.title).toBe("Producing summary media");
    expect(produceAudio?.stageLabel).toBe("Audio generation");
    expect(produceAudio?.detail).toBe("Synthesizing summary audio...");

    const artworkStarted = summaryJobProgressView({
      ...baseJob,
      progress: {
        type: "summary.artwork.started",
        scene: "scene-001",
        index: 1,
        total: 4,
      },
    });
    expect(artworkStarted?.title).toBe("Generating summary artwork");
    expect(artworkStarted?.stageLabel).toBe("Artwork generation");
    expect(artworkStarted?.detail).toBe("Scene 001 · Artwork 1 of 4 · in progress");
    expect(artworkStarted?.completed).toBe(0);
    expect(artworkStarted?.total).toBe(4);
    expect(artworkStarted?.percent).toBe(0);

    const reupscaleStarted = summaryJobProgressView({
      ...baseJob,
      progress: {
        type: "summary.reupscale.started",
        scene: "scene-002",
        index: 2,
        total: 5,
      },
    });
    expect(reupscaleStarted?.title).toBe("Re-upscaling summary artwork");
    expect(reupscaleStarted?.stageLabel).toBe("Artwork upscaling");
    expect(reupscaleStarted?.detail).toBe("Scene 002 · Upscaling 2 of 5 · in progress");
    expect(reupscaleStarted?.completed).toBe(1);
    expect(reupscaleStarted?.percent).toBe(20);
  });

  it("maps summaryMusicExport jobs and payload fallback", () => {
    const musicExport = summaryJobProgressView({
      ...baseJob,
      type: "summaryMusicExport",
      progress: {
        type: "summary.progress",
        operation: "music_export",
        phase: "preparing",
        detail: "Exporting summary with background music",
      },
    });
    expect(musicExport?.title).toBe("Exporting summary music");
    expect(musicExport?.detail).toBe("Exporting summary with background music");

    const fallbackPayload = summaryJobProgressView({
      ...baseJob,
      payload: { operation: "audio", summaryId: "sum_abc" },
    });
    expect(fallbackPayload?.title).toBe("Generating summary audio");
    expect(fallbackPayload?.stageLabel).toBe("Audio");
    expect(fallbackPayload?.detail).toBe("Audio in progress");
  });
});

describe("Summary Job UX — JobConsole Component Rendering", () => {
  const baseJob: Job = {
    id: "job-sum-rendering",
    type: "summary",
    story: "test-story",
    status: "running",
  };

  it("renders determinate progress bar with accurate ARIA attributes for chunk TTS progress", () => {
    const job: Job = {
      ...baseJob,
      progress: {
        type: "summary.progress",
        operation: "audio",
        phase: "tts",
        completed: 3,
        total: 10,
        detail: "Synthesizing speech (chunk 4 of 10)",
      },
    };
    const html = renderToStaticMarkup(<JobConsole job={job} onUpdate={() => undefined} onClose={() => undefined} />);
    expect(html).toContain("Generating summary audio");
    expect(html).toContain("Synthesizing speech (chunk 4 of 10)");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Generating summary audio progress"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="10"');
    expect(html).toContain('aria-valuenow="3"');
    expect(html).toContain('style="width:30%"');
  });

  it("renders indeterminate progress bar during phases without chunk counts", () => {
    const job: Job = {
      ...baseJob,
      progress: {
        type: "summary.progress",
        operation: "audio",
        phase: "mastering",
        detail: "Mastering audio with background music",
      },
    };
    const html = renderToStaticMarkup(<JobConsole job={job} onUpdate={() => undefined} onClose={() => undefined} />);
    expect(html).toContain("Generating summary audio");
    expect(html).toContain("Mastering audio with background music");
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain('<div class="job-progress"><i></i><i></i><i></i><i></i><i></i></div>');
  });

  it("renders minimized strip with live stage detail and title", () => {
    const job: Job = {
      ...baseJob,
      progress: {
        type: "summary.progress",
        operation: "audio",
        phase: "tts",
        completed: 1,
        total: 5,
        detail: "Synthesizing speech (chunk 2 of 5)",
      },
    };
    const html = renderToStaticMarkup(<JobConsole job={job} initialMinimized onUpdate={() => undefined} onClose={() => undefined} />);
    expect(html).toContain('class="job-minimized-strip"');
    expect(html).toContain("Generating summary audio");
    expect(html).toContain("Synthesizing speech (chunk 2 of 5)");
    expect(html).toContain('class="live-dot"');
  });
});

describe("Summary Job UX — App Persistence & Route Hydration", () => {
  it("preserves running summary job across multi-page navigation, cross-story switching, and active job hydration precedence", async () => {
    const runningJob: Job = {
      id: "job-sum-persistent",
      type: "summary",
      story: "undead-disaster",
      status: "running",
      progress: {
        type: "summary.progress",
        operation: "audio",
        phase: "tts",
        completed: 2,
        total: 6,
        detail: "Synthesizing speech (chunk 3 of 6)",
      },
    };

    let activeJobResponse: { job: Job | null } = { job: runningJob };

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/jobs/active")) {
        return new Response(JSON.stringify(activeJobResponse), { headers: { "content-type": "application/json" } });
      }
      if (urlStr.endsWith("/stories")) {
        return new Response(
          JSON.stringify({
            stories: [
              { slug: "undead-disaster", title: "Undead Disaster", progress: 50, importedChapters: 10, processedChapters: 5, qa: { pass: 5, warn: 0, fail: 0 }, sourceType: "txt" },
              { slug: "second-story", title: "Second Story", progress: 10, importedChapters: 5, processedChapters: 1, qa: { pass: 1, warn: 0, fail: 0 }, sourceType: "txt" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("/dashboard")) {
        return new Response(
          JSON.stringify({
            story: { title: "Undead Disaster", author: "Author", sourceLanguage: "zh", outputLanguage: "en", source: { type: "txt" } },
            counts: { chapters: 10, pass: 8, warn: 2, fail: 0 },
            progress: { processed: 10, audio: 5, artwork: 0, video: 0 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("/chapters?")) {
        return new Response(JSON.stringify({ items: [], page: 1, pages: 1, total: 0 }), { headers: { "content-type": "application/json" } });
      }
      if (urlStr.includes("/chapters/1")) {
        return new Response(JSON.stringify({ chapter: { chapter: 1, story: "undead-disaster", originalTitle: "One" } }), { headers: { "content-type": "application/json" } });
      }
      if (urlStr.includes("/summaries/context")) {
        return new Response(JSON.stringify({ minChapter: 1, maxChapter: 10 }), { headers: { "content-type": "application/json" } });
      }
      if (urlStr.includes("/summaries")) {
        return new Response(JSON.stringify({ items: [], page: 1, pages: 1, total: 0 }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } });
    }));

    window.history.pushState({}, "", "/stories/undead-disaster/summaries");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      // 1. Mount App at /stories/undead-disaster/summaries (activeJob is hydrated from server as runningJob)
      await act(async () => {
        root.render(<App />);
      });

      // Strict check: JobConsole must be present and display operation & live progress
      let jobConsole = host.querySelector(".job-console");
      expect(jobConsole).not.toBeNull();
      expect(jobConsole!.textContent).toContain("Generating summary audio");
      expect(jobConsole!.textContent).toContain("Synthesizing speech (chunk 3 of 6)");

      // 2. Navigate: Summaries → Chapters
      await act(async () => {
        window.history.pushState({}, "", "/stories/undead-disaster/chapters/1");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      jobConsole = host.querySelector(".job-console");
      expect(jobConsole).not.toBeNull();
      expect(jobConsole!.textContent).toContain("Generating summary audio");
      expect(jobConsole!.textContent).toContain("Synthesizing speech (chunk 3 of 6)");

      // 3. Navigate: Chapters → Audio / Export
      await act(async () => {
        window.history.pushState({}, "", "/stories/undead-disaster/audio");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      jobConsole = host.querySelector(".job-console");
      expect(jobConsole).not.toBeNull();
      expect(jobConsole!.textContent).toContain("Generating summary audio");

      // 4. Navigate: Audio / Export → Stories (root)
      await act(async () => {
        window.history.pushState({}, "", "/");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      jobConsole = host.querySelector(".job-console");
      expect(jobConsole).not.toBeNull();
      expect(jobConsole!.textContent).toContain("Generating summary audio");

      // 5. Cross-story navigation: Story A running Summary audio job → navigate to Story B
      // Story B's /jobs/active returns null
      activeJobResponse = { job: null };
      await act(async () => {
        window.history.pushState({}, "", "/stories/second-story/summaries");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      // Active job hydration precedence: known non-terminal job wins over null route hydration
      jobConsole = host.querySelector(".job-console");
      expect(jobConsole).not.toBeNull();
      expect(jobConsole!.textContent).toContain("Generating summary audio");
      expect(jobConsole!.textContent).toContain("Synthesizing speech (chunk 3 of 6)");
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  it("SummariesPage unmount and completion refreshes summary list when returning", async () => {
    const summaryListRequests: number[] = [];
    const id = "sum_test_unmount";
    const summariesData: StorySummary[] = [
      makeSummary({
        id,
        storyId: "undead-disaster",
        title: "Arc 1 Recap",
        summaryType: "detailed",
        sourceMode: "translated",
        chapters: [1, 2, 3],
        chapterRange: { from: 1, to: 3 },
        targetLength: { words: 800 },
        text: "Recap text",
      }),
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/summaries/context")) {
        return new Response(JSON.stringify({ minChapter: 1, maxChapter: 5 }), { headers: { "content-type": "application/json" } });
      }
      if (urlStr.includes("/summaries")) {
        summaryListRequests.push(Date.now());
        return new Response(
          JSON.stringify({
            items: summariesData.map((s) => ({
              id: s.id,
              title: s.title,
              summaryType: s.summaryType,
              sourceMode: s.sourceMode,
              status: s.status ?? "complete",
              chapters: s.chapters,
              updatedAt: s.updatedAt,
              createdAt: s.createdAt,
              manuallyEdited: false,
              wordCount: 10,
            })),
            page: 1,
            pages: 1,
            total: summariesData.length,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } });
    }));

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      const onJob = vi.fn();
      // Mount SummariesPage with activeJob undefined
      await act(async () => {
        root.render(<SummariesPage slug="undead-disaster" onJob={onJob} />);
      });
      expect(summaryListRequests.length).toBeGreaterThanOrEqual(1);
      const initialFetchCount = summaryListRequests.length;

      // Pass active running job
      const runningJob: Job = {
        id: "job-123",
        type: "summary",
        story: "undead-disaster",
        status: "running",
      };
      await act(async () => {
        root.render(<SummariesPage slug="undead-disaster" onJob={onJob} activeJob={runningJob} />);
      });

      // Pass completed active job -> triggers refresh
      const completedJob: Job = {
        ...runningJob,
        status: "completed",
      };
      await act(async () => {
        root.render(<SummariesPage slug="undead-disaster" onJob={onJob} activeJob={completedJob} />);
      });

      expect(summaryListRequests.length).toBeGreaterThan(initialFetchCount);
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  it("does not poll /jobs/:id independently from SummariesPage", async () => {
    const jobPollRequests: string[] = [];
    const onJob = vi.fn();

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/jobs/")) {
        jobPollRequests.push(urlStr);
        return new Response(
          JSON.stringify({ id: "job-running-test", type: "summary", story: "undead-disaster", status: "running" }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("/summaries/context")) {
        return new Response(JSON.stringify({ minChapter: 1, maxChapter: 5 }), { headers: { "content-type": "application/json" } });
      }
      if (urlStr.includes("/summaries")) {
        return new Response(JSON.stringify({ items: [], page: 1, pages: 1, total: 0 }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } });
    }));

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      const runningJob: Job = {
        id: "job-running-test",
        type: "summary",
        story: "undead-disaster",
        status: "running",
        progress: {
          type: "summary.progress",
          operation: "audio",
          phase: "tts",
          completed: 1,
          total: 4,
          detail: "Synthesizing speech (chunk 2 of 4)",
        },
      };

      await act(async () => {
        root.render(<SummariesPage slug="undead-disaster" onJob={onJob} activeJob={runningJob} />);
      });

      // Wait a short time to verify SummariesPage has no background polling loops
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(jobPollRequests.length).toBe(0);
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  it("renders inline progress with granular summary phase without falling back to Preparing chapters", async () => {
    const audioJob: Job = {
      id: "job-audio-progress",
      type: "summary",
      story: "undead-disaster",
      status: "running",
      progress: {
        type: "summary.progress",
        operation: "audio",
        phase: "tts",
        completed: 2,
        total: 5,
        detail: "Synthesizing speech (chunk 3 of 5)",
      },
    };

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/summaries/context")) {
        return new Response(JSON.stringify({ minChapter: 1, maxChapter: 5 }), { headers: { "content-type": "application/json" } });
      }
      if (urlStr.includes("/summaries")) {
        return new Response(JSON.stringify({ items: [], page: 1, pages: 1, total: 0 }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } });
    }));

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(<SummariesPage slug="undead-disaster" onJob={vi.fn()} activeJob={audioJob} />);
      });

      // Click "Create summary" to enter creation mode where Progress renders
      const createButton = host.querySelector<HTMLButtonElement>("button.button.primary");
      await act(async () => {
        createButton?.click();
      });

      const progressElement = host.querySelector(".summary-generation");
      expect(progressElement).not.toBeNull();
      expect(progressElement!.textContent).toContain("Speech synthesis");
      expect(progressElement!.textContent).toContain("Synthesizing speech (chunk 3 of 5)");
      expect(progressElement!.textContent).not.toContain("Preparing chapters");
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
