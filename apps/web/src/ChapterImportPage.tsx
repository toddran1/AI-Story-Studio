import { useEffect, useState } from "react";
import { api, post, StoryCard, StoryDashboard } from "./api.js";

type Mode = "file" | "folder" | "url";
type Inspection = {
  id: string; type: string; title?: string; author?: string; chapterCount: number; availableChapterCount: number;
  chapters: Array<{ chapter: number; originalTitle?: string; sourceTitle?: string }>;
  warnings: Array<{ code: string; message: string }>;
  update?: { existingCount: number; afterCount: number; added: number[]; replaced: number[]; unchanged: number[]; preservedCount: number; missingCount: number; missingSummary?: string; minimumChapter?: number; maximumChapter?: number };
};

export function ChapterImportPage({ storySlug, stories, navigate }: { storySlug?: string; stories: StoryCard[]; navigate: (path: string) => void }) {
  const [slug, setSlug] = useState(storySlug ?? stories[0]?.slug ?? "");
  const [story, setStory] = useState<StoryDashboard>(); const [mode, setMode] = useState<Mode>("folder");
  const [file, setFile] = useState<File>(); const [files, setFiles] = useState<File[]>([]); const [url, setUrl] = useState("");
  const [singleChapter, setSingleChapter] = useState("1"); const [splitChapters, setSplitChapters] = useState(false);
  const [range, setRange] = useState({ from: "1", to: "10" }); const [inspection, setInspection] = useState<Inspection>();
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const selectedStory = stories.find((item) => item.slug === slug);

  useEffect(() => { if (storySlug) setSlug(storySlug); }, [storySlug]);
  useEffect(() => {
    if (!slug) return;
    setStory(undefined); setInspection(undefined); setError("");
    api<StoryDashboard>(`/stories/${slug}`).then((value) => {
      setStory(value); const next = (value.counts.maxChapter ?? 0) + 1; setSingleChapter(String(next));
      const savedUrl = savedStorySourceUrl(value); setUrl(savedUrl ?? "");
      if (savedUrl) setMode("url");
    }).catch((cause) => setError(errorMessage(cause)));
  }, [slug]);

  const chooseMode = (value: Mode) => { setMode(value); setInspection(undefined); setError(""); };
  const inspect = async () => {
    setBusy(true); setError(""); setInspection(undefined);
    try {
      if (!slug) throw new Error("Choose the story you want to update");
      let next: Inspection;
      if (mode === "url") {
        const from = positiveInteger(range.from, "From chapter"); const to = positiveInteger(range.to, "To chapter");
        if (to < from) throw new Error("To chapter must be at or after From chapter");
        next = await post(`/stories/${slug}/source/inspect`, { url: normalizeWebSourceUrl(url), from, to, allowGaps: true });
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
  return <section className="page chapter-intake-page">
    <header className="intake-mast"><div><span className="eyebrow">Chapter intake · {selectedStory?.sourceType ?? story?.story.source.type ?? "source"}</span><h2>Add pages to <em>{selectedStory?.title ?? story?.story.title ?? slug}</em></h2><p>New chapter numbers slot into place. Existing chapters stay untouched unless the incoming source uses the same number.</p></div><button className="button" onClick={() => navigate(`/stories/${slug}`)}>Back to story</button></header>
    <div className="intake-context"><div><span className="mono">CURRENT EDITION</span><b>{story?.counts.chapters ?? selectedStory?.importedChapters ?? "—"} chapters</b><small>{story?.counts.minChapter ? `Chapter ${story.counts.minChapter} through ${story.counts.maxChapter}` : "No chapters imported"}</small></div><div className="intake-rule"><i /><span>Gaps are allowed</span><i /></div><p>Adding Chapters 29–40 does not remove Chapters 1–3. If Chapters 4–28 arrive later, the library orders them automatically.</p></div>
    <div className="intake-workbench"><aside className="intake-source"><label><span>Story</span><select value={slug} disabled={Boolean(storySlug)} onChange={(event) => setSlug(event.target.value)}>{stories.map((item) => <option value={item.slug} key={item.slug}>{item.title}</option>)}</select></label><div className="intake-tabs" role="tablist"><button className={mode === "folder" ? "active" : ""} onClick={() => chooseMode("folder")}>Chapter folder</button><button className={mode === "file" ? "active" : ""} onClick={() => chooseMode("file")}>Manuscript file</button><button className={mode === "url" ? "active" : ""} onClick={() => chooseMode("url")}>Web range</button></div>
      {mode === "folder" && <label className="intake-drop"><input type="file" multiple {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(event) => { setFiles(Array.from(event.target.files ?? []).filter((item) => item.name.toLowerCase().endsWith(".txt"))); setInspection(undefined); }} /><span>NUMBERED TXT FILES</span><b>{files.length ? `${files.length} chapter files ready` : "Choose a chapter folder"}</b><small>chapter-029.txt · 0030.txt · Chapter_31.txt</small></label>}
      {mode === "file" && <><label className="intake-drop"><input type="file" accept=".txt,.epub,.docx" onChange={(event) => { setFile(event.target.files?.[0]); setInspection(undefined); }} /><span>TXT · EPUB · DOCX</span><b>{file?.name ?? "Choose a manuscript"}</b><small>Up to 50 MB · inspected before import</small></label>{file?.name.toLowerCase().endsWith(".txt") && <div className="txt-numbering"><label><input type="radio" checked={!splitChapters} onChange={() => setSplitChapters(false)} /> One chapter</label><label><input type="radio" checked={splitChapters} onChange={() => setSplitChapters(true)} /> Split numbered headings</label>{!splitChapters && <label><span>Chapter number</span><input type="number" min="1" value={singleChapter} onChange={(event) => setSingleChapter(event.target.value)} /></label>}</div>}</>}
      {mode === "url" && <div className="web-range"><label><span>Story URL</span><input value={url} onChange={(event) => { setUrl(event.target.value); setInspection(undefined); setError(""); }} placeholder="https://fanqienovel.com/page/…" /></label><div><label><span>From</span><input type="number" min="1" value={range.from} onChange={(event) => setRange({ ...range, from: event.target.value })} /></label><label><span>To</span><input type="number" min="1" value={range.to} onChange={(event) => setRange({ ...range, to: event.target.value })} /></label></div></div>}
      <button className="button primary intake-inspect" disabled={busy} onClick={() => void inspect()}>{busy ? "Inspecting chapters…" : "Preview chapter update"}</button>{error && <div className="intake-error"><b>Import needs attention</b><span>{error}</span></div>}</aside>
      <section className="intake-ledger">{inspection ? <><header><div><span className="eyebrow">Update preview</span><h3>{inspection.title ?? `${inspection.chapterCount} incoming chapters`}</h3><p>{inspection.author ? `${inspection.author} · ` : ""}{inspection.type.toUpperCase()} source</p></div><span className="intake-total">{update?.afterCount ?? inspection.chapterCount}<small>after import</small></span></header><div className="intake-totals"><span className="new"><b>{update?.added.length ?? inspection.chapterCount}</b>New</span><span className="replace"><b>{update?.replaced.length ?? 0}</b>Replace</span><span><b>{update?.unchanged.length ?? 0}</b>Unchanged</span><span><b>{update?.preservedCount ?? 0}</b>Preserved</span></div><div className="chapter-shelf" aria-label="Incoming chapter map">{inspection.chapters.map((item) => <div key={item.chapter} className={added.has(item.chapter) ? "new" : replaced.has(item.chapter) ? "replace" : unchanged.has(item.chapter) ? "unchanged" : "new"}><b>{String(item.chapter).padStart(4, "0")}</b><span>{added.has(item.chapter) ? "new" : replaced.has(item.chapter) ? "replace" : "same"}</span><small>{item.originalTitle ?? item.sourceTitle ?? `Chapter ${item.chapter}`}</small></div>)}</div>{inspection.warnings.length > 0 && <div className="intake-warnings">{inspection.warnings.map((warning, index) => <p key={`${warning.code}-${index}`}>{warning.message}</p>)}</div>}{update?.missingCount ? <div className="gap-note"><span>OPEN SPACES</span><b>{update.missingSummary}</b><p>These chapter numbers remain empty. You can add them in any later update.</p></div> : <div className="gap-note complete"><span>SEQUENCE</span><b>No gaps between imported chapter numbers</b></div>}<footer><p>{update?.replaced.length ? "Replacing a chapter invalidates that chapter and later continuity-dependent work. Unrelated earlier production stays cached." : "Existing chapters and production files will be preserved."}</p><button className="button primary" disabled={busy || actionCount === 0} onClick={() => void importChapters()}>{busy ? "Updating…" : actionCount ? `Add / update ${actionCount} chapter${actionCount === 1 ? "" : "s"}` : "Everything is current"}</button></footer></> : <div className="ledger-empty"><span>CHAPTER LEDGER</span><h3>Nothing changes before you inspect.</h3><p>Choose a source. The preview will mark new chapters, replacements, unchanged overlaps, and open spaces in the sequence.</p></div>}</section>
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
