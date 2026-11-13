import { pinyin } from "pinyin-pro";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceNameEntry, SourceNameIndex } from "../../../src/naming/source-index.js";
import { api, post, put, type Job } from "./api.js";
import { Pagination } from "./Pagination.js";
import "./source-name-index.css";

type View = {
  imported: { count: number; from?: number; to?: number };
  index?: SourceNameIndex;
  stale: boolean;
  ambiguous: string[];
  saved: Record<string, string | undefined>;
  savedOutsideScan: { id: string; sourceName: string; name?: string }[];
  canonical: Record<string, { id: string; name?: string; displayName?: string } | undefined>;
};

const pageSize = 25;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

const hasHan = (value: string) => /\p{Script=Han}/u.test(value);
const romanize = (value: string) => value.replace(/\p{Script=Han}+/gu, run =>
  pinyin(run, { toneType: "none", traditional: true }).replace(/\b[a-z]/g, char => char.toUpperCase()));

function indexDisplay(entries: SourceNameEntry[], canonical: View["canonical"] | undefined) {
  const names = new Map<string, string>();
  const ambiguous = new Set<string>();
  let maxLength = 0;
  const labels = new Map(entries.map(entry => {
    const established = canonical?.[entry.id]?.displayName;
    const label = established && !hasHan(established) ? established : romanize(entry.displayName);
    for (const source of [entry.sourceName, ...entry.aliases]) {
      const spelling = source.trim().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
      if (!hasHan(spelling)) continue;
      const previous = names.get(spelling);
      if (previous && previous !== label) ambiguous.add(spelling);
      else names.set(spelling, label);
      maxLength = Math.max(maxLength, spelling.length);
    }
    return [entry.id, label];
  }));
  const renderProse = (value: string) => value.replace(/\p{Script=Han}+/gu, run => {
    const parts: string[] = [];
    let plain = "";
    for (let offset = 0; offset < run.length;) {
      let match = "";
      for (let end = Math.min(run.length, offset + maxLength); end > offset; end--) {
        const spelling = run.slice(offset, end);
        if (names.has(spelling) && !ambiguous.has(spelling)) { match = spelling; break; }
      }
      if (!match) {
        const char = String.fromCodePoint(run.codePointAt(offset)!);
        plain += char;
        offset += char.length;
        continue;
      }
      if (plain) { parts.push(romanize(plain)); plain = ""; }
      parts.push(names.get(match)!);
      offset += match.length;
    }
    if (plain) parts.push(romanize(plain));
    return parts.join(" ");
  });
  const descriptions = new Map(entries.map(entry => [entry.id, renderProse(entry.description)]));
  return { label: (entry: SourceNameEntry) => labels.get(entry.id) ?? romanize(entry.displayName), description: (entry: SourceNameEntry) => descriptions.get(entry.id) ?? renderProse(entry.description), prose: renderProse };
}

