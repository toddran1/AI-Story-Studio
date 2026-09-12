import { useEffect, useState } from "react";
import { api, post, put, StoryCard, StoryDashboard } from "./api.js";

type Mode = "file" | "folder" | "url" | "search";
type NovelProvider = { id: string; displayName: string; domains: string[]; capabilities: { search: boolean; download: boolean; authentication: string; acquisition?: Array<"html" | "json-api" | "bulk-download">; bulkFormats?: string[] }; priority: number; reliability: string; enabledByDefault: boolean; health?: { status: string; cooldownUntil?: string } };
type NovelResult = { provider: NovelProvider["id"]; bookId: string; url: string; title: string; author?: string; latestChapter?: string; chapterCount?: number };
type Inspection = {
  id: string; type: string; title?: string; author?: string; chapterCount: number; availableChapterCount: number;
  chapters: Array<{ chapter: number; originalTitle?: string; sourceTitle?: string; metadata?: { provider?: string; validation?: { status?: string; evidence?: { extractedCharacters?: number; expectedCharacters?: number } } } }>;
  warnings: Array<{ code: string; message: string }>;
  metadata?: { provider?: string; fallbackAttempts?: Array<{ provider: string; chapter: number; status: string; reason: string; extractedCharacters?: number; expectedCharacters?: number }> };
  update?: { existingCount: number; afterCount: number; added: number[]; replaced: number[]; unchanged: number[]; preservedCount: number; missingCount: number; missingSummary?: string; minimumChapter?: number; maximumChapter?: number };
};

