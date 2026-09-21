import { useEffect, useRef, useState } from "react";
import { post, put, type Job, type StorySummary } from "./api.js";
import { estimateScenePacing } from "../../../src/scenes/pacing.js";
import { summaryAudioAvailable, summaryNarrationTextAvailable, summaryScenePlanAvailable } from "../../../src/summaries/types.js";
import type { Scene } from "../../../src/scenes/types.js";

export type SummaryVisualProps = { summary: StorySummary; base: string; disabled: boolean; onChange: (summary: StorySummary) => void;
  onGenerate: (job: Job) => void; onError: (error: unknown) => void };
function useActions(props: SummaryVisualProps) {
  const [pending, setPending] = useState(false); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (path: string, input: unknown, edit = false) => {
    setPending(true);
    try { if (edit) { const result = await put<{ summary: StorySummary }>(`${props.base}/${path}`, input); if (mounted.current) props.onChange(result.summary); }
      else { const job = await post<Job>(`${props.base}/${path}`, input); if (mounted.current) props.onGenerate(job); } }
    catch (error) { if (mounted.current) props.onError(error); } finally { if (mounted.current) setPending(false); }
  };
  return { run, disabled: props.disabled || pending, pending };
}
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function SummaryScenePanel(props: SummaryVisualProps) {
  const { summary } = props; const { run, disabled, pending } = useActions(props);
  const [pacing, setPacing] = useState(summary.scenePacing?.pacing ?? "automatic");
  const [custom, setCustom] = useState(summary.scenePacing?.secondsPerScene ? "seconds" : "count"); const [count, setCount] = useState(summary.scenePacing?.sceneCount ?? 14);
  const [seconds, setSeconds] = useState(summary.scenePacing?.secondsPerScene ?? 22);
  const [draft, setDraft] = useState<Scene[]>(structuredClone(summary.scenePlan?.scenes ?? []));
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setDraft(structuredClone(summary.scenePlan?.scenes ?? [])); setDirty(false); }, [summary.scenePlan, summary.id]);
  const input = { pacing, ...(pacing === "custom" ? custom === "count" ? { sceneCount: count } : { secondsPerScene: seconds } : {}) };
  const estimate = estimateScenePacing(summary.narration?.text ?? "", input, summary.audio?.status === "current" ? summary.audio.durationSeconds : undefined);
  const edit = (id: string, patch: Partial<Scene>) => { setDraft((scenes) => scenes.map((scene) => scene.id === id ? { ...scene, ...patch } : scene)); setDirty(true); };
  const move = (index: number, direction: number) => { const next = [...draft]; const target = index + direction; [next[index], next[target]] = [next[target]!, next[index]!]; setDraft(next); setDirty(true); };
  return <section className="summary-media-editor"><header><span className="eyebrow">Recap storyboard</span><h3>Scenes & timing</h3><p>Narration sets the beats. Canonical Story Bible identities guide the visuals.</p></header>
    <div className="summary-form-row"><label>Scene pacing<select value={pacing} onChange={(event) => setPacing(event.target.value as typeof pacing)}>{["automatic", "slow", "balanced", "fast", "custom"].map((value) => <option key={value} value={value}>{value[0]!.toUpperCase() + value.slice(1)}</option>)}</select></label>
      {pacing === "custom" && <><label>Custom target<select value={custom} onChange={(event) => setCustom(event.target.value)}><option value="count">Scene count</option><option value="seconds">Seconds per scene</option></select></label><label>{custom === "count" ? "Target scenes" : "Seconds per scene"}<input type="number" min={custom === "count" ? 1 : 3} max={custom === "count" ? 100 : 120} value={custom === "count" ? count : seconds} onChange={(event) => { const value = Math.max(custom === "count" ? 1 : 3, Math.min(custom === "count" ? 100 : 120, Number(event.target.value) || 1)); custom === "count" ? setCount(value) : setSeconds(value); }} /></label></>}</div>
    <div className="summary-meta"><span>{estimate.durationSource === "mastered-audio" ? "Audio" : "Estimated audio"}: {clock(estimate.durationSeconds)}</span><span>Target {estimate.sceneCount} scenes</span><span>Average ~{estimate.averageDurationSeconds.toFixed(1)} sec</span><span>{summary.scenes?.status ?? "Not generated"} · {summary.scenePlan?.timingMethod ?? "estimated"} timing</span></div>
    {summary.alignment?.warning && <p className="summary-media-warning">Estimated timing: {summary.alignment.warning}</p>}{summary.scenes?.error && <div className="error-box">{summary.scenes.error}</div>}
    {summary.narration?.status === "stale" && summaryNarrationTextAvailable(summary) && <p className="summary-media-warning">Using stale narration — scenes can still be generated from the existing narration; regenerate narration first only if you want the plan based on the latest changes.</p>}
    <div className="summary-visual-actions"><button className="button primary" disabled={disabled || !summaryNarrationTextAvailable(summary)} onClick={() => { if (!summary.scenePlan || confirm("Regenerate all scenes? Manual visual directions may be replaced; approved artwork is preserved for review.")) void run("scenes", { ...input, force: Boolean(summary.scenePlan) }); }}>{summary.scenePlan ? "Regenerate all scenes" : "Generate scenes"}</button>
      <button className="button" disabled={disabled || !summary.scenePlan || summary.audio?.status !== "current"} onClick={() => void run("scenes", { ...summary.scenePacing, force: false })}>Update timing</button>
      {summary.scenes?.status === "stale" && <button className="button" disabled={disabled || summary.narration?.status !== "current"} onClick={() => { if (confirm("Accept the existing scene visuals against the current narration and settings? Timing will be refreshed locally.")) void run("scenes", { acceptCurrent: true }, true); }}>Review / mark current</button>}
      <button className="button" disabled={disabled || !dirty} onClick={() => void run("scenes", { scenes: draft }, true)}>Save scene edits</button></div>
    {draft.map((scene, index) => <article className="summary-scene-card" key={scene.id}><header><span className="eyebrow">Scene {String(index + 1).padStart(2, "0")}</span><span>{clock(scene.startSeconds)}–{clock(scene.endSeconds)} · {scene.disabled ? "disabled" : summary.scenePlan?.timingMethod ?? "estimated"}</span></header>
      <blockquote>{scene.narrationText ?? scene.summary}</blockquote><label>Visual beat<input disabled={disabled} value={scene.summary} onChange={(event) => edit(scene.id, { summary: event.target.value })} /></label><label>Image prompt<textarea disabled={disabled} value={scene.visualPrompt} onChange={(event) => edit(scene.id, { visualPrompt: event.target.value })} /></label>
      <div className="summary-form-row"><label>Characters (comma separated)<input disabled={disabled} value={scene.characters.join(", ")} onChange={(event) => edit(scene.id, { characters: event.target.value.split(",").map((name) => name.trim()).filter(Boolean), entityIds: [] })} /></label><label>Location<input disabled={disabled} value={scene.location ?? ""} onChange={(event) => edit(scene.id, { location: event.target.value })} /></label></div>
      <div className="summary-form-row"><label>Start seconds<input disabled={disabled} type="number" step="0.1" min={0} value={scene.startSeconds} onChange={(event) => edit(scene.id, { startSeconds: Number(event.target.value) })} /></label><label>End seconds<input disabled={disabled} type="number" step="0.1" min={0} value={scene.endSeconds} onChange={(event) => edit(scene.id, { endSeconds: Number(event.target.value) })} /></label></div>
      <div className="summary-visual-actions"><button className="button" disabled={disabled || dirty} onClick={() => { if (confirm("Regenerate this scene’s visual direction?")) void run(`scenes/${scene.id}/regenerate`, {}); }}>Regenerate scene</button><button className="button" disabled={disabled || index === 0} onClick={() => move(index, -1)}>Move up</button><button className="button" disabled={disabled || index === draft.length - 1} onClick={() => move(index, 1)}>Move down</button><button className="button" disabled={disabled || (!scene.disabled && draft.filter((item) => !item.disabled).length === 1)} onClick={() => edit(scene.id, { disabled: !scene.disabled })}>{scene.disabled ? "Enable" : "Disable"}</button><button className="button" disabled={disabled || draft.length === 1} onClick={() => { if (confirm("Delete this visual beat and redistribute its narration coverage?")) { setDraft(draft.filter((item) => item.id !== scene.id)); setDirty(true); } }}>Delete scene</button></div>
      {summary.audio?.outputFingerprint && <audio controls preload="none" aria-label={`Preview ${scene.id} timing`} src={`/api${props.base}/export/audio#t=${scene.startSeconds},${scene.endSeconds}`} />}</article>)}
    {pending && <p role="status">Starting scene job…</p>}
  </section>;
}

