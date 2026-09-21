import { useEffect, useRef, useState } from "react";
import { formatChapterSelection, parseChapterSelection } from "../../../src/batch/range.js";
import { BATCH_STAGES, STAGE_SELECTION_PRESETS, type BatchStage } from "../../../src/studio/stage-selection.js";
import type { StageExecutionBatchPlan, StageExecutionMode } from "../../../src/studio/stage-execution.js";
import { post, type Job } from "./api.js";
import { pretty } from "./format.js";

type WatchJob = (id: string, onUpdate: (job: Job) => void | Promise<void>, onError: (error: unknown) => void) => () => void;
type Props = {
  slug: string;
  selectedChapters: number[];
  onSelectionChange: (chapters: number[]) => void;
  onSelectVisible: () => void;
  onSelectMatching: () => void;
  onSelectAll: () => void;
  onJob: (job: Job) => void;
  watchJob: WatchJob;
};

const stageGroups: Array<{ label: string; stages: BatchStage[] }> = [
  { label: "Text", stages: ["translation", "narration", "qa", "storyBible", "continuity"] },
  { label: "Audio", stages: ["tts", "audioMastering", "alignment", "subtitles"] },
  { label: "Visual", stages: ["scenePlanning", "artwork", "video"] },
];
const presetLabels: Record<keyof typeof STAGE_SELECTION_PRESETS, string> = { coreText: "Core text", narrationQa: "Narration + QA", audio: "Audio", visuals: "Visuals" };

export function toggleStageSelection(current: readonly BatchStage[], stage: BatchStage): BatchStage[] {
  return current.includes(stage) ? current.filter((item) => item !== stage) : BATCH_STAGES.filter((item) => item === stage || current.includes(item));
}
export function applyStagePreset(key: keyof typeof STAGE_SELECTION_PRESETS): BatchStage[] { return [...STAGE_SELECTION_PRESETS[key]]; }

