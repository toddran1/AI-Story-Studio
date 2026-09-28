import { useEffect, useRef, useState } from "react";
import { api, post, type Job, type StorySummary } from "./api.js";
import { useMusicExportPreferences } from "./useMusicExportPreferences.js";
import { BackgroundMusicControls } from "./BackgroundMusicControls.js";

export function SummaryMusicExports({ slug, summary, onJob, onPrepare, disabled = false }: { slug: string; summary: StorySummary; onJob?: (job: Job) => void; onPrepare?: (kind: "audio" | "video") => void; disabled?: boolean }) {
  const storageKey = `summary-music:${slug}:${summary.id}`;
  const { music, setMusic, overrides, setOverrides } = useMusicExportPreferences(storageKey);
  const [job, setJob] = useState<Job>();
  const [error, setError] = useState("");
  const [downloads, setDownloads] = useState<Partial<Record<"audio" | "video", string>>>({});
  const [starting, setStarting] = useState(false);
  const [editions, setEditions] = useState<Array<{ kind: string; edition: string; createdAt: string; musicTitle: string; url: string }>>([]);
  const revision = useRef(0);
  const jobRevision = useRef(0);
  const base = `/stories/${slug}/summaries/${summary.id}`;
  useEffect(() => {
    let cancelled = false;
    void api<{ editions: typeof editions }>(`${base}/music-exports`).then((value) => { if (!cancelled) setEditions(value.editions ?? []); }).catch((cause) => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [base, job?.status]);
  useEffect(() => {
    revision.current++; setDownloads({});
  }, [base, JSON.stringify(music), JSON.stringify(overrides), summary.audio?.outputFingerprint, summary.video?.outputFingerprint]);
  useEffect(() => () => { revision.current++; }, []);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    const timer = window.setTimeout(() => {
      void api<Job>(`/jobs/${job.id}`).then(setJob).catch((cause) => { setError(String(cause)); setJob(undefined); });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [job]);
  const run = async (kind: "audio" | "video") => {
    const generation = revision.current;
    try {
      setStarting(true); setError("");
      if (music.mode === "none") { setDownloads((current) => ({ ...current, [kind]: `/api${base}/export/${kind}?download=1` })); return; }
      const created = await post<Job>(`${base}/music-export`, { kind, music, musicOverrides: overrides });
      onJob?.(created);
      if (generation !== revision.current) return;
      jobRevision.current = generation; setJob(created);
    } catch (cause) { setError(String(cause)); }
    finally { setStarting(false); }
  };
  useEffect(() => {
    if (job?.status === "failed") setError(job.error ?? "Summary music export failed");
    if (job?.status === "completed" && jobRevision.current === revision.current) {
      const result = job.result as { edition?: string; manifest?: { kind?: string } } | undefined;
      const kind = result?.manifest?.kind;
      if (result?.edition && (kind === "audio" || kind === "video")) setDownloads((current) => ({ ...current, [kind]: `/api${base}/${kind}-exports/${result.edition}.${kind === "audio" ? "mp3" : "mp4"}` }));
    }
  }, [job, base]);
  const busy = disabled || starting || Boolean(job && ["queued", "running"].includes(job.status));
  return <section className="summary-media-editor"><h3>Summary music exports</h3><p>Create a listening or video edition with background music. Clean summary audio and video remain unchanged.</p>
    <BackgroundMusicControls slug={slug} summaryId={summary.id} selection={music} onSelectionChange={setMusic} overrides={overrides} onOverridesChange={setOverrides} />
    <div className="summary-visual-actions">{(["audio", "video"] as const).map((kind) => <span key={kind}><button className="button" disabled={busy || !summary[kind]?.outputFingerprint} onClick={() => void run(kind)}>Export summary {kind === "audio" ? "MP3" : "MP4"}</button>{downloads[kind] && <a className="button" download href={downloads[kind]}>Download {kind === "audio" ? "MP3" : "MP4"} edition</a>}{(!summary[kind]?.outputFingerprint || summary[kind]?.status === "stale" || summary[kind]?.status === "failed") && <p>{summary[kind]?.outputFingerprint ? "This edition uses older or failed inputs. You can export the retained media or update it first." : `Generate summary ${kind} before exporting.`}{onPrepare && <button className="button" disabled={busy} onClick={() => onPrepare(kind)}>{kind === "audio" ? (summary.audio?.outputFingerprint ? "Update audio" : "Generate audio") : "Open video setup"}</button>}</p>}</span>)}</div>
    {editions.length > 0 && <details><summary>Saved music editions</summary>{editions.map((edition) => <p key={`${edition.kind}-${edition.edition}`}><a className="button" download href={edition.url}>{edition.kind.toUpperCase()} · {edition.musicTitle}</a> <small>{new Date(edition.createdAt).toLocaleString()}</small></p>)}</details>}
    {(starting || Boolean(job && ["queued", "running"].includes(job.status))) && <p role="status">Building summary music export…</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