export function SummaryArtworkPanel(props: SummaryVisualProps) {
  const { summary } = props; const { run, disabled } = useActions(props); const [selected, setSelected] = useState<string[]>([]);
  const scenes = summary.scenePlan?.scenes.filter((scene) => !scene.disabled) ?? [];
  const regenerate = (ids?: string[]) => { if (confirm("Regenerate artwork? Selected approved/manual images will be replaced.")) void run("artwork", { force: true, ...(ids ? { scenes: ids } : {}) }); };
  return <section className="summary-media-editor"><header><span className="eyebrow">Canonical visual continuity</span><h3>Scene artwork</h3><p>Uses this book’s image provider, style, and canonical visual references. Approved work is protected unless you explicitly regenerate it.</p></header>
    <div className="summary-meta"><span>{summary.artwork?.status ?? "Not generated"}</span><span>{scenes.length} enabled scenes</span></div>{summary.artwork?.error && <div className="error-box">{summary.artwork.error}</div>}
    {summary.scenes?.status === "stale" && scenes.length > 0 && <p className="summary-media-warning">The scene plan is stale — artwork will use the existing plan; regenerate scenes first only if you want artwork based on the latest narration.</p>}
    <div className="summary-visual-actions"><button className="button primary" disabled={disabled || !scenes.length} onClick={() => void run("artwork", { missingOnly: true })}>Generate missing artwork</button><button className="button" disabled={disabled || !selected.length || !scenes.length} onClick={() => regenerate(selected)}>Regenerate selected</button><button className="button" disabled={disabled || !scenes.length} onClick={() => regenerate()}>Regenerate all</button><button className="button" onClick={() => setSelected(selected.length === scenes.length ? [] : scenes.map((scene) => scene.id))}>Select all</button></div>
    {!scenes.length && <p>Generate scenes first.</p>}
    <div className="summary-artwork-grid">{scenes.map((scene) => { const url = `/api${props.base}/artwork/${scene.id}?v=${scene.artwork.imageFingerprint ?? ""}`; return <article className="summary-scene-card" key={scene.id}><header><label><input type="checkbox" checked={selected.includes(scene.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, scene.id] : selected.filter((id) => id !== scene.id))} /> {scene.id}</label><span>{scene.artwork.status} · {scene.artwork.review}</span></header>
      {scene.artwork.imageFingerprint ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={scene.summary} loading="lazy" /></a> : <p>No artwork yet.</p>}<h4>{scene.summary}</h4>{scene.artwork.error && <div className="error-box">{scene.artwork.error}</div>}<div className="summary-meta"><span>{scene.artwork.provider} {scene.artwork.model}</span>{scene.artwork.manuallyEdited && <span>Manually accepted</span>}</div>
      <div className="summary-visual-actions"><button className="button" disabled={disabled || !scenes.length} onClick={() => scene.artwork.imageFingerprint ? regenerate([scene.id]) : void run("artwork", { scenes: [scene.id] })}>{scene.artwork.imageFingerprint ? "Regenerate artwork" : "Generate artwork"}</button>{scene.artwork.imageFingerprint && <><button className="button" disabled={disabled} onClick={() => { if (confirm("Approve this image for the current scene and visual settings?")) void run(`artwork/${scene.id}`, { review: "approved" }, true); }}>Approve / retain</button><button className="button" disabled={disabled} onClick={() => void run(`artwork/${scene.id}`, { review: "rejected" }, true)}>Reject</button><a className="button" download href={`${url}&download=1`}>Download PNG</a></>}</div></article>; })}</div>
  </section>;
}