export function BatchProcessingPanel(props: Props) {
  const [expression, setExpression] = useState(() => formatChapterSelection(props.selectedChapters));
  const [editingExpression, setEditingExpression] = useState(false);
  const [stages, setStages] = useState<BatchStage[]>(applyStagePreset("narrationQa"));
  const [mode, setMode] = useState<StageExecutionMode>("selected");
  const [force, setForce] = useState(false);
  const [continueOnError, setContinueOnError] = useState(false);
  const [preview, setPreview] = useState<StageExecutionBatchPlan>();
  const [error, setError] = useState("");
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [activeJob, setActiveJob] = useState<Job>();
  const [result, setResult] = useState<any>();
  const watcher = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => watcher.current?.(), []);
  useEffect(() => { if (!editingExpression) setExpression(formatChapterSelection(props.selectedChapters)); }, [props.selectedChapters, editingExpression]);
  useEffect(() => { setPreview(undefined); setResult(undefined); }, [props.selectedChapters, stages, mode, force, continueOnError]);

  const updateExpression = (value: string) => {
    setExpression(value); setPreview(undefined); setResult(undefined);
    try { const chapters = parseChapterSelection(value); setError(""); props.onSelectionChange(chapters); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
  };
  const chooseChapters = (action: () => void) => { setEditingExpression(false); setError(""); action(); };
  const request = () => ({ chapters: props.selectedChapters, stages, mode, force, continueOnError });
  const createPreview = async () => {
    try { setPlanning(true); setError(""); setResult(undefined); setPreview(await post<StageExecutionBatchPlan>(`/stories/${props.slug}/stages/plan`, { ...request(), dryRun: true })); }
    catch (value) { setPreview(undefined); setError(value instanceof Error ? value.message : String(value)); }
    finally { setPlanning(false); }
  };
  const run = async () => {
    if (!preview) return;
    try {
      setRunning(true); setError(""); setResult(undefined);
      const job = await post<Job>(`/stories/${props.slug}/stages/run`, { ...request(), expectedPlanFingerprint: preview.fingerprint });
      props.onJob(job); setActiveJob(job); watcher.current?.();
      watcher.current = props.watchJob(job.id, (next) => {
        props.onJob(next); setActiveJob(next);
        if (next.status === "completed") { setRunning(false); setResult(next.result); setPreview(undefined); setActiveJob(undefined); }
        else if (next.status === "failed") { setRunning(false); setError(next.error ?? "Stage execution failed"); setActiveJob(undefined); }
      }, (value) => { setRunning(false); setError(value instanceof Error ? value.message : String(value)); });
    } catch (value) { setRunning(false); setError(value instanceof Error ? value.message : String(value)); }
  };
  const canPreview = props.selectedChapters.length > 0 && stages.length > 0 && !error && !planning && !running;
  const canRun = Boolean(preview && preview.summary.blockedOperations === 0 && !running);

  return <section className="batch-workspace" aria-labelledby="batch-workspace-title">
    <header className="batch-workspace-header"><div><span className="eyebrow">Chapter dispatch</span><h3 id="batch-workspace-title">Plan a precise batch</h3><p>Choose exact chapters and stages. Preview is required before any provider work begins.</p></div><div className="batch-count"><b>{props.selectedChapters.length}</b><span>chapters selected</span></div></header>
    <div className="batch-builder">
      <section className="batch-builder-block chapter-set-block"><div className="batch-step"><span>01</span><div><b>Chapter set</b><small>Comma-separated numbers and ranges</small></div></div><label><span className="sr-only">Chapter set</span><input value={expression} placeholder="5, 10, 13, 40-50" onFocus={() => setEditingExpression(true)} onBlur={() => { setEditingExpression(false); if (!error) setExpression(formatChapterSelection(props.selectedChapters)); }} onChange={(event) => updateExpression(event.target.value)} /></label><div className="selection-shortcuts"><button type="button" onClick={() => chooseChapters(props.onSelectVisible)}>Visible page</button><button type="button" onClick={() => chooseChapters(props.onSelectMatching)}>Matching filter</button><button type="button" onClick={() => chooseChapters(props.onSelectAll)}>All chapters</button><button type="button" onClick={() => chooseChapters(() => props.onSelectionChange([]))}>Clear</button></div></section>
      <section className="batch-builder-block stage-set-block"><div className="batch-step"><span>02</span><div><b>Stages</b><small>Select one or more outputs</small></div></div><div className="stage-presets" aria-label="Stage presets">{(Object.keys(STAGE_SELECTION_PRESETS) as Array<keyof typeof STAGE_SELECTION_PRESETS>).map((key) => <button type="button" key={key} onClick={() => setStages(applyStagePreset(key))}>{presetLabels[key]}</button>)}</div><div className="stage-groups">{stageGroups.map((group) => <div key={group.label}><span>{group.label}</span><div>{group.stages.map((stage) => <button type="button" className={stages.includes(stage) ? "selected" : ""} aria-pressed={stages.includes(stage)} key={stage} onClick={() => setStages((current) => toggleStageSelection(current, stage))}>{pretty(stage)}</button>)}</div></div>)}</div></section>
      <section className="batch-builder-block execution-block"><div className="batch-step"><span>03</span><div><b>Execution rule</b><small>Control prerequisite behavior</small></div></div><div className="mode-cards"><label className={mode === "selected" ? "selected" : ""}><input type="radio" name="batch-mode" checked={mode === "selected"} onChange={() => setMode("selected")} /><b>Selected stages only</b><small>Run exactly the selected stages. Missing prerequisites block the affected work.</small></label><label className={mode === "prerequisites" ? "selected" : ""}><input type="radio" name="batch-mode" checked={mode === "prerequisites"} onChange={() => setMode("prerequisites")} /><b>Selected stages + prerequisites</b><small>Add only missing prerequisites. Existing current or stale artifacts are reused.</small></label></div><div className="batch-toggles"><label><input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} /><span><b>Regenerate selected stages</b><small>Otherwise usable selected artifacts are reused.</small></span></label><label><input type="checkbox" checked={continueOnError} onChange={(event) => setContinueOnError(event.target.checked)} /><span><b>Continue past failures</b><small>Failed chapters remain visible for review.</small></span></label></div></section>
    </div>
    {error && <div className="batch-inline-error" role="alert">{error}</div>}
    <div className="batch-command-bar"><div><span className={preview ? "ready" : ""} />{preview ? `Plan ${preview.fingerprint.slice(0, 8)} ready` : "Preview required"}</div><button className="button" disabled={!canPreview} onClick={() => void createPreview()}>{planning ? "Planning…" : "Preview execution"}</button><button className="button primary" disabled={!canRun} onClick={() => void run()}>{running ? "Running…" : preview ? `Run ${preview.summary.operationCount} operation${preview.summary.operationCount === 1 ? "" : "s"}` : "Run batch"}</button></div>
    {preview && <ExecutionPreview preview={preview} />}
    {activeJob && <ActiveRun job={activeJob} operationCount={preview?.summary.operationCount ?? 0} />}
    {result && <CompletionSummary result={result} />}
  </section>;
}

