import type { ImageDraftOutcome } from "../../../src/scenes/image-workbench.js";
import { parseImageChapterSelection } from "../../../src/scenes/chapter-selection.js";
import { useEffect, useRef, useState } from "react";
import { api, post, type Job } from "./api.js";
import { VisualWorkflowJob, useVisualWorkflowJob } from "./VisualWorkflowJob.js";
import { referenceUrl } from "./visual-workflow.js";
import type { StudioOperations } from "../../server/operations.js";
import "./image-workbench.css";
type Board = Awaited<ReturnType<StudioOperations["imageStoryboard"]>>;
type DraftReport = { status?: string; reservedUsd?: number; requests?: number; outcomes?: ImageDraftOutcome[]; updatedAt?: string; config?: { budgetUsd: number; maxRequests: number }; scope?: { chapters: number[]; summaryId?: string } };
type Plan = Awaited<ReturnType<StudioOperations["planImageAutomation"]>>;
const time = (s: number) => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;
export function ImageWorkbench({ slug, chapter, summaryId, disabled = false, onRefresh }: { slug: string; chapter?: number; summaryId?: string; disabled?: boolean; onRefresh?: () => void }) {
  const [pageOffset,setPageOffset] = useState(0);
  const [open,setOpen] = useState(false); const [chapters,setChapters] = useState(String(chapter ?? 1)); const [board,setBoard] = useState<Board>();
  const [plan,setPlan] = useState<Plan>(); const [error,setError] = useState(""); const [busy,setBusy] = useState(false); const [exceptions,setExceptions] = useState(false); const [mode,setMode] = useState<"storyboard"|"timeline">("storyboard");
  const [config,setConfig] = useState({ budgetUsd: 10, maxRequests: 50, maxRepairs: 1, imageAllowanceUsd: 1, checkAllowanceUsd: .25, planningAllowanceUsd: .5, planMissingScenes: true, draftMissingProfiles: true });
  const [repair,setRepair] = useState<Record<string,string>>({}); const [report,setReport] = useState<DraftReport>();
  const identity = `${slug}:${chapter ?? ""}:${summaryId ?? ""}`;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const request = useRef(0);
  const scope = () => summaryId ? { chapters: [], summaryId } : { chapters: parseImageChapterSelection(chapters) };
  const endpoint = `/stories/${encodeURIComponent(slug)}/visual-workflow/images`;
  const reload = async (selectedScope?: { chapters: number[]; summaryId?: string }, offset = pageOffset) => {
    const current = ++request.current; setBusy(true); setError("");
    const valid = () => currentIdentity.current === identity && current === request.current;
    try {
      const result = await post<Board>(`${endpoint}/storyboard`, { ...(selectedScope ?? scope()), offset, limit: 40 });
      if (!valid()) return;
      setBoard(result); setPageOffset(result.offset);
      const latestReport = await api<DraftReport>(`${endpoint}/report`);
      if (valid()) setReport(latestReport);
    } catch (error) { if (valid()) setError(String(error)); }
    finally { if (valid()) setBusy(false); }
  };
  const work = useVisualWorkflowJob(slug, `image-draft:${chapter ?? summaryId}`, () => { void reload(); onRefresh?.(); setPlan(undefined); });
  useEffect(()=>{request.current++;setChapters(String(chapter??1));setBoard(undefined);setPlan(undefined);setRepair({});setBusy(false);setError("");setReport(undefined);setPageOffset(0);},[slug,chapter,summaryId]);
  useEffect(()=>{if(open)void reload(summaryId ? { chapters: [], summaryId } : { chapters: [chapter ?? 1] }, 0);return ()=>{request.current++;};},[open,slug,chapter,summaryId]);
  const pending=busy||work.active||disabled;
  const preview = async () => {
    setBusy(true); setError("");
    try { const result = await post<Plan>(`${endpoint}/plan`, { scope: scope(), ...config }); if (currentIdentity.current === identity) setPlan(result); }
    catch (error) { if (currentIdentity.current === identity) setError(String(error)); }
    finally { if (currentIdentity.current === identity) setBusy(false); }
  };
  const start = async () => {
    if (!plan) return;
    setBusy(true); setError("");
    try { const job = await post<Job>(`${endpoint}/start`, { ...plan.input, planFingerprint: plan.fingerprint }); if (currentIdentity.current === identity) { work.track(job); setPlan(undefined); } }
    catch (error) { if (currentIdentity.current === identity) setError(String(error)); }
    finally { if (currentIdentity.current === identity) setBusy(false); }
  };
  const continueRun = async () => {
    if (!report?.updatedAt) return;
    setBusy(true); setError("");
    try {
      const job = await post<Job>(`${endpoint}/continue`, { reportUpdatedAt: report.updatedAt });
      if (currentIdentity.current === identity) { work.track(job); setPlan(undefined); }
    } catch (error) {
      if (currentIdentity.current === identity) setError(String(error));
    } finally {
      if (currentIdentity.current === identity) setBusy(false);
    }
  };
  const remainingBudget = report?.config ? report.config.budgetUsd - (report.reservedUsd ?? 0) : 0;
  const remainingRequests = report?.config ? report.config.maxRequests - (report.requests ?? 0) : 0;
  const approveAndContinue = async (items: ImageDraftOutcome[]) => {
    setBusy(true); setError("");
    try {
      const job = await post<Job>(`${endpoint}/approve-references`, {
        selection: items.map(item => ({ entityId: item.entityId, referenceId: item.referenceId })),
        reportUpdatedAt: report?.updatedAt,
      });
      if (currentIdentity.current === identity) { work.track(job); setPlan(undefined); }
    } catch (error) {
      if (currentIdentity.current === identity) setError(String(error));
    } finally {
      if (currentIdentity.current === identity) setBusy(false);
    }
  };
  const rejectReference = async (items: Array<{ item: ImageDraftOutcome; feedback: string }>, regenerate: boolean, retryFailedOnly = false) => {
    setBusy(true); setError("");
    try {
      const job = await post<Job>(`${endpoint}/reject-references`, {
        selection: items.map(({ item, feedback }) => ({ entityId: item.entityId, referenceId: item.referenceId, feedback })),
        reportUpdatedAt: report?.updatedAt, regenerate, retryFailedOnly,
      });
      if (currentIdentity.current === identity) { work.track(job); setPlan(undefined); }
    } catch (error) {
      if (currentIdentity.current === identity) setError(String(error));
    } finally {
      if (currentIdentity.current === identity) setBusy(false);
    }
  };
  const rows=board?.rows.filter(r=>!exceptions||r.needsAttention)??[];
  return <details className="image-workbench" onToggle={e=>setOpen(e.currentTarget.open)}><summary>Image storyboard & continuity desk</summary>{open&&<div className="image-workbench-body">
    <header><div><h3>Review the chapter as a sequence.</h3><p>Compare frames, follow appearance changes, and resolve the exceptions.</p></div><button type="button" disabled={pending} onClick={()=>void reload()}>Refresh storyboard</button></header>
    {disabled&&<p role="status">Save your scene edits to use the image desk with the current narrative.</p>}
    {!summaryId&&<label>Chapters<input value={chapters} disabled={pending} onChange={e=>{request.current++;setChapters(e.target.value);setBoard(undefined);setPlan(undefined);setPageOffset(0);}} placeholder="1-5,8"/><button type="button" disabled={pending} onClick={()=>void reload()}>Load range</button></label>}
    <nav aria-label="Image desk views"><button type="button" aria-pressed={mode==="storyboard"} onClick={()=>setMode("storyboard")}>Contact sheet</button><button type="button" aria-pressed={mode==="timeline"} onClick={()=>setMode("timeline")}>Continuity timeline</button><label><input type="checkbox" checked={exceptions} onChange={e=>setExceptions(e.target.checked)}/> Exceptions only (this page)</label><button type="button" onClick={()=>window.print()}>Print visible frames</button></nav>
    <details className="image-automation"><summary>Automatic image draft</summary><p>Plan missing scenes, select references, generate missing or stale images, check continuity, and repair confirmed mismatches. Approved and manually accepted images are protected. Uncertain results remain for review.</p><div className="image-budget-fields">
      {([ ["budgetUsd","Reserved-cost limit ($)"],["maxRequests","Maximum provider requests"],["maxRepairs","Repairs per scene (0–3)"],["imageAllowanceUsd","Reserve per image attempt ($)"],["checkAllowanceUsd","Reserve per check ($)"],["planningAllowanceUsd","Reserve per planning attempt ($)"] ] as const).map(([key,label])=><label key={key}>{label}<input type="number" min={key==="maxRepairs"?0:key==="maxRequests"?1:.01} max={key==="maxRepairs"?3:undefined} step={key==="maxRepairs"||key==="maxRequests"?1:.01} value={config[key]} disabled={pending} onChange={e=>{setConfig(c=>({...c,[key]:Number(e.target.value)}));setPlan(undefined);}}/></label>)}
    </div><label><input type="checkbox" checked={config.draftMissingProfiles} disabled={pending} onChange={e=>{setConfig(c=>({...c,draftMissingProfiles:e.target.checked}));setPlan(undefined);}}/> Draft missing character and location profiles</label><label><input type="checkbox" checked={config.planMissingScenes} disabled={pending} onChange={e=>{setConfig(c=>({...c,planMissingScenes:e.target.checked}));setPlan(undefined);}}/> Plan scenes when a plan is missing</label><button type="button" disabled={pending} onClick={()=>void preview()}>Preview image run</button>
    {plan&&<div className="image-run-preview"><p>{plan.sceneCount} planned scenes · {plan.protectedCount} protected · {plan.minimumImages} known images to generate · {plan.missingPlans.length} missing scene plans</p>{plan.profileDrafts?.length > 0 && <p>Planned profile drafts and first reference sheets: {plan.profileDrafts.join(", ")}</p>}<ul>{plan.blocked.map((item,index)=><li key={index}>{item.label}: {item.reason}</li>)}</ul><p>{plan.provider} / {plan.model} · QA: {plan.qaProvider} / {plan.qaModel}</p><p>Reserve up to ${plan.budgetUsd.toFixed(2)} across at most {plan.maxRequests} provider attempts. Repair allowance: {plan.input.maxRepairs} per scene.</p><small>{plan.allowanceNote}</small><button type="button" disabled={pending} onClick={()=>void start()}>Start image draft</button></div>}
    </details><VisualWorkflowJob job={work.job} error={work.error}/>{report&&<p className="image-run-report">Last image run: {report.status?.replaceAll("_"," ")} · {report.requests??0} requests · ${(report.reservedUsd??0).toFixed(2)} reserved</p>}{report?.config && report.updatedAt && report.status !== "completed" && report.status !== "running" && <div className="image-run-report">
      <button type="button" disabled={pending || remainingBudget <= 0 || remainingRequests <= 0} onClick={() => void continueRun()}>Continue last image run</button>
      <p>{report.scope?.summaryId ? "Saved summary scope" : `Saved chapters: ${report.scope?.chapters.join(", ") ?? "—"}`} · {Math.max(0, remainingRequests)} requests and ${Math.max(0, remainingBudget).toFixed(2)} reserved budget remaining</p>
    </div>}{report?.outcomes && <ImageDraftExceptions slug={slug} outcomes={report.outcomes} disabled={pending || !report.updatedAt} onApprove={approveAndContinue} onReject={rejectReference} />}{error&&<p role="alert">{error}</p>}{busy&&<p role="status">Loading image work…</p>}
    {board?.missingPlans.map(s=><p key={s.label}>{s.label}: no scene plan. Use Automatic image draft to plan it.</p>)}
    {board && board.totalRows > board.limit && <nav aria-label="Storyboard pages"><button type="button" disabled={pending || board.offset === 0} onClick={() => void reload(undefined, Math.max(0,board.offset-board.limit))}>Previous frames</button><span>{board.offset+1}–{board.offset+board.rows.length} of {board.totalRows} frames</span><button type="button" disabled={pending || !board.hasMore} onClick={() => void reload(undefined,board.offset+board.limit)}>Next frames</button></nav>}
    <div className={mode==="storyboard"?"image-contact-sheet":"image-continuity-timeline"}>{rows.map(row=><article key={row.key} className={`image-frame image-frame-${row.status}`}><header><span>{row.label} · {row.scene.id}</span><strong>{row.status.replaceAll("_"," ")}{row.protected?" · protected":""}</strong></header>
      <div className="image-frame-visual">{row.imageUrl?<a href={row.imageUrl} target="_blank" rel="noreferrer"><img src={row.imageUrl} alt={row.scene.summary} loading="lazy"/></a>:<p>No frame generated</p>}<span>{time(row.scene.startSeconds)}—{time(row.scene.endSeconds)}{row.scene.sequence?` · ${row.scene.sequence.id} / ${row.scene.sequence.beat}`:""}</span></div>
      <h4>{row.scene.summary}</h4><blockquote>{row.scene.narrationText??"Narration span not recorded. Replan to bind this frame to its passage."}</blockquote>{row.imageError&&<p role="alert">{row.imageError}</p>}
      {row.flags.length>0&&<ul className="image-frame-flags">{row.flags.map((f,i)=><li key={i}>{f.message}</li>)}</ul>}
      <details open={mode==="timeline"}><summary>Why this appearance?</summary>{row.facts.length?<dl>{row.facts.map((f,i)=><div key={i}><dt>{f.subject} · {f.field.replace(/([A-Z])/g," $1")}</dt><dd>{Array.isArray(f.value)?f.value.join(", ") || "None":String(f.value)}<small>{f.source}{f.inheritedFrom?` · ${f.inheritedFrom}`:""}</small>{f.passage&&<details><summary>Source passage</summary><q>{f.passage}</q></details>}</dd></div>)}</dl>:<p>No explicit continuity facts recorded; the narrative and approved identity guide this frame.</p>}{row.scene.sequence?.positions.map(p=><p key={p.name}>{p.name}: {p.position}, facing {p.facing}{p.movement?` · ${p.movement}`:""}</p>)}</details>
      <details><summary>Selected references</summary><p>{row.references.mode} · {row.references.loadedReferenceIds.length} reference images selected</p><div className="image-selected-refs">{row.references.loadedReferences.map((r,i)=>r.entityId&&r.referenceId?<a key={i} href={referenceUrl(slug,r.entityId,r.referenceId)} target="_blank" rel="noreferrer"><img src={referenceUrl(slug,r.entityId,r.referenceId)} alt={`Selected reference ${i+1}`} loading="lazy"/></a>:null)}</div><ul>{row.references.decisions.map(decision => <li key={`${decision.entityId}:${decision.referenceId}`}>{decision.referenceId}: {decision.selected ? "Selected" : decision.eligible ? "Available; limited by image budget" : "Excluded"} · {decision.reason}</li>)}</ul></details>
      {row.check?.check&&<details><summary>Image continuity findings</summary><p>{row.check.check.summary}</p><dl>{Object.entries(row.check.check).filter(([,v])=>typeof v==="object"&&v&&"status" in v).map(([k,v])=><div key={k}><dt>{k.replace(/([A-Z])/g," $1")}</dt><dd>{(v as {status:string;observation:string}).status}: {(v as {status:string;observation:string}).observation}</dd></div>)}</dl></details>}
      {row.candidate && <details><summary>Replacement candidate {row.candidate.id} · awaiting review</summary><a href={row.candidate.imageUrl} target="_blank" rel="noreferrer"><img className="image-repair-candidate" src={row.candidate.imageUrl} alt={`Replacement candidate for ${row.scene.summary}`} loading="lazy" /></a><p>The current approved frame remains selected. Compare this candidate in the scene’s version selector before approving a replacement.</p></details>}
      {row.versionId&&<details><summary>Repair this frame</summary><p>Creates a new version from {row.versionId}. Approved production artwork stays selected.</p><label>Correction<textarea maxLength={2000} value={repair[row.key]??""} placeholder="Remove the sword; preserve the face, outfit and composition." onChange={e=>setRepair(r=>({...r,[row.key]:e.target.value}))}/></label><button type="button" disabled={pending||!repair[row.key]?.trim()} onClick={async()=>{setBusy(true);setError("");try{const check = row.check ?? await post<{ sourceFingerprint: string }>(`${endpoint.replace(/\/images$/, "")}/check/inspect`, { ...row.target, versionId: row.versionId }); if (currentIdentity.current !== identity) return; const sourceFingerprint = check.sourceFingerprint; if(!sourceFingerprint)throw new Error("Refresh the storyboard to fingerprint this repair source.");const job = await post<Job>(`${endpoint}/repair`,{target:row.target,repair:{sourceVersionId:row.versionId,instruction:repair[row.key]},sourceFingerprint}); if (currentIdentity.current === identity) work.track(job);}catch(e){if (currentIdentity.current === identity) setError(String(e));}finally{if (currentIdentity.current === identity) setBusy(false);}}}>Generate repaired version</button></details>}
    </article>)}</div>{board&&rows.length===0&&<p>No scenes in this view.</p>}
  </div>}</details>;
}