export function SummaryVideoPanel(props: SummaryVisualProps) {
  const { summary } = props; const { run, disabled } = useActions(props);
  return <section className="summary-media-editor"><header><span className="eyebrow">Recap screening room</span><h3>Summary video</h3><p>Uses mastered recap audio, scene artwork, and this book’s video settings. The recap has no silent intro; video length matches its audio.</p></header>
    <div className="summary-meta"><span>{summary.video?.status ?? "Not generated"}</span>{summary.video?.durationSeconds && <span>{clock(summary.video.durationSeconds)}</span>}{summary.video?.width && <span>{summary.video.width} × {summary.video.height}</span>}{summary.video?.sceneCount && <span>{summary.video.sceneCount} scenes</span>}{summary.video?.generatedAt && <span>{new Date(summary.video.generatedAt).toLocaleString()}</span>}<span>Audio: mastered summary narration</span></div>
    {summary.video?.status === "stale" && <p className="summary-media-warning">This video uses older inputs. Produce again to update only missing/stale stages.</p>}{summary.video?.error && <div className="error-box">{summary.video.error}</div>}
    {(summary.audio?.status === "stale" || summary.scenes?.status === "stale") && summaryAudioAvailable(summary) && summaryScenePlanAvailable(summary) && <p className="summary-media-warning">Video will render from the existing stale audio/scene inputs without regenerating them; regenerate those stages first only if you want the video based on the latest changes.</p>}
    {summary.video?.outputFingerprint && <video controls preload="metadata" aria-label="Summary video preview" src={`/api${props.base}/export/video?v=${summary.video.outputFingerprint}`} />}
    <div className="summary-visual-actions"><button className="button primary" disabled={disabled || summary.status !== "complete"} onClick={() => void run("produce", {})}>Produce summary video</button><button className="button" disabled={disabled || !summaryAudioAvailable(summary) || !summaryScenePlanAvailable(summary)} onClick={() => void run("video", { force: false })}>Generate / update video</button><button className="button" disabled={disabled || !summary.video} onClick={() => { if (confirm("Re-render the video using the existing audio and artwork?")) void run("video", { force: true }); }}>Regenerate video</button>{summary.video?.outputFingerprint && <a className="button" download href={`/api${props.base}/export/video?download=1`}>Download MP4</a>}</div>
  </section>;
}