export function ChapterImportPage({ storySlug, stories, navigate }: { storySlug?: string; stories: StoryCard[]; navigate: (path: string) => void }) {
  const [slug, setSlug] = useState(storySlug ?? stories[0]?.slug ?? "");
  const [story, setStory] = useState<StoryDashboard>(); const [mode, setMode] = useState<Mode>("folder");
  const [file, setFile] = useState<File>(); const [files, setFiles] = useState<File[]>([]); const [url, setUrl] = useState("");
  const [singleChapter, setSingleChapter] = useState("1"); const [splitChapters, setSplitChapters] = useState(false);
  const [acquisition, setAcquisition] = useState<"html" | "bulk-download">("html");
  const [range, setRange] = useState({ from: "1", to: "10" }); const [inspection, setInspection] = useState<Inspection>();
  const [providers, setProviders] = useState<NovelProvider[]>([]); const [searchQuery, setSearchQuery] = useState(""); const [searchResults, setSearchResults] = useState<NovelResult[]>([]);
  const [selectedProviders, setSelectedProviders] = useState<Array<NovelProvider["id"]>>(["ixdzs8", "shuhaige"]); const [searchWarnings, setSearchWarnings] = useState<Array<{ provider: string; message: string }>>([]);
  const [sourceSettings, setSourceSettings] = useState<StoryDashboard["story"]["sources"]>([]);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const selectedStory = stories.find((item) => item.slug === slug);

  useEffect(() => { if (storySlug) setSlug(storySlug); }, [storySlug]);
  useEffect(() => { api<{ providers: NovelProvider[] }>("/novel/providers").then((value) => { setProviders(value.providers); setSelectedProviders(value.providers.filter((provider) => provider.capabilities.search && provider.enabledByDefault && provider.health?.status !== "disabled").map((provider) => provider.id)); }).catch(() => setProviders([])); }, []);
  useEffect(() => {
    if (!slug) return;
    setStory(undefined); setInspection(undefined); setError("");
    api<StoryDashboard>(`/stories/${slug}`).then((value) => {
      setStory(value); setSourceSettings([...value.story.sources].sort((left, right) => left.priority - right.priority)); const next = (value.counts.maxChapter ?? 0) + 1; setSingleChapter(String(next));
      const savedUrl = savedStorySourceUrl(value); setUrl(savedUrl ?? "");
      if (savedUrl) setMode("url");
    }).catch((cause) => setError(errorMessage(cause)));
  }, [slug]);

  const chooseMode = (value: Mode) => { setMode(value); setInspection(undefined); setError(""); };
  const search = async () => {
    if (!searchQuery.trim()) { setError("Enter a novel title or author"); return; }
    setBusy(true); setError(""); setSearchWarnings([]);
    try { const result = await post<{ results: NovelResult[]; warnings: Array<{ provider: string; message: string }> }>("/novel/search", { query: searchQuery, providers: selectedProviders, limit: 50 }); setSearchResults(result.results); setSearchWarnings(result.warnings); }
    catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  };
  const useSearchResult = (result: NovelResult) => { setUrl(result.url); setMode("url"); setAcquisition("html"); setInspection(undefined); setError(""); };
  const saveSourceSettings = async () => {
    setBusy(true); setError("");
    try { const result = await put<{ story: StoryDashboard["story"] }>(`/stories/${slug}/sources`, { sources: sourceSettings.map(({ provider, bookId, priority, enabled }) => ({ provider, bookId, priority, enabled })) }); setSourceSettings([...result.story.sources].sort((left, right) => left.priority - right.priority)); setStory((current) => current ? { ...current, story: result.story } : current); }
    catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  };
  const inspect = async () => {
    setBusy(true); setError(""); setInspection(undefined);
    try {
      if (!slug) throw new Error("Choose the story you want to update");
      let next: Inspection;
      if (mode === "url") {
        const from = positiveInteger(range.from, "From chapter"); const to = positiveInteger(range.to, "To chapter");
        if (to < from) throw new Error("To chapter must be at or after From chapter");
        next = await post(`/stories/${slug}/source/inspect`, { url: normalizeWebSourceUrl(url), from, to, allowGaps: true, acquisition: bulkProvider ? acquisition : "html" });
      } else if (mode === "folder") {
        if (!files.length) throw new Error("Choose a folder containing numbered TXT chapter files");
        next = await post(`/stories/${slug}/source/inspect`, { files: await Promise.all(files.map(async (item) => ({ name: item.name, text: await item.text() }))), allowGaps: true });
      } else {
        if (!file) throw new Error("Choose a TXT, EPUB, or DOCX file");
        const query = new URLSearchParams({ allowGaps: "true" });
        if (file.name.toLowerCase().endsWith(".txt")) splitChapters ? query.set("split", "true") : query.set("chapter", String(positiveInteger(singleChapter, "Chapter number")));
        next = await api(`/stories/${slug}/source/inspect?${query}`, { method: "POST", body: await file.arrayBuffer(), headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) } });
      }
      setInspection(next);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  };
  const importChapters = async () => {
    if (!inspection) return; setBusy(true); setError("");
    try {
      await post(`/stories/${slug}/source/import`, { inspectionId: inspection.id, allowGaps: true });
      navigate(`/stories/${slug}`);
    } catch (cause) { setError(errorMessage(cause)); setBusy(false); }
  };

  if (!stories.length) return <section className="page"><div className="import-empty"><span>NO PROJECT</span><h2>Create a story before adding chapters.</h2><button className="button primary" onClick={() => navigate("/new")}>Create a story</button></div></section>;
  const update = inspection?.update; const added = new Set(update?.added ?? []); const replaced = new Set(update?.replaced ?? []); const unchanged = new Set(update?.unchanged ?? []);
  const actionCount = (update?.added.length ?? inspection?.chapterCount ?? 0) + (update?.replaced.length ?? 0);
  const bulkProvider = providerForUrl(providers, url)?.capabilities.acquisition?.includes("bulk-download") === true;
  return <section className="page chapter-intake-page">
    <header className="intake-mast"><div><span className="eyebrow">Chapter intake · {selectedStory?.sourceType ?? story?.story.source.type ?? "source"}</span><h2>Add pages to <em>{selectedStory?.title ?? story?.story.title ?? slug}</em></h2><p>New chapter numbers slot into place. Existing chapters stay untouched unless the incoming source uses the same number.</p></div><button className="button" onClick={() => navigate(`/stories/${slug}`)}>Back to story</button></header>
    <div className="intake-context"><div><span className="mono">CURRENT EDITION</span><b>{story?.counts.chapters ?? selectedStory?.importedChapters ?? "—"} chapters</b><small>{story?.counts.minChapter ? `Chapter ${story.counts.minChapter} through ${story.counts.maxChapter}` : "No chapters imported"}</small></div><div className="intake-rule"><i /><span>Gaps are allowed</span><i /></div><p>Adding Chapters 29–40 does not remove Chapters 1–3. If Chapters 4–28 arrive later, the library orders them automatically.</p></div>
    <div className="intake-workbench"><aside className="intake-source"><label><span>Story</span><select value={slug} disabled={Boolean(storySlug)} onChange={(event) => setSlug(event.target.value)}>{stories.map((item) => <option value={item.slug} key={item.slug}>{item.title}</option>)}</select></label><div className="intake-tabs" role="tablist"><button className={mode === "folder" ? "active" : ""} onClick={() => chooseMode("folder")}>Chapter folder</button><button className={mode === "file" ? "active" : ""} onClick={() => chooseMode("file")}>Manuscript file</button><button className={mode === "search" ? "active" : ""} onClick={() => chooseMode("search")}>Novel search</button><button className={mode === "url" ? "active" : ""} onClick={() => chooseMode("url")}>Web range</button></div>
      {mode === "folder" && <label className="intake-drop"><input type="file" multiple {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(event) => { setFiles(Array.from(event.target.files ?? []).filter((item) => item.name.toLowerCase().endsWith(".txt"))); setInspection(undefined); }} /><span>NUMBERED TXT FILES</span><b>{files.length ? `${files.length} chapter files ready` : "Choose a chapter folder"}</b><small>chapter-029.txt · 0030.txt · Chapter_31.txt</small></label>}
      {mode === "file" && <><label className="intake-drop"><input type="file" accept=".txt,.epub,.docx" onChange={(event) => { setFile(event.target.files?.[0]); setInspection(undefined); }} /><span>TXT · EPUB · DOCX</span><b>{file?.name ?? "Choose a manuscript"}</b><small>Up to 50 MB · inspected before import</small></label>{file?.name.toLowerCase().endsWith(".txt") && <div className="txt-numbering"><label><input type="radio" checked={!splitChapters} onChange={() => setSplitChapters(false)} /> One chapter</label><label><input type="radio" checked={splitChapters} onChange={() => setSplitChapters(true)} /> Split numbered headings</label>{!splitChapters && <label><span>Chapter number</span><input type="number" min="1" value={singleChapter} onChange={(event) => setSingleChapter(event.target.value)} /></label>}</div>}</>}
      {mode === "search" && <div className="novel-search"><label><span>Novel title or author</span><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder="Search available public sources" /></label><div className="provider-checks">{providers.map((provider) => <label key={provider.id} title={provider.capabilities.search ? `Priority ${provider.priority} · ${provider.reliability}` : "Direct URL only"}><input type="checkbox" disabled={!provider.capabilities.search || provider.health?.status === "disabled"} checked={selectedProviders.includes(provider.id)} onChange={(event) => setSelectedProviders(event.target.checked ? [...selectedProviders, provider.id] : selectedProviders.filter((id) => id !== provider.id))} /><span>{provider.displayName}</span><small>{provider.capabilities.search ? `${provider.reliability} · ${provider.health?.status ?? "unknown"}` : "URL ONLY"}</small></label>)}</div><button className="button primary" disabled={busy || !selectedProviders.length} onClick={() => void search()}>{busy ? "Searching sources…" : "Search providers"}</button>{searchWarnings.map((warning) => <div className="intake-error" key={warning.provider}><b>{warning.provider} unavailable</b><span>{warning.message}</span></div>)}</div>}
      {mode === "url" && <div className="web-range"><label><span>Story URL</span><input value={url} onChange={(event) => { setUrl(event.target.value); setAcquisition("html"); setInspection(undefined); setError(""); }} placeholder="https://fanqienovel.com/page/…" /></label>{bulkProvider && <label><span>Acquisition</span><select value={acquisition} onChange={(event) => { setAcquisition(event.target.value as "html" | "bulk-download"); setInspection(undefined); }}><option value="html">Individual chapter pages</option><option value="bulk-download">Official full TXT download</option></select><small>Full TXT is downloaded once, split by numbered headings, and still validated chapter by chapter.</small></label>}<div><label><span>From</span><input type="number" min="1" value={range.from} onChange={(event) => setRange({ ...range, from: event.target.value })} /></label><label><span>To</span><input type="number" min="1" value={range.to} onChange={(event) => setRange({ ...range, to: event.target.value })} /></label></div></div>}
      {sourceSettings.length > 0 && <div className="source-priority"><header><span>Configured fallbacks</span><small>Lower priority runs first</small></header>{sourceSettings.map((source) => <div key={`${source.provider}-${source.bookId}`}><label className="source-toggle"><input type="checkbox" checked={source.enabled} onChange={(event) => setSourceSettings(sourceSettings.map((item) => item.provider === source.provider && item.bookId === source.bookId ? { ...item, enabled: event.target.checked } : item))} /><b>{source.provider}</b></label><input aria-label={`${source.provider} priority`} type="number" min="0" max="10000" value={source.priority} onChange={(event) => setSourceSettings(sourceSettings.map((item) => item.provider === source.provider && item.bookId === source.bookId ? { ...item, priority: Number(event.target.value) } : item))} /></div>)}<button className="button" disabled={busy} onClick={() => void saveSourceSettings()}>Save source order</button></div>}
      {mode !== "search" && <button className="button primary intake-inspect" disabled={busy} onClick={() => void inspect()}>{busy ? "Inspecting chapters…" : "Preview chapter update"}</button>}{error && <div className="intake-error"><b>Import needs attention</b><span>{error}</span></div>}</aside>
      <section className="intake-ledger">{mode === "search" ? <div className="search-ledger"><header><div><span className="eyebrow">Provider results</span><h3>{searchResults.length ? `${searchResults.length} source match${searchResults.length === 1 ? "" : "es"}` : "Search across providers"}</h3><p>Same-title results remain separate until you choose a source.</p></div></header><div className="novel-results">{searchResults.map((result) => <article key={`${result.provider}-${result.bookId}`}><span>{result.provider.toUpperCase()}</span><h4>{result.title}</h4><p>{result.author ?? "Author not listed"}</p><small>{result.chapterCount ? `${result.chapterCount} chapters` : result.latestChapter ?? "Chapter count checked during inspection"}</small><button className="button" onClick={() => useSearchResult(result)}>Inspect this source</button></article>)}</div>{!searchResults.length && <div className="ledger-empty"><span>NOVEL DISCOVERY</span><h3>Find the edition you want.</h3><p>Provider failures are isolated and shown separately. Results are never merged solely by title.</p></div>}</div> : inspection ? <><header><div><span className="eyebrow">Update preview</span><h3>{inspection.title ?? `${inspection.chapterCount} incoming chapters`}</h3><p>{inspection.author ? `${inspection.author} · ` : ""}{inspection.metadata?.provider?.toUpperCase() ?? inspection.type.toUpperCase()} source</p></div><span className="intake-total">{update?.afterCount ?? inspection.chapterCount}<small>after import</small></span></header><div className="intake-totals"><span className="new"><b>{update?.added.length ?? inspection.chapterCount}</b>New</span><span className="replace"><b>{update?.replaced.length ?? 0}</b>Replace</span><span><b>{update?.unchanged.length ?? 0}</b>Unchanged</span><span><b>{update?.preservedCount ?? 0}</b>Preserved</span></div><div className="chapter-shelf" aria-label="Incoming chapter map">{inspection.chapters.map((item) => <div key={item.chapter} className={added.has(item.chapter) ? "new" : replaced.has(item.chapter) ? "replace" : unchanged.has(item.chapter) ? "unchanged" : "new"}><b>{String(item.chapter).padStart(4, "0")}</b><span>{added.has(item.chapter) ? "new" : replaced.has(item.chapter) ? "replace" : "same"} · {item.metadata?.provider ?? inspection.metadata?.provider ?? inspection.type}</span><small>{item.originalTitle ?? item.sourceTitle ?? `Chapter ${item.chapter}`}</small></div>)}</div>{inspection.metadata?.fallbackAttempts?.length ? <div className="fallback-evidence"><span>FALLBACK TRACE</span>{inspection.metadata.fallbackAttempts.map((attempt, index) => <p key={`${attempt.provider}-${attempt.chapter}-${index}`}><b>Chapter {attempt.chapter} · {attempt.provider} · {attempt.status}</b><small>{attempt.extractedCharacters !== undefined ? `${attempt.extractedCharacters}${attempt.expectedCharacters ? ` / ~${attempt.expectedCharacters}` : ""} characters · ` : ""}{attempt.reason}</small></p>)}</div> : null}{inspection.warnings.length > 0 && <div className="intake-warnings">{inspection.warnings.map((warning, index) => <p key={`${warning.code}-${index}`}>{warning.message}</p>)}</div>}{update?.missingCount ? <div className="gap-note"><span>OPEN SPACES</span><b>{update.missingSummary}</b><p>These chapter numbers remain empty. You can add them in any later update.</p></div> : <div className="gap-note complete"><span>SEQUENCE</span><b>No gaps between imported chapter numbers</b></div>}<footer><p>{update?.replaced.length ? "Replacing a chapter invalidates that chapter and later continuity-dependent work. Unrelated earlier production stays cached." : "Existing chapters and production files will be preserved."}</p><button className="button primary" disabled={busy || actionCount === 0} onClick={() => void importChapters()}>{busy ? "Updating…" : actionCount ? `Add / update ${actionCount} chapter${actionCount === 1 ? "" : "s"}` : "Everything is current"}</button></footer></> : <div className="ledger-empty"><span>CHAPTER LEDGER</span><h3>Nothing changes before you inspect.</h3><p>Choose a source. The preview will mark new chapters, replacements, unchanged overlaps, and open spaces in the sequence.</p></div>}</section>
    </div>
  </section>;
}

function positiveInteger(value: string, label: string) { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive whole number`); return parsed; }
export function savedStorySourceUrl(value: Pick<StoryDashboard, "story" | "source">) {
  const configured = value.story.source.url?.trim(); if (configured) return configured;
  const origin = value.source?.origin;
  if (!origin || typeof origin !== "object" || !("url" in origin)) return undefined;
  const fallback = (origin as { url?: unknown }).url; return typeof fallback === "string" && fallback.trim() ? fallback.trim() : undefined;
}
function normalizeWebSourceUrl(value: string) {
  const trimmed = value.trim(); if (!trimmed) throw new Error("Enter the story URL");
  let parsed: URL; try { parsed = new URL(trimmed); } catch { throw new Error("Enter a complete story URL, such as https://fanqienovel.com/page/…"); }
  if (parsed.protocol !== "https:") throw new Error("Story URLs must use HTTPS");
  return parsed.toString();
}
function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
function providerForUrl(providers: NovelProvider[], value: string) { try { const host = new URL(value).hostname.toLowerCase(); return providers.find((provider) => (provider.domains ?? []).some((domain) => domain.startsWith("*.") ? host.endsWith(domain.slice(1)) : host === domain)); } catch { return undefined; } }