function ImageDraftExceptions({ slug, outcomes, disabled, onApprove, onReject }: { slug: string; outcomes: ImageDraftOutcome[]; disabled: boolean; onApprove: (items: ImageDraftOutcome[]) => Promise<void>; onReject: (items: Array<{ item: ImageDraftOutcome; feedback: string }>, regenerate: boolean, retryFailedOnly?: boolean) => Promise<void> }) {
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const eligible = outcomes.filter(item => item.entityId && ["profile_review", "reference_rejected", "reference_failed", "reference_pending"].includes(item.status));
  const selection = eligible.filter(item => selected.includes(item.entityId!));
  const failed = eligible.filter(item => ["reference_failed", "reference_pending"].includes(item.status));
  const retrySelection = selection.filter(item => ["reference_failed", "reference_pending"].includes(item.status));
  const approvalSelection = selection.filter(item => item.status === "profile_review");
  const groups = new Map<string, ImageDraftOutcome[]>();
  for (const outcome of outcomes) {
    if (outcome.status === "ready" || outcome.status === "running") continue;
    const reason = outcome.error ?? outcome.status.replaceAll("_", " ");
    groups.set(reason, [...(groups.get(reason) ?? []), outcome]);
  }
  if (!groups.size) return null;
  return <details className="image-run-report" open>
    <summary>Review queue from the last image run</summary>
    <p>Approve a first sheet here to approve its drafted profile and continue the waiting scenes using the remaining run budget. Open the profile name to inspect or edit its details first.</p>
    {eligible.length > 0 && <div>
      <label><input type="checkbox" disabled={disabled} checked={selection.length === eligible.length} onChange={event => setSelected(event.target.checked ? eligible.map(item => item.entityId!) : [])} /> Select all reviewable sheets</label>
      <button type="button" disabled={disabled || !approvalSelection.length} onClick={() => void onApprove(approvalSelection)}>Approve selected ({approvalSelection.length}) & continue waiting scenes</button>
      <button type="button" disabled={disabled || !selection.length} onClick={() => void onReject(selection.map(item => ({ item, feedback: feedback[item.entityId!] ?? item.feedback ?? "" })), true)}>Reject & regenerate selected ({selection.length})</button>
      {failed.length > 0 && <button type="button" disabled={disabled} onClick={() => setSelected(failed.map(item => item.entityId!))}>Select failed sheets ({failed.length})</button>}
      <button type="button" disabled={disabled || !retrySelection.length} onClick={() => void onReject(retrySelection.map(item => ({ item, feedback: feedback[item.entityId!] ?? item.feedback ?? "" })), true, true)}>Retry selected failed sheets ({retrySelection.length})</button>
    </div>}
    {[...groups].map(([reason, items]) => <section key={reason}>
      <p>{reason}</p>
      <ul>{items.map((item, index) => <li key={index}>
        {item.entityId && ["profile_review", "reference_rejected", "reference_failed", "reference_pending"].includes(item.status) && <label><input type="checkbox" disabled={disabled} aria-label={`Select reference for ${item.key}`} checked={selected.includes(item.entityId)} onChange={event => setSelected(current => event.target.checked ? [...new Set([...current, item.entityId!])] : current.filter(id => id !== item.entityId))} /> Select sheet</label>}
        {item.entityId
        ? <a href={`/stories/${encodeURIComponent(slug)}/bible?entity=${encodeURIComponent(item.entityId)}&section=visual-canon`}>{item.key}</a>
        : item.key}
        {item.entityId && item.referenceId && <div><a href={referenceUrl(slug, item.entityId, item.referenceId)} target="_blank" rel="noreferrer"><img width="140" loading="lazy" alt={`First reference sheet for ${item.key}`} src={referenceUrl(slug, item.entityId, item.referenceId)} /></a></div>}
        {item.entityId && item.referenceId && item.status === "profile_review" && <button type="button" disabled={disabled} onClick={() => void onApprove([item])}>Approve profile & sheet, continue scenes</button>}
        {item.entityId && ["profile_review", "reference_rejected", "reference_failed", "reference_pending"].includes(item.status) && <div>
          <label>Optional feedback for the replacement sheet<textarea maxLength={2000} disabled={disabled} value={feedback[item.entityId] ?? item.feedback ?? ""} onChange={event => setFeedback(current => ({ ...current, [item.entityId!]: event.target.value }))} placeholder="For example, keep the face but change the coat to blue." /></label>
          {item.status === "profile_review" && <button type="button" disabled={disabled} onClick={() => void onReject([{ item, feedback: feedback[item.entityId!] ?? item.feedback ?? "" }], false)}>Reject sheet</button>}
          <button type="button" disabled={disabled} onClick={() => void onReject([{ item, feedback: feedback[item.entityId!] ?? item.feedback ?? "" }], true, ["reference_failed", "reference_pending"].includes(item.status))}>{item.status === "reference_rejected" ? "Generate replacement" : ["reference_failed", "reference_pending"].includes(item.status) ? "Retry failed sheet" : "Reject & regenerate"}</button>
        </div>}
      </li>)}</ul>
    </section>)}
  </details>;
}
