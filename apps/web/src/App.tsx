import { Component, ErrorInfo, FormEvent, ReactNode, useDeferredValue, useEffect, useId, useRef, useState } from "react";
import type { StageName } from "../../../src/domain/chapter.js";
import { api, ApiError, AudioDashboard, ChapterDetail, ChapterQaDetail, ChapterRow, CostAnalytics, Counts, del, ErrorDiagnostic, formatDiagnostic, Job, Model, OutputItem, post, put, ProductionManifest, ProductionPlan, QaException, QaExceptionMatchKind, QaFinding, QaRecheckSummary, QaResult, Scene, ScenesDashboard, StoryCard, StoryConfig, StoryDashboard, TtsQualityArtifact, TtsQualityIssueType, TtsSegmentQuality, VideoDashboard, acceptChapterTtsSegment, chapterTtsSegmentAudioUrl, getChapterTtsQuality, regenerateChapterTtsSegment, verifyChapterTtsQuality } from "./api.js";
import { ArtifactStatusNotice } from "./ArtifactStatusNotice.js";
import { pretty } from "./format.js";
import { GlobalSettingsPage, LibraryPage, ManageStoryPage, NewStoryPage } from "./Milestone12.js";
import { NeedsReviewPage, QueueStudioPage } from "./QueueStudio.js";
import { audioProviderDefinition, audioProviderIds, audioProviderCatalog } from "./tts-providers.js";
import { ChapterImportPage } from "./ChapterImportPage.js";
import { SummariesPage } from "./SummariesPage.js";
import { NamesLocalizationPage } from "./NamesLocalizationPage.js";
import { PronunciationFields, PronunciationPanel } from "./PronunciationPanel.js";
import { PronunciationActions } from "./PronunciationActions.js";
import { LanguageSelect } from "./languages.js";
import { AudioDeck } from "./AudioDeck.js";
import { VocalizationList } from "./VocalizationList.js";
import { getEntityStatusOptions, isStandardEntityStatus, statusKey } from "../../../src/story-bible/entity-status.js";
import { VisualProfileModal } from "./VisualProfileModal.js";
import { VisualEvidencePanel } from "./VisualEvidencePanel.js";
import { VisualProfileCheckDialog } from "./VisualProfileCheckDialog.js";
import { ArtDirectionModal } from "./ArtDirectionModal.js";
import { reviewArtworkVersion, reupscaleArtwork, updateSceneContinuity, resetSceneContinuity, ShotType, CameraAngle, CompositionTendency, ARTWORK_PROVIDERS } from "./api.js";
import type { ArtworkSettings, ArtworkVersion, BulkEntityUpdateResult, EntityAuditEntry, EntityAuditPage, EntityHistoryView, EntityImpact, EntityUsagePage, PreviousVisualHandoff, ResolvedArtworkBehavior, SceneContinuity, VideoResolution, VideoSettings, VisualCharacterState, VisualContinuityChange, VisualContinuityOverrideEntryInput, VisualContinuityReferenceDecision, VisualContinuityState, VisualEnvironmentState, VisualObjectState } from "./api.js";
import { Pagination } from "./Pagination.js";
import { BatchProcessingPanel } from "./BatchProcessingPanel.js";
import { OPENAI_TEXT_MODELS } from "../../../src/llm/openai/models.js";
import type { SceneRegenerationProposal } from "../../../src/scenes/regeneration.js";
import { enabledProductionScenes, retimeScenesToDuration } from "../../../src/scenes/production.js";
import type { SceneSettings } from "../../../src/scenes/types.js";
import { SceneFilmstrip } from "./SceneFilmstrip.js";
import { AdvancedVisualDirection } from "./AdvancedVisualDirection.js";
import { VisualGroundingPanel } from "./VisualGroundingPanel.js";
import { VideoReadinessPanel, type ReadinessCheck } from "./VideoReadinessPanel.js";
export { Pagination, type PaginationProps, type PaginationVariant } from "./Pagination.js";
import "./entity-sheet-actions.css";
import "./stage-execution.css";
import "./scenes.css";
import "./overlay-layers.css";

export type ErrorBoundaryProps = {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  navigate?: (path: string) => void;
};

export type ErrorBoundaryState = {
  error: Error | null;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Studio render error caught by boundary:", error, errorInfo);
  }

  reset = () => {
    this.setState({ error: null });
  };

  override render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return (
        <section className="page error-boundary-page" role="alert" style={{ padding: "2rem", maxWidth: "800px" }}>
          <div className="section-heading">
            <div>
              <span className="eyebrow" style={{ color: "#ef4444" }}>Unexpected View Error</span>
              <h2>Something went wrong in this view</h2>
              <p>An error occurred while displaying this page. Your data is safe on disk.</p>
            </div>
          </div>
          <div className="error-box" style={{ margin: "1.5rem 0", padding: "1rem", background: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.3)", borderRadius: "8px" }}>
            <p style={{ margin: 0, fontWeight: 500 }}>{this.state.error.message || String(this.state.error)}</p>
          </div>
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <button
              type="button"
              className="button primary"
              onClick={() => {
                this.reset();
                location.reload();
              }}
            >
              Reload Page
            </button>
            {this.props.navigate && (
              <button
                type="button"
                className="button"
                onClick={() => {
                  this.reset();
                  this.props.navigate!("/");
                }}
              >
                Return to Library
              </button>
            )}
          </div>
          {this.state.error.stack && (
            <details style={{ marginTop: "2rem", opacity: 0.7, fontSize: "0.85rem" }}>
              <summary style={{ cursor: "pointer" }}>Error details & stack trace</summary>
              <pre style={{ overflowX: "auto", padding: "1rem", background: "rgba(0,0,0,0.3)", borderRadius: "4px", marginTop: "0.5rem" }}>
                {this.state.error.stack}
              </pre>
            </details>
          )}
        </section>
      );
    }
    return this.props.children;
  }
}

type Route = { page: string; story?: string; chapter?: number };

export type NavigateOptions = { scroll?: "top" | "preserve"; replace?: boolean };

/** Scroll side effect of navigation: everything except "preserve" resets to the top. */
export function performNavigateScroll(scroll: "top" | "preserve" = "top") {
  if (scroll === "preserve") return;
  if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
}

export function App({ initialJob, initialRoute }: { initialJob?: Job; initialRoute?: Route } = {}) {
  const [route, setRoute] = useState<Route>(() => initialRoute ?? parseRoute(location.pathname));
  const [stories, setStories] = useState<StoryCard[]>([]);
  const [storiesError, setStoriesError] = useState("");
  const [job, setJob] = useState<Job | undefined>(initialJob);
  const [jobRefreshVersion, setJobRefreshVersion] = useState(0);
  const latestJob = useRef<Job | undefined>(initialJob);
  useEffect(() => { const handler = () => setRoute(parseRoute(location.pathname)); addEventListener("popstate", handler); return () => removeEventListener("popstate", handler); }, []);
  useEffect(() => { let cancelled = false; const refreshStories = () => { setStoriesError(""); api<{ stories: StoryCard[]; warnings?: string[] }>("/stories").then((value) => { if (!cancelled) { setStories(value.stories); setStoriesError(value.warnings?.join(" ") ?? ""); } }).catch((error) => { if (!cancelled) setStoriesError(message(error)); }); }; refreshStories(); window.addEventListener("stories:changed", refreshStories); return () => { cancelled = true; window.removeEventListener("stories:changed", refreshStories); }; }, [jobRefreshVersion]);
  useEffect(() => {
    const storySlug = route.story;
    if (!storySlug) {
      if (latestJob.current?.story) {
        latestJob.current = undefined;
        setJob(undefined);
      }
      return;
    }
    if (latestJob.current && latestJob.current.story !== storySlug) {
      latestJob.current = undefined;
      setJob(undefined);
    }
    if (latestJob.current && latestJob.current.story === storySlug && !isTerminalJob(latestJob.current)) {
      return;
    }
    let cancelled = false;
    api<{ job: Job | null }>(`/stories/${storySlug}/jobs/active`)
      .then((res) => {
        if (cancelled) return;
        const serverJob = res?.job;
        if (serverJob && !isTerminalJob(serverJob)) {
          if (!isJobDismissed(serverJob.id)) {
            latestJob.current = serverJob;
            setJob(serverJob);
          }
        } else {
          if (latestJob.current?.story === storySlug && !isTerminalJob(latestJob.current)) {
            if (serverJob) {
              latestJob.current = serverJob;
              setJob(serverJob);
            } else {
              latestJob.current = undefined;
              setJob(undefined);
            }
          }
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [route.story]);
  const updateJob = (next: Job) => {
    if (shouldRefreshAfterJob(latestJob.current, next)) setJobRefreshVersion((value) => value + 1);
    if (isTerminalJob(next)) clearJobDismissal(next.id);
    latestJob.current = next;
    setJob(next);
  };
  const navigate = (path: string, options?: NavigateOptions) => { if (options?.replace) history.replaceState({}, "", path); else history.pushState({}, "", path); setRoute(parseRoute(path)); performNavigateScroll(options?.scroll); };
  const active = route.story ? stories.find((story) => story.slug === route.story) : undefined;
  return <div className="studio-shell">
    <Sidebar stories={stories} active={route.story} navigate={navigate} />
    <main className="canvas" key={`${route.page}:${route.story ?? ""}:${route.chapter ?? ""}:${jobRefreshVersion}`}>
      <Topbar title={active?.title ?? pageTitle(route.page)} subtitle={active ? `${active.sourceLanguage} → ${active.outputLanguage}` : "Local production workspace"} />
      <ErrorBoundary key={`${route.page}:${route.story ?? ""}:${route.chapter ?? ""}`} navigate={navigate}>
        {route.page === "stories" && <LibraryPage stories={stories} error={storiesError} navigate={navigate} />}
        {route.page === "new" && <NewStoryPage navigate={navigate} />}
        {route.page === "app-settings" && <GlobalSettingsPage />}
        {route.page === "queue" && <QueueStudioPage navigate={navigate} />}
        {route.page === "review" && <NeedsReviewPage navigate={navigate} />}
        {route.page === "manage" && route.story && <ManageStoryPage slug={route.story} navigate={navigate} />}
        {route.page === "story" && route.story && <StoryPage slug={route.story} navigate={navigate} onJob={updateJob} />}
        {route.page === "chapter" && route.story && route.chapter && <ChapterPage slug={route.story} chapter={route.chapter} navigate={navigate} onJob={updateJob} activeJob={job} />}
        {route.page === "qa" && route.story && <QaPage slug={route.story} navigate={navigate} />}
        {route.page === "preview" && route.story && <PreviewPage slug={route.story} onJob={updateJob} />}
        {route.page === "bible" && route.story && <BiblePage slug={route.story} navigate={navigate} locationSearch={location.search} />}
        {route.page === "names" && route.story && <NamesLocalizationPage slug={route.story} navigate={navigate} onJob={updateJob} />}
        {route.page === "continuity" && route.story && <ContinuityPage slug={route.story} navigate={navigate} />}
        {route.page === "summaries" && route.story && <SummariesPage slug={route.story} onJob={updateJob} />}
        {route.page === "audio" && route.story && <AudioPage slug={route.story} onJob={updateJob} />}
        {route.page === "video" && route.story && <VideoPage slug={route.story} onJob={updateJob} />}
        {route.page === "scenes" && route.story && <ScenesPage slug={route.story} onJob={updateJob} navigate={navigate} />}
        {route.page === "production" && route.story && <ProductionPage slug={route.story} activeJob={job?.type === "production" ? job : undefined} onJob={updateJob} navigate={navigate} />}
        {route.page === "costs" && route.story && <CostsPage slug={route.story} />}
        {route.page === "outputs" && route.story && <OutputsPage slug={route.story} />}
        {route.page === "voice" && route.story && <VoicePage slug={route.story} onJob={updateJob} />}
        {route.page === "settings" && route.story && <SettingsPage slug={route.story} onJob={updateJob} />}
        {route.page === "import" && <ChapterImportPage storySlug={route.story} stories={stories} navigate={navigate} />}
      </ErrorBoundary>
    </main>
    {job && <JobConsole job={job} onUpdate={updateJob} navigate={navigate} onClose={() => {
      if (job) dismissJob(job.id);
      latestJob.current = undefined;
      setJob(undefined);
    }} />}
  </div>;
}

function Sidebar({ stories, active, navigate }: { stories: StoryCard[]; active?: string; navigate: (path: string) => void }) {
  const storyPath = (suffix: string) => active ? `/stories/${active}${suffix}` : "/";
  return <aside className="sidebar">
    <button className="brand" onClick={() => navigate("/")}><span className="brand-mark">A</span><span><b>AI Story</b><small>Studio</small></span></button>
    <nav className="main-nav" aria-label="Studio navigation">
      <Nav icon="library" label="Stories" active={!active} onClick={() => navigate("/")} />
      <Nav icon="plus" label="New story" onClick={() => navigate("/new")} />
      <Nav icon="settings" label="App settings" onClick={() => navigate("/settings")} />
      <Nav icon="production" label="Production queue" onClick={() => navigate("/queue")} />
      <Nav icon="quality" label="Needs review" onClick={() => navigate("/review")} />
      <div className="nav-caption">Active story</div>
      <Nav icon="chapters" label="Chapters" disabled={!active} onClick={() => navigate(storyPath(""))} />
      <Nav icon="quality" label="Quality review" disabled={!active} onClick={() => navigate(storyPath("/qa"))} />
      <Nav icon="compare" label="Preview A/B" disabled={!active} onClick={() => navigate(storyPath("/preview"))} />
      <Nav icon="bible" label="Story Bible" disabled={!active} onClick={() => navigate(storyPath("/bible"))} />
      <Nav icon="compare" label="Names / Localization" disabled={!active} onClick={() => navigate(storyPath("/names"))} />
      <Nav icon="quality" label="Continuity Review" disabled={!active} onClick={() => navigate(storyPath("/continuity"))} />
      <Nav icon="bible" label="Summaries" disabled={!active} onClick={() => navigate(storyPath("/summaries"))} />
      <Nav icon="scenes" label="Scenes / Artwork" disabled={!active} onClick={() => navigate(storyPath("/scenes"))} />
      <Nav icon="audio" label="Audio / Export" disabled={!active} onClick={() => navigate(storyPath("/audio"))} />
      <Nav icon="video" label="Video" disabled={!active} onClick={() => navigate(storyPath("/video"))} />
      <Nav icon="production" label="Production" disabled={!active} onClick={() => navigate(storyPath("/production"))} />
      <Nav icon="production" label="Costs / Analytics" disabled={!active} onClick={() => navigate(storyPath("/costs"))} />
      <Nav icon="audio" label="Outputs" disabled={!active} onClick={() => navigate(storyPath("/outputs"))} />
      <Nav icon="audio" label="Voice test" disabled={!active} onClick={() => navigate(storyPath("/voice"))} />
      <Nav icon="settings" label="Settings" disabled={!active} onClick={() => navigate(storyPath("/settings"))} />
      <Nav icon="library" label="Manage project" disabled={!active} onClick={() => navigate(storyPath("/manage"))} />
    </nav>
    <div className="sidebar-stories"><div className="nav-caption">On the shelf</div>{stories.slice(0, 4).map((story) => <button key={story.slug} onClick={() => navigate(`/stories/${story.slug}`)} className={active === story.slug ? "active-story" : ""}><span>{story.title.slice(0, 1)}</span><div><b>{story.title}</b><small>{story.processedChapters} of {story.importedChapters} mixed</small></div></button>)}</div>
    <div className="system-ready"><i /> Local engine ready</div>
  </aside>;
}

function Nav({ icon, label, onClick, disabled, active }: { icon: string; label: string; onClick: () => void; disabled?: boolean; active?: boolean }) { return <button className={`nav-item ${active ? "active" : ""}`} disabled={disabled} onClick={onClick}><Icon name={icon} />{label}</button>; }
function Topbar({ title, subtitle }: { title: string; subtitle: string }) { return <header className="topbar"><div><span className="eyebrow">Production desk</span><h1>{title}</h1></div><div className="topbar-meta"><span>{subtitle}</span><kbd>⌘ K</kbd></div></header>; }

function StoriesPage({ stories, error, navigate }: { stories: StoryCard[]; error?: string; navigate: (path: string) => void }) {
  return <section className="page"><div className="section-heading"><div><h2>Your story shelf</h2><p>Open a production to review chapters, quality, and audio.</p></div><button className="button primary" onClick={() => navigate("/import")}><Icon name="plus" /> Import a story</button></div>
    {error ? <ErrorBox text={error} /> : stories.length ? <div className="story-grid">{stories.map((story) => <button className="story-card" key={story.slug} onClick={() => navigate(`/stories/${story.slug}`)}>
      <div className="card-top"><span className="source-chip">{story.sourceType}</span><span className="mono">{story.progress}%</span></div><h3>{story.title}</h3><p>{story.author ?? "Author not listed"}</p>
      <div className="reel" aria-label={`${story.progress}% processed`}>{["translation", "narration", "qa", "audio"].map((stage, index) => <i key={stage} className={story.progress >= (index + 1) * 25 ? "filled" : ""} />)}</div>
      <div className="card-stats"><span><b>{story.importedChapters}</b> chapters</span><span><b>{story.processedChapters}</b> processed</span><span><b>{story.qa.warn + story.qa.fail}</b> review</span></div>
      <div className="qa-line"><Status status="pass" label={`${story.qa.pass} pass`} /><Status status="warn" label={`${story.qa.warn} warn`} /><Status status="fail" label={`${story.qa.fail} fail`} /></div>{story.sourceUrl && <small className="source-url">{new URL(story.sourceUrl).hostname}</small>}
    </button>)}</div> : <Empty title="The shelf is waiting" text="Import a TXT, EPUB, DOCX, or Fanqie story to begin." action={<button className="button primary" onClick={() => navigate("/import")}>Import your first story</button>} />}
  </section>;
}

export function StoryPage({ slug, navigate, onJob }: { slug: string; navigate: (path: string) => void; onJob: (job: Job) => void }) {
  const [overview, setOverview] = useState<StoryDashboard>(); const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(() => chapterPageSize(location.search)); const [filter, setFilter] = useState("all"); const [query, setQuery] = useState("");
  const [selectedChapters, setSelectedChapters] = useState<number[]>([]); const [markCurrentOpen, setMarkCurrentOpen] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState(query); const chapterRequest = useRef(0);
  useEffect(() => { const timer = window.setTimeout(() => setDebouncedQuery(query), 300); return () => window.clearTimeout(timer); }, [query]);
  const [chapters, setChapters] = useState<{ items: ChapterRow[]; page: number; pages: number; total: number }>(); const [error, setError] = useState(""); const [refreshResult, setRefreshResult] = useState<any>();
  useEffect(() => { api<StoryDashboard>(`/stories/${slug}/dashboard`).then(setOverview).catch((e) => setError(message(e))); }, [slug]);
  useEffect(() => { if (debouncedQuery !== query) return; const request = ++chapterRequest.current; api<any>(`/stories/${slug}/chapters?page=${page}&pageSize=${pageSize}&filter=${filter}&q=${encodeURIComponent(debouncedQuery)}`).then((value) => { if (request === chapterRequest.current) setChapters(value); }).catch((e) => { if (request === chapterRequest.current) setError(message(e)); }); return () => { chapterRequest.current++; }; }, [slug, page, pageSize, filter, query, debouncedQuery]);
  const selectMatchingChapters = async (all = false) => { try { setError(""); const selected: number[] = []; let nextPage = 1; let pages = 1; do { const result = await api<{ items: ChapterRow[]; pages: number }>(`/stories/${slug}/chapters?page=${nextPage}&pageSize=100&filter=${all ? "all" : filter}&q=${all ? "" : encodeURIComponent(query)}`); selected.push(...result.items.map((item) => item.chapter)); pages = result.pages; nextPage++; } while (nextPage <= pages); setSelectedChapters([...new Set(selected)].sort((left, right) => left - right)); } catch (value) { setError(message(value)); } };
  const refresh = async (importNew = false) => { try { const value = await post<any>(`/stories/${slug}/source/refresh`, { importNew }); setRefreshResult(value); if (importNew) alert(`Imported ${value.imported.length} new chapters.`); } catch (e) { setError(message(e)); } };
  if (!overview) return <section className="page dashboard-page"><div className="section-heading"><h2>Chapters</h2></div>{error && <ErrorBox text={error} />}{chapters ? <div className="chapter-table">{chapters.items.map((chapter) => <button key={chapter.chapter} className="tr" onClick={() => navigate(`/stories/${slug}/chapters/${chapter.chapter}`)}>Chapter {chapter.chapter} · {chapter.originalTitle ?? "Untitled chapter"}</button>)}</div> : !error && <Loading />}</section>;
  return <section className="page dashboard-page"><div className="dashboard-hero"><div><span className="eyebrow">Production dashboard</span><h2>{overview.story.title}</h2><p>{overview.story.author ?? "Author not listed"} · {overview.story.sourceLanguage} → {overview.story.outputLanguage} · {pretty(overview.story.source.type)} source</p><small>{overview.source ? `${overview.source.chapterCount} chapters imported ${new Date(overview.source.importedAt).toLocaleDateString()}` : "Source manifest unavailable"}</small></div><div className="quality-orbit"><strong>{overview.progress.processed}</strong><span>processed / {overview.counts.chapters}</span></div></div>
    <div className="dashboard-meter" aria-label="Story production progress">{Array.from({ length: Math.min(overview.counts.chapters, 60) }, (_, index) => { const ratio = overview.counts.chapters / Math.min(overview.counts.chapters, 60); const chapter = Math.floor(index * ratio) + 1; const level = chapter <= overview.progress.video ? "video" : chapter <= overview.progress.artwork ? "artwork" : chapter <= overview.progress.audio ? "audio" : chapter <= overview.progress.processed ? "text" : "imported"; return <i className={level} key={index} title={`Chapter ${chapter}: ${level}`} />; })}</div>
    <div className="dashboard-stats"><span><b>{overview.counts.chapters}</b>Imported</span><span><b>{overview.progress.processed}</b>Processed</span><span><b>{overview.counts.pass}/{overview.counts.warn}/{overview.counts.fail}</b>QA pass / warn / fail</span><span><b>{overview.progress.audio}</b>Audio</span><span><b>{overview.progress.artwork}</b>Artwork</span><span><b>{overview.progress.video}</b>Video</span><span><b>{overview.currentProfile ? pretty(overview.currentProfile) : "Not set"}</b>Current profile</span><span><b>{overview.estimatedRemainingStages}</b>Stage operations left</span></div>
    <div className="dashboard-actions"><button className="button primary" onClick={() => navigate(`/stories/${slug}/production`)}>Set up production</button><button className="button" onClick={() => navigate(`/stories/${slug}/production`)}>{overview.latestProduction?.status === "paused" ? "Resume production" : "Produce audiobook / video"}</button><button className="button" onClick={() => navigate(`/stories/${slug}/import`)}>Import / update chapters</button><button className="button" onClick={() => navigate(`/stories/${slug}/bible`)}>Open Story Bible</button><button className="button" onClick={() => navigate(`/stories/${slug}/outputs`)}>Browse outputs</button><button className="button" onClick={() => navigate(`/stories/${slug}/settings`)}>Open settings</button>{["fanqie", "web"].includes(overview.story.source.type) && <button className="button" onClick={() => refresh(false)}>Check source</button>}</div>
    {overview.latestProduction && <div className="last-run"><span><b>Last production run</b></span><Status status={overview.latestProduction.status === "completed" ? "pass" : overview.latestProduction.status === "failed" ? "fail" : "warn"} label={pretty(overview.latestProduction.status)} /><span>{overview.latestProduction.summary.completed} complete · {formatDuration(overview.latestProduction.summary.elapsedMs / 1000)}</span></div>}
    {refreshResult && <div className="refresh-banner"><div><span className="eyebrow">Remote source</span><b>{refreshResult.previousImportedCount} imported · {refreshResult.currentCount} available</b><p>{refreshResult.added.length ? `New chapters: ${refreshResult.added.map((item: any) => item.chapter).join(", ")}` : "No new chapters found."}</p></div>{refreshResult.added.length > 0 && !refreshResult.imported.length && <button className="button primary" onClick={() => refresh(true)}>Import new chapters</button>}</div>}
    <BatchProcessingPanel slug={slug} selectedChapters={selectedChapters} onSelectionChange={setSelectedChapters} onSelectVisible={() => setSelectedChapters([...(chapters?.items.map((item) => item.chapter) ?? [])].sort((left, right) => left - right))} onSelectMatching={() => void selectMatchingChapters()} onSelectAll={() => void selectMatchingChapters(true)} onJob={onJob} watchJob={watchJob} />
    {error && <ErrorBox text={error} />}
    <div className="table-tools"><div className="segmented">{[["all", "All"], ["unprocessed", "Unprocessed"], ["warn", "QA warn"], ["fail", "QA fail"], ["complete", "Complete"]].map(([value, label]) => <button className={filter === value ? "active" : ""} onClick={() => { setFilter(value); setPage(1); }} key={value}>{label}</button>)}</div><div className="chapter-table-controls"><label className="chapter-page-size"><span>Chapters per page</span><select value={pageSize} onChange={(event) => { const next = Number(event.target.value); setPageSize(next); setPage(1); const url = new URL(location.href); url.searchParams.set("pageSize", String(next)); history.replaceState({}, "", `${url.pathname}${url.search}`); }}><option value="10">10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label><input className="search" placeholder="Find chapter or title" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} /></div></div>
    {selectedChapters.length > 0 && <div className="stage-selection-rail"><span><b>Artifact acceptance</b></span><small>Keep selected existing artifacts without running providers. This is separate from batch processing.</small><button className="button" onClick={() => setMarkCurrentOpen(true)}>Mark selected stages current</button></div>}
    {chapters && <Pagination position="top" page={chapters.page} pages={chapters.pages} total={chapters.total} itemLabel="chapters" onPrevious={() => setPage(page - 1)} onNext={() => setPage(page + 1)} />}
    <div className="chapter-table"><div className="tr th selectable"><span>Select</span><span>Chapter</span><span>Translation</span><span>Narration</span><span>Quality</span><span>Mastered</span></div>{chapters?.items.map((chapter) => { const qaView = chapterQaStatusView(chapter); return <div className="tr selectable" key={chapter.chapter}><label className="row-check"><input type="checkbox" checked={selectedChapters.includes(chapter.chapter)} onChange={(event) => setSelectedChapters((current) => (event.target.checked ? [...new Set([...current, chapter.chapter])] : current.filter((value) => value !== chapter.chapter)).sort((left, right) => left - right))} aria-label={`Select chapter ${chapter.chapter}`} /></label><button className="chapter-row-link" onClick={() => navigate(`/stories/${slug}/chapters/${chapter.chapter}`)}><span><b>{String(chapter.chapter).padStart(4, "0")}</b><small>{chapter.originalTitle ?? "Untitled chapter"}</small></span><Stage value={chapter.translation} /><Stage value={chapter.narration} /><span>{qaView.empty ? <em title="Not evaluated">—</em> : <Status status={qaView.status} label={qaView.label} title={qaView.title} />}</span><span><Stage value={chapter.audioStale ? "stale" : chapter.audioAvailable ? (chapter.audioMastering === "pending" ? "complete" : chapter.audioMastering) : chapter.audioMastering} />{chapter.durationSeconds && <small className="duration">{formatDuration(chapter.durationSeconds)}</small>}</span></button></div>; })}</div>
    {chapters && <Pagination position="bottom" page={chapters.page} pages={chapters.pages} total={chapters.total} itemLabel="chapters" onPrevious={() => setPage(page - 1)} onNext={() => setPage(page + 1)} />}
    {markCurrentOpen && <MarkCurrentDialog slug={slug} chapters={selectedChapters} onClose={() => setMarkCurrentOpen(false)} onDone={() => { setMarkCurrentOpen(false); setSelectedChapters([]); api<any>(`/stories/${slug}/chapters?page=${page}&pageSize=${pageSize}&filter=${filter}&q=${encodeURIComponent(query)}`).then(setChapters); }} />}
  </section>;
}

function MarkCurrentDialog({ slug, chapters, onClose, onDone }: { slug: string; chapters: number[]; onClose: () => void; onDone: () => void }) {
  const [preview, setPreview] = useState<any>(); const [stages, setStages] = useState<string[]>([]); const [reason, setReason] = useState(""); const [error, setError] = useState(""); const [working, setWorking] = useState(false);
  useEffect(() => { post<any>(`/stories/${slug}/stages/mark-current/preview`, { chapters }).then(setPreview).catch((value) => setError(message(value))); }, [slug, chapters]);
  const accept = async () => { try { setWorking(true); setError(""); await post(`/stories/${slug}/stages/mark-current`, { chapters, stages, reason: reason.trim() || undefined }); onDone(); } catch (value) { setError(message(value)); } finally { setWorking(false); } };
  return <div className="stage-modal-backdrop" role="presentation"><section className="stage-modal" role="dialog" aria-modal="true" aria-labelledby="mark-current-title"><header><div><span className="eyebrow">Artifact acceptance</span><h3 id="mark-current-title">Mark stages current</h3></div><button className="button" onClick={onClose}>Close</button></header><p>Keep existing artifact and accept it as valid for current configuration. No generation will run.</p>{error && <ErrorBox text={error} />}{!preview ? <Loading /> : <div className="stage-choices">{preview.stages.map((item: any) => <label key={item.stage} className={item.eligible ? "" : "disabled"}><input type="checkbox" disabled={!item.eligible} checked={stages.includes(item.stage)} onChange={(event) => setStages((current) => event.target.checked ? [...current, item.stage] : current.filter((stage) => stage !== item.stage))} /><span><b>{pretty(item.stage)}</b><small>{item.eligible} stale artifact{item.eligible === 1 ? "" : "s"} can be accepted · {item.current} already current{item.manuallyAccepted ? ` (${item.manuallyAccepted} manually accepted)` : ""} · {item.missing + item.ineligible} unavailable{item.reason ? ` · ${item.reason}` : ""}</small></span></label>)}</div>}<label className="field"><span>Acceptance note (optional)</span><input value={reason} maxLength={500} placeholder="Why this retained artifact is acceptable" onChange={(event) => setReason(event.target.value)} /></label><footer><small>Future input or settings changes will make accepted stages stale again.</small><button className="button primary" disabled={!stages.length || working} onClick={() => void accept()}>{working ? "Marking current…" : "Mark current"}</button></footer></section></div>;
}

export const EXECUTABLE_CHAPTER_STAGES: Record<string, { stage: StageName; label: string }> = {
  translation: { stage: "translation", label: "Translation" },
  narration: { stage: "narration", label: "Narration" },
  context: { stage: "storyBible", label: "Story Bible" },
  audio: { stage: "audioMastering", label: "Audio" },
  subtitles: { stage: "subtitles", label: "Subtitles" },
  scenes: { stage: "scenePlanning", label: "Scenes" },
  artwork: { stage: "artwork", label: "Artwork" },
  video: { stage: "video", label: "Video" },
};

export function chapterQaStatusView(chapter: {
  qa?: "pass" | "warn" | "fail";
  qaScore?: number;
  qaStale?: boolean;
  qaStage?: string;
}): {
  status: "pass" | "warn" | "fail" | "pending";
  label: string;
  title?: string;
  empty?: boolean;
} {
  if (chapter.qaStage === "running") {
    return {
      status: "pending",
      label: "Running QA…",
      title: "QA review in progress",
    };
  }

  if (typeof chapter.qaScore === "number" && !Number.isNaN(chapter.qaScore)) {
    const scoreVal = chapter.qaScore <= 1 ? Math.round(chapter.qaScore * 100) : Math.round(chapter.qaScore);
    if (chapter.qaStale) {
      return {
        status: "warn",
        label: `QA ${scoreVal} · stale`,
        title: "QA evaluated on an earlier version of upstream artifacts — recheck required",
      };
    }
    const status = chapter.qa ?? (scoreVal >= 85 ? "pass" : scoreVal >= 70 ? "warn" : "fail");
    return {
      status,
      label: `QA ${scoreVal}`,
      title: `Quality score: ${scoreVal}`,
    };
  }

  if (chapter.qa) {
    if (chapter.qaStale) {
      return {
        status: "warn",
        label: "QA · stale",
        title: "QA evaluated on an earlier version of upstream artifacts — recheck required",
      };
    }
    return {
      status: chapter.qa,
      label: `QA ${chapter.qa}`,
      title: `QA status: ${chapter.qa}`,
    };
  }

  if (chapter.qaStage === "failed") {
    return {
      status: "fail",
      label: "QA failed",
      title: "QA execution failed",
    };
  }

  if (chapter.qaStage === "complete") {
    return {
      status: "fail",
      label: "QA missing",
      title: "QA stage marked complete but QA result artifact is missing",
    };
  }

  return {
    status: "pending",
    label: "Not evaluated",
    title: "QA has not been run for this chapter",
    empty: true,
  };
}

export function getStageActionDetails({
  tab,
  data,
  working,
  activeJob,
  chapter,
}: {
  tab: string;
  data: ChapterDetail;
  working: string;
  activeJob?: Job;
  chapter: number;
}): {
  stage: StageName;
  label: string;
  statusClass: "pass" | "warn" | "fail" | "pending";
  statusText: string;
  buttonText: string;
  actionLabel: string;
  disabled: boolean;
  isRunning: boolean;
} | undefined {
  const stageEntry = EXECUTABLE_CHAPTER_STAGES[tab];
  if (!stageEntry) return undefined;
  const { stage, label } = stageEntry;

  const jobIsRunning = Boolean(
    activeJob &&
    !isTerminalJob(activeJob) &&
    (activeJob.progress?.chapter === chapter || (!activeJob.progress?.chapter && activeJob.status === "running")) &&
    (activeJob.progress?.stage === stage || activeJob.progress?.event?.stage === stage || activeJob.type === "stageExecution" || activeJob.type === "batch")
  );
  const isRunning = working === stage || jobIsRunning;

  if (isRunning) {
    return {
      stage,
      label,
      statusClass: "pass",
      statusText: "Running",
      buttonText: `Processing…`,
      actionLabel: `Processing ${label}`,
      disabled: true,
      isRunning: true,
    };
  }

  const stageMeta = data.metadata?.stages?.[stage];
  if (stageMeta?.status === "failed") {
    return {
      stage,
      label,
      statusClass: "fail",
      statusText: "Failed",
      buttonText: `Retry ${label}`,
      actionLabel: `Retry ${label}`,
      disabled: false,
      isRunning: false,
    };
  }

  let exists = false;
  let isStale = false;
  switch (stage) {
    case "translation":
      exists = Boolean(data.translation);
      isStale = Boolean(data.stale || data.metadata?.stages?.translation?.staleReason);
      break;
    case "narration":
      exists = Boolean(data.narration);
      isStale = Boolean(data.stale || data.metadata?.stages?.narration?.staleReason);
      break;
    case "storyBible":
      exists = Boolean(data.storyContext);
      isStale = Boolean(data.storyContextStale);
      break;
    case "audioMastering":
      exists = Boolean(data.audioAvailable || data.audioUrl);
      isStale = Boolean(data.audioStale);
      break;
    case "subtitles":
      exists = Boolean(data.subtitles || data.subtitleDocument);
      isStale = Boolean(data.subtitlesStale);
      break;
    case "scenePlanning":
      exists = Boolean(data.metadata?.stages?.scenePlanning?.status === "complete");
      isStale = Boolean(data.metadata?.stages?.scenePlanning?.staleReason);
      break;
    case "artwork":
      exists = Boolean(data.metadata?.stages?.artwork?.status === "complete");
      isStale = Boolean(data.metadata?.stages?.artwork?.staleReason);
      break;
    case "video":
      exists = Boolean(data.videoUrl);
      isStale = Boolean(data.videoStale);
      break;
  }

  if (exists) {
    if (isStale) {
      return {
        stage,
        label,
        statusClass: "warn",
        statusText: "Stale",
        buttonText: stage === "storyBible" ? "Update Story Bible" : `Regenerate ${label}`,
        actionLabel: stage === "storyBible" ? "Update Story Bible" : `Regenerate ${label}`,
        disabled: false,
        isRunning: false,
      };
    }
    return {
      stage,
      label,
      statusClass: "pass",
      statusText: "Current",
      buttonText: stage === "storyBible" ? "Update Story Bible" : `Regenerate ${label}`,
      actionLabel: stage === "storyBible" ? "Update Story Bible" : `Regenerate ${label}`,
      disabled: false,
      isRunning: false,
    };
  }

  return {
    stage,
    label,
    statusClass: "pending",
    statusText: "Not generated",
    buttonText: stage === "translation" ? "Run Translation" : stage === "storyBible" ? "Update Story Bible" : `Generate ${label}`,
    actionLabel: stage === "translation" ? "Run Translation" : stage === "storyBible" ? "Update Story Bible" : `Generate ${label}`,
    disabled: false,
    isRunning: false,
  };
}

export function ChapterPage({
  slug,
  chapter,
  navigate,
  onJob,
  activeJob,
  initialData,
  initialTab: propInitialTab,
  initialQaDetail,
}: {
  slug: string;
  chapter: number;
  navigate: (path: string) => void;
  onJob: (job: Job) => void;
  activeJob?: Job;
  initialData?: ChapterDetail;
  initialTab?: string;
  initialQaDetail?: ChapterQaDetail;
}) {
  const chapterTabs = ["compare", "original", "translation", "narration", "quality", "context", "audio", "subtitles", "scenes", "artwork", "video"] as const;
  const initialTab = () => {
    if (propInitialTab && chapterTabs.includes(propInitialTab as typeof chapterTabs[number])) return propInitialTab;
    const selected = new URLSearchParams(typeof location !== "undefined" ? location.search : "").get("tab");
    return chapterTabs.includes(selected as typeof chapterTabs[number]) ? selected! : "compare";
  };
  const [data, setData] = useState<ChapterDetail | undefined>(initialData);
  const [error, setError] = useState("");
  const [tab, setTab] = useState(initialTab);
  const [draft, setDraft] = useState("");
  const [compareDrafts, setCompareDrafts] = useState({ translation: "", narration: "" });
  const [saved, setSaved] = useState("");
  const [cues, setCues] = useState<any[]>([]);
  const [working, setWorking] = useState("");
  const [markCurrentOpen, setMarkCurrentOpen] = useState(false);
  const watcher = useRef<(() => void) | undefined>(undefined);

  const load = () => api<ChapterDetail>(`/stories/${slug}/chapters/${chapter}`).then(setData);

  useEffect(() => {
    if (initialData) {
      setData(initialData);
      return;
    }
    setData(undefined);
    setError("");
    void load().catch((value) => setError(message(value)));
    return () => watcher.current?.();
  }, [slug, chapter]);

  useEffect(() => {
    if (tab === "translation" || tab === "narration") setDraft(data?.[tab] ?? "");
  }, [tab, data]);

  useEffect(() => {
    setCompareDrafts({ translation: data?.translation ?? "", narration: data?.narration ?? "" });
  }, [data?.translation, data?.narration]);

  useEffect(() => {
    setCues(data?.subtitleDocument?.cues?.map((cue: any) => ({ ...cue })) ?? []);
  }, [data?.subtitleDocument]);

  const saveText = async (field: "translation" | "narration", text: string) => {
    try {
      setError("");
      setWorking(field);
      const result = await put<any>(`/stories/${slug}/chapters/${chapter}/text`, { field, text });
      setSaved(`${pretty(field)} saved. Regenerate: ${result.invalidated.map(pretty).join(", ")}.`);
      await load();
    } catch (value) {
      setError(message(value));
    } finally {
      setWorking("");
    }
  };

  const runStage = async (stage: StageName) => {
    if (working) return;
    try {
      setError("");
      setWorking(stage);
      const next = await post<Job>(`/stories/${slug}/stages/run`, {
        chapters: [chapter],
        stage,
        mode: "selected",
        executionPolicy: "chapter-stage",
      });
      onJob(next);
      watcher.current?.();
      watcher.current = watchJob(
        next.id,
        async (job) => {
          onJob(job);
          if (isTerminalJob(job)) {
            setWorking("");
            if (job.status === "failed") setError(job.error ?? `${pretty(stage)} failed`);
            await load();
          }
        },
        (value) => {
          setWorking("");
          setError(message(value));
        }
      );
    } catch (value) {
      setWorking("");
      setError(message(value));
    }
  };

  const runSubtitleJob = async (kind: "alignment" | "subtitles", forceEstimated = false) => {
    try {
      setError("");
      setSaved("");
      setWorking(kind);
      const body = kind === "alignment" ? { chapter, force: true, forceEstimated } : { from: chapter, to: chapter, force: true, forceEstimated };
      const next = await post<Job>(`/stories/${slug}/jobs/${kind}`, body);
      onJob(next);
      watcher.current?.();
      watcher.current = watchJob(
        next.id,
        async (job) => {
          onJob(job);
          if (job.status === "completed") {
            setWorking("");
            await load();
          } else if (job.status === "failed") {
            setWorking("");
            setError(job.error ?? `${pretty(kind)} failed`);
          }
        },
        (value) => {
          setWorking("");
          setError(message(value));
        }
      );
    } catch (value) {
      setWorking("");
      setError(message(value));
    }
  };

  const saveCues = async () => {
    try {
      setError("");
      setWorking("save");
      await put(`/stories/${slug}/chapters/${chapter}/subtitles`, {
        cues: cues.map((cue, index) => ({
          ...cue,
          index: index + 1,
          startSeconds: Number(cue.startSeconds),
          endSeconds: Number(cue.endSeconds),
        })),
      });
      setSaved("Manual subtitle timing saved and protected from regeneration.");
      await load();
    } catch (value) {
      setError(message(value));
    } finally {
      setWorking("");
    }
  };

  const resetCues = async () => {
    if (!confirm("Discard protected manual subtitle edits and regenerate from the current alignment?")) return;
    try {
      setError("");
      setWorking("reset");
      await post(`/stories/${slug}/chapters/${chapter}/subtitles/reset`, {});
      setSaved("Manual edits discarded and subtitles regenerated.");
      await load();
    } catch (value) {
      setError(message(value));
    } finally {
      setWorking("");
    }
  };

  const updateCue = (index: number, patch: Record<string, unknown>) =>
    setCues((current) => current.map((cue, cueIndex) => (cueIndex === index ? { ...cue, ...patch } : cue)));

  if (error) return <LoadFailure error={error} />;
  if (!data) return <Loading />;

  const selectTab = (name: string) => {
    setTab(name);
    setSaved("");
    if (typeof location !== "undefined") {
      const url = new URL(location.href);
      url.searchParams.set("tab", name);
      history.replaceState({}, "", url);
    }
  };

  const adjacentPath = (target: number) => `/stories/${slug}/chapters/${target}?tab=${encodeURIComponent(tab)}`;
  const stageAction = getStageActionDetails({ tab, data, working, activeJob, chapter });

  return (
    <section className="page reading-page">
      <div className="chapter-workspace-header sticky">
        <div className="chapter-workspace-main">
          <div className="chapter-workspace-title">
            <span className="eyebrow">Chapter {String(chapter).padStart(4, "0")}</span>
            <h2>{data.metadata?.originalTitle ?? "Chapter review"}</h2>
          </div>
          <div className="chapter-heading-actions">
            <button className="button" onClick={() => setMarkCurrentOpen(true)}>Mark stages current</button>
            <button
              className="chapter-step"
              disabled={!data.navigation?.previous}
              aria-label={data.navigation?.previous ? `Previous chapter ${data.navigation.previous.chapter}` : "Start of story"}
              onClick={() => data.navigation?.previous && navigate(adjacentPath(data.navigation.previous.chapter))}
            >
              <span aria-hidden="true">←</span>
              <span>
                <small>Previous</small>
                {data.navigation?.previous ? <b>Chapter {String(data.navigation.previous.chapter).padStart(4, "0")}</b> : <b>Start</b>}
              </span>
            </button>
            {data.qa && <Status status={data.qaStale ? "warn" : data.qa.status} label={`${data.qaStale ? "retained · " : ""}${Math.round(data.qa.score * 100)} quality score`} title={`Quality score: ${Math.round(data.qa.score * 100)}${data.qaStale ? " (stale)" : ""}`} />}
            <button
              className="chapter-step next"
              disabled={!data.navigation?.next}
              aria-label={data.navigation?.next ? `Next chapter ${data.navigation.next.chapter}` : "End of story"}
              onClick={() => data.navigation?.next && navigate(adjacentPath(data.navigation.next.chapter))}
            >
              <span>
                <small>Next</small>
                {data.navigation?.next ? <b>Chapter {String(data.navigation.next.chapter).padStart(4, "0")}</b> : <b>End</b>}
              </span>
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
        <div className="chapter-workspace-sub">
          <div className="tabs" role="tablist">
            {chapterTabs.map((name) => (
              <button
                key={name}
                role="tab"
                aria-selected={tab === name}
                className={tab === name ? "active" : ""}
                onClick={() => selectTab(name)}
              >
                {name}
              </button>
            ))}
          </div>
          {stageAction && (
            <div className="chapter-stage-action">
              <Status status={stageAction.statusClass} label={stageAction.statusText} />
              <button
                type="button"
                className={`button primary stage-action-button ${stageAction.isRunning ? "busy" : ""}`}
                disabled={stageAction.disabled || Boolean(working)}
                aria-busy={stageAction.isRunning}
                aria-label={`${stageAction.actionLabel} for Chapter ${chapter}`}
                onClick={() => void runStage(stageAction.stage)}
              >
                {stageAction.buttonText}
              </button>
            </div>
          )}
        </div>
      </div>
      {markCurrentOpen && <MarkCurrentDialog slug={slug} chapters={[chapter]} onClose={() => setMarkCurrentOpen(false)} onDone={() => { setMarkCurrentOpen(false); void load(); }} />}
      {data.stale && <ErrorBox text="This chapter's previous translation, narration, QA, and media were retained, but are marked stale because the import was classified as changed. Review them below or reprocess when you want to replace them." />}
      {data.metadata?.stages?.narration?.staleReason && <div className="naming-notice"><b>{data.metadata.stages.narration.manualReviewRequired ? "Manual narration preserved" : "AI narration is stale"}</b><br />{data.metadata.stages.narration.staleReason}. {data.metadata.stages.narration.manualReviewRequired ? "Review it and explicitly force narration regeneration only if you want to replace the manual edit." : "Start production to regenerate narration and its dependent outputs."}</div>}
      {tab === "compare" && <>
        <div className="compare-edit-notice"><b>Correct while you compare</b><span>Edits preserve the original source and mark only dependent artifacts stale.</span></div>
        <div className="manuscript-split three">
          <Manuscript title="Original" text={data.original} />
          <CompareTextEditor title="Translation" value={compareDrafts.translation} savedValue={data.translation} saving={working === "translation"} onChange={(translation) => setCompareDrafts((current) => ({ ...current, translation }))} onSave={() => void saveText("translation", compareDrafts.translation)} />
          <CompareTextEditor title="Narration" value={compareDrafts.narration} savedValue={data.narration} saving={working === "narration"} onChange={(narration) => setCompareDrafts((current) => ({ ...current, narration }))} onSave={() => void saveText("narration", compareDrafts.narration)} />
        </div>
        {saved && <p className="save-note">{saved}</p>}
      </>}
      {tab === "original" && <Manuscript title="Original source" text={data.original} />}
      {(tab === "translation" || tab === "narration") && <>
        {data.metadata?.stages?.[tab]?.staleReason && <ArtifactStatusNotice status="stale" reason={`This ${tab} is stale: ${data.metadata.stages[tab].staleReason}. It remains visible and editable, but downstream artifacts will not treat it as current until it is regenerated or marked current.`} />}
        <div className="text-workspace">
          <div className="edit-warning"><b>Manual edit</b><span>Saving marks downstream artifacts stale. Paid stages will not run until you start production.</span></div>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={`Edit ${tab}`} />
          {tab === "narration" && data.spokenText && data.spokenText !== data.narration && (
            <details className="spoken-text-preview">
              <summary>View spoken text</summary>
              <p>This provider-neutral TTS representation keeps your visible narration unchanged.</p>
              <pre>{data.spokenText}</pre>
              <VocalizationList transformations={data.speechTransformations} />
            </details>
          )}
          {saved && <p className="save-note">{saved}</p>}
          <button className="button primary" disabled={!draft.trim() || draft === data[tab] || Boolean(working)} onClick={() => void saveText(tab, draft)}>
            {working === tab ? "Saving…" : `Save ${tab}`}
          </button>
        </div>
      </>}
      {tab === "quality" && <>
        <QaDetail slug={slug} chapter={chapter} onJob={onJob} onEditManually={() => selectTab("compare")} onChanged={() => void load()} initialData={initialQaDetail} />
        {saved && <p className="save-note">{saved}</p>}
      </>}
      {tab === "context" && (data.storyContext ? <>
        {data.storyContextStale && <ArtifactStatusNotice status="stale" reason="This context was generated from older chapter inputs or settings. You can still review it, but downstream processing will not treat it as current until it is regenerated or marked current." />}
        <div className="context-inspector">
          <div>
            <span className="eyebrow">Bounded provider context</span>
            <p>This exact structured subset was selected for the chapter from names, aliases, recent history, locks, and relationships.</p>
          </div>
          <pre>{JSON.stringify(data.storyContext, null, 2)}</pre>
        </div>
      </> : <Empty title="No context snapshot yet" text="Process this chapter to create an inspectable bounded Story Bible context." />)}
      {tab === "audio" && <>
        {data.audioStale && <ArtifactStatusNotice status="stale" reason="This master was rendered from older inputs or settings. You can still listen to it, but it will not be treated as current until it is regenerated or marked current." />}
        {data.metadata?.stages?.tts?.usage && <p className="field-note">Fish requests: {data.metadata.stages.tts.usage.requests ?? "—"} · Chunks generated: {data.metadata.stages.tts.usage.chunks ?? "—"} · Automatic retries: {data.metadata.stages.tts.usage.quality?.retried ?? 0}{data.metadata.stages.tts.usage.quality ? ` · Quality: ${pretty(data.metadata.stages.tts.usage.quality.status)}` : " · Post-generation verification: not run"}</p>}
        <AudioDeck src={data.audioUrl} title={`Chapter ${chapter} master`} />
        <TtsQualityPanel slug={slug} chapter={chapter} onJob={onJob} onChanged={() => void load()} />
      </>}
      {tab === "subtitles" && <SubtitleWorkspace data={data} cues={cues} working={working} onCue={updateCue} onAlign={(estimated) => void runSubtitleJob("alignment", estimated)} onGenerate={(estimated) => void runSubtitleJob("subtitles", estimated)} onSave={() => void saveCues()} onReset={() => void resetCues()} />}
      {(tab === "scenes" || tab === "artwork") && <>
        {data.metadata?.stages?.[tab === "scenes" ? "scenePlanning" : "artwork"]?.staleReason && <ArtifactStatusNotice status="stale" reason={`The ${tab} stage is stale: ${data.metadata.stages[tab === "scenes" ? "scenePlanning" : "artwork"].staleReason}. Existing ${tab} artifacts remain available in the visual development workspace.`} />}
        <Empty title={`Open ${tab} workspace`} text={`Review and edit Chapter ${chapter} ${tab} in the visual development workspace.`} action={<button className="button primary" onClick={() => navigate(`/stories/${slug}/scenes`)}>Open {tab}</button>} />
      </>}
      {tab === "video" && (data.videoUrl ? <>
        {data.videoStale && <ArtifactStatusNotice status="stale" reason="This video was rendered from older inputs or settings. You can still watch it, but it will not be treated as current until it is re-rendered or marked current." />}
        <video className="chapter-video-player" controls preload="metadata" src={data.videoUrl}>
          <track kind="subtitles" src={data.subtitlesUrl} srcLang="en" label="English" />
        </video>
      </> : <Empty title="No chapter video yet" text="Render this chapter from the Video workspace." />)}
    </section>
  );
}

export function chunkPresetFor(value: number): "conservative" | "balanced" | "long" | "custom" {
  if (value === 1000) return "conservative";
  if (value === 1750) return "balanced";
  if (value === 3000) return "long";
  return "custom";
}

export const TTS_ISSUE_LABELS: Record<TtsQualityIssueType, string> = {
  unexpected_speech: "Speech not present in the narration",
  unexpected_vocalization: "Unexpected vocal sound",
  segment_start_mismatch: "Opening words do not match",
  missing_speech: "Narration missing from the audio",
  repetition: "Repeated phrase",
  truncated: "Audio cut off early",
  suspected_gibberish: "Suspected gibberish",
  abnormal_duration: "Abnormal pacing",
  unexpected_silence: "Unexpected silence",
  invalid_audio: "Unreadable audio",
  transcription_failed: "Segment could not be transcribed",
};

export function ttsIssueLabel(type: TtsQualityIssueType): string {
  return TTS_ISSUE_LABELS[type] ?? pretty(type);
}

export function ttsQualityBadgeView(quality: TtsQualityArtifact): { status: "pass" | "warn" | "fail" | "pending"; label: string } {
  const segments = quality.segments;
  const needsReview = segments.filter((segment) => segment.status === "needs_review").length;
  const accepted = segments.filter((segment) => segment.status === "manually_accepted").length;
  if (quality.status === "verified") return { status: "pass", label: "TTS Quality: Passed" };
  if (quality.status === "needs_review") return { status: "warn", label: `TTS Quality: Needs review (${needsReview} segment${needsReview === 1 ? "" : "s"})` };
  if (quality.status === "unverified") return { status: "pending", label: "TTS Quality: Unverified" };
  if (accepted) return { status: "pending", label: `TTS Quality: Manually accepted (${accepted})` };
  return { status: "pending", label: "TTS Quality: Partially verified" };
}

export function TtsQualityBadge({ quality }: { quality: TtsQualityArtifact }) {
  const view = ttsQualityBadgeView(quality);
  return <Status status={view.status} label={view.label} />;
}

const TTS_SEGMENT_ICONS: Record<TtsSegmentQuality["status"], string> = { verified: "✓", needs_review: "⚠", unverified: "–", manually_accepted: "✓" };
const TTS_SEGMENT_LABELS: Record<TtsSegmentQuality["status"], string> = { verified: "Verified", needs_review: "Needs review", unverified: "Unverified", manually_accepted: "Accepted by reviewer" };

export function TtsSegmentRow({ slug, chapter, segment, busy, onRegenerate, onAccept }: { slug: string; chapter: number; segment: TtsSegmentQuality; busy: boolean; onRegenerate: () => void; onAccept: () => void }) {
  const number = segment.index + 1;
  const retries = Math.max(0, segment.attempts.length - 1);
  const summary = <><span className={`tts-segment-icon ${segment.status}`} aria-hidden="true">{TTS_SEGMENT_ICONS[segment.status]}</span><span className="tts-segment-title">Segment {number}{segment.score !== undefined && <> · {Math.round(segment.score * 100)}%</>}{retries > 0 && <> · Retried {retries}×</>} — {TTS_SEGMENT_LABELS[segment.status]}{segment.status === "manually_accepted" && segment.acceptedAt && <> · {new Date(segment.acceptedAt).toLocaleString()}</>}</span></>;
  const actions = <div className="tts-segment-actions">
    <audio controls preload="none" src={chapterTtsSegmentAudioUrl(slug, chapter, number)} aria-label={`Play segment ${number}`} />
    {segment.status !== "verified" && segment.status !== "manually_accepted" && <>
      <button type="button" className="button" disabled={busy} onClick={onRegenerate}>{busy ? "Working…" : "Regenerate segment"}</button>
      <button type="button" className="button" disabled={busy} onClick={onAccept}>Accept anyway</button>
    </>}
  </div>;
  if (segment.status === "verified") return <div className="tts-segment-row">{summary}</div>;
  return <details className="tts-segment-row">
    <summary>{summary}</summary>
    <div className="tts-segment-detail">
      <div><span className="eyebrow">Expected narration</span><p>{segment.expectedText}</p></div>
      <div><span className="eyebrow">Transcription</span><p>{segment.transcription ?? "Not transcribed"}</p></div>
      {segment.issues.length > 0 && <div><span className="eyebrow">Issues</span><ul className="tts-issue-list">{segment.issues.map((issue, index) => <li key={`${issue.type}-${index}`}>{ttsIssueLabel(issue.type)}{issue.detail ? ` — ${issue.detail}` : ""}</li>)}</ul></div>}
      {segment.attempts.length > 0 && <div><span className="eyebrow">Attempts</span><ul className="tts-attempt-list">{segment.attempts.map((attempt) => <li key={attempt.attempt}>Attempt {attempt.attempt} · {attempt.settings.deliveryIntensity} delivery{attempt.score !== undefined && <> · {Math.round(attempt.score * 100)}%</>} · {pretty(attempt.status)}</li>)}</ul></div>}
      {segment.status === "manually_accepted" && <p className="field-note">Accepted by a reviewer{segment.acceptedReason ? `: ${segment.acceptedReason}` : ""}. Manual acceptance is not an objective pass.</p>}
      {actions}
    </div>
  </details>;
}

export function TtsQualityPanel({ slug, chapter, onJob, onChanged, initialQuality }: { slug: string; chapter: number; onJob: (job: Job) => void; onChanged?: () => void; initialQuality?: TtsQualityArtifact | null }) {
  const [quality, setQuality] = useState<TtsQualityArtifact | null | undefined>(initialQuality);
  const [error, setError] = useState("");
  const [working, setWorking] = useState("");
  const watcher = useRef<(() => void) | undefined>(undefined);
  const load = async () => { const value = await getChapterTtsQuality(slug, chapter); setQuality(value.quality); };
  useEffect(() => {
    if (initialQuality !== undefined) { setQuality(initialQuality); return; }
    let cancelled = false;
    setQuality(undefined);
    setError("");
    getChapterTtsQuality(slug, chapter).then((value) => { if (!cancelled) setQuality(value.quality); }).catch((value) => { if (!cancelled) setError(message(value)); });
    return () => { cancelled = true; watcher.current?.(); };
  }, [slug, chapter]);
  const runJob = async (kind: "verify" | "regenerate", start: () => Promise<Job>) => {
    if (working) return;
    try {
      setError("");
      setWorking(kind);
      const job = await start();
      onJob(job);
      watcher.current?.();
      watcher.current = watchJob(job.id, async (next) => {
        onJob(next);
        if (isTerminalJob(next)) {
          setWorking("");
          if (next.status === "failed") setError(next.error ?? "TTS quality job failed");
          await load().catch((value) => setError(message(value)));
          onChanged?.();
        }
      }, (value) => { setWorking(""); setError(message(value)); });
    } catch (value) {
      setWorking("");
      setError(message(value));
    }
  };
  const accept = async (segment: TtsSegmentQuality) => {
    if (working) return;
    if (!confirm(`Accept segment ${segment.index + 1} as-is? This records a manual acceptance — it is not an objective pass.`)) return;
    const reason = prompt("Optional note for the review record", "") ?? undefined;
    try {
      setError("");
      setWorking("accept");
      const result = await acceptChapterTtsSegment(slug, chapter, segment.index + 1, reason?.trim() || undefined);
      setQuality(result.quality);
      onChanged?.();
    } catch (value) {
      setError(message(value));
    } finally {
      setWorking("");
    }
  };
  if (quality === undefined) return error ? <ErrorBox text={error} /> : null;
  if (quality === null) return <p className="tts-quality-empty">No segment verification record is available for this chapter. Regenerate TTS to enable verification of saved audio.</p>;
  const busy = Boolean(working);
  return <section className="tts-quality-panel" aria-label="TTS quality">
    <div className="tts-quality-summary">
      <TtsQualityBadge quality={quality} />
      <span className="tts-quality-meta">{quality.provider} · {quality.model} · {quality.segments.length} segment{quality.segments.length === 1 ? "" : "s"}</span>
      <button type="button" className="button" disabled={busy} title="Checks the existing audio against the expected narration without regenerating anything." onClick={() => void runJob("verify", () => verifyChapterTtsQuality(slug, chapter))}>{working === "verify" ? "Verifying…" : quality.status === "unverified" ? "Verify Audio" : "Re-verify"}</button>
    </div>
    {error && <ErrorBox text={error} />}
    <details className="tts-segment-list">
      <summary>Segments ({quality.segments.length})</summary>
      {quality.segments.map((segment) => <TtsSegmentRow key={segment.index} slug={slug} chapter={chapter} segment={segment} busy={busy} onRegenerate={() => void runJob("regenerate", () => regenerateChapterTtsSegment(slug, chapter, segment.index + 1))} onAccept={() => void accept(segment)} />)}
    </details>
  </section>;
}

function SubtitleWorkspace({ data, cues, working, onCue, onAlign, onGenerate, onSave, onReset }: { data: any; cues: any[]; working: string; onCue: (index: number, patch: Record<string, unknown>) => void; onAlign: (estimated: boolean) => void; onGenerate: (estimated: boolean) => void; onSave: () => void; onReset: () => void }) {
  const alignment = data.alignment; const metrics = alignment?.metrics; const document = data.subtitleDocument; const dirty = Boolean(document) && JSON.stringify(cues) !== JSON.stringify(document.cues);
  return <div className="subtitle-workspace">{data.alignmentStale && <ArtifactStatusNotice status="stale" reason="This alignment was produced from older audio or text. The retained metrics below remain reviewable; regenerate alignment to make it current." />}<div className="alignment-panel"><div><span className="eyebrow">Timing source</span><h3>{alignment ? `${pretty(alignment.mode)} · ${alignment.engine}` : "Not aligned"}</h3><p>{alignment?.warning ?? (alignment ? "Narration timing is ready." : "Run alignment after mastering audio, or create deterministic estimated timing.")}</p></div><div className="alignment-metrics"><span><b>{metrics ? `${metrics.matchedWordPercentage.toFixed(1)}%` : "—"}</b>words matched</span><span><b>{metrics?.averageConfidence === undefined ? "—" : `${Math.round(metrics.averageConfidence * 100)}%`}</b>confidence</span><span><b>{metrics ? formatDuration(metrics.audioDurationSeconds) : "—"}</b>audio</span><span><b>{document?.cues.length ?? 0}</b>cues</span></div><div className="subtitle-actions"><button className="button primary" disabled={Boolean(working) || !data.audioUrl} onClick={() => onAlign(false)}>{working === "alignment" ? "Aligning…" : "Regenerate alignment"}</button><button className="button" disabled={Boolean(working) || !data.audioUrl} onClick={() => onGenerate(false)}>Regenerate subtitles</button><button className="button" disabled={Boolean(working) || !data.audioUrl} onClick={() => onGenerate(true)}>Use estimated timing</button></div></div>
    {data.subtitlesStale && <ArtifactStatusNotice status="stale" reason="These subtitles were generated from an older alignment or narration. You can still review and edit them; regenerate subtitles to make them current." />}{document ? <><div className="subtitle-editor-head"><div><h3>Subtitle timeline</h3><p>{document.manual ? "Protected manual revision" : `${pretty(document.timingMode)} timing · edit any cue to create a protected revision`}</p></div><div><button className="button" disabled={!document.manual || Boolean(working)} onClick={onReset}>Reset manual edits</button><button className="button primary" disabled={!dirty || Boolean(working)} onClick={onSave}>{working === "save" ? "Saving…" : "Save timing edits"}</button></div></div><div className="subtitle-cue-table"><div className="subtitle-cue-row header"><span>#</span><span>Start</span><span>End</span><span>Caption</span></div>{cues.map((cue, index) => <div className="subtitle-cue-row" key={index}><span className="mono">{index + 1}</span><input aria-label={`Cue ${index + 1} start`} type="number" min="0" step="0.01" value={cue.startSeconds} onChange={(event) => onCue(index, { startSeconds: event.target.value })} /><input aria-label={`Cue ${index + 1} end`} type="number" min="0" step="0.01" value={cue.endSeconds} onChange={(event) => onCue(index, { endSeconds: event.target.value })} /><textarea aria-label={`Cue ${index + 1} text`} value={cue.text} onChange={(event) => onCue(index, { text: event.target.value })} /></div>)}</div></> : <Empty title="No subtitles yet" text="Master the chapter, then run alignment and subtitle generation. Estimated timing remains available when the local aligner is not configured." />}
  </div>;
}

export function ResetQaDialog({ slug, chapterCount, onClose, onDone }: { slug: string; chapterCount: number; onClose: () => void; onDone: (summary: string) => void }) {
  const [scope, setScope] = useState<"range" | "all">("all");
  const [fromChapter, setFromChapter] = useState("1");
  const [toChapter, setToChapter] = useState("1");
  const [chapterNumbers, setChapterNumbers] = useState<number[]>();
  const [chapterNumbersLoading, setChapterNumbersLoading] = useState(false);
  const [chapterNumbersError, setChapterNumbersError] = useState("");
  const [typedConfirmation, setTypedConfirmation] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [batchResult, setBatchResult] = useState<{ requested: number; reset: number; alreadyClean: number; failed: number; failures: Array<{ chapter: number; reason: string }> } | undefined>();

  const from = Number(fromChapter); const to = Number(toChapter);
  const rangeValid = Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 1 && to >= from;
  const affectedChapterNumbers = chapterNumbers?.filter((chapter) => chapter >= from && chapter <= to);
  const rangeMatches = Boolean(affectedChapterNumbers?.length);
  const rangeError = !rangeValid
    ? "Starting chapter must be less than or equal to ending chapter."
    : chapterNumbersError
      ? "Could not verify the chapters in this range. Retry by reopening the reset dialog."
      : chapterNumbers !== undefined && !rangeMatches
        ? "No chapters fall within this range."
        : "";
  const affectedChapterCount = scope === "all" ? chapterCount : affectedChapterNumbers?.length;
  const canSubmit = !working && typedConfirmation.trim() === "RESET QA" && (scope === "all" ? chapterCount > 0 : chapterNumbers !== undefined && !chapterNumbersError && !rangeError);

  useEffect(() => {
    if (scope !== "range") return;
    let active = true;
    setChapterNumbers(undefined);
    setChapterNumbersError("");
    setChapterNumbersLoading(true);
    const loadChapterNumbers = async () => {
      try {
        const numbers: number[] = [];
        let page = 1;
        let pages = 1;
        do {
          const result = await api<{ items: Array<{ chapter: number }>; pages: number }>(`/stories/${slug}/chapters?page=${page}&pageSize=100&filter=all`);
          numbers.push(...result.items.map((item) => item.chapter));
          pages = result.pages;
          page++;
        } while (active && page <= pages);
        if (active) setChapterNumbers(numbers);
      } catch (value) {
        if (active) setChapterNumbersError(message(value));
      } finally {
        if (active) setChapterNumbersLoading(false);
      }
    };
    void loadChapterNumbers();
    return () => { active = false; };
  }, [scope, slug]);

  const submit = async () => {
    try {
      setWorking(true);
      setError("");
      setBatchResult(undefined);
      {
        const body = scope === "all" ? { type: "book" } : { type: "range", fromChapter: from, toChapter: to };
        const res = await post<{ requested: number; reset: number; alreadyClean: number; skipped: number; failed: number; failures: Array<{ chapter: number; reason: string }> }>(`/stories/${slug}/qa/reset`, body);
        if (res.failed > 0) {
          setBatchResult(res);
          setWorking(false);
          return;
        }
        let summary = "";
        if (res.reset === 0) {
          summary = `QA was already clean for all ${res.requested} chapters. Other stages were not changed.`;
        } else if (res.alreadyClean > 0) {
          summary = `QA reset complete. ${res.reset} chapters reset; ${res.alreadyClean} already had no QA data. Other stages were not changed.`;
        } else {
          summary = `QA data reset for ${res.reset} chapter${res.reset === 1 ? "" : "s"}. Other stages were not changed.`;
        }
        onDone(summary);
      }
    } catch (err) {
      setWorking(false);
      setError(message(err));
    }
  };

  return (
    <div className="stage-modal-backdrop" role="presentation">
      <section className="stage-modal" role="dialog" aria-modal="true" aria-labelledby="reset-qa-title">
        <header>
          <div>
            <span className="eyebrow">Maintenance</span>
            <h3 id="reset-qa-title">Reset QA Data</h3>
          </div>
          <button className="button" onClick={onClose} disabled={working}>Close</button>
        </header>
        <p>
          Permanently remove QA findings, scores, resolutions, verification history, and QA run state for the selected chapters.
          Translation, narration, Story Bible, pronunciation settings, audio, scenes, artwork, video, and all other stages will remain unchanged.
          The next QA run will evaluate these chapters from a clean QA state.
        </p>
        {error && <ErrorBox text={error} />}
        {chapterNumbersError && <ErrorBox text={`Unable to check the chapter range: ${message(chapterNumbersError)}`} />}
        {batchResult && (
          <div className="naming-notice" style={{ borderLeft: "4px solid var(--color-danger, #d32f2f)", marginBottom: "16px" }}>
            <b>QA reset completed with {batchResult.failed} problem{batchResult.failed === 1 ? "" : "s"}</b>
            <p style={{ margin: "4px 0" }}>
              {batchResult.reset} chapter{batchResult.reset === 1 ? "" : "s"} reset · {batchResult.alreadyClean} already had no QA data · {batchResult.failed} failed
            </p>
            <details style={{ marginTop: "8px" }}>
              <summary style={{ cursor: "pointer" }}>Show {batchResult.failed} failure{batchResult.failed === 1 ? "" : "s"}</summary>
              <ul style={{ maxHeight: "160px", overflowY: "auto", margin: "8px 0 0", paddingLeft: "20px" }}>
                {batchResult.failures.map((f) => (
                  <li key={f.chapter}>Chapter {f.chapter} — {f.reason}</li>
                ))}
              </ul>
            </details>
          </div>
        )}
        <div className="stage-choices">
          <label>
            <input type="radio" name="scope" checked={scope === "all"} onChange={() => setScope("all")} />
            <span>
              <b>Entire book</b>
              <small>{chapterCount} chapters in project</small>
            </span>
          </label>
          <label>
            <input type="radio" name="scope" checked={scope === "range"} onChange={() => setScope("range")} />
            <span>
              <b>Chapter range</b>
              <small>Specify a starting and ending chapter number</small>
            </span>
          </label>
        </div>

        {scope === "range" && (
          <div style={{ display: "flex", gap: "12px", marginBottom: "16px" }}>
            <label className="field" style={{ flex: 1 }}>
              <span>From chapter</span>
              <input type="number" min={1} value={fromChapter} onChange={(e) => setFromChapter(e.target.value)} />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>To chapter</span>
              <input type="number" min={1} value={toChapter} onChange={(e) => setToChapter(e.target.value)} />
            </label>
          </div>
        )}

        <div className="naming-notice" style={{ marginTop: "12px", marginBottom: "12px" }}>
            <p>
              This will permanently delete QA data for <b>{affectedChapterCount === undefined ? "checking" : `${affectedChapterCount} existing chapter${affectedChapterCount === 1 ? "" : "s"}`}</b>{scope === "range" && rangeValid ? <>: Chapters {from}–{to}</> : ""}. Other production data will not be changed.
            </p>
            {scope === "range" && chapterNumbersLoading && <p>Checking which chapters exist in this range…</p>}
            {rangeError && <p className="error-text">{rangeError}</p>}
            <label className="field" style={{ marginTop: "8px" }}>
              <span>Type <code>RESET QA</code> to continue:</span>
              <input
                value={typedConfirmation}
                placeholder="RESET QA"
                onChange={(e) => setTypedConfirmation(e.target.value)}
                disabled={working}
              />
            </label>
        </div>

        <footer>
          <small>
            Affected chapters: {affectedChapterCount === undefined ? "checking…" : affectedChapterCount}
          </small>
          <button
            className="button primary"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {working ? "Resetting QA…" : "Reset QA Data"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function ResetChapterQaDialog({ slug, chapter, onClose, onDone }: { slug: string; chapter: number; onClose: () => void; onDone: (result: unknown) => void | Promise<void> }) {
  const [working, setWorking] = useState(false); const [error, setError] = useState("");
  const submit = async () => { try { setWorking(true); setError(""); const result = await post(`/stories/${slug}/chapters/${chapter}/qa/reset`, { scope: { type: "chapter", chapterNumber: chapter } }); await onDone(result); } catch (value) { setWorking(false); setError(message(value)); } };
  return <div className="stage-modal-backdrop" role="presentation"><section className="stage-modal" role="dialog" aria-modal="true" aria-labelledby="reset-chapter-qa-title"><header><div><span className="eyebrow">Maintenance</span><h3 id="reset-chapter-qa-title">Reset Chapter QA</h3></div><button className="button" disabled={working} onClick={onClose}>Cancel</button></header><p>Permanently remove all QA data for <b>Chapter {chapter}</b>: its score, findings, resolutions, verification history, and QA run state.</p><p>Translation, narration, Story Bible, pronunciation, audio, scenes, artwork, video, and other production data remain unchanged. The next QA run starts from a clean QA state.</p>{error && <ErrorBox text={error} />}<footer><small>This action affects Chapter {chapter} only.</small><button className="button primary" disabled={working} onClick={() => void submit()}>{working ? "Resetting QA…" : "Reset Chapter QA"}</button></footer></section></div>;
}

type QaListRow = { chapter: number; title?: string; status: "pass" | "warn" | "fail"; score?: number; issues: Array<{ severity: string; message: string }>; stale: boolean; needsVerification: number };
type QaPageResult = { items: QaListRow[]; page: number; pageSize: number; pages: number; total: number };
type QaSummaryResult = { counts: { pass: number; warn: number; fail: number; needsVerification: number; totalEvaluated: number; chapterCount: number; minChapter?: number; maxChapter?: number }; categories: Record<string, number> };
export function QaPage({ slug, navigate }: { slug: string; navigate: (path: string) => void }) {
  const [summary, setSummary] = useState<QaSummaryResult>(); const [summaryError, setSummaryError] = useState("");
  const [data, setData] = useState<QaPageResult>(); const [listError, setListError] = useState("");
  const [status, setStatus] = useState("all"); const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(50);
  const [revision, setRevision] = useState(0); const listRequest = useRef(0); const summaryRequest = useRef(0);
  const [resetModalOpen, setResetModalOpen] = useState(false); const [banner, setBanner] = useState("");
  useEffect(() => { const request = ++summaryRequest.current; setSummaryError(""); api<QaSummaryResult>(`/stories/${slug}/qa/summary`).then((value) => { if (request === summaryRequest.current) setSummary(value); }).catch((value) => { if (request === summaryRequest.current) setSummaryError(message(value)); }); return () => { summaryRequest.current++; }; }, [slug, revision]);
  useEffect(() => { const request = ++listRequest.current; setListError(""); api<QaPageResult>(`/stories/${slug}/qa?page=${page}&pageSize=${pageSize}&status=${status}`).then((value) => { if (request === listRequest.current) setData(value); }).catch((value) => { if (request === listRequest.current) setListError(message(value)); }); return () => { listRequest.current++; }; }, [slug, page, pageSize, status, revision]);
  const chooseStatus = (next: string) => { listRequest.current++; setStatus(next); setPage(1); };
  return <section className="page">
    <div className="section-heading"><div><h2>Quality review</h2><p>Every concern is linked back to its chapter and evidence.</p></div><div className="section-heading-actions"><button className="button" onClick={() => setResetModalOpen(true)}>Reset QA data</button></div></div>
    {banner && <div className="naming-notice" style={{ marginBottom: "16px" }}>{banner}</div>}
    {resetModalOpen && <ResetQaDialog slug={slug} chapterCount={summary?.counts.chapterCount ?? 0} onClose={() => setResetModalOpen(false)} onDone={(msg) => { setResetModalOpen(false); setBanner(msg); setRevision((value) => value + 1); }} />}
    {summaryError && <ErrorBox text={summaryError} />}
    {summary && <><div className="qa-summary">{(["pass", "warn", "fail"] as const).map((key) => <button onClick={() => chooseStatus(key)} className={`qa-count ${key}`} key={key}><span>{key}</span><b>{summary.counts[key]}</b><i /></button>)}</div>
    {summary.counts.needsVerification > 0 && <p className="qa-unverified-label"><button className="button small" onClick={() => chooseStatus("needs-verification")}>{summary.counts.needsVerification} previous findings need verification</button></p>}
    <div className="category-strip">{Object.entries(summary.categories).map(([key, value]) => <span key={key}>{pretty(key)} <b>{String(value)}</b></span>)}</div></>}
    <QaExceptionsPanel slug={slug} />
    <div className="table-tools"><div className="segmented">{["all", "pass", "warn", "fail", "needs-verification"].map((value) => <button key={value} className={status === value ? "active" : ""} onClick={() => chooseStatus(value)}>{pretty(value)}</button>)}</div><label className="chapter-page-size"><span>Rows per page</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label></div>
    {listError && <ErrorBox text={listError} />}
    {data && data.pages > 1 && <Pagination position="top" page={data.page} pages={data.pages} total={data.total} itemLabel="chapters" onPrevious={() => setPage(data.page - 1)} onNext={() => setPage(data.page + 1)} />}
    <div className="review-list">{data?.items.map((item) => { const warnings = item.issues.filter((issue) => issue.severity === "warn").length; const failures = item.issues.filter((issue) => issue.severity === "fail").length; return <button key={item.chapter} onClick={() => navigate(`/stories/${slug}/chapters/${item.chapter}?tab=quality`)}><div><span className="mono">CH {String(item.chapter).padStart(4, "0")}</span><h3>{item.title ?? `Chapter ${item.chapter}`}</h3><p>{item.stale ? (item.needsVerification ? `QA needs recheck — ${item.needsVerification} previous finding${item.needsVerification === 1 ? "" : "s"} need verification.` : "QA needs recheck — the chapter or its QA dependencies changed since this review.") : item.issues[0]?.message ?? "No issues detected."}</p></div><div className="qa-row-status">{item.stale ? <Status status="warn" label="needs verification" /> : <>{warnings > 0 && <Status status="warn" label={`${warnings} warning${warnings === 1 ? "" : "s"}`} />}{failures > 0 && <Status status="fail" label={`${failures} failure${failures === 1 ? "" : "s"}`} />}</>}<Status status={item.status} label={`${Math.round((item.score ?? 0) * 100)} score`} /></div></button>; })}</div>
    {data && data.pages > 1 && <Pagination position="bottom" page={data.page} pages={data.pages} total={data.total} itemLabel="chapters" onPrevious={() => setPage(data.page - 1)} onNext={() => setPage(data.page + 1)} />}
    {!data && !listError && <Loading />}
  </section>;
}

const QA_EXCEPTION_CATEGORIES = ["completeness", "names", "numbers", "terminology", "dialogue", "storyConsistency", "narrationFidelity"] as const;

function QaExceptionsPanel({ slug }: { slug: string }) {
  const [exceptions, setExceptions] = useState<QaException[]>(); const [error, setError] = useState(""); const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ category: string; matchKind: QaExceptionMatchKind; value: string; reason: string }>({ category: "terminology", matchKind: "terminology", value: "", reason: "" });
  const [working, setWorking] = useState(false);
  const load = async () => { const next = await api<{ exceptions: QaException[] }>(`/stories/${slug}/qa-exceptions`); setExceptions(next.exceptions); };
  useEffect(() => { void load().catch((value) => setError(message(value))); }, [slug]);
  const add = async () => { try { setWorking(true); setError(""); await post(`/stories/${slug}/qa-exceptions`, { category: draft.category, matchKind: draft.matchKind, value: draft.value.trim(), reason: draft.reason.trim() || undefined }); setDraft({ ...draft, value: "", reason: "" }); await load(); } catch (value) { setError(message(value)); } finally { setWorking(false); } };
  const remove = async (id: string) => { try { setWorking(true); setError(""); await del(`/stories/${slug}/qa-exceptions/${id}`); await load(); } catch (value) { setError(message(value)); } finally { setWorking(false); } };
  return <section className="qa-exceptions"><button className="qa-resolved-toggle" onClick={() => setOpen((value) => !value)}>{open ? "▾" : "▸"} QA exceptions{exceptions ? ` (${exceptions.length})` : ""}</button>
    {open && <div className="qa-exceptions-body"><p className="qa-exceptions-help">Dismissed findings remembered for this story. Matching findings are suppressed in future rechecks.</p>
      {error && <ErrorBox text={error} />}
      {exceptions?.length ? <div className="qa-exceptions-list">{exceptions.map((item) => <div className="qa-exception-row" key={item.id}><span className="qa-category">{pretty(item.category)}</span><span className="qa-exception-match mono">{pretty(item.matchKind)} · “{item.value}”</span><span className="qa-exception-reason">{item.reason ?? ""}</span><button className="button" disabled={working} onClick={() => void remove(item.id)}>Delete</button></div>)}</div> : <p className="qa-exceptions-help">No exceptions recorded yet.</p>}
      <div className="qa-exception-form"><Field label="Category"><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>{QA_EXCEPTION_CATEGORIES.map((value) => <option key={value} value={value}>{pretty(value)}</option>)}</select></Field><Field label="Match kind"><select value={draft.matchKind} onChange={(event) => setDraft({ ...draft, matchKind: event.target.value as QaExceptionMatchKind })}><option value="terminology">Terminology</option><option value="entity">Entity</option><option value="rule">Rule</option><option value="other">Other</option></select></Field><Field label="Value"><input value={draft.value} maxLength={300} placeholder="Text to ignore" onChange={(event) => setDraft({ ...draft, value: event.target.value })} /></Field><Field label="Reason (optional)"><input value={draft.reason} maxLength={1000} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} /></Field><button className="button" disabled={working || !draft.value.trim()} onClick={() => void add()}>Add exception</button></div>
    </div>}
  </section>;
}

function PreviewPage({ slug, onJob }: { slug: string; onJob: (job: Job) => void }) {
  const [story, setStory] = useState<StoryConfig>(); const [chapter, setChapter] = useState("1"); const [audio, setAudio] = useState(false); const [presets, setPresets] = useState<any>(); const [result, setResult] = useState<any>(); const [error, setError] = useState(""); const watcher = useRef<(() => void) | undefined>(undefined);
  useEffect(() => { setError(""); api<any>(`/stories/${slug}`).then(({ story }) => { setStory(story); const base = { translation: story.pipeline.translation, narration: story.pipeline.narration, qa: story.pipeline.qa, tts: story.pipeline.tts }; const other = story.pipeline.translation.provider === "gemini" ? "openai" : "gemini"; setPresets({ a: base, b: { ...base, translation: { provider: other, model: other === "openai" ? "gpt-5.6-terra" : "gemini-3.8-flash" } } }); }).catch((value) => setError(message(value))); return () => watcher.current?.(); }, [slug]);
  const run = async () => { try { setError(""); setResult(undefined); const job = await post<Job>(`/stories/${slug}/jobs/preview`, { chapter: Number(chapter), audioPreview: audio, presets }); onJob(job); watcher.current?.(); watcher.current = watchJob(job.id, async (next) => { onJob(next); if (next.status === "completed") setResult(await api(`/stories/${slug}/previews/${next.result.id}`)); else if (next.status === "failed") setError(next.error ?? "Preview failed"); }, (value) => setError(message(value))); } catch (e) { setError(message(e)); } };
  const choose = async (choice: "a" | "b") => { try { const response = await post<any>(`/stories/${slug}/profile`, { previewId: result.manifest.id, choice }); setStory(response.story); alert(`Option ${choice.toUpperCase()} is now the active story profile.`); } catch (e) { setError(message(e)); } };
  if (error && (!story || !presets)) return <LoadFailure error={error} />; if (!story || !presets) return <Loading />;
  return <section className="page"><div className="section-heading"><div><h2>Model audition</h2><p>One chapter, two production profiles. Canonical files stay untouched.</p><small className="active-profile">Active · {story.pipeline.translation.provider}/{story.pipeline.translation.model} translation · {story.pipeline.narration.provider}/{story.pipeline.narration.model} narration · {story.pipeline.qa.provider}/{story.pipeline.qa.model} QA</small></div><label className="toggle"><input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} /><span /> Short audio</label></div>
    <div className="preview-controls"><Field label="Chapter"><input value={chapter} onChange={(e) => setChapter(e.target.value)} /></Field><div className="preset-grid"><PresetEditor label="Option A · Current" value={presets.a} onChange={(value) => setPresets({ ...presets, a: value })} /><PresetEditor label="Option B · Challenger" value={presets.b} onChange={(value) => setPresets({ ...presets, b: value })} /></div><button className="button primary run-preview" onClick={run}>Run comparison</button></div>{error && <ErrorBox text={error} />}
    {result && <div className="comparison"><PreviewResult choice="a" result={result} onChoose={() => choose("a")} /><PreviewResult choice="b" result={result} onChoose={() => choose("b")} /></div>}
  </section>;
}

function LegacyBiblePage({ slug }: { slug: string }) { const [view, setView] = useState<any>(); const [error, setError] = useState(""); const [query, setQuery] = useState(""); const [category, setCategory] = useState("characters"); const [editing, setEditing] = useState<any>(); const sections = ["characters", "locations", "factions", "abilities", "classes", "ranks", "items", "creatures", "systemTerms", "relationships", "translationTerms"];
  const load = () => api<any>(`/stories/${slug}/story-bible`).then(setView); useEffect(() => { setView(undefined); setError(""); void load().catch((value) => setError(message(value))); }, [slug]);
  const beginAdd = () => setEditing({ category, value: newBibleValue(category) }); const save = async () => { try { setError(""); if (editing.id && !editing.id.startsWith("auto-")) await put(`/stories/${slug}/story-bible/${editing.id}`, { value: editing.value }); else await post(`/stories/${slug}/story-bible`, { category: editing.category, value: editing.value, replacementKey: editing.key }); setEditing(undefined); await load(); } catch (value) { setError(message(value)); } }; const remove = async (entry: any) => { if (!confirm(`Delete ${bibleEntryTitle(entry.value)}? This only changes the manual Bible overlay.`)) return; try { await del(`/stories/${slug}/story-bible/${entry.id}`); await load(); } catch (value) { setError(message(value)); } };
  if (error && !view) return <LoadFailure error={error} />; if (!view) return <Loading />; const entries = view.entries.filter((entry: any) => entry.category === category && JSON.stringify(entry.value).toLowerCase().includes(query.toLowerCase()));
  return <section className="page"><div className="section-heading"><div><h2>Story Bible</h2><p>Generated continuity with protected manual corrections.</p></div><div className="bible-tools"><input className="search" placeholder="Search entries" value={query} onChange={(e) => setQuery(e.target.value)} /><button className="button primary" onClick={beginAdd}>Add entry</button></div></div>{error && <ErrorBox text={error} />}<div className="bible-layout"><aside>{sections.map((section) => <button className={category === section ? "active" : ""} onClick={() => { setCategory(section); setEditing(undefined); }} key={section}>{pretty(section)} <b>{view.entries.filter((entry: any) => entry.category === section).length}</b></button>)}</aside><div className="bible-sections"><section><h3>{pretty(category)}</h3>{entries.length ? entries.map((entry: any) => <article key={entry.id}><div><b>{bibleEntryTitle(entry.value)}</b>{entry.manual && <span className="manual-badge">Manual</span>}</div><span>{entry.value.originalName ?? entry.value.original ?? entry.value.relationship}</span><p>{entry.value.description ?? entry.value.notes}</p><small className="mono">CH {entry.value.firstSeenChapter}—{entry.value.lastSeenChapter}</small><div className="entry-actions"><button onClick={() => setEditing(structuredClone(entry))}>{entry.manual ? "Edit" : "Correct"}</button><button onClick={() => remove(entry)}>Delete</button></div></article>) : <Empty title={`No ${pretty(category).toLowerCase()} yet`} text="Add a deliberate entry or let production extraction discover one." />}</section></div></div>{editing && <div className="editor-sheet"><div className="editor-sheet-head"><div><span className="eyebrow">{editing.id ? "Edit entry" : "New entry"}</span><h3>{pretty(editing.category)}</h3></div><button onClick={() => setEditing(undefined)} aria-label="Close editor">×</button></div><BibleFields category={editing.category} value={editing.value} onChange={(value) => setEditing({ ...editing, value })} /><div className="editor-sheet-actions"><button className="button" onClick={() => setEditing(undefined)}>Cancel</button><button className="button primary" onClick={save}>Save entry</button></div></div>}</section>;
}

export type BibleTab = "canonical" | "references" | "review" | "cleanup";
export type BibleQueryState = { tab?: BibleTab; type?: string; q?: string; sort?: string; readiness?: string; entity?: string; section?: "management"; page?: number };

export const BIBLE_SEARCH_DEBOUNCE_MS = 300;

/** Monotonic gate for overlapping list requests: only the most recently issued id is current. */
export function createRequestGate() {
  let latest = 0;
  return {
    next: () => ++latest,
    isCurrent: (id: number) => id === latest,
    invalidate: () => { latest += 1; },
  };
}

/** The global duplicate-suggestion strip is hidden while a canonical search is active. */
export function shouldShowDuplicateStrip(query: string, suggestions?: readonly unknown[]): boolean {
  return !query.trim() && (suggestions?.length ?? 0) > 0;
}

export function parseBibleQuery(search: string): BibleQueryState {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  const page = Number(params.get("page"));
  return {
    tab: tab && ["canonical", "references", "review", "cleanup"].includes(tab) ? tab as BibleTab : undefined,
    type: params.get("type") || undefined,
    q: params.get("q") || undefined,
    sort: params.get("sort") || undefined,
    readiness: params.get("readiness") || undefined,
    entity: params.get("entity") || undefined,
    section: params.get("section") === "management" && params.get("entity") ? "management" : undefined,
    page: Number.isInteger(page) && page > 0 ? page : undefined,
  };
}

export function bibleQueryString(state: { tab: BibleTab; type: string; q: string; sort: string; readiness: string; page: number; entity?: string; section?: "management" }): string {
  const params = new URLSearchParams();
  if (state.tab !== "canonical") params.set("tab", state.tab);
  if (state.type !== "all") params.set("type", state.type);
  if (state.q) params.set("q", state.q);
  if (state.sort !== "last") params.set("sort", state.sort);
  if (state.readiness !== "all") params.set("readiness", state.readiness);
  if (state.page > 1) params.set("page", String(state.page));
  if (state.entity) params.set("entity", state.entity);
  if (state.entity && state.section === "management") params.set("section", "management");
  const query = params.toString();
  return query ? `?${query}` : "";
}

const READINESS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "needs-attention", label: "Needs attention" },
  { value: "narration-incomplete", label: "Narration not configured" },
  { value: "localization-incomplete", label: "Localization not configured" },
  { value: "pronunciation-review", label: "Pronunciation review" },
  { value: "visual-incomplete", label: "Visual Profile incomplete" },
  { value: "continuity-issues", label: "Continuity issues" },
  { value: "duplicate-candidates", label: "Duplicate candidates" },
  { value: "type-conflicts", label: "Type conflicts" },
];

export function ReadinessStrip({ rows }: { rows?: Array<{ key: string; state: string; label: string; detail?: string }> }) {
  if (!rows?.length) return null;
  const attention = rows.filter((row) => row.state === "attention");
  if (!attention.length) return <span className="readiness-strip" title="No attention items"><i className="readiness-dot complete">✓</i></span>;
  return <span className="readiness-strip">{attention.slice(0, 3).map((row) => <i key={row.key} className="readiness-dot attention" title={`${row.label}: ${row.detail ?? "Needs attention"}`}>⚠ {row.label}</i>)}{attention.length > 3 && <i className="readiness-dot attention">+{attention.length - 3}</i>}</span>;
}

const READINESS_GLYPH: Record<string, string> = { complete: "✓", attention: "⚠", optional: "○", na: "—" };

export function ReadinessGrid({ rows }: { rows?: Array<{ key: string; state: string; label: string; detail?: string }> }) {
  if (!rows?.length) return null;
  return <div className="readiness-grid">{rows.map((row) => <div key={row.key} className={`readiness-row ${row.state}`} title={row.detail}><i>{READINESS_GLYPH[row.state] ?? "—"}</i><span>{row.label}</span><small>{row.detail}</small></div>)}</div>;
}

export function StoryBibleHealthCard({ health, onReviewAll, onOpenCleanup }: { health: any; onReviewAll: () => void; onOpenCleanup: () => void }) {
  const issues: Array<{ key: string; label: string; count: number }> = [
    { key: "duplicateCandidates", label: "duplicate candidates", count: health.issues?.duplicateCandidates ?? 0 },
    { key: "namingCollisions", label: "naming collisions", count: health.issues?.namingCollisions ?? 0 },
    { key: "continuityOpen", label: "open continuity findings", count: health.issues?.continuityOpen ?? 0 },
    { key: "pronunciationNeedsReview", label: "pronunciations to review", count: health.issues?.pronunciationNeedsReview ?? 0 },
    { key: "visualProfileIssues", label: "Visual Profile conflicts", count: health.issues?.visualProfileIssues ?? 0 },
    { key: "cleanupRecommendations", label: "cleanup recommendations", count: health.issues?.cleanupRecommendations ?? 0 },
  ];
  const stale = health.issues?.staleExtractionChapters ?? 0;
  return <section className="bible-health" aria-label="Story Bible Health">
    <div className="bible-health-head"><div><span className="eyebrow">Story Bible Health</span><b>{health.totals?.needsAttention ? `${health.totals.needsAttention} entit${health.totals.needsAttention === 1 ? "y needs" : "ies need"} attention` : "No entities need attention"}</b></div><button className="button" onClick={onReviewAll}>Review all issues</button></div>
    <div className="bible-health-counts">
      <span className="quiet"><b>{health.totals?.canonicalEntities ?? 0}</b> canonical entities</span>
      <span className="quiet"><b>{health.totals?.minorReferences ?? 0}</b> minor references</span>
      {issues.map((issue) => <span key={issue.key} className={issue.count ? "hot" : "quiet"}><b>{issue.count}</b> {issue.label}</span>)}
    </div>
    {stale > 0 && <p className="bible-health-stale">{stale} chapter{stale === 1 ? " has" : "s have"} stale Story Bible extraction. <button className="inline-action-link" onClick={onOpenCleanup}>Open cleanup →</button></p>}
  </section>;
}

export const BIBLE_REVIEW_KIND_LABELS: Record<string, string> = { duplicate: "Duplicates", naming: "Naming collisions", pronunciation: "Pronunciation", continuity: "Continuity", "visual-profile": "Visual Profiles", "stale-extraction": "Stale Extraction", cleanup: "Cleanup" };

export function BibleReviewQueue({ view, kind, status, onKind, onStatus, onPage, navigate }: { view: any; kind: string; status: string; onKind: (kind: string) => void; onStatus: (status: string) => void; onPage: (page: number) => void; navigate: (path: string) => void }) {
  const kinds = Object.keys(view.counts ?? {}).filter((key) => view.counts[key] > 0);
  return <div className="bible-review">
    <div className="segmented" style={{ marginBottom: "14px" }}>
      <button className={kind === "all" ? "active" : ""} onClick={() => onKind("all")}>All</button>
      {kinds.map((key) => <button key={key} className={kind === key ? "active" : ""} onClick={() => onKind(key)}>{BIBLE_REVIEW_KIND_LABELS[key] ?? pretty(key)} ({view.counts[key]})</button>)}
    </div>
    <div className="canonical-toolbar" style={{ gridTemplateColumns: "200px", margin: "0 0 14px" }}><select aria-label="Review status" value={status} onChange={(event) => onStatus(event.target.value)}><option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All</option></select></div>
    {status === "resolved" && <p className="quiet">Resolved view includes only review sources that keep resolution history. Derived issues disappear once corrected.</p>}
    {view.pages > 1 && <Pagination position="top" page={view.page} pages={view.pages} total={view.total} itemLabel="issues" onPrevious={() => onPage(view.page - 1)} onNext={() => onPage(view.page + 1)} />}
    <div className="continuity-list">
      {view.items.map((item: any) => <article key={item.id} className={`continuity-card ${item.severity === "critical" ? "critical" : ""}`}>
        <header><span className="eyebrow">{BIBLE_REVIEW_KIND_LABELS[item.kind] ?? pretty(item.kind)} · {pretty(item.source)}</span><Status status={item.severity === "critical" ? "fail" : item.severity === "warn" ? "warn" : "pending"} label={item.severity ?? "info"} /></header>
        <h3>{item.title}</h3>
        <p>{item.detail}</p>
        {item.chapters?.length > 0 && <small className="mono">Ch. {item.chapters.slice(0, 12).join(", ")}{item.chapters.length > 12 ? `… +${item.chapters.length - 12}` : ""}</small>}
        <div className="chapter-links"><button onClick={() => navigate(item.action.href)}>{item.action.label}</button></div>
      </article>)}
    </div>
    {!view.items.length && <Empty title="Nothing to review" text="No open issues match this filter. The queue is derived from existing findings and never runs paid work." />}
    {view.pages > 1 && <Pagination position="bottom" page={view.page} pages={view.pages} total={view.total} itemLabel="issues" onPrevious={() => onPage(view.page - 1)} onNext={() => onPage(view.page + 1)} />}
  </div>;
}

export function BiblePage({ slug, navigate, locationSearch }: { slug: string; navigate: (path: string, options?: NavigateOptions) => void; locationSearch: string }) {
  const initial = parseBibleQuery(locationSearch);
  const locationKey = `${location.pathname}${locationSearch}`;
  const [view, setView] = useState<any>(); const [detail, setDetail] = useState<any>(); const [editing, setEditing] = useState<any>(); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [query, setQuery] = useState(initial.q ?? ""); const [debouncedQuery, setDebouncedQuery] = useState((initial.q ?? "").trim()); const [type, setType] = useState(initial.type ?? "all"); const [sort, setSort] = useState(initial.sort ?? "last"); const [page, setPage] = useState(initial.page ?? 1); const [readiness, setReadiness] = useState(initial.readiness ?? "all");
  const [tab, setTab] = useState<BibleTab>(initial.tab ?? "canonical");
  const [health, setHealth] = useState<any>();
  const [openReviewTotal, setOpenReviewTotal] = useState<number>();
  const [review, setReview] = useState<any>(); const [reviewKind, setReviewKind] = useState("all"); const [reviewStatus, setReviewStatus] = useState("open"); const [reviewPage, setReviewPage] = useState(1);
  const [refsView, setRefsView] = useState<any>(); const [refsQuery, setRefsQuery] = useState(""); const deferredRefs = useDeferredValue(refsQuery); const [refsType, setRefsType] = useState("all"); const [refsPage, setRefsPage] = useState(1);
  const [analysis, setAnalysis] = useState<any>(); const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [visualProfileTarget, setVisualProfileTarget] = useState<{ id: string; name?: string } | null>(null);
  const [suppressedEntities, setSuppressedEntities] = useState<any[]>([]);
  const [mergeReview, setMergeReview] = useState<{ target: any; source: any; reason: string } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkAction, setBulkAction] = useState<"lock" | "unlock" | "set-type" | "set-visual-policy">("lock");
  const [bulkValue, setBulkValue] = useState("character");
  const [bulkPreview, setBulkPreview] = useState<BulkEntityUpdateResult | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [impactPreview, setImpactPreview] = useState<{ title: string; diff: Array<{ label: string; before: string; after: string }>; impact: EntityImpact; applyLabel?: string; apply: () => Promise<void> } | null>(null);
  const [impactBusy, setImpactBusy] = useState(false);
  const entityChildOverlayOpen = Boolean(editing || mergeReview || impactPreview || bulkPreview || visualProfileTarget);
  const activeEntityOverlay = visualProfileTarget ? `visual:${visualProfileTarget.id}` : impactPreview ? "impact" : bulkPreview ? "bulk" : editing ? `edit:${editing.id}` : mergeReview ? "merge" : undefined;
  useEffect(() => {
    if (!activeEntityOverlay) return;
    const selector = activeEntityOverlay.startsWith("visual:")
      ? ".visual-profile-modal .btn-close"
      : activeEntityOverlay === "impact"
        ? ".entity-impact-dialog .entity-sheet-close, .entity-impact-dialog .editor-sheet-head button"
        : activeEntityOverlay === "bulk"
          ? ".editor-sheet[aria-label='Review bulk update'] .editor-sheet-head button"
          : activeEntityOverlay.startsWith("edit:")
            ? ".editor-sheet[aria-label='Edit canonical record'] input:not([type='checkbox'])"
            : ".editor-sheet[aria-label='Compare canonical entities before merge'] .editor-sheet-head button";
    document.querySelector<HTMLElement>(selector)?.focus();
  }, [activeEntityOverlay]);
  useEffect(() => {
    if (!entityChildOverlayOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (visualProfileTarget) setVisualProfileTarget(null);
      else if (impactPreview) setImpactPreview(null);
      else if (bulkPreview) setBulkPreview(null);
      else if (editing) setEditing(undefined);
      else if (mergeReview) setMergeReview(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [entityChildOverlayOpen, visualProfileTarget, impactPreview, bulkPreview, editing, mergeReview]);
  const [checkedRecs, setCheckedRecs] = useState<string[]>([]);
  // Start unsynchronized so an initial ?entity= deep link is loaded as well.
  const [syncedLocationKey, setSyncedLocationKey] = useState("");
  // Tracks the URL this component last wrote via history.replaceState. App
  // passes locationSearch read live from location.search, so a self-written
  // URL can arrive as a "new" location on the next unrelated App re-render;
  // those must not be treated as external navigation.
  const selfWrittenLocationKey = useRef<string>();
  const requestImpact = async (entityId: string, body: Record<string, unknown>, preview: { title: string; diff?: Array<{ label: string; before: string; after: string }>; applyLabel?: string; apply: () => Promise<void> }) => {
    try { setError(""); const impact = await post<EntityImpact>(`/stories/${slug}/story-bible/entities/${entityId}/impact`, body); setImpactPreview({ title: preview.title, diff: preview.diff ?? [], impact, applyLabel: preview.applyLabel, apply: preview.apply }); }
    catch (value) { setError(message(value)); }
  };
  const runImpactApply = async () => { if (!impactPreview) return; try { setImpactBusy(true); setError(""); await impactPreview.apply(); setImpactPreview(null); } catch (value) { setError(message(value)); } finally { setImpactBusy(false); } };
  const [entitiesLoading, setEntitiesLoading] = useState(true); const [listError, setListError] = useState(""); const [healthError, setHealthError] = useState("");
  const listGate = useRef(createRequestGate()); const listAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), BIBLE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const loadEntities = async () => {
    const requestId = listGate.current.next();
    listAbort.current?.abort();
    const controller = new AbortController();
    listAbort.current = controller;
    setEntitiesLoading(true);
    try {
      const entities = await api<any>(`/stories/${slug}/story-bible/entities?page=${page}&pageSize=50&type=${type}&sort=${sort}${readiness === "all" ? "" : `&readiness=${readiness}`}&q=${encodeURIComponent(debouncedQuery)}`, { signal: controller.signal });
      if (!listGate.current.isCurrent(requestId)) return;
      setView(entities);
      setListError("");
    } catch (value) {
      if (!listGate.current.isCurrent(requestId) || controller.signal.aborted) return;
      setListError(message(value));
    } finally {
      if (listGate.current.isCurrent(requestId)) setEntitiesLoading(false);
    }
  };
  useEffect(() => {
    // While a search debounce is pending, query.trim() is newer than
    // debouncedQuery. Suppress the list request so a page reset caused by
    // typing doesn't fire a request with the stale query; the debounce commit
    // flips debouncedQuery and issues exactly one request.
    if (query.trim() !== debouncedQuery) return;
    void loadEntities();
  }, [slug, page, type, sort, readiness, debouncedQuery, query]);
  const loadSuppressions = async () => { try { setSuppressedEntities(await api<any[]>(`/stories/${slug}/story-bible/suppressions`)); } catch { /* non-critical: the suppression audit strip simply stays absent/stale */ } };
  const loadHealth = async () => { try { setHealth(await api<any>(`/stories/${slug}/story-bible/health`)); setHealthError(""); } catch (value) { setHealthError(message(value)); } };
  const loadReviewSummary = async () => { try { const summary = await api<any>(`/stories/${slug}/story-bible/review/summary`); setOpenReviewTotal(summary.openTotal); } catch { /* non-critical: the review count badge stays unset */ } };
  useEffect(() => { void loadSuppressions(); void loadHealth(); void loadReviewSummary(); }, [slug]);
  // Post-mutation refresh: the entity list is awaited (it drives what is on
  // screen); health/review/suppressions recompute in the background.
  const load = async () => { await loadEntities(); void loadHealth(); void loadReviewSummary(); void loadSuppressions(); };
  const loadReferences = () => api<any>(`/stories/${slug}/story-bible/references?page=${refsPage}&pageSize=50&type=${refsType}&q=${encodeURIComponent(deferredRefs)}`).then(setRefsView);
  useEffect(() => { if (tab === "references") void loadReferences().catch((value) => setError(message(value))); }, [slug, tab, refsPage, refsType, deferredRefs]);
  const loadAnalysis = async () => { try { setLoadingAnalysis(true); const res = await api<any>(`/stories/${slug}/story-bible/analysis`); setAnalysis(res); setCheckedRecs(defaultCleanupSelection(res.recommendations ?? [])); } catch (value) { setError(message(value)); } finally { setLoadingAnalysis(false); } };
  useEffect(() => { if (tab === "cleanup" && !analysis) void loadAnalysis(); }, [slug, tab]);
  const loadReview = () => api<any>(`/stories/${slug}/story-bible/review?page=${reviewPage}&pageSize=25${reviewKind === "all" ? "" : `&type=${reviewKind}`}&status=${reviewStatus}`).then((result) => { setReview(result); setOpenReviewTotal(result.openTotal); });
  useEffect(() => { if (tab === "review") void loadReview().catch((value) => setError(message(value))); }, [slug, tab, reviewPage, reviewKind, reviewStatus]);
  const [requestedEntityId, setRequestedEntityId] = useState<string | undefined>(initial.entity);
  const [managementEntityId, setManagementEntityId] = useState<string | undefined>(initial.section === "management" ? initial.entity : undefined);
  const entityRequestId = useRef(0);
  const requestedEntityIdRef = useRef(requestedEntityId);
  const detailEntityIdRef = useRef<string | undefined>(detail?.entity?.id);
  requestedEntityIdRef.current = requestedEntityId;
  detailEntityIdRef.current = detail?.entity?.id;
  const loadEntityDetail = (id: string, keepExisting = false) => {
    const requestId = ++entityRequestId.current;
    if (!keepExisting) setDetail(undefined);
    setError("");
    return api<any>(`/stories/${slug}/story-bible/entities/${id}`).then((value) => { if (entityRequestId.current === requestId) setDetail(value); }).catch((value) => { if (entityRequestId.current === requestId) setError(message(value)); });
  };
  const closeEntitySheet = (expectedEntityId?: string) => {
    if (expectedEntityId && (requestedEntityIdRef.current ? requestedEntityIdRef.current !== expectedEntityId : detailEntityIdRef.current !== expectedEntityId)) return;
    entityRequestId.current++;
    requestedEntityIdRef.current = undefined;
    detailEntityIdRef.current = undefined;
    setDetail(undefined);
    setRequestedEntityId(undefined);
    setManagementEntityId(undefined);
  };
  const navigateToEntity = (id: string, management = false) => {
    const href = `/stories/${slug}/bible${bibleQueryString({ tab, type, q: debouncedQuery, sort, readiness, page, entity: id, section: management ? "management" : undefined })}`;
    if (`${location.pathname}${location.search}` !== href) navigate(href, { scroll: "preserve" });
    else {
      setRequestedEntityId(id);
      setManagementEntityId(management ? id : undefined);
      if (detail?.entity?.id !== id) void loadEntityDetail(id);
    }
  };
  const navigateReviewAction = (href: string) => {
    const target = new URL(href, location.href);
    const query = parseBibleQuery(target.search);
    if (target.pathname === `/stories/${slug}/bible` && query.entity) {
      navigateToEntity(query.entity, query.section === "management");
      return;
    }
    navigate(href);
  };
  useEffect(() => {
    if (syncedLocationKey === locationKey) return;
    if (selfWrittenLocationKey.current === locationKey) {
      // Our own replaceState echoing back through a stale App render.
      setSyncedLocationKey(locationKey);
      return;
    }
    const next = parseBibleQuery(locationSearch);
    setTab(next.tab ?? "canonical");
    setType(next.type ?? "all");
    // Don't clobber in-progress typing; the URL q only reflects the debounced value.
    if (debouncedQuery === query.trim()) setQuery(next.q ?? "");
    setSort(next.sort ?? "last");
    setReadiness(next.readiness ?? "all");
    setPage(next.page ?? 1);
    if (!next.entity) {
      closeEntitySheet();
    } else {
      const management = next.section === "management";
      setRequestedEntityId(next.entity);
      setManagementEntityId(management ? next.entity : undefined);
      if (detail?.entity?.id !== next.entity || requestedEntityId !== next.entity) void loadEntityDetail(next.entity);
    }
    setSyncedLocationKey(locationKey);
  }, [locationKey]);
  useEffect(() => {
    // A changed browser location must first be reconciled into component state.
    // Also wait for the debounced search value to catch up after restoring a URL query.
    if (syncedLocationKey !== locationKey || debouncedQuery !== query.trim()) return;
    const desired = `/stories/${slug}/bible${bibleQueryString({ tab, type, q: debouncedQuery, sort, readiness, page, entity: requestedEntityId, section: managementEntityId === requestedEntityId ? "management" : undefined })}`;
    const current = `${location.pathname}${location.search}`;
    if (desired !== current) {
      history.replaceState({}, "", desired);
      selfWrittenLocationKey.current = desired;
    }
  }, [slug, tab, type, query, debouncedQuery, sort, readiness, page, requestedEntityId, managementEntityId, locationKey, syncedLocationKey]);
  const persistEdit = async (payload: any) => { const response = await put<any>(`/stories/${slug}/story-bible/entities/${editing.id}`, payload); const affected = response.invalidation?.affectedChapters?.length ?? 0; const manual = response.invalidation?.manualNarrationChapters?.length ?? 0; setNotice(affected ? `${affected} chapter${affected === 1 ? "" : "s"} marked affected.${manual ? ` ${manual} manual narration edit${manual === 1 ? " was" : "s were"} preserved for review.` : ""}` : "Protected record saved."); if (response.visualProfileReviewRequired) setNotice("Entity type saved. Existing Visual Profile was preserved; review it before regenerating visual canon."); setEditing(undefined); closeEntitySheet(editing.id); await load(); };
  const save = async () => { try { setError(""); const aliases = editing.aliasDrafts.map((item: any) => item.alias.trim()).filter(Boolean); const aliasNarrationRules = editing.aliasDrafts.filter((item: any) => item.alias.trim()).map((item: any) => ({ alias: item.alias.trim(), behavior: item.behavior, ...(item.behavior === "custom" ? { replacement: item.replacement.trim() } : {}) })); const payload = { canonicalName: editing.canonicalName, type: editing.type, aliases, canonicalNameLocked: editing.canonicalNameLocked, preferredNarrationName: editing.preferredNarrationName.trim() || null, aliasNarrationRules, pronunciation: editing.pronunciation ?? null, notes: editing.notes, status: editing.status }; const base = detail?.entity; if (base && canonicalEntityPatchImpact(base, payload).impactful) { await requestImpact(editing.id, { action: "update", patch: payload }, { title: `Edit ${base.canonicalName}`, diff: canonicalEntityDiff(base, payload), apply: () => persistEdit(payload) }); return; } await persistEdit(payload); } catch (value) { setError(message(value)); } };
  const merge = async (item: any) => { try { const [a, b] = await Promise.all(item.entities.map((entity: any) => api<any>(`/stories/${slug}/story-bible/entities/${entity.id}`))); setMergeReview({ target: a, source: b, reason: item.reason }); } catch (value) { setError(message(value)); } };
  const revertAuditEntry = async (entry: EntityAuditEntry) => {
    const patch = entityAuditRevertPatch(entry); const base = detail?.entity;
    if (!patch || !base) return;
    const apply = async () => { await put(`/stories/${slug}/story-bible/entities/${base.id}`, patch); await load(); if (parseBibleQuery(location.search).entity === base.id) await loadEntityDetail(base.id, true); };
    try { setError(""); if (canonicalEntityPatchImpact(base, patch).impactful) await requestImpact(base.id, { action: "update", patch }, { title: `Revert ${base.canonicalName}`, diff: canonicalEntityDiff(base, patch), applyLabel: "Revert change", apply }); else await apply(); }
    catch (value) { setError(message(value)); }
  };
  const confirmMerge = async () => { if (!mergeReview) return; const target = mergeReview.target.entity; const source = mergeReview.source.entity; const openEntityId = requestedEntityId; await requestImpact(source.id, { action: "merge", targetEntityId: target.id }, { title: `Merge ${source.canonicalName} into ${target.canonicalName}`, diff: [{ label: "Merge", before: `${source.canonicalName} (${source.id})`, after: `Merged into ${target.canonicalName}` }], applyLabel: "Confirm merge", apply: async () => { await post(`/stories/${slug}/story-bible/merges`, { targetEntityId: target.id, sourceEntityIds: [source.id], reason: `Approved duplicate suggestion: ${mergeReview.reason}` }); setMergeReview(null); if (openEntityId === source.id) closeEntitySheet(source.id); else if (openEntityId === target.id && parseBibleQuery(location.search).entity === target.id) await loadEntityDetail(target.id, true); await load(); } }); };
  const suppress = async (record: any) => { const entity = record.entity; const dependencies = [record.relationships?.length && `${record.relationships.length} relationships`, record.timeline?.length && `${record.timeline.length} timeline events`, record.issues?.length && `${record.issues.length} continuity findings`, entity.preferredNarrationName && "preferred narration name", entity.localizedNaming && "localization", record.visualProfileExists && "Visual Profile"].filter(Boolean).join(", "); if (!confirm(`Remove "${entity.canonicalName}" from the effective Story Bible?\n\nThis suppresses future rebuilt views, keeps historical evidence, and can be restored. Merge instead if this is a duplicate identity.${dependencies ? `\n\nExisting references to review: ${dependencies}.` : ""}`)) return; const reason = prompt("Reason for removing this canonical entity:"); if (!reason?.trim()) return; await requestImpact(entity.id, { action: "suppress" }, { title: `Remove ${entity.canonicalName}`, diff: [{ label: "Suppression", before: "Canonical entity", after: "Removed from the effective Story Bible (restorable)" }], applyLabel: "Remove entity", apply: async () => { await post(`/stories/${slug}/story-bible/entities/${entity.id}/suppress`, { reason: reason.trim() }); if (requestedEntityIdRef.current ? requestedEntityIdRef.current === entity.id : detailEntityIdRef.current === entity.id) { closeEntitySheet(entity.id); navigate(`/stories/${slug}/bible${bibleQueryString({ tab, type, q: debouncedQuery, sort, readiness, page })}`, { scroll: "preserve", replace: true }); } setNotice(`Removed "${entity.canonicalName}" from the effective Story Bible. You can restore it below.`); await load(); } }); };
  const restore = async (entityId: string) => { try { await post(`/stories/${slug}/story-bible/entities/${entityId}/restore`, {}); setNotice("Canonical entity restored."); await load(); } catch (value) { setError(message(value)); } };
  const undo = async (id: string) => { const expectedEntityId = requestedEntityId; if (!confirm("Undo this merge and restore the source entities?")) return; try { await post(`/stories/${slug}/story-bible/merges/${id}/undo`, {}); closeEntitySheet(expectedEntityId); await load(); } catch (value) { setError(message(value)); } };
  const demote = async (entity: any) => {
    await requestImpact(entity.id, { action: "demote" }, {
      title: `Convert ${entity.canonicalName} to a minor reference`,
      diff: [{ label: "Granularity", before: "Canonical entity", after: "Minor reference (tracked under parent context)" }],
      applyLabel: "Convert to minor reference",
      apply: async () => {
        await post(`/stories/${slug}/story-bible/entities/${entity.id}/demote`, { disposition: "minor_reference", reason: "Converted via Canonical Entity Sheet" });
        setNotice(`Converted "${entity.canonicalName}" to a minor reference.`);
        closeEntitySheet(entity.id);
        await load();
        if (tab === "references") void loadReferences();
        if (analysis) void loadAnalysis();
      },
    });
  };
  const promote = async (ref: any) => {
    if (!confirm(`Promote "${ref.name}" to a canonical entity?`)) return;
    try {
      setError("");
      await post(`/stories/${slug}/story-bible/references/${ref.id}/promote`, { reason: "Promoted via Story Bible desk" });
      setNotice(`Promoted "${ref.name}" to canonical entity.`);
      await loadReferences();
      await load();
      if (analysis) void loadAnalysis();
    } catch (value) { setError(message(value)); }
  };
  const applyCleanup = async (highConfidenceOnly = true) => {
    if (!confirm(highConfidenceOnly ? "Apply all safe, high-confidence cleanup recommendations?" : "Apply all recommended cleanup actions?")) return;
    try {
      setError("");
      const result = await post<any>(`/stories/${slug}/story-bible/cleanup/apply`, { highConfidenceOnly });
      setNotice(`Cleanup applied: ${result.demotedCount ?? 0} demoted, ${result.mergedCount ?? 0} merged.`);
      await loadAnalysis();
      await load();
      if (requestedEntityId && ((result.appliedDemotions ?? []).includes(requestedEntityId) || (result.appliedMerges ?? []).includes(requestedEntityId))) closeEntitySheet(requestedEntityId);
      if (tab === "references") void loadReferences();
    } catch (value) { setError(message(value)); }
  };
  const applySelectedCleanup = async () => {
    if (!checkedRecs.length) return;
    if (!confirm(`Apply the ${checkedRecs.length} selected cleanup recommendation${checkedRecs.length === 1 ? "" : "s"}? Protected entities are skipped by the server.`)) return;
    try {
      setError("");
      const result = await post<any>(`/stories/${slug}/story-bible/cleanup/apply`, { recommendationIds: checkedRecs });
      const parts = [`${result.appliedCount ?? 0} applied`];
      if (result.skippedProtectedCount) parts.push(`${result.skippedProtectedCount} skipped (protected)`);
      if (result.failedCount) parts.push(`${result.failedCount} failed${result.failed?.length ? `: ${result.failed.map((item: any) => `${item.canonicalName} — ${item.reason}`).join("; ")}` : ""}`);
      setNotice(`Cleanup plan: ${parts.join(" · ")}.`);
      await loadAnalysis();
      await load();
      if (requestedEntityId && ((result.appliedDemotions ?? []).includes(requestedEntityId) || (result.appliedMerges ?? []).includes(requestedEntityId))) closeEntitySheet(requestedEntityId);
      if (tab === "references") void loadReferences();
    } catch (value) { setError(message(value)); }
  };
  const reviewBulk = async () => {
    if (!selected.length) return;
    try { setError(""); setBulkBusy(true); setBulkPreview(await post<BulkEntityUpdateResult>(`/stories/${slug}/story-bible/entities/bulk`, { action: bulkAction, entityIds: selected, value: bulkAction === "set-type" || bulkAction === "set-visual-policy" ? bulkValue : undefined, dryRun: true })); }
    catch (value) { setError(message(value)); } finally { setBulkBusy(false); }
  };
  const applyBulk = async () => {
    if (!bulkPreview) return;
    try {
      setError(""); setBulkBusy(true);
      const result = await post<BulkEntityUpdateResult>(`/stories/${slug}/story-bible/entities/bulk`, { action: bulkAction, entityIds: selected, value: bulkAction === "set-type" || bulkAction === "set-visual-policy" ? bulkValue : undefined });
      const parts = [`${result.applied.length} applied`];
      if (result.skipped.length) parts.push(`${result.skipped.length} skipped (${result.skipped.map((item) => item.reason).join("; ")})`);
      if (result.invalidationSummary.affectedChapters) parts.push(`${result.invalidationSummary.affectedChapters} chapters marked affected`);
      setNotice(`Bulk update: ${parts.join(" · ")}.`);
      setBulkPreview(null); setSelected([]);
      await load();
      if (requestedEntityId && result.applied.includes(requestedEntityId) && parseBibleQuery(location.search).entity === requestedEntityId) await loadEntityDetail(requestedEntityId, true);
    } catch (value) { setError(message(value)); } finally { setBulkBusy(false); }
  };
  if (!view) return listError ? <section className="page"><ErrorBox text={listError} /><button className="button" onClick={() => void loadEntities()}>Retry</button></section> : <Loading />;
  return <section className="page canonical-page"><div className="section-heading"><div><span className="eyebrow">Long-form memory</span><h2>Story Bible</h2><p>Canonical identities, aliases, history, relationships, and traceable evidence.</p></div><div className="production-head-actions"><button className="button" onClick={() => navigate(`/stories/${slug}/names`)}>Names / Localization</button><button className="button" onClick={() => navigate(`/stories/${slug}/continuity`)}>Continuity review</button></div></div>{error && <ErrorBox text={error} />}{notice && <div className="naming-notice">{notice}</div>}{health ? <StoryBibleHealthCard health={health} onReviewAll={() => setTab("review")} onOpenCleanup={() => setTab("cleanup")} /> : healthError ? <section className="bible-health" aria-label="Story Bible Health"><div className="bible-health-head"><div><span className="eyebrow">Story Bible Health</span><b>Health summary unavailable</b></div><button className="button" onClick={() => void loadHealth()}>Retry</button></div></section> : null}
    <div className="segmented" style={{ marginBottom: "18px" }}>
      <button className={tab === "canonical" ? "active" : ""} onClick={() => setTab("canonical")}>Canonical entities ({view.total})</button>
      <button className={tab === "references" ? "active" : ""} onClick={() => setTab("references")}>Minor references</button>
      <button className={tab === "review" ? "active" : ""} onClick={() => setTab("review")}>Review{openReviewTotal !== undefined ? ` (${openReviewTotal})` : ""}</button>
      <button className={tab === "cleanup" ? "active" : ""} onClick={() => setTab("cleanup")}>Analyzer &amp; Cleanup</button>
    </div>
    {tab === "canonical" && <>
      {listError && <div className="naming-notice">Entity list failed to load: {listError} <button className="inline-action-link" onClick={() => void loadEntities()}>Retry</button></div>}
      <div className="canonical-toolbar"><input className="search" placeholder="Search canonical names, aliases, narration names, or localized names" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /><select value={type} onChange={(event) => { setType(event.target.value); setPage(1); }}><option value="all">All entity types</option>{Object.keys(view.counts).map((value) => <option value={value} key={value}>{pretty(value)} · {view.counts[value]}</option>)}</select><select aria-label="Readiness filter" value={readiness} onChange={(event) => { setReadiness(event.target.value); setPage(1); }}><option value="all">Any readiness</option>{READINESS_FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}</select><select value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }}><option value="last">Most recently seen</option><option value="first">First appearance</option><option value="name">Canonical name</option></select></div>
      {query.trim() && (entitiesLoading || debouncedQuery !== query.trim()) && <p className="searching-indicator" role="status">Searching…</p>}
      {shouldShowDuplicateStrip(debouncedQuery, view.duplicateSuggestions) && <div className="duplicate-strip"><div><span className="eyebrow">Possible duplicates</span><b>{view.duplicateSuggestions.length} suggestions need approval</b></div>{view.duplicateSuggestions.slice(0, 3).map((item: any) => <article key={item.id}><div><b>{item.entities[0].name}</b><span>↔</span><b>{item.entities[1].name}</b></div><small>{Math.round(item.confidence * 100)}% · {item.reason} · Ch. {item.supportingChapters.join(", ")}</small><button onClick={() => merge(item)}>Compare & merge…</button></article>)}</div>}
      <Pagination position="top" page={view.page} pages={view.pages} total={view.total} itemLabel="entities" onPrevious={() => setPage(page - 1)} onNext={() => setPage(page + 1)} />
      {selected.length > 0 && <div className="bulk-toolbar"><b>{selected.length} selected</b><select aria-label="Bulk action" value={bulkAction} onChange={(event) => { setBulkAction(event.target.value as typeof bulkAction); setBulkValue(event.target.value === "set-visual-policy" ? "prompt" : "character"); }}><option value="lock">Lock canonical names</option><option value="unlock">Unlock canonical names</option><option value="set-type">Set entity type</option><option value="set-visual-policy">Set Visual Profile policy</option></select>{bulkAction === "set-type" && <select aria-label="Bulk entity type" value={bulkValue} onChange={(event) => setBulkValue(event.target.value)}>{["character", "location", "organization", "ability", "item", "concept", "other"].map((value) => <option key={value} value={value}>{pretty(value)}</option>)}</select>}{bulkAction === "set-visual-policy" && <select aria-label="Bulk Visual Profile policy" value={bulkValue} onChange={(event) => setBulkValue(event.target.value)}><option value="prompt">Prompt for a Visual Profile</option><option value="skip">Skip Visual Profile</option></select>}<button className="button primary" disabled={bulkBusy} onClick={reviewBulk}>Review &amp; apply</button><button className="button" onClick={() => setSelected([])}>Clear</button></div>}
    <div className="entity-table"><div className="entity-row heading selectable"><span><input type="checkbox" aria-label="Select all on this page" checked={view.items.length > 0 && pageSelectionState(view.items.map((entity: any) => entity.id), selected) === "all"} ref={(input) => { if (input) input.indeterminate = pageSelectionState(view.items.map((entity: any) => entity.id), selected) === "some"; }} onChange={(event) => { const ids = view.items.map((entity: any) => entity.id); setSelected(event.target.checked ? [...new Set([...selected, ...ids])] : selected.filter((id) => !ids.includes(id))); }} /></span><span>Canonical entity</span><span>Type</span><span>Appearances</span><span>Origin</span><span>Issues</span><span>Readiness</span></div>{view.items.map((entity: any) => <div className="entity-row selectable" key={entity.id} onClick={() => navigateToEntity(entity.id)}><span onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`Select ${entity.canonicalName}`} checked={selected.includes(entity.id)} onChange={(event) => setSelected(toggleEntitySelection(selected, entity.id, event.target.checked))} /></span><span><b>{entity.canonicalName}</b>{view.duplicateSuggestions?.some((item: any) => item.entityIds.includes(entity.id)) && <i className="lock-dot">Possible duplicate</i>}<small>{entity.aliases.length ? entity.aliases.join(" · ") : entity.originalName}</small></span><span>{pretty(entity.type)}</span><span className="mono">{entity.firstAppearance}—{entity.lastKnownAppearance}</span><span>{entity.canonicalNameLocked && <i className="lock-dot">Locked</i>} {pretty(entity.origin)}</span><span className={entity.conflictCount ? "issue-count" : ""}>{entity.conflictCount || "—"}</span><span><ReadinessStrip rows={entity.readiness} /></span></div>)}</div>{!view.items.length && !entitiesLoading && <Empty title="No matching canonical entities" text="Run Story Bible extraction or change the filters." />}
      <Pagination position="bottom" page={view.page} pages={view.pages} total={view.total} itemLabel="entities" onPrevious={() => setPage(page - 1)} onNext={() => setPage(page + 1)} />
    </>}
    {tab === "references" && <>
      <div className="canonical-toolbar"><input className="search" placeholder="Search minor references" value={refsQuery} onChange={(event) => { setRefsQuery(event.target.value); setRefsPage(1); }} /><select value={refsType} onChange={(event) => { setRefsType(event.target.value); setRefsPage(1); }}><option value="all">All entity types</option>{refsView?.counts && Object.keys(refsView.counts).map((value) => <option value={value} key={value}>{pretty(value)} · {refsView.counts[value]}</option>)}</select></div>
      {refsView && refsView.pages > 1 && <Pagination position="top" page={refsView.page} pages={refsView.pages} total={refsView.total} itemLabel="references" onPrevious={() => setRefsPage(refsPage - 1)} onNext={() => setRefsPage(refsPage + 1)} />}
      <div className="entity-table"><div className="entity-row heading" style={{ gridTemplateColumns: "1.5fr 1fr 1.5fr 1fr 1fr 100px" }}><span>Reference name</span><span>Type</span><span>Parent entity</span><span>Appearances</span><span>Disposition</span><span>Actions</span></div>{refsView?.items?.map((ref: any) => <div className="entity-row" key={ref.id} style={{ gridTemplateColumns: "1.5fr 1fr 1.5fr 1fr 1fr 100px", cursor: "default" }}><span><b>{ref.name}</b>{ref.originalName && <small>{ref.originalName}</small>}</span><span>{pretty(ref.type)}</span><span>{ref.parentEntityName ? <b>{ref.parentEntityName}</b> : <span style={{ color: "#777" }}>—</span>}</span><span className="mono">Ch. {ref.firstSeenChapter}—{ref.lastSeenChapter}</span><span>{pretty(ref.disposition)}</span><span><button className="button" style={{ padding: "4px 8px", fontSize: "10px" }} onClick={() => promote(ref)}>Promote</button></span></div>)}</div>{!refsView?.items?.length && <Empty title="No minor references found" text="No minor references recorded yet or matching your filters." />}
      {refsView && refsView.pages > 1 && <Pagination position="bottom" page={refsView.page} pages={refsView.pages} total={refsView.total} itemLabel="references" onPrevious={() => setRefsPage(refsPage - 1)} onNext={() => setRefsPage(refsPage + 1)} />}
    </>}
    {tab === "review" && (review ? <BibleReviewQueue view={review} kind={reviewKind} status={reviewStatus} onKind={(value) => { setReviewKind(value); setReviewPage(1); }} onStatus={(value) => { setReviewStatus(value); setReviewPage(1); }} onPage={setReviewPage} navigate={navigateReviewAction} /> : <Loading />)}
    {tab === "cleanup" && (loadingAnalysis ? <Loading /> : analysis ? <div className="cleanup-view">
      <div className="qa-summary" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: "20px" }}>
        <div className="qa-count"><span>Canonical entities</span><b>{analysis.totalCanonical}</b></div>
        <div className="qa-count warn"><span>Demote candidates</span><b>{analysis.convertMinorCount}</b></div>
        <div className="qa-count pass"><span>Duplicate / Merge</span><b>{analysis.possibleDuplicatesCount}</b></div>
        <div className="qa-count"><span>Needs review / Protected</span><b>{analysis.needsReviewCount + analysis.protectedCount}</b></div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: "12px" }}>Automated recommendations for bounded, high-signal entities. Protected entities with locks or manual edits are never auto-demoted.</p>
        <div style={{ display: "flex", gap: "8px" }}>
          <button className="button" onClick={loadAnalysis}>Refresh analysis</button>
          <button className="button" onClick={applySelectedCleanup} disabled={!checkedRecs.length}>Apply selected ({checkedRecs.length})</button>
          <button className="button primary" onClick={() => applyCleanup(true)} disabled={!analysis.recommendations?.some((r: any) => r.safeToAutoApply)}>Apply safe recommendations</button>
        </div>
      </div>
      <div className="recommendations-list" style={{ display: "grid", gap: "12px" }}>
        {analysis.recommendations?.map((rec: any) => <article key={rec.id} className="continuity-card" style={{ padding: "16px", borderRadius: "8px", background: "#141419", border: "1px solid var(--line)" }}>
          <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", gap: "8px" }}>
            <span style={{ display: "flex", alignItems: "center", gap: "8px" }}><input type="checkbox" aria-label={`Select recommendation for ${rec.canonicalName}`} checked={checkedRecs.includes(rec.id)} onChange={(event) => setCheckedRecs(toggleEntitySelection(checkedRecs, rec.id, event.target.checked))} /><span className="eyebrow">{pretty(rec.type)} · {rec.targetEntityId && rec.recommendation === "needs_review" ? "Possible duplicate · Review" : pretty(rec.recommendation)}</span>{cleanupOriginLabel(rec.source) && <span style={{ fontSize: "9px", fontFamily: "var(--mono)", color: "var(--muted)", border: "1px solid var(--line)", borderRadius: "4px", padding: "1px 5px" }}>{cleanupOriginLabel(rec.source)}</span>}</span>
            <span style={{ fontSize: "10px", fontFamily: "var(--mono)", color: rec.confidence >= 0.85 ? "var(--pass)" : "var(--warn)" }}>{Math.round(rec.confidence * 100)}% confidence</span>
          </header>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px" }}>
            <div>
              <h3 style={{ margin: "0 0 4px", fontSize: "16px" }}>{rec.canonicalName}</h3>
              {rec.parentEntityName && <div style={{ fontSize: "11px", color: "var(--muted)", marginBottom: "4px" }}>Parent: <b>{rec.parentEntityName}</b></div>}
              {rec.targetEntityName && <div style={{ fontSize: "11px", color: "var(--muted)", marginBottom: "4px" }}>Target: <b>{rec.targetEntityName}</b></div>}
              {rec.supportingChapters?.length > 0 && <div style={{ fontSize: "11px", color: "var(--muted)", marginBottom: "4px" }}>Supporting chapters: <b>Ch. {rec.supportingChapters.join(", ")}</b></div>}
              <p style={{ margin: "4px 0", fontSize: "12px", color: "#aaa9b3" }}>{rec.reason}</p>
              {rec.protected && rec.protectedReasons?.length > 0 && <div style={{ marginTop: "6px", display: "flex", gap: "6px", flexWrap: "wrap" }}>{rec.protectedReasons.map((r: string, idx: number) => <span key={idx} style={{ background: "rgba(223, 166, 75, 0.15)", color: "#dfa64b", fontSize: "9px", padding: "2px 6px", borderRadius: "4px" }}>🔒 {r}</span>)}</div>}
            </div>
            <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
              {rec.recommendation === "minor_reference" && <button className="button" style={{ fontSize: "10px" }} onClick={async () => { try { setError(""); await post(`/stories/${slug}/story-bible/entities/${rec.entityId}/demote`, { parentEntityId: rec.parentEntityId, disposition: "minor_reference", reason: rec.reason }); setNotice(`Demoted "${rec.canonicalName}" to minor reference.`); await loadAnalysis(); await load(); } catch (e) { setError(message(e)); } }}>Demote to reference</button>}
              {rec.recommendation === "merge" && rec.targetEntityId && <button className="button" style={{ fontSize: "10px" }} onClick={async () => { try { setError(""); await post(`/stories/${slug}/story-bible/merges`, { targetEntityId: rec.targetEntityId, sourceEntityIds: [rec.entityId], reason: rec.reason }); setNotice(`Merged "${rec.canonicalName}" into "${rec.targetEntityName}".`); await loadAnalysis(); await load(); } catch (e) { setError(message(e)); } }}>Merge entity</button>}
              {rec.recommendation === "needs_review" && rec.targetEntityId && <button className="button" style={{ fontSize: "10px" }} onClick={async () => { try { setError(""); await post(`/stories/${slug}/story-bible/merges`, { targetEntityId: rec.targetEntityId, sourceEntityIds: [rec.entityId], reason: rec.reason }); setNotice(`Merged "${rec.canonicalName}" into "${rec.targetEntityName}".`); await loadAnalysis(); await load(); } catch (e) { setError(message(e)); } }}>Review & merge</button>}
            </div>
          </div>
        </article>)}
        {!analysis.recommendations?.length && <Empty title="Story Bible is clean" text="No entities currently warrant demotion or cleanup." />}
      </div>
    </div> : <LoadFailure error="Could not load analysis." />)}
    {tab === "canonical" && suppressedEntities.length > 0 && <div className="duplicate-strip"><div><span className="eyebrow">Suppression audit</span><b>{suppressedEntities.length} removed canonical records</b></div>{suppressedEntities.map((item: any) => <article key={item.entityId}><div><b>{item.name}</b><small>{pretty(item.type)} · {item.entityId}</small></div><small>{item.reason} · {item.suppressedAt}</small><button onClick={() => restore(item.entityId)}>Restore entity</button></article>)}</div>}
    {mergeReview && <div className="editor-sheet naming-editor" role="dialog" aria-modal="true" aria-label="Compare canonical entities before merge"><div className="editor-sheet-head"><div><span className="eyebrow">Protected identity merge</span><h3>Compare before merging</h3></div><button autoFocus onClick={() => setMergeReview(null)} aria-label="Close comparison">×</button></div>{[mergeReview.target, mergeReview.source].map((record: any, index: number) => <section key={record.entity.id}><span className="eyebrow">{index === 0 ? "Surviving target" : "Merged source"}</span><h4>{record.entity.canonicalName} · {pretty(record.entity.type)}</h4><p>Original: {record.entity.originalName || "—"} · Ch. {record.entity.firstAppearance}–{record.entity.lastKnownAppearance}</p><p>Aliases: {record.entity.aliases.join(", ") || "—"}</p><p>Description: {record.entity.description || "—"}</p><p>Preferred narration: {record.entity.preferredNarrationName || "—"} · Localized: {record.entity.localizedNaming?.fullName || "—"}</p><p>Alias rules: {record.entity.aliasNarrationRules.length} · Provenance: {record.entity.provenance.length} · Relationships: {record.relationships.length} · Timeline: {record.timeline.length}</p><p>Visual Profile: {record.visualProfileExists ? "Exists — review before merge" : "None"}</p></section>)}<section><span className="eyebrow">Result preview</span><p>Surviving ID: {mergeReview.target.entity.id}. Appearance range: Ch. {Math.min(mergeReview.target.entity.firstAppearance, mergeReview.source.entity.firstAppearance)}–{Math.max(mergeReview.target.entity.lastKnownAppearance, mergeReview.source.entity.lastKnownAppearance)}.</p><p>Aliases: {[...new Set([...mergeReview.target.entity.aliases, mergeReview.source.entity.canonicalName, ...mergeReview.source.entity.aliases])].join(", ") || "—"}</p><p>Description/notes: target text and source text are both retained. Provenance: {mergeReview.target.entity.provenance.length + mergeReview.source.entity.provenance.length} records. Relationships: {mergeReview.target.relationships.length + mergeReview.source.relationships.length} references remapped. Timeline: {mergeReview.target.timeline.length + mergeReview.source.timeline.length} events remapped.</p><p>Preferred narration: {mergeReview.target.entity.preferredNarrationName || mergeReview.source.entity.preferredNarrationName || "—"}. Localized naming: {mergeReview.target.entity.localizedNaming?.fullName || mergeReview.source.entity.localizedNaming?.fullName || "—"}. Alias rules: {mergeReview.target.entity.aliasNarrationRules.length + mergeReview.source.entity.aliasNarrationRules.length}. Merged-from IDs: {[...mergeReview.target.entity.mergedFromIds, mergeReview.source.entity.id, ...mergeReview.source.entity.mergedFromIds].join(", ")}.</p></section>{mergeNamingConflict(mergeReview.target.entity, mergeReview.source.entity) && <div className="naming-notice">Naming conflict: edit one entity’s preferred/localized naming before merging. The server will reject an unresolved conflict.</div>}<div className="editor-sheet-actions"><button className="button" onClick={() => setMergeReview({ target: mergeReview.source, source: mergeReview.target, reason: mergeReview.reason })}>Swap target</button><button className="button" onClick={() => setMergeReview(null)}>Cancel</button><button className="button primary" disabled={mergeNamingConflict(mergeReview.target.entity, mergeReview.source.entity)} onClick={confirmMerge}>Confirm merge</button></div></div>}
    {detail && <CanonicalEntitySheet key={detail.entity.id} detail={detail} slug={slug} navigate={navigate} hasActiveChildOverlay={entityChildOverlayOpen} managementInitiallyOpen={managementEntityId === detail.entity.id} onManagementOpenChange={(open: boolean) => setManagementEntityId(open ? detail.entity.id : undefined)} onClose={() => closeEntitySheet()} onUndo={undo} onEdit={() => setEditing({ ...canonicalDraft(detail.entity), originalType: detail.entity.type, visualProfileExists: detail.visualProfileExists })} onDemote={() => demote(detail.entity)} onSuppress={() => suppress(detail)} onMerge={(item: any) => merge(item)} onOpenVisualProfile={(id: string, name?: string) => setVisualProfileTarget({ id, name })} onRevert={revertAuditEntry} />}
    {visualProfileTarget && <VisualProfileModal slug={slug} entityId={visualProfileTarget.id} entityName={visualProfileTarget.name} onClose={() => setVisualProfileTarget(null)} />}
    <PronunciationPanel slug={slug} />{editing && <CanonicalEntityEditor slug={slug} value={editing} onChange={setEditing} onClose={() => setEditing(undefined)} onSave={save} />}
    {impactPreview && <EntityImpactDialog title={impactPreview.title} diff={impactPreview.diff} impact={impactPreview.impact} busy={impactBusy} applyLabel={impactPreview.applyLabel} onCancel={() => setImpactPreview(null)} onApply={runImpactApply} />}
    {bulkPreview && <div className="editor-sheet naming-editor" role="dialog" aria-modal="true" aria-label="Review bulk update"><div className="editor-sheet-head"><div><span className="eyebrow">Bulk update preview</span><h3>{bulkAction === "lock" ? "Lock canonical names" : bulkAction === "unlock" ? "Unlock canonical names" : bulkAction === "set-type" ? `Set entity type to ${pretty(bulkValue)}` : `Set Visual Profile policy to ${bulkValue}`}</h3></div><button onClick={() => setBulkPreview(null)} aria-label="Cancel bulk update">×</button></div><section className="impact-estimate"><span className="eyebrow">Eligibility</span><p>{selected.length} selected · {bulkPreview.eligible.length} can be changed · {bulkPreview.skipped.length} skipped</p>{bulkPreview.skipped.map((item) => <p key={item.id}><b>{view.items.find((entity: any) => entity.id === item.id)?.canonicalName ?? item.id}</b>: {item.reason}</p>)}</section><section className="impact-estimate"><span className="eyebrow">Estimated impact</span><p>{bulkPreview.invalidationSummary.affectedChapters ? `${bulkPreview.invalidationSummary.affectedChapters} chapters reference the affected entities and will be flagged for review` : "No production artifacts are affected by this change."}</p></section><div className="editor-sheet-actions"><button className="button" onClick={() => setBulkPreview(null)}>Cancel</button><button className="button primary" disabled={bulkBusy || !bulkPreview.eligible.length} onClick={applyBulk}>Apply to {bulkPreview.eligible.length} eligible</button></div></div>}</section>;
}

function canonicalDraft(entity: any) { const rules = new Map((entity.aliasNarrationRules ?? []).map((rule: any) => [rule.alias.toLocaleLowerCase(), rule])); return { ...entity, preferredNarrationName: entity.preferredNarrationName ?? "", aliasDrafts: entity.aliases.map((alias: string) => ({ alias, behavior: rules.get(alias.toLocaleLowerCase())?.behavior ?? "no_override", replacement: rules.get(alias.toLocaleLowerCase())?.replacement ?? "" })) }; }
function mergeNamingConflict(target: any, source: any) {
  const targetName = target.localizedNaming?.fullName ?? target.preferredNarrationName;
  const sourceName = source.localizedNaming?.fullName ?? source.preferredNarrationName;
  if (targetName && sourceName && targetName !== sourceName) return true;
  if (target.localizedNaming && source.localizedNaming && JSON.stringify(target.localizedNaming) !== JSON.stringify(source.localizedNaming)) return true;
  const rules = new Map((target.aliasNarrationRules ?? []).map((rule: any) => [rule.alias.toLocaleLowerCase(), JSON.stringify(rule)]));
  return (source.aliasNarrationRules ?? []).some((rule: any) => rules.has(rule.alias.toLocaleLowerCase()) && rules.get(rule.alias.toLocaleLowerCase()) !== JSON.stringify(rule));
}
function namingLabel(alias: string, entity: any) { const rule = (entity.aliasNarrationRules ?? []).find((item: any) => item.alias.toLocaleLowerCase() === alias.toLocaleLowerCase()); if (!rule || rule.behavior === "no_override") return "No override"; if (rule.behavior === "use_preferred") return entity.preferredNarrationName ? `Use ${entity.preferredNarrationName}` : "Use preferred name"; return `Custom → ${rule.replacement}`; }

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/**
 * Which entity edits are high-impact and must be previewed before saving.
 * Mirrors the server-side detectors (narration naming, pronunciation, type,
 * canonical rename); harmless edits — notes, status, lock toggle, aliases —
 * save directly.
 */
export function canonicalEntityPatchImpact(before: any, payload: any): { impactful: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (payload.canonicalName !== undefined && payload.canonicalName !== before.canonicalName) reasons.push("Canonical rename");
  if (payload.type !== undefined && payload.type !== before.type) reasons.push("Entity type change");
  if (payload.preferredNarrationName !== undefined && (payload.preferredNarrationName ?? null) !== (before.preferredNarrationName ?? null)) reasons.push("Preferred narration name change");
  if (payload.aliasNarrationRules !== undefined && !sameJson(payload.aliasNarrationRules, before.aliasNarrationRules ?? [])) reasons.push("Alias narration rules change");
  if (payload.localizedNaming !== undefined && !sameJson(payload.localizedNaming, before.localizedNaming)) reasons.push("Localized naming change");
  if (payload.pronunciation !== undefined && !sameJson(payload.pronunciation, before.pronunciation)) reasons.push("Pronunciation change");
  return { impactful: reasons.length > 0, reasons };
}

const formatDiffValue = (value: any): string => {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.map((item) => typeof item === "string" ? item : item.alias ? `${item.alias} (${item.behavior}${item.replacement ? `: ${item.replacement}` : ""})` : JSON.stringify(item)).join(", ") : "—";
  if (typeof value === "object") return value.fullName ?? value.customPronunciation ?? value.mode ?? JSON.stringify(value);
  return String(value);
};

/** Old → new lines for the fields an edit actually changes, in impact-preview order. */
export function canonicalEntityDiff(before: any, payload: any): Array<{ label: string; before: string; after: string }> {
  const fields: Array<{ key: string; label: string }> = [
    { key: "canonicalName", label: "Canonical name" }, { key: "type", label: "Entity type" },
    { key: "preferredNarrationName", label: "Preferred narration name" }, { key: "aliasNarrationRules", label: "Alias narration rules" },
    { key: "localizedNaming", label: "Localized naming" }, { key: "pronunciation", label: "Pronunciation" },
    { key: "canonicalNameLocked", label: "Name lock" }, { key: "status", label: "Status" }, { key: "aliases", label: "Aliases" }, { key: "notes", label: "Notes" },
  ];
  return fields.filter(({ key }) => payload[key] !== undefined && !sameJson(payload[key], before[key])).map(({ key, label }) => ({ label, before: formatDiffValue(before[key]), after: formatDiffValue(payload[key]) }));
}

/** Non-zero estimated impact lines shown in the preview dialog. */
export function impactEstimateLines(impact: EntityImpact): string[] {
  const plural = (count: number, singular: string, pluralForm?: string) => `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
  const lines: string[] = [];
  if (impact.affectedChapters?.length) lines.push(`${plural(impact.affectedChapters.length, "chapter")} reference this entity`);
  if (impact.narrationAffected) lines.push(`${plural(impact.narrationAffected, "generated narration")} may become stale`);
  if (impact.qaAffected) lines.push(`${plural(impact.qaAffected, "QA result")} need${impact.qaAffected === 1 ? "s" : ""} recheck`);
  if (impact.ttsAffected) lines.push(`${plural(impact.ttsAffected, "TTS output")} need${impact.ttsAffected === 1 ? "s" : ""} regeneration`);
  if (impact.audioAffected) lines.push(`${plural(impact.audioAffected, "mastered audio file")} need${impact.audioAffected === 1 ? "s" : ""} re-mastering`);
  if (impact.scenePlanningAffected) lines.push(`${plural(impact.scenePlanningAffected, "scene plan")} flagged for review`);
  if (impact.artworkAffected) lines.push(`${plural(impact.artworkAffected, "artwork set")} flagged for review`);
  if (impact.videoAffected) lines.push(`${plural(impact.videoAffected, "video")} flagged for review`);
  if (impact.manualNarrationChapters?.length) lines.push(`${plural(impact.manualNarrationChapters.length, "manual narration chapter")} will be preserved for review`);
  if (impact.continuityAffected) lines.push(`${plural(impact.continuityAffected, "open continuity finding")} involve${impact.continuityAffected === 1 ? "s" : ""} this entity`);
  if (impact.visualProfileAffected) lines.push("Visual Profile needs review before regenerating artwork");
  return lines;
}

/** Selection helpers for the canonical table: selection persists across pagination and filters. */
export function toggleEntitySelection(selected: readonly string[], id: string, on: boolean): string[] {
  const next = new Set(selected);
  if (on) next.add(id); else next.delete(id);
  return [...next];
}
export function pageSelectionState(pageIds: readonly string[], selected: readonly string[]): "all" | "some" | "none" {
  const set = new Set(selected);
  const onPage = pageIds.filter((id) => set.has(id)).length;
  return onPage === 0 ? "none" : onPage === pageIds.length ? "all" : "some";
}

/** Cleanup plan defaults: only unprotected, auto-safe recommendations start checked. */
export function defaultCleanupSelection(recommendations: any[]): string[] {
  return (recommendations ?? []).filter((rec: any) => rec.safeToAutoApply && !rec.protected).map((rec: any) => rec.id);
}
export function cleanupOriginLabel(source: unknown): string | undefined {
  return source === "deterministic" ? "Deterministic" : source === "ai" ? "AI-assisted" : undefined;
}

/** Preview-before-apply confirmation for high-impact entity operations. */
export function EntityImpactDialog({ title, diff = [], impact, busy = false, applyLabel = "Apply change", onCancel, onApply }: { title: string; diff?: Array<{ label: string; before: string; after: string }>; impact: EntityImpact; busy?: boolean; applyLabel?: string; onCancel: () => void; onApply: () => void }) {
  const lines = impactEstimateLines(impact);
  return <div className="editor-sheet naming-editor entity-impact-dialog" role="dialog" aria-modal="true" aria-label="Review estimated impact">
    <div className="editor-sheet-head"><div><span className="eyebrow">Estimated impact</span><h3>{title}</h3></div><button onClick={onCancel} aria-label="Cancel impact preview">×</button></div>
    {diff.length > 0 && <section className="impact-diff"><span className="eyebrow">Change</span>{diff.map((item) => <p key={item.label}><b>{item.label}</b>: {item.before} → {item.after}</p>)}</section>}
    <section className="impact-estimate"><span className="eyebrow">Estimated impact</span>{lines.length ? lines.map((line) => <p key={line}>{line}</p>) : <p>No production artifacts are affected by this change.</p>}</section>
    {impact.warnings?.length > 0 && <div className="naming-notice">{impact.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
    <div className="editor-sheet-actions"><button className="button" onClick={onCancel}>Cancel</button><button className="button primary" disabled={busy} onClick={onApply}>{applyLabel}</button></div>
  </div>;
}

export function EntityDetailAccordion({ id, title, badge, defaultOpen = false, controlledOpen, onOpenChange, children }: { id: string; title: string; badge?: string; defaultOpen?: boolean; controlledOpen?: boolean; onOpenChange?: (open: boolean) => void; children: ReactNode }) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const [visited, setVisited] = useState(defaultOpen || controlledOpen === true);
  const panelId = `entity-section-${id}`;
  useEffect(() => { if (open) setVisited(true); }, [open]);
  return <section className={`entity-detail-accordion${open ? " is-open" : ""}`}>
    <button type="button" className="entity-detail-accordion-header" aria-expanded={open} aria-controls={panelId} onClick={() => { const next = !open; onOpenChange?.(next); if (controlledOpen === undefined) setLocalOpen(next); setVisited(true); }}>
      <span className="entity-detail-accordion-title">{title}</span>
      {badge && <span className="entity-section-badge">{badge}</span>}
      <span className="entity-detail-chevron" aria-hidden="true">⌄</span>
    </button>
    <div id={panelId} className="entity-detail-accordion-body" hidden={!open}>{visited ? children : null}</div>
  </section>;
}

type CanonicalEntitySheetProps = {
  detail: any;
  slug: string;
  navigate: (path: string) => void;
  onClose: () => void;
  onUndo: (id: string) => void;
  onEdit: () => void;
  onDemote?: () => void;
  onSuppress?: () => void;
  onMerge?: (item: any) => void;
  onOpenVisualProfile?: (id: string, name?: string) => void;
  onRevert?: (entry: EntityAuditEntry) => void;
  onManagementOpenChange?: (open: boolean) => void;
  hasActiveChildOverlay?: boolean;
  historyView?: EntityHistoryView;
  managementInitiallyOpen?: boolean;
};

export function CanonicalEntitySheet({ detail, slug, navigate, onClose, onUndo, onEdit, onDemote, onSuppress, onMerge, onOpenVisualProfile, onRevert, onManagementOpenChange, hasActiveChildOverlay = false, historyView, managementInitiallyOpen = false }: CanonicalEntitySheetProps) {
  const entity = detail.entity;
  const activeMerges = (detail.merges ?? []).filter((item: any) => !item.undoneAt);
  const [descExpanded, setDescExpanded] = useState(false);
  const [mergeQuery, setMergeQuery] = useState("");
  const [mergeChoices, setMergeChoices] = useState<any[]>([]);
  const [mergeSearchError, setMergeSearchError] = useState("");
  const mergeSearchRevision = useRef(0);
  const [asOfInput, setAsOfInput] = useState(String(entity.firstAppearance ?? 1));
  const [historyState, setHistoryState] = useState<EntityHistoryView>();
  const [historyError, setHistoryError] = useState("");
  const searchMergeChoices = async () => {
    const query = mergeQuery.trim();
    if (!query) return;
    const revision = ++mergeSearchRevision.current;
    setMergeChoices([]);
    setMergeSearchError("");
    try {
      const response = await api<any>(`/stories/${slug}/story-bible/entities?page=1&pageSize=100&q=${encodeURIComponent(query)}`);
      if (mergeSearchRevision.current === revision) setMergeChoices(response.items.filter((item: any) => item.id !== entity.id));
    } catch (error) {
      if (mergeSearchRevision.current === revision) setMergeSearchError(message(error));
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !hasActiveChildOverlay) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, hasActiveChildOverlay]);

  // Read-only "as of chapter" mode: the same sheet renders the reconstructed
  // historical state; editing, management, and action controls are hidden.
  const history: EntityHistoryView | undefined = historyView ?? historyState;
  const viewing = Boolean(history);
  const historical = viewing && history!.exists;
  const shown = historical ? history!.entity : entity;
  const shownTimeline = viewing ? history!.timeline ?? [] : detail.timeline;
  const shownRelationships = viewing ? history!.relationships ?? [] : detail.relationships;
  const shownRelatedNames = viewing ? history!.relatedNames ?? {} : detail.relatedNames;
  const reviewAttentionCount = (detail.issues?.length ?? 0) + (detail.namingCollisions?.length ?? 0) + (detail.readiness ?? []).filter((row: any) => row.state === "attention").length;
  const shownProvenance = viewing ? history!.provenance ?? [] : entity.provenance;
  const overrides = new Set<string>(viewing ? history!.currentOverrides ?? [] : []);
  const manualFields = new Set<string>(detail.manualFields ?? []);
  const overrideBadge = (field: string) => overrides.has(field) ? <span className="entity-override-badge" title="Current manual editorial value — not the historical state at this chapter">Current editorial override</span> : null;
  const manualBadge = (field: string) => !viewing && manualFields.has(field) ? <span className="entity-manual-badge" title="Protected by a manual editorial override">Manual</span> : null;

  const viewAsOf = async () => {
    const chapter = Number(asOfInput);
    if (!Number.isSafeInteger(chapter) || chapter < 1) { setHistoryError("Enter a valid chapter number."); return; }
    try { setHistoryError(""); setHistoryState(await api<EntityHistoryView>(`/stories/${slug}/story-bible/entities/${entity.id}/history?chapter=${chapter}`)); }
    catch (value) { setHistoryError(message(value)); }
  };

  const hasStatus = shown.status && shown.status !== "unknown";
  const statusLabel = hasStatus ? pretty(shown.status) : undefined;
  const typeLabel = pretty(shown.type);
  const headerSubtitle = statusLabel ? `${typeLabel} · ${statusLabel}` : typeLabel;

  const description = shown.description || "";
  const isLongDescription = description.length > 220 || description.split("\n").length > 3;

  const localizedDisplay = shown.localizedNaming?.fullName
    ? [shown.localizedNaming.fullName, shown.localizedNaming.shortName].filter(Boolean).join(" · ")
    : shown.localizedNaming?.shortName;

  const narrationConfigured = Boolean(shown.preferredNarrationName || shown.localizedNaming?.fullName);

  return (
    <div className="editor-sheet entity-sheet" role="dialog" aria-modal={!hasActiveChildOverlay} aria-labelledby="canonical-entity-title" aria-hidden={hasActiveChildOverlay} inert={hasActiveChildOverlay}>
      <header className="entity-sheet-header">
        <div className="entity-sheet-title-group">
          <h3 id="canonical-entity-title" className="entity-sheet-title">{shown.canonicalName}{manualBadge("canonicalName")}{overrideBadge("canonicalName")}</h3>
          <div className="entity-sheet-subtitle">
            <span>{headerSubtitle}</span>
            {shown.canonicalNameLocked && <span className="entity-locked-badge">🔒 Locked</span>}
          </div>
          {shown.originalName && (
            <div className="entity-sheet-original-name" title="Original name">{shown.originalName}</div>
          )}
          {!viewing && (
            <div className="entity-summary-chips">
              <span className="entity-chip mono">Ch. {entity.firstAppearance}—{entity.lastKnownAppearance}</span>
              <span className={`entity-chip ${narrationConfigured ? "ok" : ""}`}>{narrationConfigured ? "Narration configured" : "Narration not configured"}</span>
              {detail.duplicateSuggestions?.length > 0 && <span className="entity-chip warn">{detail.duplicateSuggestions.length} duplicate candidate{detail.duplicateSuggestions.length === 1 ? "" : "s"}</span>}
              {detail.issues?.length > 0 && <span className="entity-chip warn">{detail.issues.length} continuity issue{detail.issues.length === 1 ? "" : "s"}</span>}
              <span className="entity-chip">{detail.visualProfileExists ? "Visual profile" : "No visual profile"}</span>
              {detail.namingCollisions?.length > 0 && <span className="entity-chip warn">Naming collision</span>}
            </div>
          )}
          <div className="entity-asof-control">
            <label htmlFor="entity-asof-chapter">View as of chapter</label>
            <input id="entity-asof-chapter" type="number" min={1} value={asOfInput} onChange={(event) => setAsOfInput(event.target.value)} />
            <button type="button" className="button" onClick={viewAsOf}>View</button>
            {viewing && <button type="button" className="button" onClick={() => { setHistoryState(undefined); setHistoryError(""); }}>Current</button>}
            {historyError && <small className="entity-asof-error">{historyError}</small>}
          </div>
        </div>
        <button className="entity-sheet-close" onClick={onClose} aria-label="Close entity">×</button>
      </header>

      <div className="entity-sheet-scroll">
        {viewing && (
          <div className="entity-asof-banner">
            <span className="entity-asof-badge">As of chapter {history!.chapter} · read-only</span>
            {history!.requestedChapter && <small>Chapter {history!.requestedChapter} is beyond the imported range; showing chapter {history!.chapter}.</small>}
            {(history!.warnings ?? []).map((warning) => <small key={warning}>{warning}</small>)}
          </div>
        )}

        {viewing && !historical && (
          <div className="naming-notice">
            No record of this entity before chapter {history!.chapter}.{history!.earliestKnownChapter ? ` Earliest known record: chapter ${history!.earliestKnownChapter}.` : ""}
          </div>
        )}

        {(!viewing || historical) && (<>
        <section className="entity-detail-section">
          <span className="section-eyebrow">Identity</span>
          <p className={`entity-description ${descExpanded || !isLongDescription ? "expanded" : "clamped"}`}>
            {description || "No description yet."}
          </p>
          {isLongDescription && (
            <button
              type="button"
              className="entity-expand-toggle"
              onClick={() => setDescExpanded(!descExpanded)}
              aria-expanded={descExpanded}
            >
              {descExpanded ? "Show less" : "Show more"}
            </button>
          )}
        </section>

        <EntityDetailAccordion key={`${entity.id}-visual-evidence`} id="visual-evidence" title="Visual evidence" badge={`${shown.visualEvidence?.length ?? 0} observations`}>
          <VisualEvidencePanel slug={slug} entity={shown} chapter={viewing ? history!.chapter : Number.MAX_SAFE_INTEGER} readOnly={viewing} />
        </EntityDetailAccordion>

        <EntityDetailAccordion key={`${entity.id}-naming`} id="naming" title="Naming & Localization" badge={narrationConfigured ? "Narration configured" : "Needs setup"} defaultOpen>
          <section className="entity-detail-section">
          <div className="compact-naming-grid">
            <div className="compact-naming-row">
              <div className="compact-naming-content">
                <span className="compact-naming-label">Preferred narration name {manualBadge("preferredNarrationName")}{overrideBadge("preferredNarrationName")}</span>
                <span className="compact-naming-value">
                  {shown.preferredNarrationName || <span className="unconfigured-label">Not configured</span>}
                </span>
              </div>
              {!viewing && !entity.preferredNarrationName && (
                <button type="button" className="inline-action-link" onClick={onEdit}>Set →</button>
              )}
            </div>
            <div className="compact-naming-row">
              <div className="compact-naming-content">
                <span className="compact-naming-label">Localized identity {manualBadge("localizedNaming")}{overrideBadge("localizedNaming")}</span>
                <span className="compact-naming-value">
                  {localizedDisplay ? (
                    <>
                      {localizedDisplay}
                      {shown.localizedNaming?.locale && (
                        <small className="compact-naming-meta"> · {shown.localizedNaming.locale}</small>
                      )}
                    </>
                  ) : (
                    <span className="unconfigured-label">Not configured</span>
                  )}
                </span>
              </div>
              {!viewing && (
                <button
                  type="button"
                  className="inline-action-link"
                  onClick={() => navigate(`/stories/${slug}/names?entity=${entity.id}`)}
                >
                  Configure →
                </button>
              )}
            </div>
            <div className="compact-naming-row">
              <div className="compact-naming-content">
                <span className="compact-naming-label">Pronunciation {manualBadge("pronunciation")}{overrideBadge("pronunciation")}</span>
                <span className="compact-naming-value">
                  {shown.pronunciation ? (shown.pronunciation.customPronunciation ?? shown.pronunciation.phoneticHint ?? shown.pronunciation.ipa ?? "Configured") : <span className="unconfigured-label">Not configured</span>}
                </span>
              </div>
            </div>
          </div>
          {!viewing && (
            <button className="button" onClick={() => navigate(`/stories/${slug}/names?entity=${entity.id}`)}>
              Open localization
            </button>
          )}
          {shown.aliases.length > 0 ? (
            <div className="entity-detail-subsection">
              <span className="entity-subsection-title">Aliases</span>
              <div className="alias-chips">
                {shown.aliases.map((alias: string) => {
                  const rule = (shown.aliasNarrationRules ?? []).find((item: any) => item.alias.toLocaleLowerCase() === alias.toLocaleLowerCase());
                  const hasOverride = rule && rule.behavior !== "no_override";
                  return <span key={alias} className="alias-chip" title={namingLabel(alias, shown)}>{alias}{hasOverride && <span className="alias-chip-badge">narration</span>}</span>;
                })}
                {manualBadge("aliases")}{overrideBadge("aliases")}
              </div>
            </div>
          ) : <p className="empty-text">No aliases recorded.</p>}
          </section>
        </EntityDetailAccordion>

        <EntityDetailAccordion key={`${entity.id}-story-information`} id="story-information" title="Story Information" badge={`Ch. ${shown.firstAppearance}–${shown.lastKnownAppearance}`} defaultOpen>
          <section className="entity-detail-section">
          <dl className="meta-compact-list">
            <div className="meta-compact-row"><dt>Type {manualBadge("type")}{overrideBadge("type")}</dt><dd>{pretty(shown.type)}</dd></div>
            {hasStatus && <div className="meta-compact-row"><dt>Status {manualBadge("status")}{overrideBadge("status")}</dt><dd>{pretty(shown.status)}</dd></div>}
            <div className="meta-compact-row">
              <dt>Appearances</dt><dd className="mono">Ch. {shown.firstAppearance}—{shown.lastKnownAppearance}</dd>
            </div>
            <div className="meta-compact-row"><dt>Origin</dt><dd>{pretty(shown.origin)}{shown.canonicalNameLocked ? " · Locked" : ""}</dd></div>
          </dl>
          {shown.notes && <div className="entity-detail-subsection"><span className="entity-subsection-title">Notes {manualBadge("notes")}{overrideBadge("notes")}</span><p className="entity-notes-copy">{shown.notes}</p></div>}
          {!viewing && detail.relatedReferences?.length > 0 && (
            <details className="related-references">
              <summary>Related references ({detail.relatedReferences.length})</summary>
              <div className="related-references-list">
                {detail.relatedReferences.map((ref: any) => (
                  <div key={ref.id} className="related-ref-row">
                    <div>
                      <b>{ref.name}</b>
                      {ref.originalName && <small> · {ref.originalName}</small>}
                    </div>
                    <span>{pretty(ref.type)}</span>
                    <span className="mono">Ch. {ref.firstSeenChapter}—{ref.lastSeenChapter}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
          </section>
        </EntityDetailAccordion>

        {shownRelationships?.length > 0 && <EntityDetailAccordion key={`${entity.id}-relationships`} id="relationships" title="Relationships" badge={`${shownRelationships.length} relationship${shownRelationships.length === 1 ? "" : "s"}`}>
          <div className="entity-history">
            {shownRelationships.map((item: any) => (
              <div key={item.id}>
                <b>{shownRelatedNames[item.sourceEntityId] ?? item.sourceEntityId}</b>
                <span>{item.type} → {shownRelatedNames[item.targetEntityId] ?? item.targetEntityId}</span>
                <small>Ch. {item.startChapter}{item.endChapter ? `—${item.endChapter}` : " · current"}</small>
              </div>
            ))}
          </div>
        </EntityDetailAccordion>}

        {shownTimeline?.length > 0 && <EntityDetailAccordion key={`${entity.id}-timeline`} id="timeline" title="Timeline" badge={`${shownTimeline.length} event${shownTimeline.length === 1 ? "" : "s"}`}>
          <div className="entity-history">
            {shownTimeline.map((item: any) => (
              <button key={item.id} onClick={() => navigate(`/stories/${slug}/chapters/${item.chapter}`)}>
                <b>Ch. {item.chapter}</b>
                <span>{pretty(item.type)}</span>
                <p>{item.summary}</p>
              </button>
            ))}
          </div>
        </EntityDetailAccordion>}

        {!viewing && <EntityDetailAccordion key={`${entity.id}-visual-canon`} id="visual-canon" title="Visual Canon" badge={detail.visualProfileExists ? "Profile available" : "No visual profile"}>
          <section className="entity-detail-section">
            <p className="empty-text">{detail.visualProfileExists ? "A Visual Profile exists for this entity." : "No Visual Profile yet."}{entity.visualProfilePolicy?.mode === "skip" ? " Policy: skipped by editorial decision." : ""} {manualBadge("visualProfilePolicy")}</p>
            <button className="button" onClick={() => onOpenVisualProfile?.(entity.id, entity.canonicalName)}>Visual Profile</button>
          </section>
        </EntityDetailAccordion>}

        {!viewing && reviewAttentionCount > 0 && (
          <EntityDetailAccordion key={`${entity.id}-issues-review`} id="issues-review" title="Issues & Review" badge={`${reviewAttentionCount} ${reviewAttentionCount === 1 ? "item" : "items"}`}>
            <section className="entity-detail-section">
            {detail.namingCollisions?.map((collision: any) => (
              <div className="entity-issue-notice" key={collision.id}><b>Naming collision</b><p>{collision.hasMergeRelationship ? "These records already share a merge relationship. " : ""}{collision.reason}</p>{collision.entities.filter((candidate: any) => candidate.id !== entity.id).map((candidate: any) => <span className="entity-collision-entity" key={candidate.id}>{candidate.canonicalName} · {pretty(candidate.type)}{candidate.field ? ` · via ${candidate.field}` : ""}</span>)}</div>
            ))}
            {detail.issues?.length > 0 && (
              <button className="button warn-badge-button" onClick={() => navigate(`/stories/${slug}/continuity?entity=${entity.id}`)}>
                {detail.issues.length} continuity issues
              </button>
            )}
            {(detail.readiness ?? []).filter((row: any) => row.state === "attention").map((row: any) => (
              <p key={row.key} className="empty-text">⚠ {row.label}{row.detail ? ` — ${row.detail}` : ""}</p>
            ))}
            </section>
          </EntityDetailAccordion>
        )}

        {!viewing && <EntityDetailAccordion key={`${entity.id}-where-used`} id="where-used" title="Where Used" badge="Chapter references"><EntityUsageSection slug={slug} entityId={entity.id} navigate={navigate} expandedByDefault /></EntityDetailAccordion>}
        {!viewing && <EntityDetailAccordion key={`${entity.id}-change-history`} id="change-history" title="Change History" badge="Audit trail"><EntityHistorySection slug={slug} entityId={entity.id} onRevert={onRevert} expandedByDefault /></EntityDetailAccordion>}

        {shownProvenance?.length > 0 && <EntityDetailAccordion key={`${entity.id}-provenance`} id="provenance" title="Provenance" badge={`${shownProvenance.length} records`}>
          <section className="entity-detail-section">
            <div className="provenance-grid">
              {shownProvenance.map((item: any, index: number) => (
                <button key={`${item.chapter}-${index}`} onClick={() => navigate(`/stories/${slug}/chapters/${item.chapter}`)}>
                  Chapter {item.chapter}
                  <small>{pretty(item.kind)} · Origin: {pretty(item.origin ?? "automatic")}{item.confidence !== undefined ? ` · Confidence: ${Math.round(item.confidence * 100)}%` : ""}</small>
                </button>
              ))}
            </div>
          </section>
        </EntityDetailAccordion>}

        {!viewing && (onDemote || onSuppress || onMerge || activeMerges.length > 0) && <EntityDetailAccordion key={`${entity.id}-entity-management`} id="entity-management" title="Entity Management" badge={detail.duplicateSuggestions?.length ? `${detail.duplicateSuggestions.length} duplicate candidate${detail.duplicateSuggestions.length === 1 ? "" : "s"}` : "Advanced"} controlledOpen={managementInitiallyOpen} onOpenChange={onManagementOpenChange}>
          <div className="entity-management-content">
            <div className="entity-management-intro"><h4>Advanced entity controls</h4><p>Changes here affect canonical Story Bible state. Destructive actions always require confirmation.</p></div>

            {detail.duplicateSuggestions?.length > 0 && <section className="entity-management-group">
              <div className="entity-management-warning"><b>Possible duplicate identities found</b><p>Compare entity type, aliases, chapter evidence, and narration mappings before merging.</p></div>
              <div className="entity-management-candidates">{detail.duplicateSuggestions.map((item: any) => {
                const candidate = item.entities.find((entry: any) => entry.id !== entity.id);
                return <article key={item.id} className="entity-management-candidate">
                  <span className="entity-candidate-kicker">Possible duplicate</span>
                  <b>{candidate?.name ?? "Unknown entity"}</b>
                  <small>{candidate ? `${candidate.type ? pretty(candidate.type) : "Entity"} · ${item.reason ?? "Matching identity evidence"}` : (item.reason ?? "Matching identity evidence")}</small>
                  {item.confidence !== undefined && <small>{Math.round(item.confidence * 100)}% match confidence</small>}
                  {onMerge && <button type="button" className="button" onClick={() => onMerge(item)}>Compare &amp; merge</button>}
                </article>;
              })}</div>
            </section>}

            {onMerge && <section className="entity-management-group">
              <h4>Merge with another entity</h4><p>Search for a canonical entity that is not listed above.</p>
              <div className="entity-management-search"><input id="merge-entity-search" value={mergeQuery} onChange={(event) => { mergeSearchRevision.current++; setMergeQuery(event.target.value); setMergeChoices([]); setMergeSearchError(""); }} placeholder="Search canonical name" /><button type="button" className="button" disabled={!mergeQuery.trim()} onClick={searchMergeChoices}>Find</button></div>
              {mergeSearchError && <small className="entity-management-error" role="alert">{mergeSearchError}</small>}
              {mergeChoices.length > 0 && <div className="entity-management-candidates">{mergeChoices.map((candidate: any) => <article key={candidate.id} className="entity-management-candidate search-result">
                <b>{candidate.canonicalName}</b><small>{pretty(candidate.type)} · Ch. {candidate.firstAppearance}–{candidate.lastKnownAppearance}</small>
                <button type="button" className="button" onClick={() => onMerge({ entities: [{ id: entity.id, name: entity.canonicalName }, { id: candidate.id, name: candidate.canonicalName }], reason: "Manual identity merge" })}>Compare &amp; merge</button>
              </article>)}</div>}
            </section>}

            {onDemote && <section className="entity-management-group entity-canonical-status">
              <h4>Canonical status</h4><p>This entity is currently canonical.</p>
              {entity.canonicalNameLocked ? <span className="locked-demote-notice">🔒 This entity is locked and cannot be converted.</span> : <button type="button" className="button" onClick={onDemote}>Convert to minor reference</button>}
            </section>}

            {activeMerges.length > 0 && <section className="entity-management-group">
              <h4>Merge history</h4>{activeMerges.map((item: any) => <button className="button merge-undo" key={item.id} onClick={() => onUndo(item.id)}>Undo merge · {item.reason}</button>)}
            </section>}

            {onSuppress && <section className="entity-danger-zone">
              <h4>Danger zone</h4><p>Remove this entity from the active canonical Story Bible. Historical evidence is preserved.</p>
              <button type="button" className="button danger" onClick={onSuppress}>Remove canonical entity…</button>
            </section>}
          </div>
        </EntityDetailAccordion>}
        </>)}
      </div>

      {!viewing && (
      <footer className="entity-sheet-actions" aria-label="Canonical entity actions">
        <button className="button primary full-width" onClick={onEdit}>Edit entity</button>
      </footer>
      )}
    </div>
  );
}

const ENTITY_USAGE_KIND_LABEL: Record<string, string> = { provenance: "Story Bible", qa: "QA", continuity: "Continuity", scene: "Scene", "visual-profile": "Visual Profile" };

/** "Used in" panel: aggregated entity usage, loaded lazily on expand. */
export function EntityUsageSection({ slug, entityId, navigate, expandedByDefault = false }: { slug: string; entityId: string; navigate: (href: string) => void; expandedByDefault?: boolean }) {
  const [expanded, setExpanded] = useState(expandedByDefault);
  const [data, setData] = useState<EntityUsagePage>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);
  const load = async (page: number) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try { setData(await api<EntityUsagePage>(`/stories/${slug}/story-bible/entities/${entityId}/usage?page=${page}&pageSize=25`)); setError(""); }
    catch (value) { setError(message(value)); }
    finally { inFlight.current = false; setLoading(false); }
  };
  useEffect(() => { if (expanded && !data && !error && !loading) void load(1); }, [expanded, data, error, loading, slug, entityId]);
  const [first, last] = data?.summary.sourceChapters ?? [];
  return (
    <section className="entity-detail-section">
      {!expandedByDefault && <span className="section-eyebrow">Used in</span>}
      {!expanded && <button type="button" className="button" onClick={() => setExpanded(true)}>View where this entity is used</button>}
      {expanded && error && <div className="entity-lazy-load-error" role="alert"><p className="empty-text">{error}</p><button type="button" className="button" disabled={loading} onClick={() => void load(1)}>Retry</button></div>}
      {expanded && loading && !data && <p className="empty-text">Loading usage…</p>}
      {expanded && data && (
        <>
          <p className="entity-usage-summary">
            Appears Ch. <button type="button" className="inline-action-link" onClick={() => navigate(`/stories/${slug}/chapters/${first}`)}>{first}</button>
            {" — "}
            <button type="button" className="inline-action-link" onClick={() => navigate(`/stories/${slug}/chapters/${last}`)}>{last}</button>
            {` · ${data.summary.translationChapters ?? 0} translated · ${data.summary.narrationChapters ?? 0} narrated · ${data.summary.qaFindings} QA · ${data.summary.continuityFindings} continuity · ${data.summary.scenes} scenes${data.summary.visualProfile ? " · Visual Profile" : ""}`}
          </p>
          <div className="entity-history">
            {data.uses.map((use, index) => (
              <button key={`${use.kind}-${use.chapter ?? 0}-${use.sceneId ?? index}`} onClick={() => navigate(use.href)}>
                <b>{use.chapter ? `Ch. ${use.chapter}` : "—"}</b>
                <span>{ENTITY_USAGE_KIND_LABEL[use.kind] ?? use.kind}</span>
                <p>{use.label}{use.excerpt ? ` — ${use.excerpt}` : ""}</p>
              </button>
            ))}
            {!data.uses.length && <p className="empty-text">No recorded uses beyond the canonical record.</p>}
          </div>
          {data.total > data.pageSize && (
            <div className="field-row">
              <button type="button" className="button" disabled={data.page <= 1} onClick={() => void load(data.page - 1)}>Previous</button>
              <small>Page {data.page} · {data.total} uses</small>
              <button type="button" className="button" disabled={data.page * data.pageSize >= data.total} onClick={() => void load(data.page + 1)}>Next</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const ENTITY_AUDIT_ACTION_LABEL: Record<string, string> = {
  created: "Created", updated: "Updated", renamed: "Renamed", type_changed: "Type changed",
  narration_mapping_changed: "Narration mapping changed", localized_naming_changed: "Localized naming changed",
  locked: "Locked", unlocked: "Unlocked", merged: "Merged", merge_undone: "Merge undone",
  demoted: "Demoted to minor reference", promoted: "Promoted to canonical entity",
  suppressed: "Removed (suppressed)", restored: "Restored", visual_profile_policy_changed: "Visual Profile policy changed",
};
const ENTITY_AUDIT_FIELD_LABEL: Record<string, string> = {
  canonicalName: "canonical name", type: "type", aliases: "aliases", canonicalNameLocked: "name lock",
  notes: "notes", status: "status", preferredNarrationName: "preferred narration name",
  aliasNarrationRules: "alias narration rules", localizedNaming: "localized naming",
  pronunciation: "pronunciation", visualProfilePolicy: "Visual Profile policy",
};
/** Fields whose recorded `before` value can be safely re-applied through the normal update path. */
const ENTITY_AUDIT_REVERTABLE_FIELDS = new Set(["canonicalName", "preferredNarrationName", "type", "notes", "canonicalNameLocked", "status"]);
const ENTITY_AUDIT_REVERTABLE_ACTIONS = new Set(["updated", "renamed", "type_changed", "narration_mapping_changed", "locked", "unlocked"]);

export function entityAuditRevertPatch(entry: EntityAuditEntry): Record<string, unknown> | undefined {
  if (!ENTITY_AUDIT_REVERTABLE_ACTIONS.has(entry.action) || !entry.before) return undefined;
  const keys = Object.keys(entry.before);
  if (!keys.length || keys.some((key) => !ENTITY_AUDIT_REVERTABLE_FIELDS.has(key))) return undefined;
  return entry.before;
}

function auditValueLabel(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.map((item) => auditValueLabel(item)).join(", ") : "—";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.fullName === "string" || typeof record.shortName === "string") return [record.fullName, record.shortName].filter(Boolean).join(" · ") || "—";
    if (typeof record.mode === "string") return String(record.mode);
    return "configured";
  }
  return String(value);
}

export function entityAuditDeltaLabel(entry: EntityAuditEntry): string | undefined {
  const keys = Object.keys(entry.after ?? entry.before ?? {}).filter((key) => ENTITY_AUDIT_FIELD_LABEL[key]);
  if (!keys.length) return undefined;
  return keys.map((key) => `${ENTITY_AUDIT_FIELD_LABEL[key]}: ${auditValueLabel(entry.before?.[key])} → ${auditValueLabel(entry.after?.[key])}`).join(" · ");
}

/** "Change History" panel: append-only audit entries merged with the pre-existing historical record. */
export function EntityHistorySection({ slug, entityId, onRevert, expandedByDefault = false }: { slug: string; entityId: string; onRevert?: (entry: EntityAuditEntry) => void; expandedByDefault?: boolean }) {
  const [expanded, setExpanded] = useState(expandedByDefault);
  const [data, setData] = useState<EntityAuditPage>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);
  const load = async (page: number) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try { setData(await api<EntityAuditPage>(`/stories/${slug}/story-bible/entities/${entityId}/audit?page=${page}&pageSize=25`)); setError(""); }
    catch (value) { setError(message(value)); }
    finally { inFlight.current = false; setLoading(false); }
  };
  useEffect(() => { if (expanded && !data && !error && !loading) void load(1); }, [expanded, data, error, loading, slug, entityId]);
  return (
    <section className="entity-detail-section">
      {!expandedByDefault && <span className="section-eyebrow">Change History</span>}
      {!expanded && <button type="button" className="button" onClick={() => setExpanded(true)}>View change history</button>}
      {expanded && error && <div className="entity-lazy-load-error" role="alert"><p className="empty-text">{error}</p><button type="button" className="button" disabled={loading} onClick={() => void load(1)}>Retry</button></div>}
      {expanded && loading && !data && <p className="empty-text">Loading history…</p>}
      {expanded && data && (
        <>
          <div className="entity-history">
            {data.entries.map((entry) => (
              <div key={entry.id} className="entity-audit-entry">
                <b>{ENTITY_AUDIT_ACTION_LABEL[entry.action] ?? pretty(entry.action)}</b>
                <span>{entry.source}{entry.timestamp ? ` · ${new Date(entry.timestamp).toLocaleString()}` : ""}</span>
                <p>{entityAuditDeltaLabel(entry) ?? entry.reason ?? ""}</p>
                {onRevert && entityAuditRevertPatch(entry) && (
                  <button type="button" className="inline-action-link" onClick={() => onRevert(entry)}>Revert this change</button>
                )}
              </div>
            ))}
            {!data.entries.length && !data.historical.length && <p className="empty-text">No recorded changes yet.</p>}
            {data.historical.map((item, index) => (
              <div key={`historical-${index}`} className="entity-audit-entry">
                <b>{item.label}</b>
                <span>{[item.source, item.timestamp ? new Date(item.timestamp).toLocaleString() : undefined].filter(Boolean).join(" · ")}</span>
              </div>
            ))}
          </div>
          {data.total > data.pageSize && (
            <div className="field-row">
              <button type="button" className="button" disabled={data.page <= 1} onClick={() => void load(data.page - 1)}>Previous</button>
              <small>Page {data.page} · {data.total} changes</small>
              <button type="button" className="button" disabled={data.page * data.pageSize >= data.total} onClick={() => void load(data.page + 1)}>Next</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function EntityStatusField({ type, value, onChange }: { type: string; value: string | undefined; onChange: (value: string) => void }) {
  const current = value ?? "unknown";
  const standard = current !== "" && isStandardEntityStatus(type, current);
  const selected = standard ? getEntityStatusOptions(type).find((option) => option.value === statusKey(current))?.value ?? "unknown" : "custom";
  return <Field label="Current status"><select aria-label="Current status" value={selected} onChange={(event) => onChange(event.target.value === "custom" ? "" : event.target.value)}>{getEntityStatusOptions(type).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}<option value="custom">Custom…</option></select>{selected === "custom" && <><input aria-label="Custom current status" value={value ?? ""} placeholder="Story-specific status" maxLength={500} onChange={(event) => onChange(event.target.value)} /><small>Use a concise story-specific state when no standard status fits.</small></>}</Field>;
}
function CanonicalEntityEditor({ slug, value, onChange, onClose, onSave }: any) {
  const editAlias = (index: number, patch: any) => onChange({ ...value, aliasDrafts: value.aliasDrafts.map((item: any, position: number) => position === index ? { ...item, ...patch } : item) });
  const needsCustomStatus = value.status === "" || (!isStandardEntityStatus(value.type, value.status ?? "unknown") && !String(value.status ?? "").trim());
  return <div className="editor-sheet naming-editor" role="dialog" aria-modal="true" aria-label="Edit canonical record"><div className="editor-sheet-head"><div><span className="eyebrow">Protected manual overlay</span><h3>Edit canonical record</h3></div><button onClick={onClose} aria-label="Close editor">×</button></div><Field label="Entity Type"><select aria-label="Entity Type" value={value.type} onChange={(event) => { const nextType = event.target.value; const known = ["character", "location", "organization", "ability", "item", "concept", "other"].some((type) => isStandardEntityStatus(type, value.status ?? "unknown")); const status = known && !isStandardEntityStatus(nextType, value.status ?? "unknown") ? "unknown" : value.status; onChange({ ...value, type: nextType, status }); }}><option value="character">Character</option><option value="location">Location</option><option value="item">Item</option><option value="organization">Organization</option><option value="ability">Ability</option><option value="concept">Concept</option><option value="other">Other</option></select><small>Protected manual type correction. Existing Visual Profile data is preserved; review it before regenerating visual canon.</small></Field>{value.visualProfileExists && value.originalType !== value.type && <div className="naming-notice">The existing Visual Profile will be preserved but moved to draft. Review its type and visual canon before regenerating artwork.</div>}<Field label="Canonical name"><input value={value.canonicalName} onChange={(event) => onChange({ ...value, canonicalName: event.target.value })} /></Field><label className="toggle-line"><input type="checkbox" checked={value.canonicalNameLocked} onChange={(event) => onChange({ ...value, canonicalNameLocked: event.target.checked })} /> Lock canonical name against automatic renaming</label><div className="preferred-name-field"><Field label="Preferred Narration Name"><input value={value.preferredNarrationName} placeholder={value.canonicalName} onChange={(event) => onChange({ ...value, preferredNarrationName: event.target.value })} /></Field><small>A strong, context-aware preference for newly generated narration. Source text and manual narration remain untouched.</small></div><div className="alias-editor-head"><div><span className="eyebrow">Identity aliases</span><p>Choose how each alias should normally read in narration.</p></div><button className="button" onClick={() => onChange({ ...value, aliasDrafts: [...value.aliasDrafts, { alias: "", behavior: "no_override", replacement: "" }] })}>Add alias</button></div><div className="alias-rule-editor">{value.aliasDrafts.map((item: any, index: number) => <div className="alias-rule-row" key={index}><input aria-label={`Alias ${index + 1}`} value={item.alias} placeholder="Alias" onChange={(event) => editAlias(index, { alias: event.target.value })} /><select aria-label={`Narration behavior for alias ${index + 1}`} value={item.behavior} onChange={(event) => editAlias(index, { behavior: event.target.value })}><option value="no_override">No override</option><option value="use_preferred">Use Preferred Narration Name</option><option value="custom">Custom replacement</option></select>{item.behavior === "custom" && <input aria-label={`Custom replacement for alias ${index + 1}`} value={item.replacement} placeholder="Narration phrase" onChange={(event) => editAlias(index, { replacement: event.target.value })} />}<button className="alias-remove" aria-label={`Remove alias ${item.alias || index + 1}`} onClick={() => onChange({ ...value, aliasDrafts: value.aliasDrafts.filter((_: any, position: number) => position !== index) })}>×</button></div>)}</div><PronunciationFields value={value.pronunciation} onChange={(pronunciation) => onChange({ ...value, pronunciation })} /><PronunciationActions slug={slug} id={value.id} locked={Boolean(value.pronunciation?.locked || value.pronunciation?.source === "manual")} onEnriched={(pronunciation) => onChange((current: any) => current?.id === value.id && JSON.stringify(current.pronunciation) === JSON.stringify(value.pronunciation) ? { ...current, pronunciation } : current)} /><EntityStatusField type={value.type} value={value.status} onChange={(status) => onChange({ ...value, status })} /><Field label="Manual notes"><textarea value={value.notes} onChange={(event) => onChange({ ...value, notes: event.target.value })} /></Field><div className="editor-sheet-actions"><button className="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={needsCustomStatus} onClick={onSave}>Save protected record</button></div></div>;
}

export function ContinuityPage({ slug, navigate }: { slug: string; navigate: (path: string) => void }) {
  const [summary, setSummary] = useState<any>();
  const [view, setView] = useState<any>();
  const [status, setStatus] = useState("open");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [pageError, setPageError] = useState("");
  const [revision, setRevision] = useState(0);
  const pageRequest = useRef(0);
  const summaryRequest = useRef(0);
  const entityFilter = new URLSearchParams(location.search).get("entity");
  useEffect(() => {
    const request = ++summaryRequest.current;
    void api<any>(`/stories/${slug}/continuity/summary`).then((value) => { if (request === summaryRequest.current) setSummary(value); }).catch((value) => { if (request === summaryRequest.current) setError(message(value)); });
    return () => { summaryRequest.current++; };
  }, [slug, revision]);
  useEffect(() => {
    const request = ++pageRequest.current;
    const params = new URLSearchParams({ status, page: String(page), pageSize: "25" });
    if (entityFilter) params.set("entity", entityFilter);
    setPageError("");
    void api<any>(`/stories/${slug}/continuity?${params}`).then((value) => { if (request === pageRequest.current) setView(value); }).catch((value) => { if (request === pageRequest.current) setPageError(message(value)); });
    return () => { pageRequest.current++; };
  }, [slug, status, page, entityFilter, revision]);
  const resolve = async (id: string, resolution: string) => {
    try {
      const note = resolution === "dismissed" ? prompt("Optional reason for dismissing this finding:") ?? undefined : undefined;
      await put(`/stories/${slug}/continuity/${id}`, { resolution, note });
      setView((current: any) => current ? { ...current, items: status === "open" ? current.items.filter((item: any) => item.id !== id) : current.items.map((item: any) => item.id === id ? { ...item, status: resolution === "dismissed" ? "dismissed" : "resolved", resolutionNote: note } : item) } : current);
      setRevision((value) => value + 1);
    } catch (value) { setError(message(value)); }
  };
  if (!view && !summary) return error || pageError ? <LoadFailure error={error || pageError} /> : <Loading />;
  const counts = summary?.counts ?? view?.counts ?? { open: 0, resolved: 0 };
  return <section className="page continuity-page">
    <div className="section-heading"><div><span className="eyebrow">Historical consistency</span><h2>Continuity Review</h2><p>Review contradictions without silently rewriting canonical history.</p></div><button className="button" onClick={() => navigate(`/stories/${slug}/bible`)}>Open Story Bible</button></div>
    {error && <ErrorBox text={error} />}{pageError && <ErrorBox text={pageError} />}
    {(summary?.needsReanalysis ?? view?.needsReanalysis) && <div className="naming-notice">Canonical identities changed since this continuity review. Re-run analysis before acting on older findings; no paid work starts automatically.</div>}
    <div className="review-summary"><span><b>{counts.open}</b> open</span><span><b>{counts.resolved}</b> resolved</span><span><b>{summary?.analyzedThroughChapter ?? view?.analyzedThroughChapter ?? 0}</b> analyzed through</span></div>
    <div className="segmented"><button className={status === "open" ? "active" : ""} onClick={() => { setStatus("open"); setPage(1); }}>Open</button><button className={status === "all" ? "active" : ""} onClick={() => { setStatus("all"); setPage(1); }}>All findings</button><button className={status === "dismissed" ? "active" : ""} onClick={() => { setStatus("dismissed"); setPage(1); }}>Dismissed</button></div>
    {entityFilter && <div className="naming-notice">Showing findings for {view?.names?.[entityFilter] ?? entityFilter}. <button className="inline-action-link" onClick={() => navigate(`/stories/${slug}/continuity`)}>Show all →</button></div>}
    {view && <><Pagination position="top" page={view.page} pages={view.pages} total={view.total} itemLabel="findings" onPrevious={() => setPage(view.page - 1)} onNext={() => setPage(view.page + 1)} /><div className="continuity-list">{view.items.map((finding: any) => <article key={finding.id} className={`continuity-card ${finding.severity}`}><header><span className="eyebrow">{pretty(finding.type)}</span><Status status={finding.severity === "critical" ? "fail" : "warn"} label={pretty(finding.severity)} /></header><h3>{finding.entityIds.map((id: string, index: number) => <span key={id}>{index > 0 && " · "}<button className="entity-link" onClick={() => navigate(`/stories/${slug}/bible?entity=${id}`)}>{view.names[id] ?? id}</button></span>)}</h3><p>{finding.explanation}</p><div className="chapter-links">{finding.chapters.map((chapter: number) => <button key={chapter} onClick={() => navigate(`/stories/${slug}/chapters/${chapter}`)}>Open Chapter {chapter}</button>)}</div><details><summary>Why the Bible believes this</summary>{finding.supportingFacts.map((fact: any, index: number) => <div key={index}><b>Chapter {fact.chapter}</b><span>{fact.summary}</span><small>{pretty(fact.provenanceKind)}</small></div>)}</details>{finding.status === "open" ? <div className="resolution-actions">{finding.type === "status_conflict" && <button onClick={() => void resolve(finding.id, "accepted_new")}>Accept newest status</button>}<button onClick={() => void resolve(finding.id, "kept_existing")}>Keep canonical</button><button onClick={() => void resolve(finding.id, "intentional")}>Mark intentional</button><button onClick={() => navigate(`/stories/${slug}/bible`)}>Correct Bible</button>{finding.type === "identity_alias_ambiguity" && <button onClick={() => void resolve(finding.id, "merged")}>Merge these entities</button>}<button onClick={() => void resolve(finding.id, "dismissed")}>Dismiss false positive</button></div> : <div className="resolution-note"><b>{pretty(finding.status)}</b>{finding.resolutionNote && <span>{finding.resolutionNote}</span>}</div>}</article>)}</div>{!view.items.length && <Empty title="No continuity findings here" text="Analysis runs during production and never makes paid calls from this page." />}<Pagination position="bottom" page={view.page} pages={view.pages} total={view.total} itemLabel="findings" onPrevious={() => setPage(view.page - 1)} onNext={() => setPage(view.page + 1)} /></>}
  </section>;
}

function BibleFields({ category, value, onChange }: { category: string; value: any; onChange: (value: any) => void }) { const field = (key: string, label: string) => <Field label={label}><input value={value[key] ?? ""} onChange={(event) => onChange({ ...value, [key]: event.target.value })} /></Field>; return <div className="bible-form">{category === "relationships" ? <>{field("subject", "Subject")}{field("relationship", "Relationship")}{field("object", "Object")}</> : category === "translationTerms" ? <>{field("original", "Original term")}{field("canonicalEnglish", "Canonical English")}<Field label="Notes"><textarea value={value.notes ?? ""} onChange={(event) => onChange({ ...value, notes: event.target.value })} /></Field></> : <>{field("canonicalEnglishName", "Canonical English name")}{field("originalName", "Original name")}<Field label="Description"><textarea value={value.description ?? ""} onChange={(event) => onChange({ ...value, description: event.target.value })} /></Field></>}<div className="field-row"><Field label="First seen"><input type="number" min="1" value={value.firstSeenChapter} onChange={(event) => onChange({ ...value, firstSeenChapter: Number(event.target.value) })} /></Field><Field label="Last updated"><input type="number" min="1" value={value.lastSeenChapter} onChange={(event) => onChange({ ...value, lastSeenChapter: Number(event.target.value) })} /></Field></div></div>; }
function newBibleValue(category: string) { const chapters = { firstSeenChapter: 1, lastSeenChapter: 1 }; if (category === "relationships") return { subject: "", relationship: "", object: "", ...chapters }; if (category === "translationTerms") return { original: "", canonicalEnglish: "", notes: "", ...chapters }; return { canonicalEnglishName: "", originalName: "", description: "", ...(category === "characters" ? { aliases: [], pronouns: [] } : {}), ...chapters }; }
function bibleEntryTitle(value: any) { return value.canonicalEnglishName ?? value.canonicalEnglish ?? `${value.subject} → ${value.object}`; }

function getSceneProductionState(scene: Scene, artworkCurrent = false): { label: string; cls: string } {
  if (scene.disabled) return { label: "Disabled", cls: "state-disabled" };
  if (artworkCurrent && scene.artwork?.review === "approved" && scene.imageUrl && scene.artwork?.status === "complete") {
    return { label: "Video Ready", cls: "state-video-ready" };
  }
  if (scene.artwork?.review === "approved") {
    return { label: "Approved", cls: "state-approved" };
  }
  if (scene.artwork?.review === "needs-regeneration" || (scene.artwork?.status === "complete" && scene.artwork?.review === "unreviewed")) {
    return { label: "Needs Review", cls: "state-needs-review" };
  }
  if (scene.artwork?.status === "running") {
    return { label: "Generating", cls: "state-generating" };
  }
  if (scene.artwork?.status === "complete") {
    return { label: "Generated", cls: "state-generated" };
  }
  if (scene.visualPrompt) {
    return { label: "Prompt Ready", cls: "state-prompt-ready" };
  }
  return { label: "Planned", cls: "state-planned" };
}

export type ArtworkEstimate = { count: number; provider: string; model: string };

export function ArtworkEstimateSummary({ estimate }: { estimate: ArtworkEstimate }) {
  return (
    <div className="cost-estimate">
      <b>{estimate.count}</b>
      <span>scene{estimate.count === 1 ? "" : "s"} to generate</span>
      <small>{estimate.provider}{estimate.model ? ` · ${estimate.model}` : ""} · paid image request{estimate.count === 1 ? "" : "s"} · dry run only — nothing generated.</small>
    </div>
  );
}

export function artworkModelOptionsFor(provider: string, currentModel: string): string[] {
  const entry = ARTWORK_PROVIDERS.find((item) => item.name === provider);
  if (!entry) return currentModel ? [currentModel] : [];
  return entry.models.includes(currentModel) ? entry.models : [...entry.models, currentModel];
}

// Mirrors src/artwork/resolution.ts TARGET_DIMENSIONS for the 16:9 video canvas.
export const VIDEO_RESOLUTION_PRESETS: Record<VideoResolution, { width: number; height: number; label: string }> = {
  "720p": { width: 1280, height: 720, label: "720p" },
  "1080p": { width: 1920, height: 1080, label: "1080p" },
  "1440p": { width: 2560, height: 1440, label: "1440p" },
  "2160p": { width: 3840, height: 2160, label: "4K (2160p)" },
};
export type VideoResolutionPreset = VideoResolution | "custom";

/** A story without a resolution preset uses its explicit custom dimensions. */
export function videoResolutionFor(video: VideoSettings): VideoResolutionPreset {
  return video.resolution ?? "custom";
}

/** Selecting a preset drives width/height; "custom" keeps explicit dims and drops the preset. */
export function applyVideoResolutionPreset(video: VideoSettings, preset: VideoResolutionPreset): VideoSettings {
  if (preset === "custom") return { ...video, resolution: undefined };
  const target = VIDEO_RESOLUTION_PRESETS[preset];
  return { ...video, resolution: preset, width: target.width, height: target.height };
}

/** Re-upscale only makes sense when a non-native target is set and upscaling is allowed. */
export function reupscaleAvailable(artwork: Pick<ArtworkSettings, "outputResolution" | "upscaling">): boolean {
  return artwork.outputResolution !== "native" && artwork.upscaling !== "off";
}

/** Compact pre-generation estimate line. Never shown when behavior is unknown. */
export function resolvedBehaviorSummary(behavior: ResolvedArtworkBehavior): string | undefined {
  if (behavior.upscaling === "unknown") return undefined;
  const parts: string[] = [];
  if (behavior.nativeEstimate) parts.push(`Native generation: ~${behavior.nativeEstimate}`);
  if (behavior.target) parts.push(`Target: ${behavior.target.width}×${behavior.target.height}`);
  parts.push(`Upscaling: ${behavior.upscaling === "not-required" ? "not required" : behavior.upscaling}`);
  return parts.join(" · ");
}

export function ResolvedBehaviorHint({ behavior }: { behavior: ResolvedArtworkBehavior }) {
  const summary = resolvedBehaviorSummary(behavior);
  if (!summary) return null;
  return (
    <small className="field-note artwork-resolution-hint" title="Pre-generation estimate — actual dimensions are known only after generation.">
      Estimate — {summary}
    </small>
  );
}

/** One or two compact metadata lines for an artwork version, plus any upscaler warning. */
export function artworkVersionMetadata(version: ArtworkVersion): { original?: string; production?: string; warning?: string } {
  const original = version.original
    ? `Original ${version.original.width}×${version.original.height} · ${version.provider} ${version.model}`
    : undefined;
  let production: string | undefined;
  if (version.production) {
    production = version.production.upscaled
      ? `Production ${version.production.width}×${version.production.height} · AI upscaled${version.production.engine ? ` (${version.production.engine})` : ""}`
      : `Production ${version.production.width}×${version.production.height} · original (upscaling off or not required)`;
  }
  const warning = version.upscale?.status === "unavailable"
    ? `Upscaler unavailable — using original${version.upscale.warning ? ` (${version.upscale.warning})` : ""}`
    : undefined;
  return { original, production, warning };
}

export function ArtworkVersionMetadata({ version }: { version: ArtworkVersion }) {
  const meta = artworkVersionMetadata(version);
  if (!meta.original && !meta.production && !meta.warning) return null;
  return (
    <div className="version-metadata">
      {meta.original && <small>{meta.original}</small>}
      {meta.production && <small>{meta.production}</small>}
      {meta.warning && <small className="version-metadata-warning">{meta.warning}</small>}
    </div>
  );
}

const CONTINUITY_CHARACTER_LABELS: Record<string, string> = {
  appearanceDelta: "appearance",
  wardrobe: "wardrobe",
  equipment: "equipment",
  carriedItems: "carrying",
  injuries: "injuries",
  condition: "condition",
  transformation: "transformation",
  visibleEmotionalState: "emotional state",
  location: "location",
};
const CONTINUITY_ENVIRONMENT_LABELS: Record<string, string> = {
  locationId: "location",
  description: "description",
  timeOfDay: "time of day",
  lighting: "lighting",
  weather: "weather",
  condition: "condition",
  damage: "damage",
};

function continuityFieldValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return Array.isArray(value) ? value.join(", ") : String(value);
}

export function humanizeContinuityChanges(change?: VisualContinuityChange): string[] {
  if (!change) return [];
  const lines: string[] = [];
  for (const character of change.characters ?? []) {
    if (character.op === "enter") {
      lines.push(`${character.name} enters`);
    } else if (character.op === "exit") {
      lines.push(`${character.name} exits`);
    } else {
      const parts = [
        ...Object.entries(character.set ?? {}).map(([key, value]) => {
          const text = continuityFieldValue(value);
          return text ? `${CONTINUITY_CHARACTER_LABELS[key] ?? key} → ${text}` : undefined;
        }),
        ...(character.clear ?? []).map((key) => `${CONTINUITY_CHARACTER_LABELS[key] ?? key} cleared`),
      ].filter((part): part is string => Boolean(part));
      lines.push(parts.length ? `${character.name}: ${parts.join("; ")}` : `${character.name} updated`);
    }
  }
  if (change.environment) {
    for (const [key, value] of Object.entries(change.environment.set ?? {})) {
      const text = continuityFieldValue(value);
      if (text) lines.push(`environment: ${CONTINUITY_ENVIRONMENT_LABELS[key] ?? key} → ${text}`);
    }
    for (const key of change.environment.clear ?? []) {
      lines.push(`environment: ${CONTINUITY_ENVIRONMENT_LABELS[key] ?? key} cleared`);
    }
  }
  for (const object of change.objects ?? []) {
    if (object.op === "add") {
      lines.push(`${object.name} appears`);
    } else if (object.op === "remove") {
      lines.push(`${object.name} removed`);
    } else {
      const parts = Object.entries(object.set ?? {})
        .map(([key, value]) => {
          const text = continuityFieldValue(value);
          return text ? `${key} → ${text}` : undefined;
        })
        .filter((part): part is string => Boolean(part));
      lines.push(parts.length ? `${object.name}: ${parts.join("; ")}` : `${object.name} updated`);
    }
  }
  if (change.note) lines.push(change.note);
  return lines;
}

export function describeContinuityReference(decision?: VisualContinuityReferenceDecision): string {
  if (!decision || decision.kind === "none") {
    return decision?.reason ? `Text-only continuity — ${decision.reason}` : "Text-only continuity";
  }
  const source = decision.sourceSceneId
    ? `${decision.sourceChapter !== undefined ? `Chapter ${decision.sourceChapter} · ` : ""}Scene ${decision.sourceSceneId.replace(/^scene-/, "")}`
    : decision.kind === "previous-chapter"
      ? "Previous chapter"
      : "Previous scene";
  const version = decision.versionNumber !== undefined ? ` (v${decision.versionNumber})` : "";
  if (decision.used) return `Using ${source} approved artwork${version} as reference`;
  return `${source} artwork not used${decision.reason ? ` — ${decision.reason}` : ""}`;
}

export function describePreviousHandoff(handoff: PreviousVisualHandoff): string {
  return `Chapter ${handoff.chapter} · Scene ${handoff.sceneId.replace(/^scene-/, "")}`;
}

export function continuityReferenceTriState(value?: "prefer" | "avoid"): "inherit" | "prefer" | "avoid" {
  return value ?? "inherit";
}

export function describeCharacterContinuityState(character: VisualCharacterState): string {
  const parts: string[] = [];
  for (const [key, label] of Object.entries(CONTINUITY_CHARACTER_LABELS)) {
    const text = continuityFieldValue(character[key as keyof VisualCharacterState]);
    if (text) parts.push(`${label}: ${text}`);
  }
  return parts.length ? `${character.name} — ${parts.join("; ")}` : character.name;
}

export function describeEnvironmentContinuityState(environment?: VisualEnvironmentState): string[] {
  if (!environment) return [];
  const lines: string[] = [];
  for (const [key, label] of Object.entries(CONTINUITY_ENVIRONMENT_LABELS)) {
    const text = continuityFieldValue(environment[key as keyof VisualEnvironmentState]);
    if (text) lines.push(`environment — ${label}: ${text}`);
  }
  return lines;
}

export function describeObjectContinuityState(object: VisualObjectState): string {
  const parts = [object.condition ? `condition: ${object.condition}` : undefined, object.possessedBy ? `with ${object.possessedBy}` : undefined].filter((part): part is string => Boolean(part));
  return parts.length ? `${object.name} — ${parts.join("; ")}` : object.name;
}

export function hasContinuityState(state?: VisualContinuityState): boolean {
  return Boolean(
    state &&
      (state.characters.length > 0 ||
        state.objects.length > 0 ||
        Boolean(state.spatial) ||
        describeEnvironmentContinuityState(state.environment).length > 0),
  );
}

export function hasContinuityContent(continuity?: SceneContinuity, changes?: VisualContinuityChange): boolean {
  return Boolean(
    continuity?.referenceDecision ||
      continuity?.manualOverride ||
      hasContinuityState(continuity?.startState) ||
      hasContinuityState(continuity?.endState) ||
      humanizeContinuityChanges(changes ?? continuity?.changes).length > 0,
  );
}

export function PreviousHandoffBadge({ handoff }: { handoff?: PreviousVisualHandoff }) {
  if (!handoff) return null;
  return (
    <div className="handoff-badge">
      <span className="eyebrow">Previous chapter handoff</span>
      <b>{describePreviousHandoff(handoff)}</b>
      <span className="routing-badge inherited">
        {handoff.usedAsReference ? "Using approved artwork as reference" : "Text-only continuity"}
      </span>
      {handoff.origin === "manual" && <span className="manual-badge">Manual</span>}
    </div>
  );
}

export function SceneContinuityStateView({ title, state }: { title: string; state?: VisualContinuityState }) {
  if (!hasContinuityState(state)) return null;
  const lines = [
    ...(state?.characters ?? []).map(describeCharacterContinuityState),
    ...describeEnvironmentContinuityState(state?.environment),
    ...(state?.objects ?? []).map(describeObjectContinuityState),
    ...(state?.spatial ? [`spatial: ${state.spatial}`] : []),
  ];
  return (
    <div className="continuity-state">
      <h5>{title}</h5>
      <ul>
        {lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

export function SceneContinuityPanel({
  scene,
  busy,
  onSave,
  onReset,
}: {
  scene: Scene;
  busy: boolean;
  onSave: (input: Omit<VisualContinuityOverrideEntryInput, "sceneId">) => void;
  onReset: () => void;
}) {
  const continuity = scene.continuity;
  const override = continuity?.manualOverride;
  const [note, setNote] = useState(override?.note ?? "");
  const [reference, setReference] = useState<"inherit" | "prefer" | "avoid">(continuityReferenceTriState(override?.usePreviousReference));
  const changeLines = humanizeContinuityChanges(scene.visualChanges ?? continuity?.changes);
  const empty = !hasContinuityContent(continuity, scene.visualChanges);

  const save = () => {
    const trimmed = note.trim();
    onSave({
      ...(trimmed ? { note: trimmed } : {}),
      ...(reference === "inherit" ? {} : { usePreviousReference: reference }),
    });
  };

  return (
    <details className="scene-direction-panel scene-continuity-panel">
      <summary>
        🧭 Visual Continuity
        {override && (
          <span className="manual-badge">Manual override{override.stale ? " · stale" : ""}</span>
        )}
      </summary>
      <div className="scene-direction-content">
        {empty ? (
          <small className="continuity-empty">No continuity state recorded for this scene.</small>
        ) : (
          <>
            <SceneContinuityStateView title="Entering state" state={continuity?.startState} />
            {changeLines.length > 0 && (
              <div className="continuity-state">
                <h5>Changes in this scene</h5>
                <ul>
                  {changeLines.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
            <SceneContinuityStateView title="Ending state" state={continuity?.endState} />
            {continuity?.referenceDecision && (
              <p className="continuity-reference">Previous reference: {describeContinuityReference(continuity.referenceDecision)}</p>
            )}
          </>
        )}

        <div className="continuity-override-editor">
          <div className="form-row">
            <label>Continuity note (manual correction)</label>
            <input
              type="text"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="e.g. Malakai still has the staff. Coat is no longer torn."
            />
          </div>
          <div className="form-row">
            <label>Use previous scene reference</label>
            <select value={reference} onChange={(event) => setReference(event.target.value as "inherit" | "prefer" | "avoid")}>
              <option value="inherit">Inherit (automatic)</option>
              <option value="prefer">Prefer previous artwork</option>
              <option value="avoid">Avoid previous artwork</option>
            </select>
          </div>
          <div className="continuity-override-actions">
            {override && <span className="badge">revision {override.revision}{override.stale ? " · stale" : ""}</span>}
            <button type="button" className="button small" disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save continuity override"}
            </button>
            {override && (
              <button type="button" className="button small" disabled={busy} onClick={onReset}>
                Reset override
              </button>
            )}
          </div>
        </div>
      </div>
    </details>
  );
}

function chapterSceneEditableValues(scene: Scene) {
  const { summary, startSeconds, endSeconds, characters, location, visualPrompt, importance, disabled, direction, overrides, visualChanges } = scene;
  return { summary, startSeconds, endSeconds, characters, location, visualPrompt, importance, disabled, direction, overrides, visualChanges };
}

function chapterSceneDirty(scene: Scene, saved: Scene[]) {
  const original = saved.find((item) => item.id === scene.id);
  return Boolean(original && JSON.stringify(chapterSceneEditableValues(scene)) !== JSON.stringify(chapterSceneEditableValues(original)));
}

export function chapterSceneStructureDirty(draft: Scene[], saved: Scene[]) {
  if (draft.map((scene) => scene.id).join("|") !== saved.map((scene) => scene.id).join("|")) return true;
  const byId = new Map(saved.map((scene) => [scene.id, scene]));
  return draft.some((scene) => Boolean(scene.disabled) !== Boolean(byId.get(scene.id)?.disabled));
}

export function chapterScenesDirty(draft: Scene[], saved: Scene[]) {
  return chapterSceneStructureDirty(draft, saved) || draft.some((scene) => chapterSceneDirty(scene, saved));
}

export function moveChapterSceneDraft(scenes: Scene[], sceneId: string, offset: -1 | 1) {
  const from = scenes.findIndex((scene) => scene.id === sceneId);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= scenes.length) return scenes;
  const result = [...scenes];
  [result[from], result[to]] = [result[to]!, result[from]!];
  let cursor = 0;
  return result.map((scene) => {
    const duration = scene.endSeconds - scene.startSeconds;
    const next = { ...scene, startSeconds: cursor, endSeconds: cursor + duration };
    cursor = next.endSeconds;
    return next;
  });
}

export function toggleChapterSceneEnabledDraft(scenes: Scene[], sceneId: string) {
  const scene = scenes.find((item) => item.id === sceneId);
  if (!scene) return scenes;
  if (!scene.disabled && enabledProductionScenes(scenes).length <= 1) return scenes;
  return scenes.map((item) => item.id === sceneId ? { ...item, disabled: !item.disabled } : item);
}

export function canDeleteChapterSceneDraft(scenes: Scene[], sceneId: string) {
  if (scenes.length <= 1 || !scenes.some((item) => item.id === sceneId)) return false;
  const remaining = scenes.filter((item) => item.id !== sceneId);
  return enabledProductionScenes(remaining).length > 0;
}

export function deleteChapterSceneDraft(scenes: Scene[], sceneId: string, confirmed: boolean, durationSeconds: number, settings: SceneSettings) {
  if (!confirmed || !canDeleteChapterSceneDraft(scenes, sceneId)) return scenes;
  const remaining = scenes.filter((item) => item.id !== sceneId);
  return retimeScenesToDuration(remaining, durationSeconds, settings);
}

export function chapterVideoReadinessChecks(chapter: ScenesDashboard["chapters"][number] | undefined, manifest: Array<Scene & { imageUrl?: string }> | undefined, manifestStale: boolean | undefined, subtitleMode: VideoSettings["subtitleMode"]): ReadinessCheck[] {
  if (!chapter) return [{ label: "Chapter", state: "blocker", detail: "Select a chapter to inspect its production inputs." }];
  const checks: ReadinessCheck[] = [];
  checks.push(chapter.audioAvailable
    ? { label: "Audio", state: chapter.audioStale ? "warning" : "ready", detail: chapter.audioStale ? "Retained audio is available; production can reuse it with a stale-input warning." : "Current mastered audio is available." }
    : { label: "Audio", state: "blocker", detail: "Required mastered audio is missing." });
  checks.push(subtitleMode === "none"
    ? { label: "Subtitle timing", state: "ready", detail: "Subtitles are disabled for this video." }
    : chapter.subtitlesAvailable
      ? { label: "Subtitle timing", state: chapter.subtitlesStale ? "warning" : "ready", detail: chapter.subtitlesStale ? "Retained subtitle timing is available; production can regenerate or reuse it." : "Current subtitle timing is available." }
      : { label: "Subtitle timing", state: "warning", detail: "Timing is missing; the production flow prepares subtitles before rendering." });
  checks.push(manifest
    ? { label: "Scene plan", state: manifestStale ? "warning" : "ready", detail: manifestStale ? "A retained scene plan is available; artwork and video can use it with a stale-input warning." : "A current scene plan is available." }
    : { label: "Scene plan", state: "warning", detail: "No scene plan is available; the chapter renderer can use its configured background fallback." });
  const active = enabledProductionScenes(manifest ?? []);
  const unresolved = active.flatMap((scene) => scene.resolvedCharacters ?? []).filter((item) => !item.entityId || item.profileStatus !== "approved").length;
  checks.push(!active.length
    ? { label: "Visual Profiles", state: "warning", detail: "No enabled scene identities are available for artwork." }
    : unresolved
      ? { label: "Visual Profiles", state: "warning", detail: `${unresolved} scene identity/profile${unresolved === 1 ? " needs" : "s need"} review before artwork generation.` }
      : { label: "Visual Profiles", state: "ready", detail: "Enabled scene identities resolve to approved profiles." });
  const fullyApproved = active.length > 0 && active.every((scene) => scene.artwork.status === "complete" && Boolean(scene.imageUrl) && scene.artwork.review === "approved");
  const rejected = active.some((scene) => scene.artwork.review === "rejected" || scene.artwork.review === "needs-regeneration");
  checks.push(fullyApproved
    ? { label: "Artwork", state: chapter.artworkStatus === "complete" && !manifestStale ? "ready" : "warning", detail: chapter.artworkStatus === "complete" && !manifestStale ? "Every enabled scene has intact approved artwork." : "Approved artwork is retained, but the chapter artwork stage is stale." }
    : { label: "Artwork", state: "warning", detail: rejected ? "Some artwork is rejected or marked for regeneration; the chapter renderer uses its configured background fallback until all scene artwork is approved." : "Artwork is missing or unreviewed; the chapter renderer can use its configured background fallback." });
  checks.push(chapter.videoAvailable
    ? { label: "Video", state: chapter.videoStale ? "warning" : "ready", detail: chapter.videoStale ? "A retained video exists and needs a render to match current inputs." : "A current video render is available." }
    : { label: "Video", state: "warning", detail: "No video render is available yet." });
  return checks;
}

function reconcileChapterSceneDrafts(draft: Scene[], oldSaved: Scene[], incoming: Scene[]) {
  const edited = new Map(draft.filter((scene) => chapterSceneDirty(scene, oldSaved)).map((scene) => [scene.id, scene]));
  const reordered = draft.map((scene) => scene.id).join("|") !== oldSaved.map((scene) => scene.id).join("|");
  if (reordered) {
    const fresh = new Map(incoming.map((scene) => [scene.id, scene]));
    return draft.map((scene) => edited.get(scene.id) ?? fresh.get(scene.id) ?? scene);
  }
  return incoming.map((scene) => edited.get(scene.id) ?? scene);
}

export function ScenesPage({ slug, onJob, navigate, initialData }: { slug: string; onJob: (job: Job) => void; navigate?: (path: string) => void; initialData?: ScenesDashboard }) {
  const [data, setData] = useState<ScenesDashboard | undefined>(initialData);
  const [draft, setDraft] = useState<Scene[]>(() => (initialData?.manifest?.scenes ? structuredClone(initialData.manifest.scenes) : []));
  const savedRef = useRef<Scene[]>(structuredClone(initialData?.manifest?.scenes ?? []));
  const [saved, setSaved] = useState<Scene[]>(savedRef.current);
  const [savingSceneId, setSavingSceneId] = useState<string>();
  const [sceneErrors, setSceneErrors] = useState<Record<string, string>>({});
  const [savedSceneId, setSavedSceneId] = useState<string>();
  const [sceneProposal, setSceneProposal] = useState<SceneRegenerationProposal>();
  const [proposalMode, setProposalMode] = useState<Record<string, SceneRegenerationProposal["mode"]>>({});
  const [regeneratingSceneId, setRegeneratingSceneId] = useState<string>();
  const loadRequest = useRef(0);
  const [rangeMode, setRangeMode] = useState<"single" | "range">("single");
  const [range, setRange] = useState({ from: "", to: "" });
  const [rangeError, setRangeError] = useState("");
  const [error, setError] = useState("");
  const [estimate, setEstimate] = useState<ArtworkEstimate>();
  const [chapterProductionPlan, setChapterProductionPlan] = useState<ProductionPlan>();
  const [planningProduction, setPlanningProduction] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sceneFilter, setSceneFilter] = useState<"all" | "needs-review" | "approved" | "video-ready">("all");
  const [selectedSceneIds, setSelectedSceneIds] = useState<string[]>([]);
  const [selectedVersionByScene, setSelectedVersionByScene] = useState<Record<string, string>>({});
  const [showArtDirectionModal, setShowArtDirectionModal] = useState(false);
  const [visualPreflight, setVisualPreflight] = useState<any | null>(null);
  const [pendingArtworkExtra, setPendingArtworkExtra] = useState<Record<string, unknown> | null>(null);
  const [oneTimeUnprofiled, setOneTimeUnprofiled] = useState<string[]>([]);
  const [continuityBusy, setContinuityBusy] = useState(false);
  const [reupscaling, setReupscaling] = useState(false);
  const watcher = useRef<(() => void) | undefined>(undefined);

  const load = async (chapter?: number, resetDraft = false, acceptedScene?: Scene, refreshIndex = true) => {
    const request = ++loadRequest.current;
    const selected = chapter ?? data?.selectedChapter; if (!selected) return;
    const next = await api<ScenesDashboard>(`/stories/${slug}/scenes/${selected}`);
    if (request !== loadRequest.current) return;
    setData((current) => current ? { ...current, selectedChapter: next.selectedChapter, manifest: next.manifest, previousHandoff: next.previousHandoff } : next);
    if (refreshIndex) void api<{ row: ScenesDashboard["chapters"][number]; counts: ScenesDashboard["counts"] }>(`/stories/${slug}/scenes/index/${selected}`).then(({ row, counts }) => { if (request === loadRequest.current) setData((current) => current ? { ...current, chapters: current.chapters.map((item) => item.chapter === selected ? row : item), counts } : current); }).catch((value) => { if (request === loadRequest.current) setError(message(value)); });
    const incoming = structuredClone(next.manifest?.scenes ?? []);
    setSelectedSceneIds((current) => resetDraft ? [] : current.filter((id) => incoming.some((scene) => scene.id === id)));
    const previous = savedRef.current;
    setDraft((current) => {
      if (resetDraft) return incoming;
      const reconciled = reconcileChapterSceneDrafts(current, previous, incoming);
      return acceptedScene ? reconciled.map((scene) => scene.id === acceptedScene.id && JSON.stringify(chapterSceneEditableValues(scene)) === JSON.stringify(chapterSceneEditableValues(acceptedScene)) ? incoming.find((item) => item.id === acceptedScene.id) ?? scene : scene) : reconciled;
    });
    setSaved(incoming);
    savedRef.current = incoming;
    if (!range.from && next.selectedChapter) {
      setRange({ from: String(next.selectedChapter), to: String(next.selectedChapter) });
    }
  };

  useEffect(() => {
    savedRef.current = [];
    setSaved([]);
    setDraft([]);
    setSceneProposal(undefined);
    setData(undefined);
    setError("");
    let cancelled = false;
    api<ScenesDashboard>(`/stories/${slug}/scenes/index`).then((index) => { if (cancelled) return; setData(index); if (index.selectedChapter) void load(index.selectedChapter, true, undefined, false).catch((value) => { if (!cancelled) setError(message(value)); }); }).catch((value) => { if (!cancelled) setError(message(value)); });
    return () => { cancelled = true; loadRequest.current++; watcher.current?.(); };
  }, [slug]);

  const chooseChapter = (chapter: number) => {
    setSelectedSceneIds([]);
    setEstimate(undefined);
    setChapterProductionPlan(undefined);
    setRange({ from: String(chapter), to: String(chapter) });
    setRangeError("");
    void load(chapter, true, undefined, false).catch((value) => setError(message(value)));
  };

  const handleRangeChange = (fromVal: string, toVal: string) => {
    setChapterProductionPlan(undefined);
    setRange({ from: fromVal, to: toVal });
    const fromNum = Number(fromVal);
    const toNum = Number(toVal);
    if (!fromVal.trim() || !toVal.trim()) {
      setRangeError("Range bounds cannot be empty");
    } else if (Number.isNaN(fromNum) || Number.isNaN(toNum) || fromNum < 1 || toNum < 1) {
      setRangeError("Chapter numbers must be positive integers");
    } else if (fromNum > toNum) {
      setRangeError("Start chapter must be less than or equal to end chapter");
    } else {
      setRangeError("");
    }
  };

  const run = async (kind: "scenes" | "artwork", extra: Record<string, unknown> = {}) => {
    const fromNum = Number(range.from);
    const toNum = Number(range.to);
    if (fromNum > toNum) {
      setRangeError("Start chapter must be less than or equal to end chapter");
      return;
    }
    try {
      setError("");
      const { preflightAccepted, ...requestExtra } = extra as Record<string, unknown> & { preflightAccepted?: boolean };
      const selectedChapter = kind === "artwork" && requestExtra.scenes ? data?.selectedChapter : undefined;
      const requestRange = { from: selectedChapter ?? fromNum, to: selectedChapter ?? toNum };
      if (kind === "artwork" && !preflightAccepted) {
        const preflight = await post<any>(`/stories/${slug}/artwork/visual-preflight`, { ...requestRange, ...requestExtra });
        if (!preflight.ready) {
          setVisualPreflight(preflight);
          setPendingArtworkExtra(requestExtra);
          setOneTimeUnprofiled([]);
          return;
        }
      }
      const job = await post<Job>(`/stories/${slug}/jobs/${kind}`, { ...requestRange, ...requestExtra });
      onJob(job);
      watcher.current?.();
      watcher.current = watchJob(job.id, async (next) => {
        onJob(next);
        if (next.status === "completed") {
          if (next.result?.dryRun) {
            setEstimate({
              count: next.result.imageCountEstimate,
              provider: next.result.provider ?? data?.artworkRouting?.provider ?? data?.artwork?.provider ?? "openai",
              model: next.result.model ?? data?.artworkRouting?.model ?? data?.artwork?.model ?? "",
            });
          }
          await load(data?.selectedChapter);
        } else if (next.status === "failed") {
          setError(next.error ?? `${pretty(kind)} job failed`);
        }
      }, (value) => setError(message(value)));
    } catch (value) {
      setError(message(value));
    }
  };

  const continueArtworkAfterPreflight = () => {
    if (!pendingArtworkExtra) return;
    void run("artwork", { ...pendingArtworkExtra, allowUnprofiledEntityIds: oneTimeUnprofiled, preflightAccepted: true });
    setVisualPreflight(null);
    setPendingArtworkExtra(null);
  };

  const previewChapterProduction = async () => {
    if (!data?.selectedChapter) return;
    setPlanningProduction(true);
    setError("");
    try { setChapterProductionPlan(await post<ProductionPlan>(`/stories/${slug}/production/plan`, { from: data.selectedChapter, to: data.selectedChapter, outputs: ["video"], artwork: true, refresh: false, dryRun: true })); }
    catch (cause) { setError(message(cause)); }
    finally { setPlanningProduction(false); }
  };
  const startChapterProduction = async () => {
    if (!chapterProductionPlan || !data?.selectedChapter || chapterProductionPlan.from !== data.selectedChapter || draft.some((scene) => chapterSceneDirty(scene, saved))) return;
    setPlanningProduction(true);
    setError("");
    try {
      const job = await post<Job>(`/stories/${slug}/jobs/production`, { from: data.selectedChapter, to: data.selectedChapter, outputs: ["video"], artwork: true, refresh: false });
      onJob(job);
      setChapterProductionPlan(undefined);
      watcher.current?.();
      watcher.current = watchJob(job.id, async (next) => { onJob(next); if (next.status === "completed") await load(data.selectedChapter); else if (next.status === "failed") setError(next.error ?? "Chapter production failed"); }, (cause) => setError(message(cause)));
    } catch (cause) { setError(message(cause)); }
    finally { setPlanningProduction(false); }
  };

  const reopenArtworkPreflight = async () => {
    if (!pendingArtworkExtra) return;
    try {
      const fromNum = pendingArtworkExtra.scenes ? data?.selectedChapter : Number(range.from); const toNum = pendingArtworkExtra.scenes ? data?.selectedChapter : Number(range.to);
      const preflight = await post<any>(`/stories/${slug}/artwork/visual-preflight`, { from: fromNum, to: toNum, ...pendingArtworkExtra });
      // Keep the gate visible even when every profile is now ready: the user
      // must explicitly choose Continue before any paid generation starts.
      setVisualPreflight(preflight);
      setOneTimeUnprofiled([]);
    } catch (value) { setError(message(value)); }
  };

  const save = async () => {
    if (!data?.selectedChapter) return;
    try {
      setSaving(true);
      setError("");
      await put(`/stories/${slug}/chapters/${data.selectedChapter}/scenes`, { scenes: draft });
      await load(data.selectedChapter, true);
    } catch (value) {
      setError(message(value));
    } finally {
      setSaving(false);
    }
  };

  const saveScene = async (scene: Scene) => {
    if (!data?.selectedChapter) return;
    const original = savedRef.current.find((item) => item.id === scene.id);
    if (!original?.contentFingerprint) { setSceneErrors((errors) => ({ ...errors, [scene.id]: "Refresh this scene before saving." })); return; }
    setSavingSceneId(scene.id);
    setSceneErrors((errors) => ({ ...errors, [scene.id]: "" }));
    try {
      await put(`/stories/${slug}/chapters/${data.selectedChapter}/scenes/${scene.id}`, { scene, expectedFingerprint: original.contentFingerprint });
      await load(data.selectedChapter, false, scene);
      setSavedSceneId(scene.id);
    } catch (cause) { setSceneErrors((errors) => ({ ...errors, [scene.id]: message(cause) })); }
    finally { setSavingSceneId(undefined); }
  };

  const revertScene = (sceneId: string) => {
    const original = savedRef.current.find((item) => item.id === sceneId);
    if (original) setDraft((current) => current.map((item) => item.id === sceneId ? structuredClone(original) : item));
    setSceneErrors((errors) => ({ ...errors, [sceneId]: "" }));
  };

  const previewSceneRegeneration = async (scene: Scene) => {
    if (!data?.selectedChapter) return;
    setRegeneratingSceneId(scene.id);
    setSceneErrors((errors) => ({ ...errors, [scene.id]: "" }));
    try {
      const result = await post<{ proposal: SceneRegenerationProposal }>(`/stories/${slug}/chapters/${data.selectedChapter}/scenes/${scene.id}/regenerate-preview`, { mode: proposalMode[scene.id] ?? "image_prompt" });
      setSceneProposal(result.proposal);
    } catch (cause) { setSceneErrors((errors) => ({ ...errors, [scene.id]: message(cause) })); }
    finally { setRegeneratingSceneId(undefined); }
  };
  const applySceneRegeneration = async (sceneId: string) => {
    if (!data?.selectedChapter || sceneProposal?.sceneId !== sceneId) return;
    const sceneAtApply = draft.find((item) => item.id === sceneId);
    setRegeneratingSceneId(sceneId);
    try {
      await put(`/stories/${slug}/chapters/${data.selectedChapter}/scenes/${sceneId}/apply-regeneration`, sceneProposal);
      setSceneProposal(undefined);
      await load(data.selectedChapter, false, sceneAtApply);
      setSavedSceneId(sceneId);
    } catch (cause) { setSceneErrors((errors) => ({ ...errors, [sceneId]: message(cause) })); }
    finally { setRegeneratingSceneId(undefined); }
  };

  const review = async (scene: Scene, value: Scene["artwork"]["review"]) => {
    if (!data?.selectedChapter) return;
    try {
      await post(`/stories/${slug}/chapters/${data.selectedChapter}/scenes/${scene.id}/review`, { review: value });
      await load(data.selectedChapter);
    } catch (cause) {
      setError(message(cause));
    }
  };

  const handleApproveVersion = async (scene: Scene, versionId: string) => {
    if (!data?.selectedChapter) return;
    try {
      setError("");
      await reviewArtworkVersion(slug, data.selectedChapter, scene.id, versionId, "approved");
      await load(data.selectedChapter);
    } catch (cause) {
      setError(message(cause));
    }
  };

  // Re-derives upscaled production assets from preserved originals only — no
  // paid image generation is involved.
  const handleReupscale = async () => {
    if (!data?.selectedChapter) return;
    try {
      setReupscaling(true);
      setError("");
      const result = await reupscaleArtwork(slug, data.selectedChapter);
      if (result.warnings.length) setError(result.warnings.join(" "));
      await load(data.selectedChapter);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setReupscaling(false);
    }
  };

  const edit = (id: string, patch: Partial<Scene>) => {
    setChapterProductionPlan(undefined);
    setSavedSceneId(undefined);
    setDraft((current) => current.map((scene) => (scene.id === id ? { ...scene, ...patch } : scene)));
  };

  const editDirection = (id: string, patch: Partial<NonNullable<Scene["direction"]>>) => {
    setChapterProductionPlan(undefined);
    setDraft((current) => current.map((scene) => (scene.id === id ? { ...scene, direction: { ...scene.direction, ...patch } } : scene)));
  };

  const editOverrides = (id: string, patch: Partial<NonNullable<Scene["overrides"]>>) => {
    setChapterProductionPlan(undefined);
    setDraft((current) => current.map((scene) => (scene.id === id ? { ...scene, overrides: { ...scene.overrides, ...patch } } : scene)));
  };

  // Refresh continuity from the server without clobbering unsaved scene draft
  // edits: only continuity-related fields are merged back into the draft.
  const refreshContinuity = async () => {
    const request = loadRequest.current;
    const chapter = data?.selectedChapter;
    if (!chapter) return;
    const next = await api<ScenesDashboard>(`/stories/${slug}/scenes/${chapter}`);
    if (request !== loadRequest.current) return;
    setData((current) => current ? { ...current, manifest: next.manifest, previousHandoff: next.previousHandoff } : next);
    setDraft((current) =>
      current.map((scene) => {
        const fresh = next.manifest?.scenes.find((item) => item.id === scene.id);
        return fresh ? { ...scene, continuity: fresh.continuity, visualChanges: fresh.visualChanges } : scene;
      }),
    );
  };

  const saveSceneContinuity = async (scene: Scene, input: Omit<VisualContinuityOverrideEntryInput, "sceneId">) => {
    if (!data?.selectedChapter) return;
    try {
      setContinuityBusy(true);
      setError("");
      await updateSceneContinuity(slug, data.selectedChapter, scene.id, input);
      await refreshContinuity();
    } catch (value) {
      setError(message(value));
    } finally {
      setContinuityBusy(false);
    }
  };

  const resetSceneContinuityOverride = async (scene: Scene) => {
    if (!data?.selectedChapter) return;
    try {
      setContinuityBusy(true);
      setError("");
      await resetSceneContinuity(slug, data.selectedChapter, scene.id);
      await refreshContinuity();
    } catch (value) {
      setError(message(value));
    } finally {
      setContinuityBusy(false);
    }
  };

  if (error && !data) return <LoadFailure error={error} />;
  if (!data) return <Loading />;
  const plannerNotReady = Boolean(data.scenePlannerRouting && !data.scenePlannerRouting.ready);
  const artworkRouting = data.artworkRouting ?? {
    provider: data.artwork?.provider ?? "openai",
    model: data.artwork?.model ?? "",
    availableProviders: ARTWORK_PROVIDERS,
  };

  const chapterArtworkCurrent = data.chapters.find((item) => item.chapter === data.selectedChapter)?.artworkStatus === "complete" && !data.manifestStale;
  const selectedChapterRow = data.chapters.find((item) => item.chapter === data.selectedChapter);
  const structuralChanges = chapterSceneStructureDirty(draft, saved);
  const hasUnsavedSceneChanges = chapterScenesDirty(draft, saved);
  const videoReadiness = chapterVideoReadinessChecks(selectedChapterRow, data.manifest?.scenes, data.manifestStale, data.videoSubtitleMode);
  const filteredScenes = draft.filter((scene) => {
    if (sceneFilter === "all") return true;
    const state = getSceneProductionState(scene, chapterArtworkCurrent);
    if (sceneFilter === "needs-review") return state.label === "Needs Review";
    if (sceneFilter === "approved") return state.label === "Approved" || state.label === "Video Ready";
    if (sceneFilter === "video-ready") return state.label === "Video Ready";
    return true;
  });

  const canReupscale = reupscaleAvailable(data.artwork);

  const filterCounts = {
    all: draft.length,
    needsReview: draft.filter((s) => getSceneProductionState(s, chapterArtworkCurrent).label === "Needs Review").length,
    approved: draft.filter((s) => getSceneProductionState(s, chapterArtworkCurrent).label === "Approved" || getSceneProductionState(s, chapterArtworkCurrent).label === "Video Ready").length,
    videoReady: draft.filter((s) => getSceneProductionState(s, chapterArtworkCurrent).label === "Video Ready").length,
  };

  return (
    <section className="page scenes-page">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Visual development</span>
          <h2>Scene reel & Visual Canon</h2>
          <p>Plan the chapter’s visual rhythm, direct each frame with canonical profiles, then approve the artwork that enters video.</p>
        </div>
        <div className="scene-status-cluster">
          <div className="scene-count">
            <b>{data.counts.planned}</b>
            <span>chapters planned</span>
            <small>{data.counts.artworkReady} with artwork</small>
          </div>
          <div className="scene-planner-badge" title={data.scenePlannerRouting?.reason}>
            <span className="eyebrow">Planner</span>
            <b>{data.scenePlannerRouting ? `${data.scenePlannerRouting.provider} · ${data.scenePlannerRouting.model}` : `${data.planner.provider} · ${data.planner.model}`}</b>
            <span className={`routing-badge ${data.scenePlannerRouting?.source === "override" ? "override" : "inherited"}`}>
              {data.scenePlannerRouting?.source === "override" ? "Book override" : "Studio default"}
            </span>
            <button type="button" className="button small text-btn" onClick={() => navigate?.(`/stories/${slug}/settings`) ?? (location.href = `/stories/${slug}/settings`)}>Settings</button>
          </div>
          <div className="scene-planner-badge" title={`Effective artwork provider and model: ${artworkRouting.provider} · ${artworkRouting.model}`}>
            <span className="eyebrow">Artwork</span>
            <b>{artworkRouting.provider} · {artworkRouting.model}</b>
            <span className="routing-badge inherited">Story settings</span>
            <button type="button" className="button small text-btn" onClick={() => navigate?.(`/stories/${slug}/settings`) ?? (location.href = `/stories/${slug}/settings`)}>Settings</button>
          </div>
        </div>
      </div>

      {plannerNotReady && (
        <div className="scene-preflight-alert" role="alert">
          <div>
            <Status status="fail" label="Scene Planner Not Configured" />
            <p>{data.scenePlannerRouting?.reason ?? "Scene planner provider or model is not configured."}</p>
          </div>
          <button type="button" className="button primary" onClick={() => navigate?.(`/stories/${slug}/settings`) ?? (location.href = `/stories/${slug}/settings`)}>
            Configure Scene Planner →
          </button>
        </div>
      )}

      <div className="scene-toolbar">
        <Field label="Selection Mode">
          <select
            value={rangeMode}
            onChange={(e) => {
              const mode = e.target.value as "single" | "range";
              setRangeMode(mode);
              if (mode === "single" && data.selectedChapter) {
                setRange({ from: String(data.selectedChapter), to: String(data.selectedChapter) });
                setRangeError("");
              }
            }}
          >
            <option value="single">Single Chapter</option>
            <option value="range">Chapter Range</option>
          </select>
        </Field>

        {rangeMode === "single" ? (
          <Field label="Chapter">
            <select
              value={data.selectedChapter ?? ""}
              onChange={(event) => chooseChapter(Number(event.target.value))}
            >
              {data.chapters.map((chapter) => (
                <option key={chapter.chapter} value={chapter.chapter}>
                  {String(chapter.chapter).padStart(4, "0")} · {chapter.title ?? "Untitled"}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <>
            <Field label="Range from">
              <input
                inputMode="numeric"
                value={range.from}
                onChange={(event) => handleRangeChange(event.target.value, range.to)}
              />
            </Field>
            <Field label="Range to">
              <input
                inputMode="numeric"
                value={range.to}
                onChange={(event) => handleRangeChange(range.from, event.target.value)}
              />
            </Field>
          </>
        )}

        <div className="scene-actions">
          <button
            type="button"
            className="button"
            onClick={() => setShowArtDirectionModal(true)}
            title="Manage story art direction presets and global visual style"
          >
            🎨 Art Direction
          </button>
          <button
            type="button"
            className="button"
            disabled={plannerNotReady || Boolean(rangeError)}
            onClick={() => run("scenes")}
          >
            Plan scenes
          </button>
          <button
            type="button"
            className="button"
            disabled={Boolean(rangeError)}
            onClick={() => run("artwork", { dryRun: true })}
          >
            Estimate images
          </button>
          <button
            type="button"
            className="button primary"
            disabled={Boolean(rangeError)}
            onClick={() => run("artwork")}
          >
            Generate artwork
          </button>
          <button
            type="button"
            className="button"
            disabled={!canReupscale || reupscaling || !data.selectedChapter}
            title={canReupscale ? "Re-run upscaling from existing originals — no new image generation" : "Re-upscale needs a Final resolution other than Native and Upscaling not Off (Artwork settings)"}
            onClick={() => void handleReupscale()}
          >
            {reupscaling ? "Re-upscaling…" : "Re-upscale"}
          </button>
          <button type="button" className="button" disabled={!data.selectedChapter || planningProduction || hasUnsavedSceneChanges} onClick={() => void previewChapterProduction()}>{planningProduction ? "Planning…" : "Produce this chapter…"}</button>
        </div>

        {rangeError && (
          <div style={{ gridColumn: "1/-1", color: "var(--fail)", fontSize: "11px" }}>
            ⚠️ {rangeError}
          </div>
        )}

        {estimate !== undefined && <ArtworkEstimateSummary estimate={estimate} />}
        {chapterProductionPlan && <div className="summary-scene-proposal" role="region" aria-label="Chapter production plan"><strong>Chapter {data.selectedChapter} production plan</strong><p>{chapterProductionPlan.stages.map((stage) => `${pretty(stage)}: ${chapterProductionPlan.counts[stage]?.required ?? 0} needed / ${chapterProductionPlan.counts[stage]?.reusable ?? 0} reusable`).join(" · ")}</p><p>Potential paid work: {chapterProductionPlan.estimates.llmOperations} LLM · {chapterProductionPlan.estimates.ttsOperations} TTS · {chapterProductionPlan.estimates.imageOperations} images. Existing current stages are reused.</p><div className="scene-edit-actions"><button type="button" className="button primary" disabled={planningProduction} onClick={() => void startChapterProduction()}>Continue production</button><button type="button" className="button" onClick={() => setChapterProductionPlan(undefined)}>Cancel</button></div></div>}
        {data.resolvedBehavior && <ResolvedBehaviorHint behavior={data.resolvedBehavior} />}
      </div>

      <VideoReadinessPanel checks={videoReadiness} />

      {error && <ErrorBox text={error} />}

      {data.manifest ? (
        <>
          {(data.manifestStale || data.chapters?.find((item) => item.chapter === data.selectedChapter)?.sceneStatus === "stale") && (
            <ArtifactStatusNotice
              status="stale"
              reason="This scene plan was generated from older inputs or settings. Scenes and artwork remain visible below; plan scenes again to make the manifest current."
            />
          )}

          <SceneFilmstrip scenes={draft} imageFor={(scene) => scene.imageUrl} statusFor={(scene) => getSceneProductionState(scene, chapterArtworkCurrent).label} onSelect={(scene) => document.getElementById(scene.id)?.scrollIntoView({ behavior: "smooth" })} />

          <div className="scene-reel-head">
            <div>
              <h3>Chapter {data.manifest.chapter} direction</h3>
              <p>
                {data.manifest.manuallyEdited ? `Manual revision ${data.manifest.manualRevision}` : "Planner draft"} · {formatDuration(data.manifest.durationSeconds)}
              </p>
              <PreviousHandoffBadge handoff={data.previousHandoff} />
            </div>
            <button className="button primary" disabled={saving || Boolean(savingSceneId) || !hasUnsavedSceneChanges} onClick={save}>
              {saving ? "Saving…" : "Save all scene edits"}
            </button>
          </div>

          {structuralChanges && <p className="summary-media-warning" role="status">Scene plan has unsaved structural changes. Order, enable/disable, and deletion edits take effect when you save all scene edits.</p>}

          <div className="scene-filter-bar">
            <button
              type="button"
              className={`filter-btn ${sceneFilter === "all" ? "active" : ""}`}
              onClick={() => setSceneFilter("all")}
            >
              All Scenes <span className="filter-count">({filterCounts.all})</span>
            </button>
            <button
              type="button"
              className={`filter-btn ${sceneFilter === "needs-review" ? "active" : ""}`}
              onClick={() => setSceneFilter("needs-review")}
            >
              Needs Review <span className="filter-count">({filterCounts.needsReview})</span>
            </button>
            <button
              type="button"
              className={`filter-btn ${sceneFilter === "approved" ? "active" : ""}`}
              onClick={() => setSceneFilter("approved")}
            >
              Approved <span className="filter-count">({filterCounts.approved})</span>
            </button>
            <button
              type="button"
              className={`filter-btn ${sceneFilter === "video-ready" ? "active" : ""}`}
              onClick={() => setSceneFilter("video-ready")}
            >
              Video Ready <span className="filter-count">({filterCounts.videoReady})</span>
            </button>
          </div>
          <div className="scene-edit-actions" aria-label="Selected chapter scenes">
            <span>{selectedSceneIds.length} selected</span>
            <button type="button" className="button small" onClick={() => setSelectedSceneIds(filteredScenes.map((scene) => scene.id))}>Select visible</button>
            <button type="button" className="button small" disabled={!selectedSceneIds.length} onClick={() => setSelectedSceneIds([])}>Clear selection</button>
            <button type="button" className="button small" disabled={!selectedSceneIds.length || hasUnsavedSceneChanges || Boolean(rangeError)} onClick={() => { if (confirm(`Regenerate artwork for ${selectedSceneIds.length} selected scene${selectedSceneIds.length === 1 ? "" : "s"}? Existing versions remain available, and this may call the image provider.`)) void run("artwork", { scenes: selectedSceneIds, force: true }); }}>Regenerate selected artwork</button>
          </div>

          <div className="scene-cards">
            {filteredScenes.map((scene) => {
              const draftIndex = draft.findIndex((item) => item.id === scene.id);
              const state = getSceneProductionState(scene, chapterArtworkCurrent);
              const versions = scene.artwork?.versions ?? [];
              const selectedVerId = selectedVersionByScene[scene.id] || scene.artwork?.approvedVersionId || (versions.length ? versions.at(-1)!.id : undefined);
              const displayedVersion = versions.find((v) => v.id === selectedVerId);
              const displayImageUrl = displayedVersion ? (scene.versionUrls?.[String(displayedVersion.versionNumber)] || displayedVersion.imageUrl || scene.imageUrl) : scene.imageUrl;

              return (
                <article id={scene.id} key={scene.id} className={`scene-card ${scene.importance ?? "standard"}`}>
                  <div className="scene-frame">
                    {displayImageUrl ? (
                      <img src={displayImageUrl} alt={scene.summary} />
                    ) : (
                      <div>
                        <span>{String(draftIndex + 1).padStart(2, "0")}</span>
                        <small>Frame pending</small>
                      </div>
                    )}
                    <span className={`state-badge ${state.cls}`}>{state.label}</span>
                  </div>

                  <div className="scene-copy">
                    <header>
                      <div>
                        <label className="scene-select"><input type="checkbox" aria-label={`Select ${scene.id}`} checked={selectedSceneIds.includes(scene.id)} onChange={(event) => setSelectedSceneIds((current) => event.target.checked ? [...current, scene.id] : current.filter((id) => id !== scene.id))} /></label>
                        <span className="eyebrow">{scene.id}</span>
                        <h3>{formatTime(scene.startSeconds)} — {formatTime(scene.endSeconds)}</h3>
                      </div>
                      <Stage value={scene.artwork?.status ?? "pending"} />
                    </header>
                    <div className="scene-edit-actions">
                      <span role="status">{savingSceneId === scene.id ? "Saving…" : chapterSceneDirty(scene, saved) ? "Unsaved changes" : savedSceneId === scene.id ? "Saved" : ""}</span>
                      <button type="button" className="button small" disabled={saving || Boolean(savingSceneId) || structuralChanges || !chapterSceneDirty(scene, saved)} onClick={() => void saveScene(scene)}>Save this scene</button>
                      <button type="button" className="button small" disabled={saving || Boolean(savingSceneId) || !chapterSceneDirty(scene, saved)} onClick={() => revertScene(scene.id)}>Revert</button>
                      <select aria-label={`Regeneration mode for ${scene.id}`} disabled={saving || Boolean(regeneratingSceneId)} value={proposalMode[scene.id] ?? "image_prompt"} onChange={(event) => setProposalMode((current) => ({ ...current, [scene.id]: event.target.value as SceneRegenerationProposal["mode"] }))}><option value="image_prompt">Image prompt only</option><option value="full_visual_direction">Full visual direction</option></select>
                      <button type="button" className="button small" disabled={saving || Boolean(regeneratingSceneId) || structuralChanges || chapterSceneDirty(scene, saved)} onClick={() => void previewSceneRegeneration(scene)}>{regeneratingSceneId === scene.id ? "Regenerating…" : "Regenerate scene preview"}</button>
                      <button type="button" className="button small" disabled={saving || Boolean(savingSceneId) || Boolean(regeneratingSceneId) || draftIndex === 0} onClick={() => { setChapterProductionPlan(undefined); setDraft((current) => moveChapterSceneDraft(current, scene.id, -1)); }}>Move up</button>
                      <button type="button" className="button small" disabled={saving || Boolean(savingSceneId) || Boolean(regeneratingSceneId) || draftIndex === draft.length - 1} onClick={() => { setChapterProductionPlan(undefined); setDraft((current) => moveChapterSceneDraft(current, scene.id, 1)); }}>Move down</button>
                      <button type="button" className="button small" disabled={saving || Boolean(savingSceneId) || Boolean(regeneratingSceneId) || (!scene.disabled && enabledProductionScenes(draft).length <= 1)} onClick={() => { setChapterProductionPlan(undefined); setDraft((current) => toggleChapterSceneEnabledDraft(current, scene.id)); }}>{scene.disabled ? "Enable" : "Disable"}</button>
                      <button type="button" className="button small" title={!canDeleteChapterSceneDraft(draft, scene.id) ? "A chapter must keep at least one scene and at least one enabled scene." : undefined} disabled={saving || Boolean(savingSceneId) || Boolean(regeneratingSceneId) || !canDeleteChapterSceneDraft(draft, scene.id)} onClick={() => { const confirmed = confirm("Delete this visual beat from the chapter scene plan? Existing immutable artwork files are not automatically destroyed."); if (!confirmed || !data.manifest) return; try { const next = deleteChapterSceneDraft(draft, scene.id, confirmed, data.manifest.durationSeconds, data.settings); setChapterProductionPlan(undefined); setDraft(next); setSelectedSceneIds((current) => current.filter((id) => id !== scene.id)); setError(""); } catch (cause) { setError(message(cause)); } }}>Delete scene</button>
                    </div>
                    {sceneErrors[scene.id] && <div className="error-box" role="alert">{sceneErrors[scene.id]}</div>}
                    {sceneProposal?.sceneId === scene.id && <div className="summary-scene-proposal"><strong>Regeneration proposal · {sceneProposal.mode === "image_prompt" ? "Image prompt only" : "Full visual direction"}</strong><small>{sceneProposal.provider} · {sceneProposal.model} · Preview only; saved scene unchanged.</small>
                      {([["Visual beat", "summary"], ["Image prompt", "visualPrompt"], ["Characters", "characters"], ["Location", "location"], ["Importance", "importance"]] as const).map(([label, key]) => <div className="summary-proposal-row" key={key}><b>{label}</b><span><small>Current</small>{Array.isArray(sceneProposal.current[key]) ? sceneProposal.current[key].join(", ") : sceneProposal.current[key] ?? "—"}</span><span><small>Proposed</small>{Array.isArray(sceneProposal.proposed[key]) ? sceneProposal.proposed[key].join(", ") : sceneProposal.proposed[key] ?? "—"}</span></div>)}
                      <div className="scene-edit-actions"><button type="button" className="button primary" disabled={Boolean(regeneratingSceneId) || structuralChanges || chapterSceneDirty(scene, saved)} onClick={() => void applySceneRegeneration(scene.id)}>Apply proposal</button><button type="button" className="button" disabled={Boolean(regeneratingSceneId)} onClick={() => setSceneProposal(undefined)}>Cancel</button></div></div>}

                    {/* Versions Switcher Bar */}
                    {versions.length > 0 && (
                      <div className="version-tabs-bar">
                        <div className="version-tabs">
                          {versions.map((ver) => {
                            const isApproved = scene.artwork?.approvedVersionId === ver.id;
                            const isSelected = selectedVerId === ver.id;
                            return (
                              <button
                                key={ver.id}
                                type="button"
                                className={`version-tab ${isSelected ? "active" : ""} ${isApproved ? "is-approved" : ""}`}
                                onClick={() => setSelectedVersionByScene({ ...selectedVersionByScene, [scene.id]: ver.id })}
                                title={`Version ${ver.versionNumber}: ${new Date(ver.createdAt).toLocaleTimeString()} (${ver.provider}/${ver.model})${ver.original ? ` · Original ${ver.original.width}×${ver.original.height}` : ""}${ver.production ? ` · Production ${ver.production.width}×${ver.production.height}${ver.production.upscaled ? " (AI upscaled)" : ""}` : ""}${ver.upscale?.status === "unavailable" ? " · Upscaler unavailable — using original" : ""}${ver.provenance?.referencesUsed ? ` · references: ${ver.provenance.referencesUsed}${ver.provenance.referenceImageCount ? ` (${ver.provenance.referenceImageCount} image${ver.provenance.referenceImageCount === 1 ? "" : "s"})` : ""}` : ""}${isApproved ? " · approved" : ""}`}
                              >
                                v{ver.versionNumber}{isApproved ? " ✓" : ""}
                              </button>
                            );
                          })}
                        </div>
                        {displayedVersion && (
                          <div className="version-approve-action">
                            {scene.artwork?.approvedVersionId === displayedVersion.id ? (
                              <span className="version-approved-note">✓ Approved Canon Version</span>
                            ) : (
                              <button
                                type="button"
                                className="button small text-btn"
                                onClick={() => handleApproveVersion(scene, displayedVersion.id)}
                              >
                                Approve v{displayedVersion.versionNumber}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {displayedVersion && <ArtworkVersionMetadata version={displayedVersion} />}
                    {displayedVersion && <VisualGroundingPanel label={`Grounding recorded for v${displayedVersion.versionNumber}`} recorded={Boolean(displayedVersion.provenance || displayedVersion.resolvedVisualProfileReferences?.length || displayedVersion.artDirectionFingerprint)}>
                      <span>Art Direction · {displayedVersion.artDirectionFingerprint ? "recorded for this version" : "not recorded"}</span>
                      {(displayedVersion.resolvedVisualProfileReferences ?? []).length ? displayedVersion.resolvedVisualProfileReferences!.map((reference) => <span key={`${reference.entityId}:${reference.referenceId ?? ""}`}>{reference.name ?? reference.entityId} — {reference.referenceId ? "approved reference" : "Visual Profile context"}</span>) : <span>Visual Profile references not recorded</span>}
                      {displayedVersion.provenance?.continuityReference?.used ? <span>Continuity · {displayedVersion.provenance.continuityReference.sourceSceneId ?? "previous scene"}{displayedVersion.provenance.continuityReference.versionNumber ? ` approved v${displayedVersion.provenance.continuityReference.versionNumber}` : ""} reference</span> : <span>Continuity · {displayedVersion.provenance?.continuityReference?.reason ?? "no previous artwork reference recorded"}</span>}
                      <span>Reference mode · {displayedVersion.provenance?.referencesUsed ?? "not recorded"}</span>
                    </VisualGroundingPanel>}

                    <Field label="Summary">
                      <textarea
                        value={scene.summary}
                        onChange={(event) => edit(scene.id, { summary: event.target.value })}
                      />
                    </Field>

                    <div className="scene-fields">
                      <Field label="Start seconds">
                        <input
                          type="number"
                          step="0.001"
                          min="0"
                          value={scene.startSeconds}
                          onChange={(event) => edit(scene.id, { startSeconds: Number(event.target.value) })}
                        />
                      </Field>
                      <Field label="End seconds">
                        <input
                          type="number"
                          step="0.001"
                          min="0"
                          value={scene.endSeconds}
                          onChange={(event) => edit(scene.id, { endSeconds: Number(event.target.value) })}
                        />
                      </Field>
                      <Field label="Importance">
                        <select
                          value={scene.importance}
                          onChange={(event) => edit(scene.id, { importance: event.target.value as Scene["importance"] })}
                        >
                          <option value="transition">Transition</option>
                          <option value="standard">Standard</option>
                          <option value="major">Major</option>
                        </select>
                      </Field>
                    </div>

                    <div className="scene-fields two">
                      <div>
                        <Field label="Characters">
                          <input
                            value={(scene.characters ?? []).join(", ")}
                            onChange={(event) =>
                              edit(scene.id, {
                                characters: event.target.value
                                  .split(",")
                                  .map((v) => v.trim())
                                  .filter(Boolean),
                              })
                            }
                          />
                        </Field>
                        {(scene.characters ?? []).length > 0 && (
                          <div className="entity-chip-list">
                            {(scene.characters ?? []).map((charName, charIdx) => {
                              const profileList = Array.isArray(data.visualProfiles)
                                ? data.visualProfiles
                                : Object.values(data.visualProfiles ?? {});

                              let resolved = scene.resolvedCharacters?.[charIdx]?.name === charName
                                ? scene.resolvedCharacters[charIdx]
                                : scene.resolvedCharacters?.find((r) => r.name === charName);

                              if (!resolved && profileList.length > 0) {
                                const matched = profileList.find(
                                  (p: any) => p.canonicalName === charName || p.entityId === charName
                                );
                                if (matched) {
                                  resolved = {
                                    name: charName,
                                    entityId: matched.entityId,
                                    canonicalName: matched.canonicalName || charName,
                                    profileStatus: matched.status === "approved" ? "approved" : "draft",
                                    visualProfileId: matched.id,
                                    resolution: "exact_id",
                                  };
                                }
                              }

                              if (resolved?.entityId) {
                                const statusLabel =
                                  resolved.profileStatus === "approved"
                                    ? "(approved)"
                                    : resolved.profileStatus === "draft"
                                    ? "(draft)"
                                    : "(no profile)";
                                const displayName =
                                  resolved.canonicalName && resolved.canonicalName !== charName
                                    ? `${charName} (${resolved.canonicalName})`
                                    : charName;
                                return (
                                  <button
                                    key={`${charName}-${charIdx}`}
                                    type="button"
                                    className={`entity-chip ${resolved.profileStatus === "approved" ? "approved" : ""}`}
                                    onClick={() => {
                                      setActiveVisualProfile({
                                        id: resolved!.entityId!,
                                        name: resolved!.canonicalName || charName,
                                      });
                                    }}
                                    title={`Visual Profile for ${resolved.canonicalName || charName} [${resolved.entityId}]`}
                                  >
                                    <span className="chip-canon-icon">✦</span>
                                    <span>{displayName}</span>
                                    <small>{statusLabel}</small>
                                  </button>
                                );
                              }

                              return (
                                <span
                                  key={`${charName}-${charIdx}`}
                                  className="entity-chip unlinked"
                                  title={`"${charName}" is not linked to a canonical Story Bible entity`}
                                  style={{ opacity: 0.6, cursor: "not-allowed", borderStyle: "dashed" }}
                                >
                                  <span className="chip-canon-icon">?</span>
                                  <span>{charName}</span>
                                  <small>(unlinked)</small>
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <Field label="Location">
                        <input
                          value={scene.location ?? ""}
                          onChange={(event) => edit(scene.id, { location: event.target.value || undefined })}
                        />
                      </Field>
                    </div>

                    <AdvancedVisualDirection source="chapter" direction={scene.direction} overrides={scene.overrides} artDirection={data.artDirection}
                      onDirection={(patch) => editDirection(scene.id, patch)} onOverrides={(patch) => editOverrides(scene.id, patch)} />

                    <SceneContinuityPanel
                      key={`${scene.id}:${scene.continuity?.manualOverride?.revision ?? 0}`}
                      scene={scene}
                      busy={continuityBusy}
                      onSave={(input) => void saveSceneContinuity(scene, input)}
                      onReset={() => void resetSceneContinuityOverride(scene)}
                    />

                    <Field label="Artwork prompt">
                      <textarea
                        className="prompt-editor"
                        value={scene.visualPrompt}
                        onChange={(event) => edit(scene.id, { visualPrompt: event.target.value })}
                      />
                    </Field>

                    <div className="scene-review">
                      <button onClick={() => review(scene, "approved")} disabled={!displayImageUrl || structuralChanges}>
                        Approve
                      </button>
                      <button onClick={() => review(scene, "rejected")} disabled={!displayImageUrl || structuralChanges}>
                        Reject
                      </button>
                      <button onClick={() => review(scene, "needs-regeneration")} disabled={!displayImageUrl || structuralChanges}>
                        Needs regeneration
                      </button>
                      <button
                        className="regenerate"
                        onClick={() => run("artwork", { scenes: [scene.id], force: true })}
                        disabled={structuralChanges}
                        title="Regenerate this scene as a new Version (preserves earlier versions)"
                      >
                        Regenerate frame (v{versions.length + 1})
                      </button>
                    </div>

                    {scene.artwork.error && <small className="scene-error">{scene.artwork.error}</small>}
                  </div>
                </article>
              );
            })}
          </div>
        </>
      ) : (
        <Empty
          title="No scene plan yet"
          text="Choose one mastered chapter and plan its visual sequence. No artwork is generated during planning."
          action={
            <button className="button primary" disabled={plannerNotReady || Boolean(rangeError)} onClick={() => run("scenes")}>
              Plan this chapter
            </button>
          }
        />
      )}

      {showArtDirectionModal && (
        <ArtDirectionModal
          slug={slug}
          onClose={() => setShowArtDirectionModal(false)}
          onUpdated={() => load(data?.selectedChapter)}
        />
      )}

      {visualPreflight && <VisualProfileCheckDialog slug={slug} report={visualPreflight} oneTimeEntityIds={oneTimeUnprofiled} onOneTimeEntityIds={setOneTimeUnprofiled}
        onCancel={() => { setVisualPreflight(null); setPendingArtworkExtra(null); setOneTimeUnprofiled([]); }} onContinue={continueArtworkAfterPreflight} onRefresh={() => void reopenArtworkPreflight()} onError={(value) => setError(message(value))} />}
    </section>
  );
}

export function VideoPage({ slug, onJob }: { slug: string; onJob: (job: Job) => void }) {
  const [data, setData] = useState<Omit<VideoDashboard, "chapters"> & { minChapter?: number; maxChapter?: number }>();
  const [chapterPage, setChapterPage] = useState<{ items: VideoDashboard["chapters"]; page: number; pages: number; total: number }>();
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(25); const [refreshVersion, setRefreshVersion] = useState(0);
  const [range, setRange] = useState({ from: "", to: "", subtitleMode: "burn" as "none" | "burn" | "soft" | "both" });
  const [error, setError] = useState(""); const [pageError, setPageError] = useState(""); const watcher = useRef<(() => void) | undefined>(undefined);
  const summaryRequest = useRef(0); const pageRequest = useRef(0);
  useEffect(() => { const request = ++summaryRequest.current; api<Omit<VideoDashboard, "chapters"> & { minChapter?: number; maxChapter?: number }>(`/stories/${slug}/video/summary`).then((next) => { if (request !== summaryRequest.current) return; setData(next); setError(""); setRange((current) => ({ ...current, subtitleMode: next.settings.subtitleMode, ...(!current.from ? { from: String(next.minChapter ?? ""), to: String(next.maxChapter ?? "") } : {}) })); }).catch((value) => { if (request === summaryRequest.current) setError(message(value)); }); return () => { summaryRequest.current++; }; }, [slug, refreshVersion]);
  useEffect(() => { const request = ++pageRequest.current; api<{ items: VideoDashboard["chapters"]; page: number; pages: number; total: number }>(`/stories/${slug}/video/chapters?page=${page}&pageSize=${pageSize}`).then((next) => { if (request === pageRequest.current) { setChapterPage(next); setPageError(""); } }).catch((value) => { if (request === pageRequest.current) setPageError(message(value)); }); return () => { pageRequest.current++; }; }, [slug, page, pageSize, refreshVersion]);
  useEffect(() => () => watcher.current?.(), [slug]);
  const run = async (kind: "subtitles" | "video" | "video-export") => { try { setError(""); const job = await post<Job>(`/stories/${slug}/jobs/${kind}`, { from: Number(range.from), to: Number(range.to), ...(kind === "video" ? { subtitleMode: range.subtitleMode } : {}) }); onJob(job); watcher.current?.(); watcher.current = watchJob(job.id, (next) => { onJob(next); if (next.status === "completed") setRefreshVersion((value) => value + 1); else if (next.status === "failed") setError(next.error ?? "Video job failed"); }, (value) => setError(message(value))); } catch (value) { setError(message(value)); } };
  if (!data && !chapterPage) return error ? <LoadFailure error={error} /> : <Loading />;
  if (!data) return <section className="page video-page">{error && <ErrorBox text={error} />}{pageError && <ErrorBox text={pageError} />}{chapterPage?.items.map((item) => <p key={item.chapter}>Chapter {item.chapter} · {item.title}</p>)}</section>;
  return <section className="page video-page"><div className="section-heading"><div><span className="eyebrow">Picture desk</span><h2>Chapter video editions</h2><p>Mastered narration becomes a restrained, readable screen edition.</p></div><div className="video-format-stamp">{data.settings.width}<i>×</i>{data.settings.height}<small>{data.settings.fps} FPS · H.264</small></div></div>
    <div className="render-rail"><span className={`rail-node ${data.counts.mastered ? "complete" : ""}`}><i>01</i><b>Mastered audio</b><small>{data.counts.mastered} / {data.counts.total}</small></span><span className={`rail-node ${data.counts.subtitles ? "complete" : ""}`}><i>02</i><b>Subtitle timing</b><small>{data.counts.subtitles} / {data.counts.total}</small></span><span className={`rail-node ${data.background.coverAvailable ? "complete" : "fallback"}`}><i>03</i><b>Visual field</b><small>{data.background.coverAvailable ? `${data.background.coverName} · ${data.background.effectiveMode}` : "Generated studio fallback"}</small></span><span className={`rail-node ${data.counts.videos ? "complete" : ""}`}><i>04</i><b>Chapter renders</b><small>{data.counts.videos} / {data.counts.total}</small></span></div>
    <div className="video-console"><div><span className="eyebrow">Render range</span><h3>Screen edition</h3><p>{data.settings.introDurationSeconds}s title card · CRF {data.settings.quality} · {pretty(data.settings.backgroundMode)}</p></div><Field label="From"><input value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field><Field label="To"><input value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field><Field label="Subtitles"><select value={range.subtitleMode} onChange={(e) => setRange({ ...range, subtitleMode: e.target.value as typeof range.subtitleMode })}><option value="burn">Burned in</option><option value="soft">Optional track</option><option value="both">Burned + track</option><option value="none">No subtitles</option></select></Field><div className="video-actions"><button className="button" onClick={() => run("subtitles")}>Generate subtitles</button><button className="button" onClick={() => run("video")}>Render chapters</button><button className="button primary" onClick={() => run("video-export")}>Build combined video</button></div></div>
    {error && <ErrorBox text={error} />}{pageError && <ErrorBox text={pageError} />}<div className="video-ledger"><section><div className="ledger-head"><h3>Render queue</h3><span className="mono">{data.counts.videos} ready</span><label>Rows <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></label></div>{chapterPage && chapterPage.pages > 1 && <Pagination position="top" page={chapterPage.page} pages={chapterPage.pages} total={chapterPage.total} itemLabel="chapters" onPrevious={() => setPage(chapterPage.page - 1)} onNext={() => setPage(chapterPage.page + 1)} />}{chapterPage?.items.map((chapter) => <article key={chapter.chapter}><span className="chapter-index">{String(chapter.chapter).padStart(4, "0")}</span><div><b>{chapter.title ?? `Chapter ${chapter.chapter}`}</b><small>{chapter.durationSeconds ? `${formatDuration(chapter.durationSeconds)} audio` : "Master audio first"}</small></div><Stage value={chapter.subtitleStatus} /><Stage value={chapter.videoStatus} />{chapter.videoAvailable ? <>{chapter.videoStale && <Status status="warn" label="stale" />}<video controls preload="none" src={`/api/stories/${slug}/chapters/${chapter.chapter}/video`} /></> : <span className="render-empty">—</span>}</article>)}{chapterPage && chapterPage.pages > 1 && <Pagination position="bottom" page={chapterPage.page} pages={chapterPage.pages} total={chapterPage.total} itemLabel="chapters" onPrevious={() => setPage(chapterPage.page - 1)} onNext={() => setPage(chapterPage.page + 1)} />}</section><aside><h3>Combined editions</h3>{data.exports.length ? data.exports.map((item) => <a href={item.downloadUrl} download key={item.fingerprint}><span>MP4</span><div><b>Chapters {item.from}–{item.to}</b><small>{formatDuration(item.durationSeconds)} · {new Date(item.createdAt).toLocaleString()}</small></div><strong>↓</strong></a>) : <Empty title="No video edition yet" text="Render a range, then build one continuous MP4." />}</aside></div>
  </section>;
}

export function AudioPage({ slug, onJob }: { slug: string; onJob: (job: Job) => void }) {
  const [data, setData] = useState<Omit<AudioDashboard, "chapters"> & { minChapter?: number; maxChapter?: number }>();
  const [masters, setMasters] = useState<{ items: AudioDashboard["chapters"]; page: number; pages: number; total: number }>();
  const [range, setRange] = useState({ from: "", to: "", format: "m4b" as "mp3" | "m4b" });
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(() => { const value = Number(new URLSearchParams(location.search).get("pageSize")); return [10, 25, 50, 100].includes(value) ? value : 25; });
  const [error, setError] = useState(""); const [pageError, setPageError] = useState(""); const watcher = useRef<(() => void) | undefined>(undefined);
  const summaryRequest = useRef(0); const pageRequest = useRef(0); const [refreshVersion, setRefreshVersion] = useState(0);
  useEffect(() => { const request = ++summaryRequest.current; api<Omit<AudioDashboard, "chapters"> & { minChapter?: number; maxChapter?: number }>(`/stories/${slug}/audio/summary`).then((next) => { if (request !== summaryRequest.current) return; setData(next); setError(""); setRange((current) => current.from ? current : { ...current, from: String(next.minChapter ?? ""), to: String(next.maxChapter ?? "") }); }).catch((value) => { if (request === summaryRequest.current) setError(message(value)); }); return () => { summaryRequest.current++; }; }, [slug, refreshVersion]);
  useEffect(() => { const request = ++pageRequest.current; api<{ items: AudioDashboard["chapters"]; page: number; pages: number; total: number }>(`/stories/${slug}/audio/chapters?page=${page}&pageSize=${pageSize}`).then((next) => { if (request === pageRequest.current) { setMasters(next); setPageError(""); } }).catch((value) => { if (request === pageRequest.current) setPageError(message(value)); }); return () => { pageRequest.current++; }; }, [slug, page, pageSize, refreshVersion]);
  useEffect(() => () => watcher.current?.(), [slug]);
  const run = async (kind: "audio" | "audiobook") => { try { setError(""); const body = { from: Number(range.from), to: Number(range.to), ...(kind === "audiobook" ? { format: range.format } : {}) }; const job = await post<Job>(`/stories/${slug}/jobs/${kind}`, body); onJob(job); watcher.current?.(); watcher.current = watchJob(job.id, (next) => { onJob(next); if (next.status === "completed") setRefreshVersion((value) => value + 1); else if (next.status === "failed") setError(next.error ?? "Audio job failed"); }, (value) => setError(message(value))); } catch (value) { setError(message(value)); } };
  if (!data && !masters) return error ? <LoadFailure error={error} /> : <Loading />;
  if (!data) return <section className="page audio-page">{error && <ErrorBox text={error} />}{pageError && <ErrorBox text={pageError} />}{masters?.items.map((item) => <p key={item.chapter}>Chapter {item.chapter} · {item.title}</p>)}</section>;
  return <section className="page audio-page"><div className="section-heading"><div><h2>Audio mastering &amp; export</h2><p>Polished chapter masters and bookmarkable audiobook editions.</p></div><Status status={data.counts.mastered !== data.counts.total || !data.counts.total ? "pending" : data.counts.stale ? "warn" : "pass"} label={`${data.counts.mastered} / ${data.counts.total} available${data.counts.stale ? ` · ${data.counts.stale} stale` : ""}`} /></div>
    <div className="audio-metrics"><article><span>Available chapter masters</span><b>{data.counts.mastered}</b><small>{data.counts.current} current · {data.counts.stale} stale</small></article><article><span>Total available audio</span><b>{formatDuration(data.totalDurationSeconds)}</b></article><article><span>Loudness target</span><b>{data.settings.loudnessTarget} <small>LUFS</small></b></article><article><span>True peak ceiling</span><b>{data.settings.truePeak} <small>dBTP</small></b></article></div>
    <div className="export-console"><div><span className="eyebrow">Build an edition</span><h3>{range.format.toUpperCase()} audiobook</h3><p>Existing masters—including stale retained versions—are used as-is. Only missing chapter masters are created first.</p></div><Field label="From"><input value={range.from} inputMode="numeric" onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field><Field label="To"><input value={range.to} inputMode="numeric" onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field><Field label="Format"><select value={range.format} onChange={(e) => setRange({ ...range, format: e.target.value as "mp3" | "m4b" })}><option value="m4b">M4B · chapters + bookmarks</option><option value="mp3">MP3 · universal playback</option></select></Field><div className="export-actions"><button className="button" onClick={() => run("audio")}>Master missing chapters</button><button className="button primary" onClick={() => run("audiobook")}>Build audiobook</button></div></div>
    {error && <ErrorBox text={error} />}{pageError && <ErrorBox text={pageError} />}<div className="audio-layout"><section><div className="audio-master-heading"><h3>Chapter masters</h3><label className="chapter-page-size"><span>Chapters per page</span><select value={pageSize} aria-label="Chapter masters per page" onChange={(event) => { const next = Number(event.target.value); setPageSize(next); setPage(1); const url = new URL(location.href); url.searchParams.set("pageSize", String(next)); history.replaceState({}, "", `${url.pathname}${url.search}`); }}><option value="10">10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label></div>{(masters?.total ?? 0) > 0 && <Pagination position="top" page={masters!.page} pages={masters!.pages} total={masters!.total} itemLabel="chapters" onPrevious={() => setPage(masters!.page - 1)} onNext={() => setPage(masters!.page + 1)} />}<div className="master-list">{masters?.items.map((chapter) => <article key={chapter.chapter}><span className="mono">{String(chapter.chapter).padStart(4, "0")}</span><div><b>{chapter.title ?? `Chapter ${chapter.chapter}`}</b><small>{chapter.durationSeconds ? formatDuration(chapter.durationSeconds) : chapter.audioAvailable ? (chapter.audioStale ? "Retained master" : "Mastered") : "Awaiting master"}</small></div><div className="master-flags"><Stage value={chapter.status} />{chapter.audioStale && chapter.status !== "stale" && <Status status="warn" label="stale" />}</div>{chapter.audioAvailable && <div className="master-audio"><audio controls preload="none" src={`/api/stories/${slug}/chapters/${chapter.chapter}/audio`} /><a className="audio-download" href={`/api/stories/${slug}/chapters/${chapter.chapter}/audio?download=1`} download>Download MP3</a></div>}</article>)}</div>{(masters?.total ?? 0) > 0 && <Pagination position="bottom" page={masters!.page} pages={masters!.pages} total={masters!.total} itemLabel="chapters" onPrevious={() => setPage(masters!.page - 1)} onNext={() => setPage(masters!.page + 1)} />}</section><section><h3>Exports</h3><div className="export-list">{data.exports.length ? data.exports.map((item) => <a href={item.downloadUrl} key={item.fingerprint} download><span>{item.format.toUpperCase()}</span><div><b>Chapters {item.from}–{item.to}</b><small>{formatDuration(item.durationSeconds)} · {new Date(item.createdAt).toLocaleString()}</small></div><strong>↓</strong></a>) : <Empty title="No editions yet" text="Choose a range and build your first MP3 or M4B." />}</div></section></div>
  </section>;
}

const OUTPUT_GROUPS: Array<[OutputItem["group"], string]> = [["chapterAudio", "Chapter audio"], ["audiobooks", "Audiobooks"], ["chapterVideos", "Chapter videos"], ["combinedVideos", "Combined videos"], ["subtitles", "Subtitles"], ["artwork", "Artwork"]];
function OutputGroupSection({ slug, group, label, count }: { slug: string; group: OutputItem["group"]; label: string; count?: number }) {
  const [open, setOpen] = useState(group === "chapterAudio"); const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: OutputItem[]; page: number; pages: number; total: number }>(); const [error, setError] = useState(""); const requestRef = useRef(0); const [retry, setRetry] = useState(0);
  useEffect(() => { if (!open) return; const request = ++requestRef.current; api<{ items: OutputItem[]; page: number; pages: number; total: number }>(`/stories/${slug}/outputs/page?group=${group}&page=${page}&pageSize=50`).then((next) => { if (request === requestRef.current) { setData(next); setError(""); } }).catch((value) => { if (request === requestRef.current) setError(message(value)); }); return () => { requestRef.current++; }; }, [slug, group, open, page, retry]);
  return <section className="output-group"><button type="button" onClick={() => setOpen((value) => !value)}><h3>{label}</h3><span>{data?.total ?? count ?? "—"}</span></button>{open && <>{error && <><ErrorBox text={error} /><button className="button" onClick={() => setRetry((value) => value + 1)}>Retry {label}</button></>}{data?.items.length ? <div className="output-grid">{data.items.map((item) => <article key={item.id}><span className="format-stamp">{item.format.toUpperCase()}</span><div><b>{item.chapter ? "Chapter " + item.chapter : "Chapters " + item.from + "–" + item.to}</b><small>{formatBytes(item.bytes)} · {new Date(item.createdAt).toLocaleString()}{item.durationSeconds ? " · " + formatDuration(item.durationSeconds) : ""}</small></div><div>{["mp3", "m4b"].includes(item.format) && <a href={item.url}>Play</a>}{["mp4", "png"].includes(item.format) && <a href={item.url} target="_blank">View</a>}<a href={item.downloadUrl ?? item.url} download>Download</a></div></article>)}</div> : data && !error ? <p className="empty-line">Nothing here yet. Production will place finished files here.</p> : !error && <Loading />}{data && data.pages > 1 && <Pagination position="bottom" page={data.page} pages={data.pages} total={data.total} itemLabel="files" onPrevious={() => setPage(data.page - 1)} onNext={() => setPage(data.page + 1)} />}</>}</section>;
}
export function OutputsPage({ slug }: { slug: string }) {
  const [summary, setSummary] = useState<{ counts: Partial<Record<OutputItem["group"], number>> }>(); const [error, setError] = useState("");
  useEffect(() => { let cancelled = false; api<{ counts: Partial<Record<OutputItem["group"], number>> }>(`/stories/${slug}/outputs/summary`).then((value) => { if (!cancelled) setSummary(value); }).catch((value) => { if (!cancelled) setError(message(value)); }); return () => { cancelled = true; }; }, [slug]);
  return <section className="page outputs-page"><div className="section-heading"><div><span className="eyebrow">Deliverables</span><h2>Outputs library</h2><p>Every finished file, served through validated local-file routes.</p></div><span className="mono">{summary ? Object.values(summary.counts).reduce<number>((sum, value) => sum + (value ?? 0), 0) + " known files" : ""}</span></div>{error && <ErrorBox text={error} />}{OUTPUT_GROUPS.map(([group, label]) => <OutputGroupSection key={`${slug}:${group}`} slug={slug} group={group} label={label} count={summary?.counts[group]} />)}</section>;
}

function VoicePage({ slug, onJob }: { slug: string; onJob: (job: Job) => void }) {
  const demo = "The old city held its breath as dawn touched the rooftops. Somewhere beyond the walls, a bell began to ring.";
  const [story, setStory] = useState<StoryConfig>(); const [text, setText] = useState(demo); const [referenceId, setReferenceId] = useState(""); const [model, setModel] = useState(""); const [speed, setSpeed] = useState(1); const [audioUrl, setAudioUrl] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const watcher = useRef<(() => void) | undefined>();
  useEffect(() => { api<any>("/stories/" + slug).then((value) => { setStory(value.story); setReferenceId(value.story.pipeline.tts.referenceId ?? ""); setModel(value.story.pipeline.tts.model); setSpeed(value.story.pipeline.tts.speed); }).catch((value) => setError(message(value))); }, [slug]);
  useEffect(() => () => watcher.current?.(), [slug]);
  const generate = async () => { try { setBusy(true); setError(""); setAudioUrl(""); const job = await post<Job>("/stories/" + slug + "/jobs/voice-preview", { text, provider: story?.pipeline.tts.provider, referenceId: referenceId || undefined, model, speed }); onJob(job); watcher.current?.(); watcher.current = watchJob(job.id, (next) => { onJob(next); if (next.status === "completed") { setAudioUrl(next.result.audioUrl); setBusy(false); } else if (next.status === "failed") { setError(next.error ?? "Voice preview failed"); setBusy(false); } }, (value) => { setError(message(value)); setBusy(false); }, { maxFailures: 8 }); } catch (value) { setError(message(value)); setBusy(false); } };
  if (!story) return error ? <LoadFailure error={error} /> : <Loading />;
  const provider = audioProviderDefinition(story.pipeline.tts.provider);
  return <section className="page voice-page"><div className="section-heading"><div><span className="eyebrow">Voice booth</span><h2>Test narration voice</h2><p>Preview files stay separate from chapter production and never change story fingerprints.</p></div><span className="paid-flag">{provider.previewCostLabel}</span></div><div className="voice-console"><div><Field label="Audio provider"><select value={story.pipeline.tts.provider} disabled={audioProviderIds.length === 1}>{audioProviderIds.map((id) => <option key={id} value={id}>{audioProviderCatalog[id].label}</option>)}</select></Field><Field label={provider.modelLabel}><select value={model} onChange={(event) => setModel(event.target.value)}>{provider.models.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field><Field label={provider.referenceLabel}><input value={referenceId} placeholder="Model ID or fish.audio model URL" onChange={(event) => setReferenceId(event.target.value)} /></Field><Field label={`Speed · ${speed.toFixed(2)}×`}><input type="range" min="0.5" max="2" step="0.05" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} /></Field><div className="voice-quality-note"><b>Reference-quality preview</b><span>44.1 kHz · 192 kbps · normal latency</span>{speed !== 1 && <button type="button" onClick={() => setSpeed(1)}>Use source pace · 1.00×</button>}</div></div><div><Field label={"Sample text · " + text.length + "/1200"}><textarea value={text} maxLength={1200} onChange={(event) => setText(event.target.value)} /></Field><div className="voice-actions"><button className="button" onClick={() => setText(demo)}>Use demo narration</button><button className="button primary" disabled={busy || !text.trim()} onClick={generate}>{busy ? "Generating…" : "Generate voice preview"}</button></div></div></div>{error && <ErrorBox text={error} />}{audioUrl ? <AudioDeck src={audioUrl} downloadUrl={`${audioUrl}?download=1`} title="Voice preview" download /> : <Empty title="The booth is ready" text="Choose a voice, keep the sample short, then generate a standalone preview." />}</section>;
}

function languagesMatch(left: string, right: string) { return left.trim().toLowerCase().replaceAll("_", "-") === right.trim().toLowerCase().replaceAll("_", "-"); }
export function chapterPageSize(search: string) { const value = Number(new URLSearchParams(search).get("pageSize")); return [10, 25, 50, 100].includes(value) ? value : 50; }
export function paginateRows<T>(items: readonly T[], page: number, pageSize: number) { const pages = Math.max(1, Math.ceil(items.length / pageSize)); const currentPage = Math.min(Math.max(1, page), pages); return { items: items.slice((currentPage - 1) * pageSize, currentPage * pageSize), page: currentPage, pages, total: items.length }; }
function formatSpeechAbbreviations(value: Record<string, string> | undefined) { return Object.entries(value ?? {}).map(([written, spoken]) => `${written} = ${spoken}`).join("\n"); }
function parseSpeechAbbreviations(value: string) { return Object.fromEntries(value.split("\n").map((line) => line.split("=")).map(([written, spoken]) => [written?.trim(), spoken?.trim()] as const).filter(([written, spoken]) => Boolean(written && spoken))); }
export function SettingsPage({ slug, onJob, initialStory, initialEffectiveRouting }: { slug: string; onJob: (job: Job) => void; initialStory?: StoryConfig; initialEffectiveRouting?: Record<string, ResolvedModelRouting> }) {
  const [story, setStory] = useState<StoryConfig | undefined>(initialStory);
  const [effectiveRouting, setEffectiveRouting] = useState<Record<string, ResolvedModelRouting> | undefined>(initialEffectiveRouting);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (initialStory) return;
    setStory(undefined);
    setError("");
    api<any>("/stories/" + slug).then((x) => {
      setStory(x.story);
      setEffectiveRouting(x.effectiveRouting);
    }).catch((value) => setError(message(value)));
  }, [slug, initialStory]);
  if (error && !story) return <LoadFailure error={error} />;
  if (!story) return <Loading />;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const response = await put<any>(`/stories/${slug}/settings`, {
        title: story.title,
        author: story.author,
        description: story.description,
        tags: story.tags,
        notes: story.notes,
        sourceLanguage: story.sourceLanguage,
        outputLanguage: story.outputLanguage,
        recentChapterSummaries: story.context.recentChapterSummaries,
        qaMode: story.qaMode,
        narrationSettings: story.narrationSettings,
        translation: story.pipeline.translation,
        narration: story.pipeline.narration,
        qa: story.pipeline.qa,
        storyBible: story.pipeline.storyBible,
        scenePlanner: story.pipeline.scenePlanner,
        pipelineOverrides: story.pipelineOverrides,
        tts: {
          provider: story.pipeline.tts.provider,
          model: story.pipeline.tts.model,
          referenceId: story.pipeline.tts.referenceId,
          secondaryReferenceId: story.pipeline.tts.secondaryReferenceId,
          voiceMode: story.pipeline.tts.voiceMode,
          deliveryIntensity: story.pipeline.tts.deliveryIntensity,
          qualityGuard: story.pipeline.tts.qualityGuard,
          qualityMode: story.pipeline.tts.qualityMode ?? (story.pipeline.tts.qualityGuard ? "verify" : "off"),
          providerQualityGuard: story.pipeline.tts.providerQualityGuard,
          maxCharsPerRequest: story.pipeline.tts.maxCharsPerRequest,
          maxQualityRetries: story.pipeline.tts.maxQualityRetries,
          speed: story.pipeline.tts.speed,
        },
        audio: story.audio,
        subtitles: story.subtitles,
        video: story.video,
        scenes: story.scenes,
        artwork: story.artwork,
      });
      setStory(response.story);
      if (response.effectiveRouting) setEffectiveRouting(response.effectiveRouting);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  };
  const translateMetadata = async () => {
    if (translating) return;
    try {
      setTranslating(true);
      setError("");
      const savedStory = await put<any>(`/stories/${slug}/settings`, {
        title: story.title,
        author: story.author,
        description: story.description,
        tags: story.tags,
        notes: story.notes,
        sourceLanguage: story.sourceLanguage,
        outputLanguage: story.outputLanguage,
        recentChapterSummaries: story.context.recentChapterSummaries,
        qaMode: story.qaMode,
        narrationSettings: story.narrationSettings,
        translation: story.pipeline.translation,
        narration: story.pipeline.narration,
        qa: story.pipeline.qa,
        storyBible: story.pipeline.storyBible,
        scenePlanner: story.pipeline.scenePlanner,
        pipelineOverrides: story.pipelineOverrides,
        tts: {
          provider: story.pipeline.tts.provider,
          model: story.pipeline.tts.model,
          referenceId: story.pipeline.tts.referenceId,
          secondaryReferenceId: story.pipeline.tts.secondaryReferenceId,
          voiceMode: story.pipeline.tts.voiceMode,
          deliveryIntensity: story.pipeline.tts.deliveryIntensity,
          qualityGuard: story.pipeline.tts.qualityGuard,
          qualityMode: story.pipeline.tts.qualityMode ?? (story.pipeline.tts.qualityGuard ? "verify" : "off"),
          providerQualityGuard: story.pipeline.tts.providerQualityGuard,
          maxCharsPerRequest: story.pipeline.tts.maxCharsPerRequest,
          maxQualityRetries: story.pipeline.tts.maxQualityRetries,
          speed: story.pipeline.tts.speed,
        },
        audio: story.audio,
        subtitles: story.subtitles,
        video: story.video,
        scenes: story.scenes,
        artwork: story.artwork,
      });
      setStory(savedStory.story);
      if (savedStory.effectiveRouting) setEffectiveRouting(savedStory.effectiveRouting);
      const job = await post<Job>(`/stories/${slug}/jobs/metadata-translation`, {});
      onJob(job);
      watchJob(job.id, async (next) => {
        onJob(next);
        if (next.status === "completed") {
          const value = await api<any>(`/stories/${slug}`);
          setStory(value.story);
          if (value.effectiveRouting) setEffectiveRouting(value.effectiveRouting);
          setSaved(true);
          setTimeout(() => setSaved(false), 2500);
          setTranslating(false);
        } else if (next.status === "failed" || next.status === "paused") {
          setError(next.error ?? "Metadata translation did not finish");
          setTranslating(false);
        }
      }, (value) => {
        setError(message(value));
        setTranslating(false);
      });
    } catch (value) {
      setError(message(value));
      setTranslating(false);
    }
  };
  const model = (key: "translation" | "narration" | "qa" | "storyBible" | "scenePlanner", value: Model) =>
    setStory({ ...story, pipeline: { ...story.pipeline, [key]: value } });
  const audio = (key: keyof StoryConfig["audio"], value: string | number) =>
    setStory({ ...story, audio: { ...story.audio, [key]: value } });
  const metadataAtSourceLanguage = Boolean(
    story.metadataTranslationSource && languagesMatch(story.metadataTranslationSource.language, story.outputLanguage)
  );
  const artworkModelOptions = artworkModelOptionsFor(story.artwork.provider, story.artwork.model);
  const stages = ["translation", "narration", "qa", "storyBible", "scenePlanner"] as const;
  return <section className="page settings-page">
    <div className="section-heading"><div><h2>Story settings</h2><p>Credentials remain in the server environment and are never sent here.</p></div>{saved && <Status status="pass" label="Changes saved" />}</div>
    <form onSubmit={save}>
      <div className="settings-group manuscript-settings"><h3>Manuscript</h3>
        <Field label="Story title"><input value={story.title} onChange={(event) => setStory({ ...story, title: event.target.value })} /></Field>
        <div className="field-row"><Field label="Source language"><LanguageSelect value={story.sourceLanguage} onChange={(sourceLanguage) => setStory({ ...story, sourceLanguage })} /></Field><Field label="Output language"><LanguageSelect value={story.outputLanguage} onChange={(outputLanguage) => setStory({ ...story, outputLanguage })} /></Field></div>
        <Field label="Recent summaries in context"><input type="number" min="0" max="100" value={story.context.recentChapterSummaries} onChange={(event) => setStory({ ...story, context: { recentChapterSummaries: Number(event.target.value) } })} /></Field>
      </div>
      <div className="settings-group metadata-settings"><h3>Reader metadata</h3>
        <Field label="Author"><input value={story.author ?? ""} onChange={(event) => setStory({ ...story, author: event.target.value || undefined })} /></Field>
        <Field label="Description"><textarea value={story.description} maxLength={10_000} onChange={(event) => setStory({ ...story, description: event.target.value })} /></Field>
        <Field label="Tags · comma separated"><input value={story.tags.join(", ")} onChange={(event) => setStory({ ...story, tags: event.target.value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 30) })} /></Field>
        <div className="metadata-translation"><div><span>LOCALIZE READER METADATA</span><b>{story.sourceLanguage} → {story.outputLanguage}</b><small>{metadataAtSourceLanguage ? "Restore the preserved original title, author, description, and tags." : "Uses the selected translation model. The original source metadata is retained for later retranslation."}</small></div><button type="button" className="button" disabled={translating || (languagesMatch(story.sourceLanguage, story.outputLanguage) && !metadataAtSourceLanguage)} onClick={() => void translateMetadata()}>{translating ? "Translating…" : metadataAtSourceLanguage ? "Restore original metadata" : "Translate metadata"}</button></div>
      </div>
      <div className="settings-group model-profile-group">
        <h3>Model profile</h3>
        <p className="field-note">Inherits Studio defaults unless an override is configured for this book.</p>
        {stages.map((key) => {
          const isOverridden = Boolean(story.pipelineOverrides?.[key]);
          const routing = effectiveRouting?.[key];
          const currentModel = story.pipeline[key] ?? { provider: routing?.provider ?? "openai", model: routing?.model ?? "" };
          return <div key={key} className={`stage-routing-card ${isOverridden ? "overridden" : "inherited"}`}>
            <div className="stage-routing-header">
              <div>
                <b>{pretty(key)}</b>
                <span className={`routing-badge ${isOverridden ? "override" : "inherited"}`}>
                  {isOverridden ? "Book override" : "Inherited from Studio defaults"}
                </span>
              </div>
              {isOverridden ? (
                <button
                  type="button"
                  className="button small text-btn"
                  onClick={() =>
                    setStory({
                      ...story,
                      pipelineOverrides: { ...(story.pipelineOverrides ?? {}), [key]: false },
                    })
                  }
                >
                  Reset to Studio default
                </button>
              ) : (
                <button
                  type="button"
                  className="button small text-btn"
                  onClick={() =>
                    setStory({
                      ...story,
                      pipelineOverrides: { ...(story.pipelineOverrides ?? {}), [key]: true },
                      pipeline: {
                        ...story.pipeline,
                        [key]: {
                          provider: routing?.provider ?? currentModel.provider,
                          model: routing?.model ?? currentModel.model,
                        },
                      },
                    })
                  }
                >
                  Use book override
                </button>
              )}
            </div>
            {isOverridden ? (
              <ModelEditor label="" value={currentModel} onChange={(value) => model(key, value)} />
            ) : (
              <div className="inherited-routing-info">
                <span className="mono">{routing ? `${routing.provider} · ${routing.model}` : `${currentModel.provider} · ${currentModel.model}`}</span>
                {routing && !routing.ready && <small className="field-note error">{routing.reason}</small>}
              </div>
            )}
          </div>;
        })}
        <Field label="QA mode"><select value={story.qaMode ?? "production"} onChange={(event) => setStory({ ...story, qaMode: event.target.value as StoryConfig["qaMode"] })}><option value="production">Production — material issues only</option><option value="thorough">Thorough — also style and polish</option></select></Field>
        <label className={`narration-policy ${story.narrationSettings.profanityMode === "soften-strong" ? "active" : ""}`}>
          <div><span>NARRATION ONLY</span><b>Soften strong profanity</b><small>Uses milder wording for harsh terms while keeping the scene's meaning and intensity. Ass, hell, and damn remain allowed. Original and translation stay unchanged.</small></div>
          <input type="checkbox" checked={story.narrationSettings.profanityMode === "soften-strong"} onChange={(event) => setStory({ ...story, narrationSettings: { ...story.narrationSettings, profanityMode: event.target.checked ? "soften-strong" : "preserve" } })} />
          <i aria-hidden="true" />
        </label>
        <label className={`narration-policy ${story.narrationSettings.bleepStrongProfanity ? "active" : ""}`}>
          <div><span>AUDIO ONLY</span><b>Bleep strong profanity</b><small>Inserts a local censor tone for strong terms after TTS. Ass, hell, and damn remain. Original, translation, and saved narration stay unchanged.</small></div>
          <input type="checkbox" checked={story.narrationSettings.bleepStrongProfanity} onChange={(event) => setStory({ ...story, narrationSettings: { ...story.narrationSettings, bleepStrongProfanity: event.target.checked } })} />
          <i aria-hidden="true" />
        </label>
        <label className={`narration-policy ${story.narrationSettings.includeChapterTitle === false ? "active" : ""}`}>
          <div><span>NARRATION ONLY</span><b>Omit chapter title</b><small>Starts narration with the chapter body. The original source and translated chapter keep their title.</small></div>
          <input type="checkbox" checked={story.narrationSettings.includeChapterTitle === false} onChange={(event) => setStory({ ...story, narrationSettings: { ...story.narrationSettings, includeChapterTitle: !event.target.checked } })} />
          <i aria-hidden="true" />
        </label>
        <Field label="Speech normalization"><select value={story.narrationSettings.speechNormalization ?? "automatic"} onChange={(event) => setStory({ ...story, narrationSettings: { ...story.narrationSettings, speechNormalization: event.target.value as "automatic" | "enabled" | "disabled" } })}><option value="automatic">Automatic · natural for narration language</option><option value="enabled">Enabled</option><option value="disabled">Disabled · preserve written text</option></select><small className="field-note">Converts high-confidence structured text for TTS only. Visible narration is never changed.</small></Field>
        <Field label="Time speech"><select value={story.narrationSettings.timeSpeechMode ?? "natural_12h"} disabled={story.narrationSettings.speechNormalization === "disabled"} onChange={(event) => setStory({ ...story, narrationSettings: { ...story.narrationSettings, timeSpeechMode: event.target.value as "natural_12h" | "natural_24h" | "preserve" } })}><option value="natural_12h">Natural 12-hour · 23:57 → eleven fifty-seven p.m.</option><option value="natural_24h">Natural 24-hour · twenty-three fifty-seven</option><option value="preserve">Preserve written form</option></select></Field>
        <Field label="Vocalizations"><select value={story.narrationSettings.speechVocalizations?.mode ?? "automatic"} disabled={story.narrationSettings.speechNormalization === "disabled"} onChange={(event) => setStory({ ...story, narrationSettings: { ...story.narrationSettings, speechVocalizations: { ...story.narrationSettings.speechVocalizations, mode: event.target.value as "automatic" | "preserve" | "disabled" } } })}><option value="automatic">Automatic · rewrite or tag laughter, sighs, and gasps</option><option value="preserve">Preserve · record diagnostics only</option><option value="disabled">Disabled · ignore vocalizations</option></select><small className="field-note">Detects expressive interjections (Hahaha, sigh, ugh) and renders them for TTS. Visible narration is never changed.</small></Field>
        <Field label="Vocalization fallback"><select value={story.narrationSettings.speechVocalizations?.fallback ?? "safe_normalize"} disabled={story.narrationSettings.speechNormalization === "disabled" || (story.narrationSettings.speechVocalizations?.mode ?? "automatic") !== "automatic"} onChange={(event) => setStory({ ...story, narrationSettings: { ...story.narrationSettings, speechVocalizations: { ...story.narrationSettings.speechVocalizations, fallback: event.target.value as "safe_normalize" | "omit_unsupported" | "preserve" } } })}><option value="safe_normalize">Safe normalize · canonical short spoken form</option><option value="omit_unsupported">Omit unsupported · drop the vocalization</option><option value="preserve">Preserve · leave text unchanged</option></select><small className="field-note">Applies when the TTS provider has no native expressive tag for a detected vocalization.</small></Field>
        <Field label="Abbreviation speech overrides"><textarea value={formatSpeechAbbreviations(story.narrationSettings.speechAbbreviations)} placeholder={"EXP = experience points\nNPC = non-player character"} onChange={(event) => setStory({ ...story, narrationSettings: { ...story.narrationSettings, speechAbbreviations: parseSpeechAbbreviations(event.target.value) } })} /><small className="field-note">One <code>WRITTEN = spoken form</code> per line. Defaults cover EXP, XP, HP, MP, and NPC; overrides affect TTS only.</small></Field>
      </div>
      <div className="settings-group artwork-settings"><h3>Artwork</h3>
        <section className="settings-subsection"><h4>Image Generation</h4>
          <Field label="Image provider">
            <select
              value={story.artwork.provider}
              onChange={(event) => {
                const provider = event.target.value as StoryConfig["artwork"]["provider"];
                const entry = ARTWORK_PROVIDERS.find((item) => item.name === provider);
                setStory({ ...story, artwork: { ...story.artwork, provider, model: entry?.defaultModel ?? story.artwork.model } });
              }}
            >
              {ARTWORK_PROVIDERS.map((item) => <option key={item.name} value={item.name}>{item.name === "openai" ? "OpenAI" : "Gemini"}</option>)}
            </select>
          </Field>
          <Field label="Image model">
            <select
              value={story.artwork.model}
              onChange={(event) => setStory({ ...story, artwork: { ...story.artwork, model: event.target.value } })}
            >
              {artworkModelOptions.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <small className="field-note">Switching the provider preselects its default model. Style, aspect ratio, and quality settings are unchanged.</small>
          </Field>
          <Field label="Generation quality">
            <select
              value={story.artwork.quality}
              onChange={(event) => setStory({ ...story, artwork: { ...story.artwork, quality: event.target.value as ArtworkSettings["quality"] } })}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
            <small className="field-note">Generation effort and cost per image. Final size is set under Output Quality.</small>
          </Field>
          <Field label="Aspect ratio">
            <select
              value={story.artwork.aspectRatio}
              onChange={(event) => setStory({ ...story, artwork: { ...story.artwork, aspectRatio: event.target.value as ArtworkSettings["aspectRatio"] } })}
            >
              <option value="16:9">16:9 · landscape</option>
              <option value="1:1">1:1 · square</option>
              <option value="9:16">9:16 · portrait</option>
            </select>
          </Field>
        </section>
        <section className="settings-subsection"><h4>Output Quality</h4>
          <Field label="Final resolution">
            <select
              value={story.artwork.outputResolution}
              onChange={(event) => setStory({ ...story, artwork: { ...story.artwork, outputResolution: event.target.value as ArtworkSettings["outputResolution"] } })}
            >
              <option value="native">Native · provider decides</option>
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
              <option value="1440p">1440p</option>
              <option value="2160p">4K (2160p)</option>
            </select>
            <small className="field-note">Final production image size.</small>
          </Field>
          <Field label="Upscaling">
            <select
              value={story.artwork.upscaling}
              onChange={(event) => setStory({ ...story, artwork: { ...story.artwork, upscaling: event.target.value as ArtworkSettings["upscaling"] } })}
            >
              <option value="off">Off · use the provider's image as-is</option>
              <option value="automatic">Automatic · only when the generated image is smaller than the target</option>
              <option value="always">Always</option>
            </select>
          </Field>
          <Field label="Upscaler">
            <select value={story.artwork.upscaler} disabled>
              <option value="local-realesrgan">Local AI · Real-ESRGAN</option>
            </select>
            <small className="field-note">Runs locally on preserved originals — no paid image requests.</small>
          </Field>
        </section>
      </div>
      <div className="settings-group video-settings"><h3>Video</h3>
        <Field label="Resolution">
          <select
            value={videoResolutionFor(story.video)}
            onChange={(event) => setStory({ ...story, video: applyVideoResolutionPreset(story.video, event.target.value as VideoResolutionPreset) })}
          >
            {(Object.entries(VIDEO_RESOLUTION_PRESETS) as Array<[VideoResolution, (typeof VIDEO_RESOLUTION_PRESETS)[VideoResolution]]>).map(([value, preset]) => (
              <option key={value} value={value}>{preset.label} · {preset.width}×{preset.height}</option>
            ))}
            <option value="custom">Custom</option>
          </select>
          <small className="field-note">A preset drives the render canvas size. Choose Custom to set exact dimensions.</small>
        </Field>
        {videoResolutionFor(story.video) === "custom" && (
          <div className="field-row">
            <Field label="Width"><input type="number" min="640" max="3840" value={story.video.width} onChange={(event) => setStory({ ...story, video: { ...story.video, width: Number(event.target.value) } })} /></Field>
            <Field label="Height"><input type="number" min="360" max="2160" value={story.video.height} onChange={(event) => setStory({ ...story, video: { ...story.video, height: Number(event.target.value) } })} /></Field>
          </div>
        )}
      </div>
      <div className="settings-group"><h3>Voice</h3>
        <Field label="Audio provider"><select value={story.pipeline.tts.provider} disabled={audioProviderIds.length === 1}>{audioProviderIds.map((id) => <option key={id} value={id}>{audioProviderCatalog[id].label}</option>)}</select></Field>
        <Field label={audioProviderDefinition(story.pipeline.tts.provider).modelLabel}><select value={story.pipeline.tts.model} onChange={(event) => setStory({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, model: event.target.value } } })}>{audioProviderDefinition(story.pipeline.tts.provider).models.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
        <Field label={audioProviderDefinition(story.pipeline.tts.provider).referenceLabel}><input value={story.pipeline.tts.referenceId ?? ""} onChange={(event) => setStory({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, referenceId: event.target.value } } })} /></Field>
        <div className="voice-casting" role="group" aria-label="Voice casting"><span>VOICE CASTING</span>{([{"id":"same-voice-dialogue","label":"Same voice · dialogue delivery","detail":"Keeps one voice identity and gives quoted speech a restrained performance shift.","recommended":true},{"id":"narrator-only","label":"Narrator only","detail":"One unchanged voice treatment for everything.","recommended":false},{"id":"narrator-dialogue","label":"Narrator + dialogue voice","detail":"Uses one separate secondary voice for every quoted line.","recommended":false}] as const).map((option) => <button key={option.id} type="button" aria-pressed={story.pipeline.tts.voiceMode === option.id} className={`${story.pipeline.tts.voiceMode === option.id ? "active" : ""} ${option.recommended ? "recommended" : ""}`.trim()} onClick={() => setStory({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, voiceMode: option.id } } })}><b>{option.label}</b><small>{option.detail}</small></button>)}</div>
        {story.pipeline.tts.voiceMode === "narrator-dialogue" && <Field label="Dialogue voice / reference ID"><input value={story.pipeline.tts.secondaryReferenceId ?? ""} placeholder="Fish model ID or fish.audio model URL" onChange={(event) => setStory({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, secondaryReferenceId: event.target.value || undefined } } })} /><small className="field-note">Quoted speech uses this voice. Until one is set, dialogue safely uses the narrator voice.</small></Field>}
        <Field label="Delivery intensity"><select value={story.pipeline.tts.deliveryIntensity} onChange={(event) => setStory({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, deliveryIntensity: event.target.value as "none" | "restrained" | "expressive" } } })}><option value="none">None · no emotion cues</option><option value="restrained">Restrained · consistent</option><option value="expressive">Expressive · more variation</option></select></Field>
        <div className="voice-casting" role="group" aria-label="TTS chunk size"><span>TTS CHUNK SIZE</span>{([{"id":"conservative","label":"Conservative · ~1,000 chars","detail":"More, smaller requests. Smallest blast radius when a request fails.","recommended":false},{"id":"balanced","label":"Balanced · ~1,750 chars","detail":"Recommended default for most voices.","recommended":true},{"id":"long","label":"Long · ~3,000 chars","detail":"Fewer requests; only for very stable voices.","recommended":false},{"id":"custom","label":"Custom","detail":"Choose an exact size between 500 and 20,000 characters.","recommended":false}] as const).map((option) => <button key={option.id} type="button" aria-pressed={chunkPresetFor(story.pipeline.tts.maxCharsPerRequest) === option.id} className={`${chunkPresetFor(story.pipeline.tts.maxCharsPerRequest) === option.id ? "active" : ""} ${option.recommended ? "recommended" : ""}`.trim()} onClick={() => setStory({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, maxCharsPerRequest: option.id === "conservative" ? 1000 : option.id === "balanced" ? 1750 : option.id === "long" ? 3000 : story.pipeline.tts.maxCharsPerRequest } } })}><b>{option.label}</b><small>{option.detail}</small></button>)}</div>
        {chunkPresetFor(story.pipeline.tts.maxCharsPerRequest) === "custom" && <Field label="Custom chunk size · characters"><input type="number" min="500" max="20000" step="50" value={story.pipeline.tts.maxCharsPerRequest} onChange={(event) => setStory({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, maxCharsPerRequest: Math.max(500, Math.min(20000, Number(event.target.value) || 500)) } } })} /></Field>}
        <Field label="Post-generation audio quality mode"><select value={story.pipeline.tts.qualityMode ?? (story.pipeline.tts.qualityGuard ? "verify" : "off")} onChange={(event) => setStory({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, qualityMode: event.target.value as "off" | "verify" | "auto_repair" } } })}><option value="off">Off — generate once</option><option value="verify">Verify only — no Fish retries</option><option value="auto_repair">Auto repair — retry failed chunks</option></select><small className="field-note">Existing qualityGuard settings use Verify only. Manual segment verification and regeneration remain available.</small></Field>
        {(story.pipeline.tts.qualityMode === "auto_repair") && <Field label="Max quality retries"><input type="number" min="0" max="5" step="1" value={story.pipeline.tts.maxQualityRetries} onChange={(event) => setStory({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, maxQualityRetries: Math.max(0, Math.min(5, Math.round(Number(event.target.value) || 0))) } } })} /><small className="field-note">Extra Fish attempts per failed segment when Auto repair is selected.</small></Field>}
        <div className="diagnostic-delivery"><div><span>TROUBLESHOOTING</span><small>Flattens delivery and disables vocalization rendering to isolate unstable voices. Updates this form — save to apply.</small></div><button type="button" className="button" onClick={() => setStory({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, deliveryIntensity: "none" } }, narrationSettings: { ...story.narrationSettings, speechVocalizations: { ...story.narrationSettings.speechVocalizations, mode: "disabled" } } })}>Use diagnostic delivery (flat, no vocalizations)</button></div>
        <details className="settings-advanced"><summary>Advanced voice settings</summary>
          <label className={`narration-policy ${story.pipeline.tts.providerQualityGuard ? "active" : ""}`}><div><span>PROVIDER QUALITY</span><b>Provider Quality Guard</b><small>Use the TTS provider's native quality-control feature when supported.</small></div><input type="checkbox" checked={story.pipeline.tts.providerQualityGuard} onChange={(event) => setStory({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, providerQualityGuard: event.target.checked } } })} /><i aria-hidden="true" /></label>
          <Field label={`Speed · ${story.pipeline.tts.speed.toFixed(2)}×`}><input type="range" min="0.5" max="2" step="0.05" value={story.pipeline.tts.speed} onChange={(event) => setStory({ ...story, pipeline: { ...story.pipeline, tts: { ...story.pipeline.tts, speed: Number(event.target.value) } } })} /></Field>
        </details>
      </div>
      <div className="settings-group"><h3>Audio master</h3>
        <div className="field-row"><Field label="Loudness · LUFS"><input type="number" min="-24" max="-12" step="0.5" value={story.audio.loudnessTarget} onChange={(event) => audio("loudnessTarget", Number(event.target.value))} /></Field><Field label="True peak · dBTP"><input type="number" min="-6" max="-0.1" step="0.1" value={story.audio.truePeak} onChange={(event) => audio("truePeak", Number(event.target.value))} /></Field></div>
        <div className="field-row"><Field label="Segment gap · sec"><input type="number" min="0" max="5" step="0.05" value={story.audio.segmentGapSeconds} onChange={(event) => audio("segmentGapSeconds", Number(event.target.value))} /></Field><Field label="Chapter gap · sec"><input type="number" min="0" max="10" step="0.1" value={story.audio.chapterGapSeconds} onChange={(event) => audio("chapterGapSeconds", Number(event.target.value))} /></Field></div>
        <div className="field-row"><Field label="Bitrate"><select value={story.audio.bitrate} onChange={(event) => audio("bitrate", event.target.value)}>{["64k", "96k", "128k", "160k", "192k", "256k", "320k"].map((value) => <option key={value}>{value}</option>)}</select></Field><Field label="Sample rate"><select value={story.audio.sampleRate} onChange={(event) => audio("sampleRate", Number(event.target.value))}>{[32000, 44100, 48000].map((value) => <option key={value} value={value}>{value} Hz</option>)}</select></Field></div>
      </div>
      {error && <ErrorBox text={error} />}<button className="button primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
    </form>
  </section>;
}

function CostsPage({ slug }: { slug: string }) {
  const [data,setData]=useState<CostAnalytics>();const [records,setRecords]=useState<any>();const [error,setError]=useState("");const [filters,setFilters]=useState({chapterFrom:"",chapterTo:"",provider:"",model:"",stage:"",fromDate:"",toDate:""});
  const query=()=>{const params=new URLSearchParams();for(const [key,value] of Object.entries(filters))if(value)params.set(key,value);return params.toString();};
  const load=async()=>{setError("");const suffix=query()?`?${query()}`:"";const [summary,ledger]=await Promise.all([api<CostAnalytics>(`/stories/${slug}/costs${suffix}`),api<any>(`/stories/${slug}/costs/records${suffix}`)]);setData(summary);setRecords(ledger);};
  useEffect(()=>{void load().catch(value=>setError(message(value)));},[slug]);
  if(error&&!data)return <LoadFailure error={error}/>;if(!data)return <Loading/>;const total=Math.max(.000001,...data.dimensions.map(item=>Number(item.costUsd)));
  return <section className="page costs-page"><div className="section-heading"><div><span className="eyebrow">Provider ledger</span><h2>Costs & analytics</h2><p>Recorded API usage with immutable price snapshots. Unavailable pricing stays visible and is never counted as free.</p></div><div className="production-head-actions"><a className="button" href={`/api/stories/${slug}/costs/export?format=csv`}>Export CSV</a><a className="button" href={`/api/stories/${slug}/costs/export?format=json`}>Export JSON</a><button className="button" onClick={()=>void load().catch(value=>setError(message(value)))}>Refresh ledger</button></div></div>
    <div className="cost-score"><div><span>Recorded spend</span><strong>${Number(data.summary.totalCostUsd).toFixed(4)}</strong><small>{data.summary.unpricedRequests?`${data.summary.unpricedRequests} unpriced request${data.summary.unpricedRequests===1?"":"s"}`:"All usage priced"}</small></div><div className="cost-pulse"><i style={{width:`${Math.min(100,data.summary.successful/Math.max(1,data.summary.requests)*100)}%`}}/><span>{data.summary.requests} requests · {data.summary.failed} failed · {data.summary.retries} retries</span></div></div>
    <div className="cost-filters"><Field label="Chapter from"><input inputMode="numeric" value={filters.chapterFrom} onChange={e=>setFilters({...filters,chapterFrom:e.target.value})}/></Field><Field label="Chapter to"><input inputMode="numeric" value={filters.chapterTo} onChange={e=>setFilters({...filters,chapterTo:e.target.value})}/></Field><Field label="Provider"><input placeholder="All providers" value={filters.provider} onChange={e=>setFilters({...filters,provider:e.target.value})}/></Field><Field label="Model"><input placeholder="All models" value={filters.model} onChange={e=>setFilters({...filters,model:e.target.value})}/></Field><Field label="Stage"><input placeholder="All stages" value={filters.stage} onChange={e=>setFilters({...filters,stage:e.target.value})}/></Field><Field label="From date"><input type="date" value={filters.fromDate} onChange={e=>setFilters({...filters,fromDate:e.target.value})}/></Field><Field label="To date"><input type="date" value={filters.toDate} onChange={e=>setFilters({...filters,toDate:e.target.value})}/></Field><button className="button primary" onClick={()=>void load().catch(value=>setError(message(value)))}>Apply</button></div>
    {error&&<ErrorBox text={error}/>}
    <div className="cost-metrics"><span><b>{Number(data.summary.inputTokens).toLocaleString()}</b>input tokens</span><span><b>{Number(data.summary.cachedInputTokens).toLocaleString()}</b>cached tokens</span><span><b>{Number(data.summary.outputTokens).toLocaleString()}</b>output tokens</span><span><b>{Number(data.summary.inputUtf8Bytes).toLocaleString()}</b>TTS UTF-8 bytes</span><span><b>{data.summary.images}</b>images</span></div>
    <div className="cost-attribution"><header><span>Attribution</span><span>Requests</span><span>Spend</span></header>{data.dimensions.map(item=><article key={`${item.stage}:${item.provider}:${item.model}`}><div><b>{pretty(item.stage)}</b><small>{item.provider} · {item.model}</small></div><span className="mono">{item.requests}</span><div className="cost-bar"><i style={{width:`${Number(item.costUsd)/total*100}%`}}/><b className="mono">${Number(item.costUsd).toFixed(5)}</b></div></article>)}</div>
    <div className="chapter-ledger"><h3>Chapter ledger</h3>{data.chapters.filter(item=>item.chapter).map(item=><div key={item.chapter}><span className="mono">CH {String(item.chapter).padStart(4,"0")}</span><i style={{width:`${Math.min(100,Number(item.costUsd)/total*100)}%`}}/><b className="mono">${Number(item.costUsd).toFixed(5)}</b>{item.unpriced>0&&<small>{item.unpriced} unpriced</small>}</div>)}</div>
    <div className="usage-ledger"><div className="usage-row heading"><span>Time / chapter</span><span>Operation</span><span>Usage</span><span>Cost</span></div>{records?.items.map((item:any)=><div className="usage-row" key={item.id}><span><b>{new Date(item.attemptedAt).toLocaleString()}</b><small>{item.chapter?`Chapter ${item.chapter}`:"Story level"}</small></span><span><b>{pretty(item.stage)}</b><small>{item.provider} · {item.model}{item.retry?" · retry":""}</small></span><span className="mono">{item.inputTokens!==undefined?`${item.inputTokens} in / ${item.outputTokens??0} out`:item.inputUtf8Bytes!==undefined?`${item.inputUtf8Bytes} bytes`:item.imageCount!==undefined?`${item.imageCount} image`:"Not reported"}</span><span className={`mono ${item.costStatus}`}>{item.costUsd!==undefined?`$${Number(item.costUsd).toFixed(6)}`:"Unavailable"}</span></div>)}</div>
  </section>;
}

export function ProductionPage({ slug, activeJob, onJob, navigate }: { slug: string; activeJob?: Job; onJob: (job: Job) => void; navigate:(path:string)=>void }) {
  const [story, setStory] = useState<StoryConfig>(); const [latest, setLatest] = useState<ProductionManifest>(); const [plan, setPlan] = useState<ProductionPlan>(); const [range, setRange] = useState({ from: "", to: "" }); const [allRange, setAllRange] = useState({ from: "", to: "" }); const [rangeMode, setRangeMode] = useState<"all" | "custom">("all"); const [profile, setProfile] = useState(""); const [outputs, setOutputs] = useState<string[]>([]); const [artwork, setArtwork] = useState(false); const [repairQa, setRepairQa] = useState(true); const [refresh, setRefresh] = useState(false); const [budget, setBudget] = useState(""); const [error, setError] = useState("");
  const statusRequest = useRef(0); const [statusError, setStatusError] = useState("");
  useEffect(() => { let cancelled = false; setError(""); api<any>(`/stories/${slug}`).then((value) => { if (cancelled) return; setStory(value.story); setProfile((current) => { if (current) return current; const next = value.story.defaultProductionProfile ?? "audiobook"; const defaults = value.story.productionProfiles[next]; if (defaults) { setOutputs(defaults.outputs); setArtwork(defaults.artwork); setRepairQa(defaults.repairQa); } return next; }); const imported = { from: String(value.counts.minChapter ?? ""), to: String(value.counts.maxChapter ?? "") }; setAllRange(imported); setRange((current) => current.from ? current : imported); }).catch((value) => { if (!cancelled) setError(message(value)); }); return () => { cancelled = true; }; }, [slug]);
  const loadStatus = () => { const request = ++statusRequest.current; void api<{ latest?: ProductionManifest }>(`/stories/${slug}/production/status`).then((value) => { if (request === statusRequest.current) { setLatest(value.latest); setStatusError(""); } }).catch((value) => { if (request === statusRequest.current) setStatusError(message(value)); }); };
  useEffect(() => { loadStatus(); return () => { statusRequest.current++; }; }, [slug]);
  useEffect(() => { if (!activeJob || isTerminalJob(activeJob)) { if (activeJob) loadStatus(); return; } const timer = window.setInterval(loadStatus, 4000); return () => window.clearInterval(timer); }, [activeJob?.id, activeJob?.status, slug]);
  const payload = (dryRun: boolean) => { const selectedRange = rangeMode === "all" ? allRange : range; return { from: Number(selectedRange.from), to: Number(selectedRange.to), profile: profile || undefined, outputs: outputs.length ? outputs : undefined, artwork, repairQa, refresh, dryRun, maxProviderBudgetUsd: budget ? Number(budget) : undefined }; };
  const preview = async () => { try { setError(""); setPlan(await post<ProductionPlan>(`/stories/${slug}/production/plan`, payload(true))); } catch (e) { setError(message(e)); } };
  const start = async (override?: { from: number; to: number }) => { if (!plan && !override) { setError("Review the production plan before starting."); return; } try { setError(""); const started=await post<any>(`/stories/${slug}/jobs/production`, { ...payload(false), ...override });if(typeof started.totalItems==="number")navigate(`/queue?job=${started.id}`);else onJob(started); } catch (e) { setError(message(e)); } };
  const resume = async () => { if (!latest) return; try { setError(""); onJob(await post<Job>(`/stories/${slug}/jobs/production`, { from: latest.selection.from, to: latest.selection.to, ...latest.options, dryRun: false })); } catch (value) { setError(message(value)); } };
  const chooseProfile = (name: string) => { setProfile(name); const value = story?.productionProfiles[name]; if (value) { setOutputs(value.outputs); setArtwork(value.artwork); setRepairQa(value.repairQa); } setPlan(undefined); };
  const toggleOutput = (value: string) => setOutputs((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  return <section className="page production-page"><div className="section-heading"><div><span className="eyebrow">End-to-end orchestrator</span><h2>Production run</h2><p>Plan, resume, and finish a chapter range through only the stages its outputs require.</p></div><div className="production-head-actions"><a className="button" href={"/stories/" + slug}>Story dashboard</a>{latest?.status === "paused" && <button className="button primary" onClick={resume}>Resume safely</button>}{latest && <Status status={latest.status === "completed" ? "pass" : latest.status.includes("error") ? "warn" : "pending"} label={pretty(latest.status)} />}</div></div>
    <div className="production-controls"><div className="production-options"><span>Chapter range</span><label><input type="radio" checked={rangeMode === "all"} onChange={() => setRangeMode("all")} /> All imported chapters</label><label><input type="radio" checked={rangeMode === "custom"} onChange={() => setRangeMode("custom")} /> Custom range</label></div>{rangeMode === "custom" && <><Field label="From"><input value={range.from} inputMode="numeric" onChange={(e) => { setRange({ ...range, from: e.target.value }); setPlan(undefined); }} /></Field><Field label="To"><input value={range.to} inputMode="numeric" onChange={(e) => { setRange({ ...range, to: e.target.value }); setPlan(undefined); }} /></Field></>}<Field label="Production profile"><select value={profile} onChange={(e) => chooseProfile(e.target.value)}>{Object.keys(story?.productionProfiles ?? { audio: true, audiobook: true, "story-video": true, everything: true }).map((name) => <option key={name} value={name}>{pretty(name)}</option>)}</select></Field><div className="production-options"><span>Final output</span>{["audio", "audiobook", "video"].map((value) => <label key={value}><input type="checkbox" checked={outputs.includes(value)} onChange={() => { toggleOutput(value); setPlan(undefined); }} /> {value === "audio" ? "Narrated chapters" : pretty(value)}</label>)}</div><div className="production-options"><span>Production options</span><label title="Attempts bounded text repair after a failed quality gate."><input type="checkbox" checked={repairQa} onChange={(e) => { setRepairQa(e.target.checked); setPlan(undefined); }} /> QA repair</label><label title="May call the configured paid image provider."><input type="checkbox" checked={artwork} onChange={(e) => { setArtwork(e.target.checked); setPlan(undefined); }} /> Artwork generation</label><label title="Included automatically for video output."><input type="checkbox" checked={outputs.includes("video")} readOnly /> Subtitle generation</label><label title="Included automatically for every narrated output."><input type="checkbox" checked readOnly /> Audio mastering</label><label><input type="checkbox" checked={refresh} onChange={(e) => { setRefresh(e.target.checked); setPlan(undefined); }} /> Check remote source first</label></div><button className="button primary" onClick={preview}>Review production plan</button></div>
    {error && <ErrorBox text={error} />}{statusError && <ErrorBox text={statusError} />}{plan && <div className="production-plan"><div className="section-heading"><div><h3>Review before production</h3><p>{plan.chapters.length} chapters · expected: {plan.finalOutputs.join(" · ")}</p></div><span className="mono">{plan.from}–{plan.to}</span></div><div className="plan-grid">{plan.stages.map((stage) => <article key={stage}><span>{pretty(stage)}</span><b>{plan.counts[stage]?.required ?? 0}</b><small>{plan.counts[stage]?.reusable ?? 0} cached</small></article>)}</div><p className="cost-note"><b>May call paid providers:</b> LLM {plan.estimates.llmOperations} · TTS {plan.estimates.ttsOperations} · artwork {plan.estimates.imageOperations}{plan.estimates.imagesPendingPlanning ? ` · ${plan.estimates.imagesPendingPlanning} chapters need scene plans before image totals are known` : ""}. Cached operations are excluded.</p>{plan.costEstimate&&<div className={`plan-cost ${plan.costEstimate.classification}`}><span className="eyebrow">{plan.costEstimate.classification} estimate · {plan.costEstimate.confidence} confidence</span><b>{plan.costEstimate.estimatedUsd!==undefined?`$${plan.costEstimate.estimatedUsd.toFixed(4)}`:"Pricing unavailable"}</b>{plan.costEstimate.lowUsd!==undefined&&<small>Likely range ${plan.costEstimate.lowUsd.toFixed(4)}–${plan.costEstimate.highUsd?.toFixed(4)} · {plan.costEstimate.unknownStages.length?`${plan.costEstimate.unknownStages.length} stage(s) unknown`:"all stages represented"}</small>}</div>}<Field label="Optional provider budget (USD)"><input type="number" min="0.01" step="0.01" placeholder="No budget guard" value={budget} onChange={event=>setBudget(event.target.value)}/></Field><small className="budget-note">Checked after each chapter. In-flight provider requests can exceed this amount.</small><button className="button primary start-production" disabled={activeJob?.status === "running"} onClick={() => start()}>Start production</button></div>}
    {latest && <div className="production-run"><div className="run-head"><div><span className="eyebrow">{latest.status === "running" ? "Live production" : "Durable run record"}</span><h3>{latest.current.chapter ? "Chapter " + latest.current.chapter + " · " + pretty(latest.current.stage ?? "working") : pretty(latest.status)}</h3></div><b className="mono">{Math.round((latest.summary.completed + latest.summary.failed + latest.summary.needsReview) / Math.max(1, latest.summary.chapters) * 100)}%</b></div><div className="summary-strip"><span><b>{latest.summary.completed}</b> complete</span><span><b>{latest.summary.failed}</b> failed</span><span><b>{latest.summary.needsReview}</b> warnings</span><span><b>{latest.summary.reusedStages}</b> cached</span><span><b>{formatDuration(latest.summary.elapsedMs / 1000)}</b> running time</span></div><div className="production-table">{Object.values(latest.chapters).map((chapter) => <article key={chapter.chapter}><header><b>Chapter {chapter.chapter}</b><div><Status status={chapter.status === "complete" ? "pass" : chapter.status === "needs-review" ? "warn" : chapter.status === "failed" ? "fail" : "pending"} label={pretty(chapter.status)} />{chapter.status === "failed" && <><button onClick={() => start({ from: chapter.chapter, to: chapter.chapter })}>Retry</button><a href={"/stories/" + slug + "/chapters/" + chapter.chapter}>Open</a></>}</div></header><div>{Object.entries(chapter.operations).map(([stage, operation]) => <span key={stage} className={operation.status}><i />{pretty(stage)}{operation.reused ? " ↺" : ""}</span>)}</div></article>)}</div>{latest.failures.length > 0 && <div className="run-log"><h3>Warnings and failures</h3>{latest.failures.map((failure, index) => <p key={index}><span>{failure.chapter ? "Chapter " + failure.chapter : "Export"}</span>{pretty(failure.stage)} · {failure.message}</p>)}</div>}{Object.entries(latest.summary.exports).length > 0 && <div className="export-links">{latest.summary.exports.audiobook && <a className="button" href={`/api/stories/${slug}/exports/${latest.selection.from}-${latest.selection.to}.${latest.options.audiobookFormat}`}>Download audiobook</a>}{latest.summary.exports.video && <a className="button" href={`/api/stories/${slug}/video-exports/${latest.selection.from}-${latest.selection.to}.mp4`}>Download video</a>}</div>}</div>}
  </section>;
}

export function JobConsole({ job, onUpdate, onClose, navigate, initialQaComparison, initialMinimized }: {
  job: Job;
  onUpdate: (job: Job) => void;
  onClose: () => void;
  navigate?: (path: string) => void;
  initialQaComparison?: { status: "current" | "historical" | "unknown_legacy"; nowCurrent: boolean };
  initialMinimized?: boolean;
}) {
  const [minimized, setMinimized] = useState(() => initialMinimized ?? isJobConsoleMinimized(job.id));
  const [actionError, setActionError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (initialMinimized !== undefined) {
      setMinimized(initialMinimized);
    } else {
      setMinimized(isJobConsoleMinimized(job.id));
    }
  }, [job.id, initialMinimized]);

  useEffect(() => {
    if (job.status === "failed" && minimized) {
      setMinimized(false);
      setJobConsoleMinimized(job.id, false);
    }
  }, [job.id, job.status, minimized]);

  const toggleMinimize = (event?: React.MouseEvent) => {
    event?.stopPropagation();
    setMinimized((prev) => {
      const next = !prev;
      setJobConsoleMinimized(job.id, next);
      return next;
    });
  };

  useEffect(() => {
    if (isTerminalJob(job)) return;
    return watchJob(job.id, onUpdate, (value) => setActionError(message(value)));
  }, [job.id]);
  const diagnostic: ErrorDiagnostic | undefined = job.diagnostic ?? job.progress?.diagnostic;
  const stage = diagnostic?.stage ?? job.progress?.stage ?? job.progress?.event?.stage ?? job.progress?.type?.replace("chapter.", "");
  const chapter = diagnostic?.chapter ?? job.progress?.chapter;
  const detail = job.progress?.event?.detail ?? job.progress?.detail;
  // QA-related failures carry the failure-time dependency fingerprint; compare
  // it against the chapter's current QA state so stale failures read as history.
  const qaRelated = Boolean(diagnostic && diagnostic.chapter && (diagnostic.category === "content_qa" || diagnostic.issues?.length));
  const [qaComparison, setQaComparison] = useState<{ status: "current" | "historical" | "unknown_legacy" | "reset_not_run"; nowCurrent: boolean } | undefined>(initialQaComparison);
  useEffect(() => {
    if (!qaRelated || !diagnostic?.chapter) { setQaComparison(undefined); return; }
    let cancelled = false;
    api<ChapterQaDetail>(`/stories/${job.story}/chapters/${diagnostic.chapter}/qa`).then((qaDetail) => {
      if (cancelled) return;
      const status: "current" | "historical" | "unknown_legacy" = !diagnostic.qaDependencyFingerprint || !qaDetail.currentFingerprint
        ? "unknown_legacy"
        : diagnostic.qaDependencyFingerprint === qaDetail.currentFingerprint
          ? "current"
          : "historical";
      setQaComparison({ status, nowCurrent: !qaDetail.qaStale && qaDetail.state.status === "pass" });
    }).catch(() => {
      if (cancelled) return;
      setQaComparison({ status: "reset_not_run", nowCurrent: false });
    });
    return () => { cancelled = true; };
  }, [job.id, job.story, qaRelated, diagnostic?.id, diagnostic?.chapter, diagnostic?.qaDependencyFingerprint]);
  const pause = async () => { try { setActionError(""); await post(`/jobs/${job.id}/pause`, {}); } catch (error) { setActionError(message(error)); } };
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    setActionError("");
    try {
      let nextJob: Job;
      try {
        nextJob = await post<Job>(`/jobs/${job.id}/retry`, {});
      } catch {
        if (job.type === "scenes") {
          const ch = chapter ?? (job.progress as any)?.chapter ?? 1;
          nextJob = await post<Job>(`/stories/${job.story}/jobs/scenes`, { from: ch, to: ch });
        } else {
          throw new Error("Could not retry this job automatically.");
        }
      }
      onUpdate(nextJob);
    } catch (error) {
      setActionError(message(error));
    } finally {
      setRetrying(false);
    }
  };
  const copyDiagnostic = async () => {
    if (!diagnostic) return;
    const text = `${formatDiagnostic(diagnostic)}\n${diagnostic.technicalDetails ? `Details: ${diagnostic.technicalDetails}\n` : ""}Job: ${job.id}\nTime: ${diagnostic.timestamp}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setActionError("Could not copy the diagnostic. Select the technical details and copy them manually.");
    }
  };
  const isSceneJob = job.type === "scenes" || stage === "scenePlanning" || stage === "scenes";
  const label = ({ batch: "Processing chapters", preview: "Rendering comparison", metadataTranslation: "Translating reader metadata", qaRepair: "Repairing selected QA findings", qaRecheck: "Rechecking chapter QA", stageExecution: "Processing stage", summary: "Building story recap", audio: "Mastering chapter audio", audiobook: "Building audiobook", alignment: "Aligning narration to audio", subtitles: "Timing subtitles", video: "Rendering chapter video", videoExport: "Building combined video", scenes: "Planning chapter scenes", artwork: "Generating scene artwork", production: "Producing finished story", ttsQualityVerify: "Verifying TTS quality", ttsSegmentRegenerate: "Regenerating TTS segment" } as Record<string, string>)[job.type] ?? "Working";
  const modelBadge = [diagnostic?.provider, diagnostic?.model].filter(Boolean).join(" · ");
  const terminal = isTerminalJob(job);
  const title = terminal ? (job.status === "completed" ? `${label} — completed` : `${label} — ${job.status}`) : label;
  const jobWarnings: string[] = [...(Array.isArray(job.progress?.warnings) ? job.progress.warnings : []), ...(Array.isArray(job.result?.warnings) ? job.result.warnings : [])].filter((warning, index, all) => typeof warning === "string" && all.indexOf(warning) === index);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (job.status !== "completed" || diagnostic) return;
    const timer = window.setTimeout(() => onCloseRef.current(), 10000);
    return () => window.clearTimeout(timer);
  }, [job.id, job.status]);
  return <aside className={`job-console ${job.status}${minimized ? " minimized" : ""}`} role={job.status === "failed" ? "alert" : "status"}>
    {minimized ? (
      <div
        className="job-minimized-strip"
        onClick={toggleMinimize}
      >
        <div className="job-minimized-info">
          {!terminal && <span className="live-dot" />}
          <b className="job-minimized-title">{label}</b>
          {chapter != null ? (
            <span className="job-minimized-detail">
              Chapter {chapter}{stage ? ` · ${pretty(stage)}` : ""}
            </span>
          ) : (
            <span className="mono job-minimized-status">{job.status}</span>
          )}
        </div>
        <button
          type="button"
          className="job-console-toggle"
          aria-label="Expand job console"
          title="Expand job console"
          onClick={toggleMinimize}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>
      </div>
    ) : (
      <>
        <div className="job-head">
          <div>{!terminal && <span className="live-dot" />}<b>{title}</b></div>
          <div className="job-head-controls">
            <span className="mono">{job.status}</span>
            <button
              type="button"
              className="job-console-toggle"
              aria-label="Minimize job console"
              title="Minimize job console"
              onClick={toggleMinimize}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        </div>
        <div className="job-progress"><i /><i /><i /><i /><i /></div>
        {diagnostic ? <div className="incident">
          <h3>{isSceneJob ? "Scene planning failed" : diagnostic.summary}</h3>
          <div className="incident-meta">
            {chapter && <span>Chapter {chapter}</span>}
            {stage && <span>{pretty(stage)}</span>}
            <span>{pretty(diagnostic.category)}</span>
            {modelBadge && <span>{modelBadge}</span>}
          </div>
          {isSceneJob && diagnostic.summary && <p className="incident-reason">{diagnostic.summary}</p>}
          {qaRelated && qaComparison?.nowCurrent && <p className="incident-historical">Chapter QA is current and passing now — this failure is historical.</p>}
          {qaRelated && !qaComparison?.nowCurrent && qaComparison?.status === "historical" && (
            <p className="incident-historical">Previous production attempt failed quality review. The chapter or its QA dependencies have changed since this failure. Recheck QA before retrying production.</p>
          )}
          {qaRelated && !qaComparison?.nowCurrent && qaComparison?.status === "unknown_legacy" && (
            <p className="incident-historical">Previous QA failure. This production attempt predates QA freshness tracking, so its relationship to the chapter's current QA state cannot be verified. Recheck QA to verify current quality before retrying.</p>
          )}
          {qaRelated && qaComparison?.status === "reset_not_run" && (
            <p className="incident-historical">This production attempt previously failed quality review. Current QA data has been reset and has not yet been rechecked.</p>
          )}
          {diagnostic.issues?.length ? (qaComparison?.nowCurrent || qaComparison?.status === "historical" || qaComparison?.status === "unknown_legacy" || qaComparison?.status === "reset_not_run"
            ? <details><summary>Issues reported by this attempt</summary><ul>{diagnostic.issues.slice(0, 3).map((issue, index) => <li key={`${issue.category}-${index}`}><b>{pretty(issue.category)}</b>{issue.message}</li>)}</ul></details>
            : <ul>{diagnostic.issues.slice(0, 3).map((issue, index) => <li key={`${issue.category}-${index}`}><b>{pretty(issue.category)}</b>{issue.message}</li>)}</ul>) : null}          <div className="incident-next"><small>Recommended next step</small><p>{diagnostic.recommendedAction}</p></div>
          <details><summary>Technical details</summary><p>{diagnostic.technicalDetails ?? "No additional provider details were supplied."}</p><small>{new Date(diagnostic.timestamp).toLocaleString()} · {diagnostic.id} · Job {job.id.slice(0, 8)}</small></details>
        </div> : <p>{actionError || job.error || (chapter ? `Chapter ${chapter} · ${pretty(stage ?? "working")}${detail ? ` — ${detail}` : ""}` : pretty(job.status))}</p>}
        {jobWarnings.length > 0 && <ul className="job-warnings">{jobWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        <div className="job-actions">
          {diagnostic && <button type="button" onClick={() => void copyDiagnostic()}>{copied ? "Copied" : "Copy details"}</button>}
          {job.status === "failed" && <button type="button" className="button-retry" disabled={retrying} onClick={() => void retry()}>{retrying ? "Retrying…" : "Retry"}</button>}
          {job.story && (
            <button type="button" onClick={() => navigate?.(`/stories/${job.story}/settings`) ?? (location.href = `/stories/${job.story}/settings`)}>Open model settings</button>
          )}
          {diagnostic?.chapter && <a href={`/stories/${job.story}/chapters/${diagnostic.chapter}`}>Open chapter</a>}
          {job.status === "running" && ["batch", "stageExecution", "audio", "audiobook", "subtitles", "video", "scenes", "artwork", "production"].includes(job.type) && <button type="button" onClick={() => void pause()}>Pause after chapter</button>}
          <button type="button" onClick={onClose}>{terminal ? "Close" : "Dismiss"}</button>
        </div>
        {actionError && diagnostic && <p className="incident-action-error">{actionError}</p>}
      </>
    )}
  </aside>;
}

function PresetEditor({ label, value, onChange }: { label: string; value: any; onChange: (value: any) => void }) { return <div className="preset"><span className="eyebrow">{label}</span>{(["translation", "narration", "qa"] as const).map((key) => <ModelEditor key={key} label={pretty(key)} value={value[key]} onChange={(next) => onChange({ ...value, [key]: next })} />)}</div>; }
function ModelEditor({ label, value, onChange }: { label: string; value: Model; onChange: (value: Model) => void }) {
  const modelListId = useId();
  return <div className="model-editor">{label ? <label>{label}</label> : null}<select value={value.provider} onChange={(e) => onChange({ ...value, provider: e.target.value as Model["provider"] })}><option value="openai">OpenAI</option><option value="gemini">Gemini</option><option value="kimi">Kimi</option></select><input aria-label={`${label || "Model"} model ID`} list={value.provider === "openai" ? modelListId : undefined} value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} />{value.provider === "openai" && <datalist id={modelListId}>{OPENAI_TEXT_MODELS.map((model) => <option key={model} value={model} />)}</datalist>}</div>;
}
function PreviewResult({ choice, result, onChoose }: { choice: "a" | "b"; result: any; onChoose: () => void }) { const qa = result[choice === "a" ? "qaA" : "qaB"]; return <article className="preview-result"><div className="preview-result-head"><span className="option-letter">{choice.toUpperCase()}</span><Status status={qa.status} label={`${Math.round(qa.score * 100)} score`} /></div><Manuscript title="Translation" text={result[choice === "a" ? "translationA" : "translationB"]} compact /><Manuscript title="Narration" text={result[choice === "a" ? "narrationA" : "narrationB"]} compact />{result[choice === "a" ? "audioA" : "audioB"] && <AudioDeck src={`/api/stories/${result.manifest.story}/previews/${result.manifest.id}/audio-${choice}`} title={`Option ${choice.toUpperCase()} sample`} />}<button className="button primary" onClick={onChoose}>Use option {choice.toUpperCase()}</button></article>; }
function Manuscript({ title, text, compact }: { title: string; text?: string; compact?: boolean }) { return <article className={`manuscript ${compact ? "compact" : ""}`}><header className="manuscript-header"><span>{title}</span><small className="mono">{text?.split(/\s+/).filter(Boolean).length ?? 0} words</small></header><div>{text ? text.split(/\n\n+/).map((paragraph, index) => <p key={index}>{paragraph}</p>) : <p className="empty-line">This stage has not produced text yet.</p>}</div></article>; }
function CompareTextEditor({ title, value, savedValue, saving, onChange, onSave }: { title: string; value: string; savedValue?: string; saving: boolean; onChange: (value: string) => void; onSave: () => void }) {
  const changed = value !== (savedValue ?? "");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(420, el.scrollHeight)}px`;
  }, [value]);

  return (
    <article className="manuscript compare-text-editor">
      <header className="manuscript-header">
        <span>{title}</span>
        <small className="mono">{value.split(/\s+/).filter(Boolean).length} words</small>
      </header>
      <textarea
        ref={textareaRef}
        aria-label={`Edit ${title}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <footer className="compare-editor-footer">
        <span>{changed ? "Unsaved correction" : "Current version"}</span>
        <button className="button primary" disabled={!value.trim() || !changed || saving} onClick={onSave}>
          {saving ? "Saving…" : `Save ${title}`}
        </button>
      </footer>
    </article>
  );
}
const QA_FINDING_OUTCOME: Record<string, string> = { fixed_manual: "Fixed manually", fixed_ai: "Fixed with AI", dismissed: "Dismissed", obsolete: "Obsolete" };

function guessExceptionValue(messageText: string) {
  const match = /"([^"]{1,120})"|“([^”]{1,120})”|'([^']{1,120})'/.exec(messageText);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

export function QaDetail({ slug, chapter, onJob, onEditManually, onChanged, initialData, initialError }: { slug: string; chapter: number; onJob: (job: Job) => void; onEditManually: () => void; onChanged: () => void; initialData?: ChapterQaDetail; initialError?: string }) {
  const [data, setData] = useState<ChapterQaDetail | undefined>(initialData); const [error, setError] = useState(initialError ?? ""); const [note, setNote] = useState(""); const [busy, setBusy] = useState("");
  const [dismissTarget, setDismissTarget] = useState<QaFinding>(); const [resetOpen, setResetOpen] = useState(false);
  const [repairChoice, setRepairChoice] = useState<QaFinding>();
  const [safeFixRecheckFailed, setSafeFixRecheckFailed] = useState(false);
  const [retryRecheck, setRetryRecheck] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]); const [recheckSummary, setRecheckSummary] = useState<QaRecheckSummary>();
  const watcher = useRef<(() => void) | undefined>(undefined); const mutationInFlight = useRef(false); const qaRevision = useRef(0);
  const load = async () => { const revision = qaRevision.current; const next = await api<ChapterQaDetail>(`/stories/${slug}/chapters/${chapter}/qa`); if (revision === qaRevision.current) setData(next); return next; };
  const applyAuthoritativeQa = (result: unknown) => {
    const presentation = (result as { presentation?: ChapterQaDetail } | undefined)?.presentation;
    if (presentation) { qaRevision.current++; setData(presentation); }
  };
  const isLifecycleConflict = (value: unknown) => value instanceof ApiError
    ? value.code === "QA_FINDING_ALREADY_RESOLVED" || value.code === "QA_FINDING_ALREADY_OPEN"
    : /QA finding (?:has already been resolved|is already open|is not open)/i.test(message(value));
  const reconcileLifecycleConflict = async (value: unknown) => {
    if (!isLifecycleConflict(value)) return false;
    qaRevision.current++; setDismissTarget(undefined); setBusy(""); setError("");
    try {
      await load(); onChanged();
      setNote(value instanceof ApiError && value.code === "QA_FINDING_ALREADY_OPEN"
        ? "This finding was already open. QA state was refreshed."
        : "This finding had already been resolved. QA state was refreshed.");
    } catch (reloadError) { setError(message(reloadError)); }
    return true;
  };
  const reconcileStaleSelection = async (value: unknown) => {
    const staleSelection = value instanceof ApiError
      ? value.code === "QA_FINDING_STALE_SELECTION"
      : value === "QA_FINDING_STALE_SELECTION" || /selected QA findings? (?:changed while|are no longer open|no longer exist)/i.test(message(value));
    if (!staleSelection) return false;
    qaRevision.current++; setRepairChoice(undefined); setBusy(""); setError(""); mutationInFlight.current = false;
    try { await load(); onChanged(); setNote("The selected QA finding changed while the repair was queued. QA has been refreshed; review and select the current finding before retrying."); }
    catch (reloadError) { setError(message(reloadError)); }
    return true;
  };
  const reconcileMutation = async (result: unknown) => { applyAuthoritativeQa(result); await load(); onChanged(); };
  useEffect(() => { qaRevision.current++; if (!initialData && !initialError) { setData(undefined); setError(""); setRecheckSummary(undefined); void load().catch((value) => setError(message(value))); } return () => watcher.current?.(); }, [slug, chapter]);
  const toggleExpanded = (key: string) => setExpanded((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  const runJob = (kind: string, job: Job, onComplete?: (job: Job) => void) => { setError(""); setNote(""); setBusy(kind); onJob(job); watcher.current?.(); watcher.current = watchJob(job.id, async (next) => { onJob(next); if (next.status === "completed") { setBusy(""); mutationInFlight.current = false; if (kind === "recheck") setRetryRecheck(false); applyAuthoritativeQa(next.result); onComplete?.(next); await load(); onChanged(); } else if (next.status === "failed") { setBusy(""); mutationInFlight.current = false; if (kind === "recheck") setRetryRecheck(true); if (next.diagnostic?.code === "QA_FINDING_STALE_SELECTION") await reconcileStaleSelection(next.error ?? "QA_FINDING_STALE_SELECTION"); else if (!await reconcileLifecycleConflict(next.error ?? "QA job failed")) setError(next.error ?? "QA job failed"); } }, (value) => { setBusy(""); mutationInFlight.current = false; if (kind === "recheck") setRetryRecheck(true); setError(message(value)); }); };
  const recheck = async (mode: "changed" | "full") => { setRetryRecheck(false); try { const job = await post<Job>(`/stories/${slug}/chapters/${chapter}/qa/recheck`, { mode }); runJob("recheck", job, (done) => { const summary = done.result?.summary as QaRecheckSummary | undefined; if (summary) setRecheckSummary(summary); }); } catch (value) { setRetryRecheck(true); setError(message(value)); } };
  const safeFixes = async () => { if (!data || !confirm(`Apply AI fixes to ${data.counts.safeFixesAvailable} finding${data.counts.safeFixesAvailable === 1 ? "" : "s"} marked safe to fix, then recheck the chapter? This may incur provider charges.`)) return; try { const job = await post<Job>(`/stories/${slug}/chapters/${chapter}/qa/safe-fixes`, {}); runJob("safeFixes", job, (done) => { const fixed: string[] = done.result?.fixed ?? []; const failed: Array<{ id: string; message: string }> = done.result?.failed ?? []; const partial = done.result?.status === "repairs_applied_recheck_failed"; setSafeFixRecheckFailed(partial); setNote(partial ? `${fixed.length} fix${fixed.length === 1 ? " was" : "es were"} saved, but QA verification could not complete. The chapter remains stale and still needs QA verification.` : `Applied ${fixed.length} safe fix${fixed.length === 1 ? "" : "es"}.${failed.length ? ` ${failed.length} failed: ${failed.map((item) => item.message).join("; ")}` : ""}`); }); } catch (value) { setError(message(value)); } };
  const fixWithAi = async (finding: QaFinding, target?: "translation" | "narration" | "both") => { if (mutationInFlight.current || busy || !confirm(`Send this finding and the chapter text to the configured AI model for repair${target ? ` (${target})` : ""}, then recheck QA? This may incur provider charges.`)) return; mutationInFlight.current = true; try { const job = await post<Job>(`/stories/${slug}/chapters/${chapter}/qa/findings/${finding.id}/fix-ai`, { ...(target ? { target } : {}) }); setRepairChoice(undefined); runJob(`fix:${finding.id}`, job, (done) => { const repaired: string[] = done.result?.repaired ?? []; const partial = done.result?.status === "repair_applied_recheck_failed"; setSafeFixRecheckFailed(partial); setNote(partial ? "Repair was saved, but QA verification could not complete. The chapter still needs QA verification." : done.result?.fixed ? `Finding repaired in ${repaired.join(" and ") || "chapter text"} and verified by recheck.` : "Repair was applied, but the recheck still reports the problem — it was reopened."); }); } catch (value) { mutationInFlight.current = false; if (!await reconcileLifecycleConflict(value) && !await reconcileStaleSelection(value)) { if (value instanceof ApiError && value.code === "QA_REPAIR_TARGET_AMBIGUOUS") setRepairChoice(finding); else setError(message(value)); } } };
  const resolveManual = async (finding: QaFinding) => { if (mutationInFlight.current || busy) return; mutationInFlight.current = true; try { setError(""); setNote(""); setBusy(`resolve:${finding.id}`); const result = await post(`/stories/${slug}/chapters/${chapter}/qa/findings/${finding.id}/resolve-manual`, {}); setBusy(""); setNote("Finding marked as fixed manually. A future recheck will verify it."); await reconcileMutation(result); } catch (value) { setBusy(""); if (!await reconcileLifecycleConflict(value)) setError(message(value)); } finally { mutationInFlight.current = false; } };
  const reopen = async (finding: QaFinding) => { if (mutationInFlight.current || busy) return; mutationInFlight.current = true; try { setError(""); setNote(""); setBusy(`reopen:${finding.id}`); const result = await post(`/stories/${slug}/chapters/${chapter}/qa/findings/${finding.id}/reopen`, {}); setBusy(""); await reconcileMutation(result); } catch (value) { setBusy(""); if (!await reconcileLifecycleConflict(value)) setError(message(value)); } finally { mutationInFlight.current = false; } };
  if (error && !data) {
    const isNoQa = /does not have a QA result|no QA result|QA has not been run/i.test(error);
    if (isNoQa) {
      return <div className="qa-detail stateful">
        <div className="qa-attention-head">
          <div>
            <h3>QA not run</h3>
            <div className="qa-attention-counts"><Status status="pending" label="Not evaluated" /></div>
          </div>
          <div className="qa-attention-actions">
            <button className="button primary" disabled={Boolean(busy)} onClick={() => void recheck("full")}>{busy === "recheck" ? "Running QA…" : "Run QA"}</button>
          </div>
        </div>
        <Empty title="QA has not been run for this chapter" text="Run QA to evaluate terminology, pronunciation, continuity, and stylistic rules." />
      </div>;
    }
    const contextInvalid = /Story Context|stored context/i.test(error);
    const continuityInvalid = /Continuity Review/i.test(error);
    return <div className="qa-detail"><ErrorBox text={error} />{contextInvalid && <a className="button" href={`/stories/${slug}/bible`}>Open Story Bible</a>}{continuityInvalid && <a className="button" href={`/stories/${slug}/continuity`}>Open Continuity Review</a>}</div>;
  }
  if (!data) return <Loading />;
  const stale = data.qaStale;
  const rawScore = data.state?.score ?? data.stats?.current?.score;
  const scorePercent = typeof rawScore === "number" && !Number.isNaN(rawScore) ? Math.round(rawScore <= 1 ? rawScore * 100 : rawScore) : undefined;
  const openFindingsList = data.state.findings.filter((finding) => finding.status === "open");
  const resolvedFindings = data.state.findings.filter((finding) => finding.status !== "open");
  const critical = openFindingsList.filter((finding) => finding.severity === "fail").length;
  const warnings = openFindingsList.filter((finding) => finding.severity === "warn").length;
  const needsVerification = data.stats?.needsVerification ?? (stale ? data.state.findings.filter((finding) => finding.status !== "obsolete").length : 0);
  const unverified = (finding: QaFinding) => stale && finding.verifiedAgainstFingerprint !== data.currentFingerprint;
  const summaryParts = recheckSummary ? [recheckSummary.verified ? `✓ ${recheckSummary.verified} fix${recheckSummary.verified === 1 ? "" : "es"} verified` : "", recheckSummary.respected ? `✓ ${recheckSummary.respected} dismissal${recheckSummary.respected === 1 ? "" : "s"} respected` : "", recheckSummary.reopened ? `⚠ ${recheckSummary.reopened} returned` : "", recheckSummary.newFindings ? `${recheckSummary.newFindings} new issue${recheckSummary.newFindings === 1 ? "" : "s"}` : ""].filter(Boolean) : [];
  return <div className="qa-detail stateful">
    <div className="qa-attention-head">
      <div>
        <h3>{stale ? "QA needs recheck" : openFindingsList.length ? `${openFindingsList.length} issue${openFindingsList.length === 1 ? "" : "s"} need${openFindingsList.length === 1 ? "s" : ""} attention` : "No open issues"}</h3>
        {scorePercent !== undefined && (
          <div className="qa-score-display">
            <strong>{scorePercent} / 100</strong>
            {stale && <span className="qa-score-badge">· Previous score</span>}
          </div>
        )}
        <div className="qa-attention-counts">{stale
          ? <Status status="warn" label={needsVerification ? `${needsVerification} previous finding${needsVerification === 1 ? "" : "s"} need${needsVerification === 1 ? "s" : ""} verification` : "Previous result is out of date"} />
          : <>{critical > 0 && <Status status="fail" label={`${critical} critical`} />}{warnings > 0 && <Status status="warn" label={`${warnings} warning${warnings === 1 ? "" : "s"}`} />}{!openFindingsList.length && <Status status="pass" label="Chapter is clear" />}</>}</div>
      </div>
      <div className="qa-attention-actions">
        {data.counts.safeFixesAvailable > 0 && !stale && <button className="button primary" disabled={Boolean(busy)} onClick={() => void safeFixes()}>{busy === "safeFixes" ? "Fixing…" : `Fix ${data.counts.safeFixesAvailable} safe issue${data.counts.safeFixesAvailable === 1 ? "" : "s"}`}</button>}
        <div className="qa-recheck-split"><button className={`button${stale ? " primary" : ""}`} disabled={Boolean(busy)} onClick={() => void recheck("changed")}>{busy === "recheck" ? "Rechecking…" : "Recheck QA"}</button><details className="qa-recheck-menu"><summary aria-label="Recheck options">▾</summary><div><button disabled={Boolean(busy)} onClick={() => void recheck("changed")}>Recheck changed content</button><button disabled={Boolean(busy)} onClick={() => void recheck("full")}>Full chapter recheck</button><button disabled={Boolean(busy)} onClick={() => setResetOpen(true)}>Reset QA data…</button></div></details></div>
      </div>
    </div>
    {stale && <ArtifactStatusNotice status="stale" reason={data.freshness === "missing"
      ? "This is a retained QA result without a current evaluation fingerprint. Editing chapter text or marking findings resolved does not rerun QA. Use Recheck QA after your last edit to verify the chapter and make its score current."
      : data.freshness === "failed"
        ? "The last QA evaluation failed. The previous score is retained; retry QA to verify the current chapter."
        : "The chapter or its QA dependencies changed since this review. Previous findings are awaiting verification — recheck QA after your last edit to make this result current."} />}
    {data.repairPrerequisites?.storyContextValid === false && <div className="naming-notice" role="status">{data.repairPrerequisites.storyContextError ?? "AI repair is blocked because this chapter's Story Context is invalid."} <a className="button" href={`/stories/${slug}/bible`}>Open Story Bible</a></div>}
    {data.artifacts?.translationAvailable === false && <div className="naming-notice" role="status">Translation artifact is unavailable. AI repair for translation findings is disabled.</div>}
    {data.artifacts?.narrationAvailable === false && <div className="naming-notice" role="status">Narration artifact is unavailable. AI repair for narration findings is disabled.</div>}
    {error && <><ErrorBox text={retryRecheck ? `QA model failed to respond or the recheck could not complete. No QA state was changed. ${error}` : error} />{retryRecheck && <button className="button" disabled={Boolean(busy)} onClick={() => void recheck("full")}>Retry QA</button>}{/Story Context|stored context/i.test(error) && <a className="button" href={`/stories/${slug}/bible`}>Open Story Bible</a>}{/Continuity Review/i.test(error) && <a className="button" href={`/stories/${slug}/continuity`}>Open Continuity Review</a>}</>}
    {note && <div className="naming-notice">{note}{safeFixRecheckFailed && <button className="button" onClick={() => { setSafeFixRecheckFailed(false); setNote(""); void recheck("full"); }}>Retry QA</button>}</div>}
    {repairChoice && <div className="naming-notice" role="group" aria-label="Repair target"><b>Choose which artifact to repair</b><span>The finding does not identify whether translation, narration, or both are at fault.</span><div className="qa-finding-actions"><button className="button" onClick={() => void fixWithAi(repairChoice, "translation")}>Translation</button><button className="button" onClick={() => void fixWithAi(repairChoice, "narration")}>Narration</button><button className="button" onClick={() => void fixWithAi(repairChoice, "both")}>Both</button><button className="button" onClick={() => setRepairChoice(undefined)}>Cancel</button></div></div>}
    {recheckSummary && <div className="naming-notice qa-recheck-summary"><b>Recheck complete{recheckSummary.fellBackToFull ? " (full recheck — changed content could not be isolated)" : ""}</b><span>{summaryParts.length ? summaryParts.join(" · ") : "No changes to findings"}{` — Needs attention: ${recheckSummary.open}`}</span></div>}
    {stale && openFindingsList.length > 0 && <p className="qa-unverified-label">{openFindingsList.length} previous open finding{openFindingsList.length === 1 ? "" : "s"} — awaiting QA verification, not yet confirmed against the current chapter.</p>}
    <div className="issues">
      {openFindingsList.map((finding) => <QaFindingCard key={finding.id} finding={finding} busy={busy} expanded={expanded} pendingVerification={unverified(finding)} slug={slug} onToggle={toggleExpanded} onFixAi={() => void fixWithAi(finding)} onEdit={onEditManually} onResolve={() => void resolveManual(finding)} onDismiss={() => setDismissTarget(finding)} />)}
      {!openFindingsList.length && !stale && <Empty title="Nothing needs attention" text="Every finding for this chapter is resolved. Recheck QA after editing the manuscript to verify it stays clear." />}
    </div>
    {resolvedFindings.length > 0 && <QaResolvedFindings findings={resolvedFindings} busy={busy} expanded={expanded} currentFingerprint={data.currentFingerprint} onToggle={toggleExpanded} onReopen={(finding) => void reopen(finding)} />}
    {dismissTarget && <DismissFindingDialog slug={slug} chapter={chapter} finding={dismissTarget} busy={Boolean(busy)} onClose={() => setDismissTarget(undefined)} onDone={async (result, remembered) => { setDismissTarget(undefined); setError(""); setNote(remembered ? "Finding dismissed and remembered as a story-level exception." : "Finding dismissed. A future recheck will respect this decision."); await reconcileMutation(result); }} onError={(value) => { setDismissTarget(undefined); void reconcileLifecycleConflict(value).then((recovered) => { if (!recovered) setError(message(value)); }); }} />}
    {resetOpen && <ResetChapterQaDialog slug={slug} chapter={chapter} onClose={() => setResetOpen(false)} onDone={async () => { setResetOpen(false); setNote(`QA data reset for Chapter ${chapter}. Other stages were not changed.`); setData(undefined); setError(""); try { await load(); } catch (err) { setError(message(err)); } onChanged(); }} />}
  </div>;
}

export function QaFindingCard({ finding, busy, expanded, pendingVerification = false, slug, onToggle, onFixAi, onEdit, onResolve, onDismiss }: { finding: QaFinding; busy: string; expanded: string[]; pendingVerification?: boolean; slug?: string; onToggle: (key: string) => void; onFixAi: () => void; onEdit: () => void; onResolve: () => void; onDismiss: () => void }) {
  const evidenceLong = finding.evidence.length > 240; const evidenceKey = `evidence:${finding.id}`; const detailsKey = `details:${finding.id}`;
  return <article>
    <div className="qa-issue-heading"><span className="qa-category">{pretty(finding.category)}</span><div className="qa-issue-badges"><Status status={finding.severity} label={finding.severity === "fail" ? "Critical" : "Warning"} /><span className="qa-origin-badge">{finding.origin === "llm" ? "AI" : "Deterministic"}</span>{finding.safeToFix === true && <span className="qa-safe-badge">Safe fix</span>}{finding.reopenedAt && <span className="qa-reviewed">Returned after fix</span>}{pendingVerification && <span className="qa-reviewed">Awaiting QA verification</span>}</div></div>
    <h3>{finding.message}</h3>
    <blockquote>{evidenceLong && !expanded.includes(evidenceKey) ? `${finding.evidence.slice(0, 240)}…` : finding.evidence}{evidenceLong && <button className="qa-inline-toggle" onClick={() => onToggle(evidenceKey)}>{expanded.includes(evidenceKey) ? "Show less" : "Show more"}</button>}</blockquote>
    {finding.suggestedFix && <p className="qa-suggested-fix"><b>Suggested fix</b>{finding.suggestedFix}</p>}
    <div className="qa-finding-actions"><button className="button primary" disabled={Boolean(busy)} onClick={onFixAi}>{busy === `fix:${finding.id}` ? "Repairing…" : "Fix with AI"}</button><button className="button" disabled={Boolean(busy)} onClick={onEdit}>Edit manually</button><button className="button" disabled={Boolean(busy)} onClick={onResolve}>{busy === `resolve:${finding.id}` ? "Marking…" : "Mark resolved"}</button><button className="button" disabled={Boolean(busy)} onClick={onDismiss}>Dismiss</button>{slug && finding.provenance?.entityIds?.length ? <a className="button" href={`/stories/${slug}/bible?entity=${finding.provenance.entityIds[0]}`}>Open entity{finding.provenance.entityIds.length > 1 ? ` (+${finding.provenance.entityIds.length - 1})` : ""}</a> : null}</div>
    <button className="qa-inline-toggle qa-details-toggle" onClick={() => onToggle(detailsKey)}>{expanded.includes(detailsKey) ? "▾ Hide details" : "▸ Details"}</button>
    {expanded.includes(detailsKey) && <small className="qa-provenance mono">Finding {finding.id} · origin {finding.origin}{finding.confidence !== undefined ? ` · confidence ${Math.round(finding.confidence * 100)}%` : ""}{finding.firstDetectedAt ? ` · first detected ${new Date(finding.firstDetectedAt).toLocaleString()}` : ""}{finding.lastVerifiedAt ? ` · last verified ${new Date(finding.lastVerifiedAt).toLocaleString()}` : ""}{finding.provenance?.stage ? ` · stage ${finding.provenance.stage}` : ""}</small>}
  </article>;
}

export function QaResolvedFindings({ findings, busy, expanded, currentFingerprint, onToggle, onReopen, defaultOpen = false }: { findings: QaFinding[]; busy: string; expanded: string[]; currentFingerprint?: string; onToggle: (key: string) => void; onReopen: (finding: QaFinding) => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const verification = (finding: QaFinding) => currentFingerprint === undefined ? "" : finding.verifiedAgainstFingerprint === currentFingerprint ? " · verified" : " · awaiting QA verification";
  return <div className="qa-resolved"><button className="qa-resolved-toggle" onClick={() => setOpen((value) => !value)}>{open ? "▾" : "▸"} Resolved issues ({findings.length})</button>
    {open && <div className="issues resolved-list">{findings.map((finding) => { const detailKey = `resolved:${finding.id}`; return <article key={finding.id} className="resolved">
      <div className="qa-issue-heading"><span className="qa-category">{pretty(finding.category)}</span><div className="qa-issue-badges"><span className="qa-reviewed">{`${QA_FINDING_OUTCOME[finding.status] ?? pretty(finding.status)}${verification(finding)}`}</span><Status status={finding.severity} label={finding.severity === "fail" ? "Critical" : "Warning"} /></div></div>
      <h3>{finding.message}</h3>
      <div className="qa-finding-actions"><button className="qa-inline-toggle" onClick={() => onToggle(detailKey)}>{expanded.includes(detailKey) ? "Hide resolution" : "Resolution detail"}</button><button className="button" disabled={Boolean(busy)} onClick={() => onReopen(finding)}>{busy === `reopen:${finding.id}` ? "Reopening…" : "Reopen"}</button></div>
      {expanded.includes(detailKey) && <small className="qa-provenance">{finding.resolution ? `${QA_FINDING_OUTCOME[finding.status] ?? pretty(finding.status)} · resolved ${new Date(finding.resolution.resolvedAt).toLocaleString()}${finding.resolution.reason ? ` · reason: ${finding.resolution.reason}` : ""}` : "No resolution detail recorded."}{` · Finding ${finding.id}`}</small>}
    </article>; })}</div>}
  </div>;
}

function DismissFindingDialog({ slug, chapter, finding, busy, onClose, onDone, onError }: { slug: string; chapter: number; finding: QaFinding; busy: boolean; onClose: () => void; onDone: (result: unknown, remembered: boolean) => void | Promise<void>; onError: (error: unknown) => void }) {
  const [reason, setReason] = useState(""); const [remember, setRemember] = useState(false);
  const [matchKind, setMatchKind] = useState<QaExceptionMatchKind>("terminology"); const [value, setValue] = useState(() => guessExceptionValue(finding.message));
  const [working, setWorking] = useState(false); const submitting = useRef(false);
  const submit = async () => { if (submitting.current || working || busy) return; submitting.current = true; try { setWorking(true); const result = await post(`/stories/${slug}/chapters/${chapter}/qa/findings/${finding.id}/dismiss`, { reason: reason.trim() || undefined, remember: remember ? { matchKind, value: value.trim() } : undefined }); await onDone(result, remember); } catch (cause) { setWorking(false); onError(cause); } finally { submitting.current = false; } };
  return <div className="stage-modal-backdrop" role="presentation"><section className="stage-modal qa-dismiss-modal" role="dialog" aria-modal="true" aria-labelledby="dismiss-finding-title"><header><div><span className="eyebrow">{pretty(finding.category)} finding</span><h3 id="dismiss-finding-title">Dismiss finding</h3></div><button className="button" disabled={working || busy} onClick={onClose}>Close</button></header><p>{finding.message}</p>
    <label className="field"><span>Reason (optional)</span><input value={reason} maxLength={1000} placeholder="Why this finding needs no action" onChange={(event) => setReason(event.target.value)} /></label>
    <label className="toggle-line"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> Remember this decision for this story</label>
    {remember && <div className="field-row"><Field label="Match kind"><select value={matchKind} onChange={(event) => setMatchKind(event.target.value as QaExceptionMatchKind)}><option value="terminology">Terminology</option><option value="entity">Entity</option><option value="rule">Rule</option><option value="other">Other</option></select></Field><Field label="Value to ignore"><input value={value} maxLength={300} placeholder="Text this exception matches" onChange={(event) => setValue(event.target.value)} /></Field></div>}
    <footer><small>Dismissed findings stay visible under Resolved issues and are respected by future rechecks.</small><button className="button primary" disabled={working || busy || (remember && !value.trim())} onClick={() => void submit()}>{working ? "Dismissing…" : "Dismiss finding"}</button></footer></section></div>;
}
function Stage({ value = "pending" }: { value?: string }) { return <span className={`stage ${value}`}><i />{value === "complete" ? "Complete" : pretty(value)}</span>; }
export function Status({ status, label, title }: { status: string; label: string; title?: string }) { return <span className={`status ${status}`} title={title}><i />{label}</span>; }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }
function Loading() { return <div className="loading"><i /><i /><i /></div>; }
function LoadFailure({ error }: { error: string }) { return <section className="page"><ErrorBox text={error} /><button className="button" onClick={() => location.reload()}>Retry</button></section>; }
function ErrorBox({ text }: { text: string }) { return <div className="error-box"><Icon name="quality" /><span>{text}</span></div>; }
function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) { return <div className="empty"><span className="empty-glyph">¶</span><h3>{title}</h3><p>{text}</p>{action}</div>; }
function Icon({ name }: { name: string }) { const paths: Record<string, string> = { library: "M4 5.5h5v13H4zM11 5.5h5v13h-5zM18 7h2v11.5h-2z", import: "M12 3v12m0 0 4-4m-4 4-4-4M4 19h16", chapters: "M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM5 7h14M9 4v16", quality: "M12 3 4 6v5c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6zM9 12l2 2 4-5", compare: "M8 4H4v16h4M16 4h4v16h-4M8 12h8", audio: "M4 15V9m4 9V6m4 15V3m4 15V6m4 9V9", video: "M4 6h11v12H4zM15 10l5-3v10l-5-3z", production: "M4 18V6l8-3 8 3v12l-8 3zM8 8h8M8 12h8M8 16h5", bible: "M4 5.5A3.5 3.5 0 0 1 7.5 2H12v18H7.5A3.5 3.5 0 0 0 4 23zM20 5.5A3.5 3.5 0 0 0 16.5 2H12v18h4.5A3.5 3.5 0 0 1 20 23z", settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 12H2m20 0h-2M12 4V2m0 20v-2M6.3 6.3 4.9 4.9m14.2 14.2-1.4-1.4M17.7 6.3l1.4-1.4M4.9 19.1l1.4-1.4", plus: "M12 5v14M5 12h14" }; return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name] ?? paths.library} /></svg>; }
function parseRoute(path: string): Route { const parts = path.split("?")[0]!.split("/").filter(Boolean); if (!parts.length) return { page: "stories" }; if (parts[0] === "new") return { page: "new" }; if (parts[0] === "settings") return { page: "app-settings" }; if (parts[0] === "queue") return {page:"queue"}; if(parts[0]==="review")return{page:"review"}; if (parts[0] === "import") return { page: "import" }; if (parts[0] !== "stories" || !parts[1]) return { page: "stories" }; if (parts[2] === "chapters" && parts[3]) return { page: "chapter", story: parts[1], chapter: Number(parts[3]) }; if (["qa", "preview", "bible", "names", "continuity", "summaries", "audio", "video", "scenes", "production", "costs", "outputs", "voice", "settings", "manage", "import"].includes(parts[2] ?? "")) return { page: parts[2]!, story: parts[1] }; return { page: "story", story: parts[1] }; }
function pageTitle(page: string) { return ({ stories: "AI Story Studio", import: "Import", new: "New Story", "app-settings": "Studio Settings",queue:"Production Queue",review:"Needs Review" } as Record<string, string>)[page] ?? pretty(page); }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function formatDuration(seconds: number) { if (!Number.isFinite(seconds) || seconds <= 0) return "0:00"; const whole = Math.round(seconds); const hours = Math.floor(whole / 3600); const minutes = Math.floor(whole % 3600 / 60); const rest = whole % 60; return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${minutes}:${String(rest).padStart(2, "0")}`; }
function formatBytes(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function formatTime(seconds: number) { const minutes = Math.floor(Math.max(0, seconds) / 60); const rest = Math.floor(Math.max(0, seconds) % 60); return `${minutes}:${String(rest).padStart(2, "0")}`; }

export function isTerminalJob(job: Job) { return ["completed", "failed", "paused"].includes(job.status); }
export function dismissJob(jobId: string) {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(`dismissed_job_${jobId}`, "true");
    }
  } catch {
    // sessionStorage unavailable or restricted
  }
}
export function isJobDismissed(jobId: string): boolean {
  try {
    if (typeof sessionStorage !== "undefined") {
      return sessionStorage.getItem(`dismissed_job_${jobId}`) === "true";
    }
  } catch {
    return false;
  }
  return false;
}
export function clearJobDismissal(jobId: string) {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(`dismissed_job_${jobId}`);
    }
  } catch {
    // ignore
  }
}
export function setJobConsoleMinimized(jobId: string, minimized: boolean) {
  try {
    if (typeof sessionStorage !== "undefined") {
      if (minimized) {
        sessionStorage.setItem(`minimized_job_${jobId}`, "true");
      } else {
        sessionStorage.removeItem(`minimized_job_${jobId}`);
      }
    }
  } catch {
    // sessionStorage unavailable or restricted
  }
}
export function isJobConsoleMinimized(jobId: string): boolean {
  try {
    if (typeof sessionStorage !== "undefined") {
      return sessionStorage.getItem(`minimized_job_${jobId}`) === "true";
    }
  } catch {
    return false;
  }
  return false;
}
export function clearJobMinimized(jobId: string) {
  setJobConsoleMinimized(jobId, false);
}
export function shouldRefreshAfterJob(previous: Job | undefined, next: Job) {
  // These read-only jobs own their result in the current workspace. Remounting
  // on completion discards that result before the page can render it.
  if (next.type === "voicePreview" || next.type === "entityLocalizationSuggestions" || next.type === "summary") return false;
  return isTerminalJob(next) && (previous?.id !== next.id || !isTerminalJob(previous));
}
function watchJob(id: string, onUpdate: (job: Job) => void | Promise<void>, onError: (error: unknown) => void, options: { maxFailures?: number } = {}) {
  let stopped = false; let timer: number | undefined; let failures = 0; const source = new EventSource(`/api/jobs/${id}/events`);
  const deliver = (job: Job) => { failures = 0; void Promise.resolve(onUpdate(job)).catch(onError); if (isTerminalJob(job)) stop(); };
  const poll = async () => {
    if (stopped) return;
    try { const job = await api<Job>(`/jobs/${id}`); deliver(job); if (!isTerminalJob(job)) timer = window.setTimeout(poll, 1000); }
    catch (error) { failures++; onError(error); if (options.maxFailures !== undefined && failures >= options.maxFailures) { stop(); return; } timer = window.setTimeout(poll, 2000); }
  };
  source.addEventListener("job", (event) => { try { deliver(JSON.parse((event as MessageEvent).data) as Job); } catch (error) { onError(error); } });
  source.onerror = () => { if (stopped) return; source.close(); void poll(); };
  function stop() { if (stopped) return; stopped = true; source.close(); if (timer !== undefined) clearTimeout(timer); }
  return stop;
}
