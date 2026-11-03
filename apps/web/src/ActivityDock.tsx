import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Job, isTerminalJob } from "./api.js";
import { scopeIncludesChapter } from "../../../src/storage/operation-scope.js";
import "./activity-dock.css";
export function useActivityJobs(initial?: Job) {
  const [jobs, setJobs] = useState<Job[]>(initial ? [initial] : []);
  const records = useRef(new Map<string, Job>(initial ? [[initial.id, initial]] : []));
  const [error, setError] = useState("");
  const startedAt = useRef(Date.now());
  const update = useCallback((next: Job) => {
    const previous = records.current.get(next.id);
    const previousTime = Date.parse(previous?.updatedAt ?? ""), nextTime = Date.parse(next.updatedAt ?? "");
    if (Number.isFinite(previousTime) && Number.isFinite(nextTime) && nextTime < previousTime) return;
    // Queue resume keeps the same job ID. Accept a newer resumed state while
    // ignoring delayed progress from before a terminal notification.
    if (previous && isTerminalJob(previous) && !isTerminalJob(next) && !(nextTime > previousTime)) return;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    records.current.set(next.id, next);
    if (records.current.size > 200) for (const [id, value] of records.current) { if (records.current.size <= 200) break; if (isTerminalJob(value) && id !== next.id) records.current.delete(id); }
    setJobs([...records.current.values()]);
    if (isTerminalJob(next) && previous && !isTerminalJob(previous)) window.dispatchEvent(new CustomEvent("studio:job-finished", { detail: next }));
  }, []);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await api<{ jobs: Job[] }>("/jobs"); if (!active) return;
        for (const job of value.jobs) if (!isTerminalJob(job) || job.status === "paused" || records.current.has(job.id) || Date.parse(job.createdAt ?? "") >= startedAt.current) update(job);
        setError("");
      } catch (value) { if (active) setError(value instanceof Error ? value.message : String(value)); }
      if (active) timer = setTimeout(poll, 2000);
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [update]);
  return { jobs, update, error };
}
export function useActivityRefresh(story: string, onFinished: (job: Job) => void) {
  const callback = useRef(onFinished); callback.current = onFinished;
  useEffect(() => { const finished = (event: Event) => { const job = (event as CustomEvent<Job>).detail; if (job.story === story) callback.current(job); }; window.addEventListener("studio:job-finished", finished); return () => window.removeEventListener("studio:job-finished", finished); }, [story]);
}
export function activityJobForChapter(jobs: Job[], story?: string, chapter?: number) {
  return jobs.find(job => job.story === story && !isTerminalJob(job) && (chapter === undefined || scopeIncludesChapter(job.scope, chapter)));
}
export function ActivityDock({ jobs, error, titles, renderJob }: { jobs: Job[]; error?: string; titles: Record<string, string>; renderJob: (job: Job, hide: () => void) => ReactNode }) {
  const [hidden, setHidden] = useState<string[]>(() => { try { const value: unknown = JSON.parse(localStorage.getItem("studio:hidden-activities") ?? "[]"); return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(-200) : []; } catch { return []; } });
  const [collapsed, setCollapsed] = useState(false);
  const changeHidden = (value: string[] | ((current: string[]) => string[])) => setHidden(current => {
    const ids = typeof value === "function" ? value(current) : value;
    try { localStorage.setItem("studio:hidden-activities", JSON.stringify(ids.slice(-200))); } catch { /* Hiding still works for this tab. */ }
    return ids;
  });
  const active = jobs.filter(job => !isTerminalJob(job));
  if (!jobs.length && !error) return null;
  return <section className="activity-dock" aria-label="Production activity">
    <header><button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>Activity · {active.length} active</button><button type="button" onClick={() => { changeHidden([]); setCollapsed(false); }}>Show all ({jobs.length})</button><button type="button" onClick={() => setCollapsed(true)} aria-label="Hide activity panel">Hide</button></header>
    {!collapsed && <div className="activity-dock-list">{error && <p role="alert">Activity connection interrupted: {error}. Retrying…</p>}{jobs.filter(job => !hidden.includes(job.id)).slice().sort((a, b) => Number(isTerminalJob(a)) - Number(isTerminalJob(b)) || (b.createdAt ?? "").localeCompare(a.createdAt ?? "")).map(job => <article key={job.id} className="activity-card"><div className="activity-location"><span>{titles[job.story] ?? job.story}</span><span>{job.scope?.chapters ? `Ch. ${job.scope.chapters.join(", ")}` : job.scope?.from ? `Ch. ${job.scope.from}–${job.scope.to ?? "end"}` : "Book activity"}</span></div>{renderJob(job, () => changeHidden(current => [...current, job.id]))}</article>)}{hidden.length > 0 && <p className="activity-hidden-note">Hidden activities keep running. Use Show all to restore them.</p>}</div>}
  </section>;
}