function ExecutionPreview({ preview }: { preview: StageExecutionBatchPlan }) {
  const counts = preview.summary.providerOperations;
  return <section className="execution-preview" aria-live="polite"><header><div><span className="eyebrow">Execution preview</span><b>{preview.summary.operationCount} planned · {preview.summary.reusedCount} reused · {preview.summary.blockedOperations} blocked</b></div><div className="provider-tally"><span>LLM <b>{counts.llm}</b></span><span>TTS <b>{counts.tts}</b></span><span>Images <b>{counts.images}</b></span></div></header>{preview.summary.addedPrerequisites.length > 0 && <p className="prerequisite-note">Added prerequisites: {preview.summary.addedPrerequisites.map(pretty).join(", ")}</p>}{preview.summary.blockedOperations > 0 && <p className="blocked-note">This plan cannot run until blocked prerequisites are supplied or “Add prerequisites” is selected.</p>}<div className="execution-ledger"><div className="execution-ledger-head"><span>Chapter</span><span>Run</span><span>Reuse</span><span>Blocked</span></div>{preview.chapters.map((chapter) => <div className="execution-ledger-row" key={chapter.chapter}><strong>Ch. {String(chapter.chapter).padStart(4, "0")}</strong><StageList entries={chapter.entries.filter((item) => item.action.endsWith("run"))} /><StageList entries={chapter.entries.filter((item) => item.action === "reuse")} /><StageList entries={chapter.entries.filter((item) => item.action === "blocked")} blocked /></div>)}</div></section>;
}
function StageList({ entries, blocked = false }: { entries: StageExecutionBatchPlan["chapters"][number]["entries"]; blocked?: boolean }) { return <div className={blocked ? "stage-list blocked" : "stage-list"}>{entries.length ? entries.map((entry) => <span title={entry.reason} key={entry.stage}>{pretty(entry.stage)}</span>) : <i>—</i>}</div>; }
function ActiveRun({ job, operationCount }: { job: Job; operationCount: number }) { const progress = job.progress ?? {}; return <div className="batch-active-run" role="status"><div><span className="batch-run-pulse" /><b>Processing</b><small>{operationCount} planned operations</small></div><span>{progress.chapter ? `Chapter ${progress.chapter}` : "Preparing batch"}{progress.event?.stage ? ` · ${pretty(progress.event.stage)}` : ""}</span><small>Live details are also available in the job console.</small></div>; }
function CompletionSummary({ result }: { result: any }) { const summary = result.summary ?? {}; return <div className="batch-completion" role="status"><b>Batch complete</b><span>{summary.completedChapters ?? 0} chapters processed · {summary.completedOperations ?? 0} operations completed · {summary.reusedCount ?? 0} artifacts reused · {summary.blockedChapters ?? 0} blocked · {summary.failedChapters ?? 0} failed</span></div>; }
