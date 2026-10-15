import { useEffect, useRef, useState } from "react";
import { api, post, getChapterTtsQuality, chapterTtsSegmentAudioUrl, type AudioDashboard, type Job, type TtsQualityArtifact } from "./api.js";

type Selection = { chapter: number; segments?: number[] };
type Result = { chapter: number; segment?: number; status: string; error?: string };
type Watch = (id: string, update: (job: Job) => void, error: (error: unknown) => void) => () => void;
export function AudioRegeneration({ slug, onJob, watchJob }: { slug: string; onJob: (job: Job) => void; watchJob: Watch }) {
  const [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const [rows, setRows] = useState<{ items: AudioDashboard["chapters"]; page: number; pages: number; total: number }>();
  const [selections, setSelections] = useState<Selection[]>([]);
  const [qualities, setQualities] = useState<Record<number, TtsQualityArtifact | null>>({});
  const [expanded, setExpanded] = useState<number[]>([]), [loading, setLoading] = useState<number[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number>();
  const [entry, setEntry] = useState(""); const [error, setError] = useState("");
  const [rebuild, setRebuild] = useState(true), [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job>(); const watcher = useRef<(() => void) | undefined>(undefined);
  const sorted = [...selections].sort((a,b) => a.chapter-b.chapter);
  const full = sorted.filter(row => !row.segments).length;
  const segments = sorted.reduce((sum,row) => sum + (row.segments?.length ?? 0),0);
  useEffect(() => { let cancelled = false; setRows(undefined); api<NonNullable<typeof rows>>(`/stories/${slug}/audio/chapters?page=${page}&pageSize=25`).then(value => { if (!cancelled) setRows(value); }).catch(error => { if (!cancelled) setError(String(error)); }); return () => { cancelled = true; }; }, [slug,page,revision]);
  useEffect(() => () => watcher.current?.(), [slug]);
  const selectFull = (chapter: number, selected: boolean) => setSelections(current => [...current.filter(row => row.chapter !== chapter), ...(selected ? [{ chapter }] : [])]);
  const selectSegment = (chapter: number, segment: number, selected: boolean) => setSelections(current => {
    const chosen = current.find(row => row.chapter === chapter)?.segments ?? [];
    const next = selected ? [...new Set([...chosen, segment])].sort((a,b) => a-b) : chosen.filter(value => value !== segment);
    return [...current.filter(row => row.chapter !== chapter), ...(next.length ? [{ chapter, segments: next }] : [])];
  });
  const inspect = async (chapter: number) => {
    setExpanded(current => current.includes(chapter) ? current.filter(value => value !== chapter) : [...current, chapter]);
    if (chapter in qualities || loading.includes(chapter)) return;
    setLoading(current => [...current, chapter]);
    try { const value = await getChapterTtsQuality(slug,chapter); setQualities(current => ({ ...current, [chapter]: value.quality })); }
    catch (error) { setError(`Chapter ${chapter}: ${String(error)}`); }
    finally { setLoading(current => current.filter(value => value !== chapter)); }
  };
  const add = async () => {
    setAdding(true);
    try {
      const numbers = new Set<number>();
      for (const token of entry.split(",").map(value => value.trim()).filter(Boolean)) {
        const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token); if (!match) throw new Error("Use chapter numbers or ranges, such as 310, 321-325.");
        const from = Number(match[1]), to = Number(match[2] ?? match[1]);
        if (from < 1 || to < from || to-from > 1999) throw new Error("Choose a valid range of up to 2,000 chapters.");
        for (let chapter=from; chapter<=to; chapter++) numbers.add(chapter);
      }
      if (!numbers.size || numbers.size > 2000) throw new Error("Enter 1–2,000 chapters.");
      const known = new Set<number>();
      // Validate manual numbers against the imported chapter list before selecting.
      for (let page=1;;page++) { const list = await api<NonNullable<typeof rows>>(`/stories/${slug}/audio/chapters?page=${page}&pageSize=100`); list.items.forEach(row => known.add(row.chapter)); if (page >= list.pages) break; }
      const missing = [...numbers].filter(chapter => !known.has(chapter)); if (missing.length) throw new Error(`Chapters not found: ${missing.join(", ")}`);
      setSelections(current => [...current.filter(row => !numbers.has(row.chapter)), ...[...numbers].map(chapter => ({ chapter }))]); setPage(Math.floor([...known].indexOf(Math.min(...numbers))/25)+1); setEntry(""); setError("");
    } catch (error) { setError(String(error)); } finally { setAdding(false); }
  };
  const run = async () => {
    setBusy(true); setError("");
    try {
      const next = await post<Job>(`/stories/${slug}/jobs/audio-regeneration`, { selections: sorted, rebuildMasters: rebuild });
      setJob(next); onJob(next); watcher.current?.();
      watcher.current = watchJob(next.id, next => {
        setJob(next); onJob(next);
        if (["completed","failed","paused"].includes(next.status)) { setBusy(false); setRevision(value => value+1); setQualities({}); if (next.error) setError(next.error); }
      }, error => { setBusy(false); setError(String(error)); });
    } catch (error) { setBusy(false); setError(String(error)); }
  };
  const progress = job?.progress as { chapter?: number; segment?: number; completed?: number; total?: number; phase?: string } | undefined;
  const result = job?.result as { results?: Result[] } | undefined;
  const failures = result?.results?.filter(row => row.status === "failed") ?? [];
  const pager = <nav className="regen-pager" aria-label="Regeneration chapters"><button className="button" disabled={busy || !rows || rows.page <= 1} onClick={() => setPage(rows!.page-1)}>Previous</button><label>Page <input type="number" min="1" max={rows?.pages ?? 1} aria-label="Regeneration page" value={page} disabled={busy || !rows} onChange={event => { const next = Number(event.target.value); if (Number.isInteger(next) && next >= 1 && next <= (rows?.pages ?? 1)) setPage(next); }} /> of {rows?.pages ?? "…"} · {rows?.total ?? "…"} chapters</label><button className="button" disabled={busy || !rows || rows.page >= rows.pages} onClick={() => setPage(rows!.page+1)}>Next</button></nav>;
  return <section className="audio-regeneration"><header className="section-heading"><div><span className="eyebrow">Speech repair desk</span><h2>Regenerate speech</h2><p>Replace a chapter’s speech or choose only the segments that need another take.</p></div></header>
    {error && <p className="regen-error" role="alert">{error}</p>}
    <div className="regen-layout"><div><div className="regen-tools"><label>Chapters or ranges<input value={entry} disabled={busy} onChange={event => setEntry(event.target.value)} placeholder="310, 321-325" /></label><button className="button" disabled={busy || adding || !entry.trim()} onClick={() => void add()}>{adding ? "Finding chapters…" : "Add chapters"}</button><button className="button" disabled={busy || !rows} onClick={() => setSelections(current => [...current.filter(row => !rows!.items.some(item => item.chapter === row.chapter)), ...rows!.items.map(row => ({ chapter: row.chapter }))])}>Select this page</button></div>
    {pager}
    {!rows ? <p role="status">Loading chapters…</p> : rows.items.map(row => {
      const selection = selections.find(item => item.chapter === row.chapter); const quality = qualities[row.chapter];
      return <article className={`regen-chapter ${selection ? "selected" : ""}`} key={row.chapter}><div className="regen-chapter-head"><label><input type="checkbox" disabled={busy} checked={Boolean(selection && !selection.segments)} onChange={event => selectFull(row.chapter,event.target.checked)} /><span className="regen-number">{String(row.chapter).padStart(4,"0")}</span><span><b>{row.title ?? `Chapter ${row.chapter}`}</b><small>{selection?.segments ? `${selection.segments.length} segment${selection.segments.length === 1 ? "" : "s"} selected` : selection ? "Full chapter selected" : "Select full chapter or inspect segments"}</small></span></label><button className="button" aria-expanded={expanded.includes(row.chapter)} disabled={busy} onClick={() => void inspect(row.chapter)}>{expanded.includes(row.chapter) ? "Hide segments" : "Choose segments"}</button></div>
      {expanded.includes(row.chapter) && <div className="regen-segments">{loading.includes(row.chapter) ? <p>Loading segments…</p> : !quality ? <p>No saved segment review is available. Choose the full chapter to generate speech.</p> : <><p>Choosing segments replaces this chapter’s full-chapter selection. Each selected segment gets one attempt.</p><button className="button" disabled={busy} onClick={() => setSelections(current => [...current.filter(item => item.chapter !== row.chapter), { chapter: row.chapter, segments: quality.segments.map(segment => segment.index+1) }])}>Select all segments</button>{quality.segments.map(segment => <details className="regen-segment" key={segment.index}><summary><label onClick={event => event.stopPropagation()}><input type="checkbox" disabled={busy} checked={Boolean(selection?.segments?.includes(segment.index+1))} onChange={event => selectSegment(row.chapter,segment.index+1,event.target.checked)} />Segment {segment.index+1}</label><span>{segment.status.replaceAll("_"," ")}</span></summary><audio controls preload="none" aria-label={`Chapter ${row.chapter} segment ${segment.index+1}`} src={chapterTtsSegmentAudioUrl(slug,row.chapter,segment.index+1)} /><p className="regen-script">{segment.expectedText}</p></details>)}</>}</div>}</article>;
    })}{pager}</div>
    <aside className="regen-selection"><span className="eyebrow">Next takes</span><h3>{sorted.length} chapter{sorted.length === 1 ? "" : "s"} selected</h3><p>{full} full chapters · {segments} individual segments</p><p>Full chapters use current narration and speech rules, with normal TTS retries. Segments use saved narration when their boundaries still match, and never retry automatically. Boundary changes require full-chapter regeneration.</p><ol className={editing !== undefined ? "regen-selection-editing" : undefined}>{sorted.map(row => <li key={row.chapter}><div className="regen-selection-row"><span>Chapter {row.chapter}<small>{row.segments ? `Segments ${row.segments.join(", ")}` : "All speech"}</small></span><div className="regen-selection-actions"><button className="button" disabled={busy} aria-label={`Edit chapter ${row.chapter} selection`} aria-expanded={editing === row.chapter} onClick={() => setEditing(editing === row.chapter ? undefined : row.chapter)}>Edit</button><button className="button" disabled={busy} aria-label={`Remove chapter ${row.chapter}`} onClick={() => { selectFull(row.chapter,false); if (editing === row.chapter) setEditing(undefined); }}>×</button></div></div>{editing === row.chapter && <SelectionEditor key={row.chapter} slug={slug} selection={row} onCancel={() => setEditing(undefined)} onSave={next => { setSelections(current => current.map(item => item.chapter === next.chapter ? next : item)); setEditing(undefined); }} />}</li>)}</ol><label><input type="checkbox" checked={rebuild} disabled={busy} onChange={event => setRebuild(event.target.checked)} />Rebuild chapter masters afterward</label><p>{rebuild ? "The full-audio download will include the replacements. Review flagged takes after the run." : "Downloads keep the previous master until you rebuild it."}</p><button className="button primary" disabled={busy || !sorted.length || editing !== undefined} onClick={() => void run()}>{busy ? "Regenerating…" : "Regenerate selection"}</button><small>Uses Fish Audio and incurs provider usage. Chapters run in order.</small>
    {job && <div className="regen-run" role="status"><b>{job.status}</b><p>{progress?.chapter ? `Chapter ${progress.chapter}${progress.segment ? ` · Segment ${progress.segment}` : ""} · ${progress.phase ?? "working"}` : "Preparing selection"}</p><progress max={progress?.total ?? 1} value={progress?.completed ?? 0} /><p>{progress?.completed ?? 0} of {progress?.total ?? full+segments} takes finished</p>{job.status === "running" && <button className="button" onClick={() => void post(`/jobs/${job.id}/pause`, {}).catch(error => setError(String(error)))}>Pause after current take</button>}{!busy && result?.results && <p>{result.results.filter(row => row.status === "completed").length} completed · {failures.length} failures</p>}{failures.map((row,index) => <p className="regen-error" key={index}><a href={`/stories/${slug}/chapters/${row.chapter}?tab=audio`}>Review audio</a> · Chapter {row.chapter}{row.segment ? `, segment ${row.segment}` : ""}: {row.error}</p>)}{!busy && <button className="button" onClick={() => { const completed = new Set(result?.results?.filter(row => row.status === "completed").map(row => `${row.chapter}:${row.segment ?? "all"}`)); setSelections(current => current.flatMap(row => { if (!row.segments) return completed.has(`${row.chapter}:all`) ? [] : [row]; const remaining = row.segments.filter(segment => !completed.has(`${row.chapter}:${segment}`)); return remaining.length ? [{ ...row, segments: remaining }] : []; })); }}>Remove completed takes</button>}</div>}
    </aside></div>
  </section>;
}

function SelectionEditor({ slug, selection, onSave, onCancel }: { slug: string; selection: Selection; onSave: (selection: Selection) => void; onCancel: () => void }) {
  const [mode, setMode] = useState(selection.segments ? "segments" : "full");
  const [chosen, setChosen] = useState(selection.segments ?? []);
  const [quality, setQuality] = useState<TtsQualityArtifact | null>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(""); setQuality(undefined);
    getChapterTtsQuality(slug, selection.chapter).then(value => { if (!cancelled) setQuality(value.quality); }).catch(error => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; };
  }, [slug, selection.chapter, attempt]);
  const available = quality?.segments.map(segment => segment.index + 1) ?? [];
  const valid = chosen.length > 0 && chosen.every(segment => available.includes(segment));
  return <div className="regen-quick-edit" role="group" aria-label={`Edit chapter ${selection.chapter} selection`}>
    <p className="regen-edit-title">What should get another take?</p>
    <label className="regen-edit-mode"><input type="radio" name={`scope-${selection.chapter}`} checked={mode === "full"} onChange={() => setMode("full")} />Full chapter</label>
    <label className="regen-edit-mode"><input type="radio" name={`scope-${selection.chapter}`} checked={mode === "segments"} onChange={() => setMode("segments")} />Specific segments</label>
    {mode === "segments" && <>{error ? <div role="alert"><p>Could not load segments. {error}</p><button className="button" onClick={() => setAttempt(value => value + 1)}>Retry loading</button></div> : quality === undefined ? <p role="status">Loading segments…</p> : !available.length ? <p>No saved segments. Choose the full chapter to generate speech.</p> : <><div className="regen-segment-picks">{available.map(segment => <label key={segment} className={chosen.includes(segment) ? "chosen" : ""}><input type="checkbox" checked={chosen.includes(segment)} onChange={event => setChosen(current => event.target.checked ? [...current, segment].sort((a,b) => a-b) : current.filter(value => value !== segment))} />Segment {segment}</label>)}</div><p>{chosen.length ? `Only segment${chosen.length === 1 ? "" : "s"} ${chosen.join(", ")} will regenerate.` : "Choose at least one segment."}</p></>}</>}
    <div className="regen-edit-actions"><button className="button" onClick={onCancel}>Cancel</button><button className="button primary" disabled={mode === "segments" && !valid} onClick={() => onSave(mode === "full" ? { chapter: selection.chapter } : { chapter: selection.chapter, segments: chosen })}>Apply selection</button></div>
  </div>;
}