export function SourceNameIndexPage({ slug, job, onJob, navigate }: {
  slug: string; job?: Job; onJob: (job: Job) => void; navigate: (path: string) => void;
}) {
  const endpoint = `/stories/${slug}/source-names`;
  const [view, setView] = useState<View>();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<{ fingerprint: string; requests: number; cached: number; chapters: number; model: string }>();
  const [cap, setCap] = useState("100");
  const [revision, reload] = useState(0);
  const [removing, setRemoving] = useState<string>();
  const inspector = useRef<HTMLElement>(null);
  const running = job?.status === "running" || job?.status === "queued";
  useEffect(() => {
    const controller = new AbortController();
    void api<View>(endpoint, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setView(result);
    }).catch(error => {
      if (!controller.signal.aborted) setError(message(error));
    });
    return () => controller.abort();
  }, [endpoint, job?.id, job?.status, revision]);

  async function scan(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const range = { from: from ? Number(from) : undefined, to: to ? Number(to) : undefined };
      if (!preview) setPreview(await post<NonNullable<typeof preview>>(`${endpoint}/preview`, range));
      else {
        onJob(await post<Job>(endpoint, { ...range, fingerprint: preview.fingerprint, approvedRequests: Number(cap) }));
        setPreview(undefined);
      }
    } catch (error) {
      setError(message(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function removeOutsideScan(id: string) {
    setRemoving(id);
    setError("");
    try {
      await put(`${endpoint}/${id}`, { name: "" });
      reload(value => value + 1);
    } catch (error) {
      setError(message(error));
    } finally {
      setRemoving(undefined);
    }
  }

  const index = view?.index;
  const entries = index?.entries ?? [];
  const display = useMemo(() => indexDisplay(index?.entries ?? [], view?.canonical), [index, view?.canonical]);
  const ranked = entries.filter(entry => entry.suggestedName && !view?.ambiguous.includes(entry.id) && !view?.saved[entry.id] && !view?.canonical[entry.id]?.name);
  const types = [...new Set(entries.map(entry => entry.type))].sort();
  const search = query.trim().toLowerCase();
  const filtered = entries.filter(entry => (!kind || entry.type === kind) &&
    [entry.sourceName, entry.displayName, display.label(entry), ...entry.aliases, entry.description, display.description(entry), view?.saved[entry.id], view?.canonical[entry.id]?.name]
      .some(value => value?.toLowerCase().includes(search)));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages);
  const entry = entries.find(item => item.id === selected);
  function choose(id: string) {
    setSelected(id);
    requestAnimationFrame(() => {
      inspector.current?.focus({ preventScroll: true });
      inspector.current?.scrollIntoView({ block: "start" });
    });
  }

  return <section className="page source-index">
    <header className="source-index-header">
      <div>
        <span className="source-index-kicker">Editorial desk · Original manuscript</span>
        <h2>Source Name Index</h2>
        <p>Find the names your listeners will hear most. Decide what to call them before generating narration.</p>
      </div>
      <button className="button" onClick={() => navigate(`/stories/${slug}/names`)}>Names / Localization</button>
    </header>

    <form className="source-index-scan" onSubmit={scan}>
      <div className="source-index-range">
        <div className="source-index-scan-intro">
          <h3>Scan imported chapters</h3>
          <p>{view?.imported.count ? `${view.imported.count.toLocaleString()} imported · Leave both fields blank to scan all.` : "Import source chapters to begin."}</p>
        </div>
        <div className="source-index-range-fields">
          <label className="field"><span>From chapter</span><input type="number" min={view?.imported.from ?? 1} max={view?.imported.to} placeholder={String(view?.imported.from ?? "")} value={from} disabled={submitting} onChange={event => { setFrom(event.target.value); setPreview(undefined); }} /></label>
      <label className="field"><span>Through chapter</span><input type="number" min={view?.imported.from ?? 1} max={view?.imported.to} placeholder={String(view?.imported.to ?? "")} value={to} disabled={submitting} onChange={event => { setTo(event.target.value); setPreview(undefined); }} /></label>
        </div>
        {!preview && <button className="button primary" disabled={!view?.imported.count || running || submitting}>{running ? "Scanning…" : submitting ? "Preparing preview…" : "Preview scan"}</button>}
      </div>
      {preview ? <section className="source-index-preview" aria-label="Scan preview">
        <header>
          <h4>Scan preview</h4>
          <span className="source-index-model">{preview.model}</span>
        </header>
        <dl className="source-index-preview-stats" aria-live="polite">
          <div><dt>Chapters</dt><dd>{preview.chapters.toLocaleString()}</dd></div>
          <div><dt>New passage evaluations</dt><dd>{preview.requests.toLocaleString()}</dd></div>
          <div><dt>Cached passages</dt><dd>{preview.cached.toLocaleString()}</dd></div>
        </dl>
        <div className="source-index-approval">
          <label className="field"><span>Maximum provider attempts</span><input type="number" min="0" max="10000" required value={cap} disabled={submitting} aria-describedby="source-index-cap-help" onChange={event => setCap(event.target.value)} /></label>
          <p id="source-index-cap-help">Provider charges may apply. The cap includes fallback attempts and carries through resume and retry.</p>
          <button className="button primary" disabled={running || submitting || !cap.trim() || preview.requests > Number(cap) || Number(cap) > 10_000}>{submitting ? "Starting…" : "Start approved scan"}</button>
          {preview.requests > Number(cap) && <p className="source-index-cap-warning" role="status">Choose a smaller range or raise the cap to cover the new passage evaluations.</p>}
        </div>
      </section> : <p className="source-index-scan-note">Uses your Story Bible model. Provider charges may apply. Previously scanned passages are reused.</p>}
    </form>
    {(error || job?.status === "failed") && <p className="error-box" role="alert">{error || job?.error || "The scan failed. Run it again to reuse completed passages."}</p>}
    {running && <p className="source-index-status" role="status">{job?.progress?.chapter ? `Scanning chapter ${job.progress.chapter} · ${job.progress.index} of ${job.progress.total}` : "Preparing the source scan…"} You can follow this scan in Activity.</p>}
    {job?.status === "paused" && !job.resumedBy && <p className="source-index-status">Scan paused. Resume in Activity to continue using the saved passages.</p>}
    {view?.stale && <p className="error-box">This index needs a refresh. Preview a new scan to update the counts and save naming decisions.</p>}

    {Boolean(view?.savedOutsideScan.length) && <details className="source-index-empty">
      <summary>Saved rules outside this scan</summary>
      <ul>{view?.savedOutsideScan.map(rule => <li key={rule.id}>
        {romanize(rule.sourceName)} · {romanize(rule.name ?? "")} <button className="button" disabled={Boolean(removing)} onClick={() => void removeOutsideScan(rule.id)}>Remove rule</button>
      </li>)}</ul>
    </details>}
    {index ? <>
      <p className="source-index-coverage"><b>{entries.length.toLocaleString()} entities</b> · {index.chapters.length.toLocaleString()} scanned chapters · Ch. {index.chapters[0]}–{index.chapters.at(-1)}
        <span>Counts are literal mentions of indexed source names and aliases.</span></p>
      <div className="source-index-desk">
        <aside className="source-index-queue" aria-label="Ranked rename suggestions">
          <h3>Review first</h3>
          <p>Ranked by narrative importance, mention count, and chapter coverage.</p>
          {ranked.length ? <ol>{ranked.slice(0, 10).map(entry => <li key={entry.id}>
            <button onClick={() => choose(entry.id)}>
              <span><strong>{display.label(entry)}</strong><small>{entry.mentions.toLocaleString()} mentions</small></span>
              <span className="source-index-proposal">{romanize(entry.suggestedName)}</span>
            </button>
          </li>)}</ol> : <p>No outstanding rename suggestions in this scan.</p>}
        </aside>
        <div className="source-index-register">
          <section className="source-index-inspector" ref={inspector} tabIndex={-1} aria-label="Selected entity">
            {entry ? <NameInspector key={entry.id} entry={entry} display={display} index={index} view={view!} endpoint={endpoint} navigate={navigate} reload={() => reload(value => value + 1)} />
              : <><h3>Read the evidence</h3><p>Select a name to see its description, where it appears, and the proposed narration name.</p></>}
          </section>
          <div className="source-index-filters">
            <input className="search" aria-label="Search indexed names" placeholder="Search names or descriptions" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />
            <select aria-label="Entity type" value={kind} onChange={event => { setKind(event.target.value); setPage(1); }}>
              <option value="">All types</option>{types.map(type => <option key={type} value={type}>{type[0]!.toUpperCase() + type.slice(1)}</option>)}
            </select>
          </div>
          <ul className="source-index-entities">{filtered.slice((current - 1) * pageSize, current * pageSize).map(entry => <li key={entry.id}>
            <button aria-pressed={selected === entry.id} onClick={() => choose(entry.id)}>
              <span className="source-index-identity"><strong>{display.label(entry)}</strong><small>{entry.type}</small></span>
              <span className="source-index-description">{display.description(entry)}</span>
              <span className="source-index-tally"><strong>{entry.mentions.toLocaleString()}</strong><small>{entry.chapters.length} ch.</small></span>
            </button>
          </li>)}</ul>
          {!filtered.length && <p className="source-index-status">No entities match these filters.</p>}
          {pages > 1 && <Pagination page={current} pages={pages} onPrevious={() => setPage(current - 1)} onNext={() => setPage(current + 1)} />}
        </div>
      </div>
    </> : <div className="source-index-empty"><h3>Your manuscript is the starting point.</h3><p>Scan a chapter range to build a list of the people, places, abilities, and things you may want to rename.</p></div>}
  </section>;
}

function NameInspector({ entry, display, index, view, endpoint, navigate, reload }: {
  entry: SourceNameEntry; display: ReturnType<typeof indexDisplay>; index: SourceNameIndex; view: View; endpoint: string; navigate: (path: string) => void; reload: () => void;
}) {
  const saved = view.saved[entry.id];
  const canonical = view.canonical[entry.id];
  const ambiguous = view.ambiguous.includes(entry.id);
  const canEdit = !canonical?.name && !ambiguous;
  const [name, setName] = useState(saved ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const chapterPositions = new Map(index.chapters.map((chapter, position) => [chapter, position]));
  const bins = Array.from({ length: Math.min(48, index.chapters.length) }, () => 0);
  for (const { chapter, count } of entry.chapters) {
    const position = chapterPositions.get(chapter);
    if (position !== undefined) {
      const bin = Math.floor(position * bins.length / index.chapters.length);
      bins[bin] = (bins[bin] ?? 0) + count;
    }
  }
  const peak = Math.max(1, ...bins);
  async function save(value: string) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await put<{ invalidation: { affectedChapters: number[]; manualNarrationChapters: number[] } }>(`${endpoint}/${entry.id}`, { name: value, scannedAt: index.scannedAt });
      setName(value);
      const { affectedChapters, manualNarrationChapters } = result.invalidation;
      setNotice(`${value ? "Narration name saved." : "Source name rule removed."}${affectedChapters.length ? ` ${affectedChapters.length} existing chapters flagged for review or regeneration.` : ""}${manualNarrationChapters.length ? ` ${manualNarrationChapters.length} manual narrations kept for review.` : ""}`);
      reload();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return <>
    <span className="source-index-kicker">{entry.type} · {entry.importance} in the scanned source</span>
    <h3>{display.label(entry)}</h3>
    <p>{display.description(entry)}</p>
    <details><summary>Original source spellings</summary><p>{[entry.sourceName, ...entry.aliases].join(" · ")}</p></details>
    <figure className="source-index-mentions">
      <figcaption><strong>{entry.mentions.toLocaleString()} mentions</strong><span>Across {entry.chapters.length.toLocaleString()} scanned chapters</span></figcaption>
      <div className="source-index-strip" aria-hidden="true">{bins.map((count, i) => <i key={i} style={{ height: `${count ? 15 + 85 * Math.sqrt(count / peak) : 5}%` }} data-hit={count > 0} />)}</div>
      <details><summary>Show counts by chapter</summary><ul>{entry.chapters.map(hit => <li key={hit.chapter}><a href={`${endpoint.replace("/source-names", "")}/chapters/${hit.chapter}?tab=original`}>Ch. {hit.chapter}</a> · {hit.count}</li>)}</ul></details>
    </figure>
    {entry.suggestedName && <div className="source-index-suggestion"><strong>{romanize(entry.suggestedName)}</strong><p>{display.prose(entry.reason)}</p>{canEdit && <button className="button" disabled={busy || view.stale} onClick={() => setName(romanize(entry.suggestedName))}>Use suggestion</button>}</div>}
    {canonical && <button className="button" onClick={() => navigate(`${endpoint.replace("/source-names", "")}/names?entity=${canonical.id}`)}>{canonical.name ? `Edit localization · ${romanize(canonical.name)}` : "Open localization settings"}</button>}
    {ambiguous && <p>This spelling is ambiguous. Source rules for this spelling are held for review. Use Names / Localization to rename a specific identity.</p>}
    {canEdit && <form className="source-index-name-form" onSubmit={event => { event.preventDefault(); void save(name.trim()); }}>
        <label className="field"><span>Narration name</span><input value={name} maxLength={160} onChange={event => setName(event.target.value)} placeholder={display.label(entry)} /></label>
        <button className="button primary" disabled={busy || view.stale || !name.trim() || name.trim() === saved}>{busy ? "Saving…" : "Save narration name"}</button>
        <p>Applies to future narration and flags affected existing narration for review.</p>
      </form>}
    {saved && <button className="button" disabled={busy} onClick={() => void save("")}>Remove source rule · {romanize(saved)}</button>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error-box">{error}</p>}
  </>;
}
