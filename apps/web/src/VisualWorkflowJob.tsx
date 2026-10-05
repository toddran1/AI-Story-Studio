import { useEffect, useRef, useState } from "react";
import { api, post, type Job } from "./api.js";
export function useVisualWorkflowJob(slug: string, channel: string, onFinished?: (job: Job) => void) {
  const key = `visual-workflow:${slug}:${channel}`;
  const [record, setRecord] = useState<{ key: string; job: Job }>(); const job = record?.key === key ? record.job : undefined; const sequence = useRef(0); const [error, setError] = useState(""); const finished = useRef(""); const callback = useRef(onFinished); callback.current = onFinished;
  useEffect(() => { let active = true; const request = ++sequence.current; setRecord(undefined); setError(""); const id = localStorage.getItem(key); if (id && /^[a-f0-9-]{36}$/.test(id)) api<Job>(`/jobs/${id}`).then(job => { if (active && request === sequence.current && job.story === slug && job.type === "visualWorkflow") setRecord({ key, job }); }).catch(error => { if (active) setError(String(error)); }); return () => { active = false; }; }, [key, slug]);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    let active = true; let timer: ReturnType<typeof setTimeout> | undefined; let source: EventSource | undefined;
    const update = (next: Job) => { if (active && next.id === job.id) setRecord({ key, job: next }); };
    const poll = async () => { try { update(await api<Job>(`/jobs/${job.id}`)); } catch (error) { if (active) setError(String(error)); } if (active) timer = setTimeout(poll, 2000); };
    if (typeof EventSource !== "undefined") { source = new EventSource(`/api/jobs/${job.id}/events`); source.addEventListener("job", event => { try { update(JSON.parse((event as MessageEvent).data)); } catch { setError("Unreadable job update."); } }); source.onerror = () => { source?.close(); if (!timer) void poll(); }; }
    else void poll();
    return () => { active = false; source?.close(); if (timer) clearTimeout(timer); };
  }, [job?.id, job?.status]);
  useEffect(() => { if (job && !["queued", "running"].includes(job.status) && finished.current !== job.id) { finished.current = job.id; callback.current?.(job); } }, [job]);
  const track = (next: Job) => { sequence.current++; localStorage.setItem(key, next.id); setError(""); setRecord({ key, job: next }); };
  return { job, track, error, active: !!job && ["queued", "running"].includes(job.status) };
}
export function VisualWorkflowJob({ job, error, onRetry }: { job?: Job; error?: string; onRetry?: (job: Job) => void }) {
  const [stopping, setStopping] = useState(false); const [actionError, setActionError] = useState("");
  useEffect(() => { setStopping(false); setActionError(""); }, [job?.id]);
  const outcomes = (job?.result?.outcomes ?? job?.progress?.outcomes ?? []) as Array<{ key: string; status: string; error?: string }>;
  return <div className="visual-workflow-job">{error && <p role="alert">{error}</p>}{job && <><p role="status">{job.status} · {job.progress?.label ?? "Visual work"} {job.progress?.index && `(${job.progress.index} of ${job.progress.total})`}</p>{job.progress?.total && <progress value={job.status === "completed" ? job.progress.total : outcomes.length} max={job.progress.total} />}{job.error && <p role="alert">{job.error}</p>}<ul>{outcomes.filter(item => item.error).map(item => <li key={item.key}>{item.error}</li>)}</ul>{["queued", "running"].includes(job.status) && <button type="button" disabled={stopping} onClick={async () => { try { await post(`/jobs/${job.id}/pause`, {}); setStopping(true); } catch (error) { setActionError(String(error)); } }}>{stopping ? "Stopping after current item…" : "Stop after current item"}</button>}{onRetry && (["failed", "paused"].includes(job.status) || outcomes.some(item => item.status === "failed")) && <button type="button" onClick={() => onRetry(job)}>Preview remaining work</button>}</>}{actionError && <p role="alert">{actionError}</p>}</div>;
}
export function VisualCostPreview({ plan }: { plan: { imageCount: number; estimatedCostUsd?: number; costNote: string; provider: string; model: string } }) {
  return <p>{plan.imageCount} new images · {plan.provider} / {plan.model} · {plan.estimatedCostUsd === undefined ? "Cost unavailable for this model" : `Estimated output cost $${plan.estimatedCostUsd.toFixed(3)}`}<small>{plan.costNote}</small></p>;
}
