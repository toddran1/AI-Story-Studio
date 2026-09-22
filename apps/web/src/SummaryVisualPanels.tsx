import { useEffect, useRef, useState } from "react";
import { api, getArtDirection, post, put, type Job, type StoryArtDirection, type StorySummary } from "./api.js";
import { estimateScenePacing } from "../../../src/scenes/pacing.js";
import { summaryAudioAvailable, summaryNarrationTextAvailable, summaryScenePlanAvailable } from "../../../src/summaries/types.js";
import type { SummarySceneRegenerationProposal } from "../../../src/summaries/media.js";
import type { Scene } from "../../../src/scenes/types.js";
import { dirtySceneIds, reconcileSceneDrafts, sceneEditableValues, scenePlanStructureDirty } from "./summary-scene-draft.js";
import { VisualProfileCheckDialog, type VisualPreflightReport } from "./VisualProfileCheckDialog.js";

export type SummaryVisualProps = { slug?: string; summary: StorySummary; base: string; disabled: boolean; onChange: (summary: StorySummary) => void;
  onGenerate: (job: Job) => void; onError: (error: unknown) => void; onEditScene?: (sceneId: string) => void; focusSceneId?: string; produceBlocked?: { id: string; preflight: VisualPreflightReport } };
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
  const [saved, setSaved] = useState<Scene[]>(structuredClone(summary.scenePlan?.scenes ?? []));
  const savedRef = useRef(saved);
  const summaryIdRef = useRef(summary.id);
  const [draft, setDraft] = useState<Scene[]>(structuredClone(saved));
  const [savingScene, setSavingScene] = useState<string>();
  const [savingAll, setSavingAll] = useState(false);
  const [sceneError, setSceneError] = useState<Record<string, string>>({});
  const [savedScene, setSavedScene] = useState<string>();
  const [planError, setPlanError] = useState("");
  const [proposal, setProposal] = useState<SummarySceneRegenerationProposal>();
  const [regeneratingScene, setRegeneratingScene] = useState<string>();
  const [modeByScene, setModeByScene] = useState<Record<string, SummarySceneRegenerationProposal["mode"]>>({});
  const [artDirection, setArtDirection] = useState<StoryArtDirection>();
  const [savingArtDirection, setSavingArtDirection] = useState(false);
  const [artDirectionError, setArtDirectionError] = useState("");
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  useEffect(() => {
    if (!props.slug) return;
    let active = true;
    void getArtDirection(props.slug).then((value) => { if (active) { setArtDirection(value); setArtDirectionError(""); } }).catch((error) => { if (active) setArtDirectionError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [props.slug]);
  useEffect(() => {
    const incoming = structuredClone(summary.scenePlan?.scenes ?? []);
    if (summaryIdRef.current !== summary.id) {
      summaryIdRef.current = summary.id; setDraft(incoming); setSaved(incoming); savedRef.current = incoming;
      setProposal(undefined); setSceneError({}); return;
    }
    const previous = savedRef.current;
    setDraft((current) => reconcileSceneDrafts(current, previous, incoming));
    setSaved(incoming); savedRef.current = incoming;
  }, [summary.scenePlan, summary.id]);
  useEffect(() => {
    if (!props.focusSceneId) return;
    const target = document.getElementById(`summary-scene-${summary.id}-${props.focusSceneId}`);
    target?.scrollIntoView({ block: "center", behavior: "smooth" }); target?.focus({ preventScroll: true });
  }, [props.focusSceneId, summary.id]);
  const dirtyIds = dirtySceneIds(draft, saved);
  const planDirty = scenePlanStructureDirty(draft, saved);
  const anyDirty = planDirty || dirtyIds.size > 0;
  const working = disabled || Boolean(savingScene) || savingAll || Boolean(regeneratingScene);
  const input = { pacing, ...(pacing === "custom" ? custom === "count" ? { sceneCount: count } : { secondsPerScene: seconds } : {}) };
  const estimate = estimateScenePacing(summary.narration?.text ?? "", input, summary.audio?.status === "current" ? summary.audio.durationSeconds : undefined);
  const edit = (id: string, patch: Partial<Scene>) => { setDraft((scenes) => scenes.map((scene) => scene.id === id ? { ...scene, ...patch } : scene)); setSavedScene(undefined); setSceneError((errors) => ({ ...errors, [id]: "" })); };
  const move = (index: number, direction: number) => { setDraft((current) => { const next = [...current]; const target = index + direction; [next[index], next[target]] = [next[target]!, next[index]!]; return next; }); };
  const acceptSaved = (next: StorySummary, all: boolean) => {
    const incoming = structuredClone(next.scenePlan?.scenes ?? []);
    const previous = savedRef.current;
    setDraft((current) => all ? incoming : reconcileSceneDrafts(current, previous, incoming));
    setSaved(incoming); savedRef.current = incoming; props.onChange(next);
  };
  const showSaved = (id: string) => { setSavedScene(id); if (savedTimer.current) clearTimeout(savedTimer.current); savedTimer.current = setTimeout(() => setSavedScene(undefined), 2500); };
  const saveScene = async (scene: Scene) => {
    setSavingScene(scene.id); setSceneError((errors) => ({ ...errors, [scene.id]: "" }));
    try {
      const { visualChanges: _visualChanges, ...values } = sceneEditableValues(scene);
      const result = await put<{ summary: StorySummary }>(`${props.base}/scenes/${scene.id}`, { scene: values });
      acceptSaved(result.summary, false); showSaved(scene.id);
    } catch (error) { setSceneError((errors) => ({ ...errors, [scene.id]: error instanceof Error ? error.message : String(error) })); }
    finally { setSavingScene(undefined); }
  };
  const saveAll = async () => {
    setSavingAll(true); setPlanError("");
    try { const result = await put<{ summary: StorySummary }>(`${props.base}/scenes`, { scenes: draft }); acceptSaved(result.summary, true); showSaved("all"); }
    catch (error) { setPlanError(error instanceof Error ? error.message : String(error)); }
    finally { setSavingAll(false); }
  };
  const previewRegeneration = async (scene: Scene) => {
    setRegeneratingScene(scene.id); setSceneError((errors) => ({ ...errors, [scene.id]: "" }));
    try { const result = await post<{ proposal: SummarySceneRegenerationProposal }>(`${props.base}/scenes/${scene.id}/regenerate-preview`, { mode: modeByScene[scene.id] ?? "image_prompt" }); setProposal(result.proposal); }
    catch (error) { setSceneError((errors) => ({ ...errors, [scene.id]: error instanceof Error ? error.message : String(error) })); }
    finally { setRegeneratingScene(undefined); }
  };
  const applyRegeneration = async (sceneId: string) => {
    if (!proposal || proposal.sceneId !== sceneId) return;
    setRegeneratingScene(sceneId);
    try { const result = await put<{ summary: StorySummary }>(`${props.base}/scenes/${sceneId}/apply-regeneration`, proposal); acceptSaved(result.summary, false); setProposal(undefined); showSaved(sceneId); }
    catch (error) { setSceneError((errors) => ({ ...errors, [sceneId]: error instanceof Error ? error.message : String(error) })); }
    finally { setRegeneratingScene(undefined); }
  };
  const defaultPreset = artDirection?.presets.find((preset) => preset.isDefault) ?? artDirection?.presets.find((preset) => preset.id === artDirection.activePresetId) ?? artDirection?.presets[0];
  const summaryDirection = summary.artDirectionOverride;
  const summaryDirectionValue = summaryDirection?.mode === "disabled" ? "disabled" : summaryDirection?.mode === "preset" ? `preset:${summaryDirection.presetId}` : "story-default";
  const missingSummaryPreset = summaryDirection?.mode === "preset" && artDirection && !artDirection.presets.some((preset) => preset.id === summaryDirection.presetId);
  const saveSummaryDirection = async (value: string) => {
    if (value === summaryDirectionValue) return;
    const artDirectionOverride = value === "disabled" ? { mode: "disabled" as const } : value.startsWith("preset:") ? { mode: "preset" as const, presetId: value.slice(7) } : { mode: "story-default" as const };
    setSavingArtDirection(true); setArtDirectionError("");
    try { const result = await put<{ summary: StorySummary }>(props.base, { artDirectionOverride }); props.onChange(result.summary); }
    catch (error) { setArtDirectionError(error instanceof Error ? error.message : String(error)); }
    finally { setSavingArtDirection(false); }
  };
  const sceneDirectionLabel = (scene: Scene) => {
    if (scene.direction?.useStoryArtDirection === false) return "Art direction disabled for this scene";
    const ownId = scene.overrides?.artDirectionPresetId;
    if (ownId) return artDirection?.presets.find((preset) => preset.id === ownId) ? `Scene override · ${artDirection.presets.find((preset) => preset.id === ownId)!.name}` : `Missing scene preset · ${ownId} (using Story Default)`;
    if (scene.overrides?.artDirectionMode === "story-default") return `Scene override · Story Default · ${defaultPreset?.name ?? "loading"}`;
    if (summaryDirection?.mode === "disabled") return "Inherits summary · No Story Art Direction";
    if (summaryDirection?.mode === "preset") return missingSummaryPreset ? `Inherits summary · missing preset (using Story Default)` : `Inherits summary · ${artDirection?.presets.find((preset) => preset.id === summaryDirection.presetId)?.name ?? "selected preset"}`;
    return `Story Default · ${defaultPreset?.name ?? "loading"}`;
  };
  const inheritedDirectionLabel = () => summaryDirection?.mode === "disabled" ? "No Story Art Direction" : summaryDirection?.mode === "preset" ? missingSummaryPreset ? "Missing summary preset (using Story Default)" : artDirection?.presets.find((preset) => preset.id === summaryDirection.presetId)?.name ?? "Summary preset" : `Story Default · ${defaultPreset?.name ?? "loading"}`;
  const directionOptions = (scene: Scene): Array<{ value: string; label: string }> => {
    const options = [{ value: "inherit", label: `Inherit · ${inheritedDirectionLabel()}` }, { value: "story-default", label: `Story Default · ${defaultPreset?.name ?? "Main Style"}` }, ...(artDirection?.presets ?? []).map((preset) => ({ value: `preset:${preset.id}`, label: preset.name }))];
    const ownId = scene.overrides?.artDirectionPresetId;
    if (ownId && !artDirection?.presets.some((preset) => preset.id === ownId)) options.push({ value: `missing:${ownId}`, label: `Missing preset · ${ownId} (fallback)` });
    return options;
  };
  const setScenePreset = (scene: Scene, value: string) => {
    const overrides = { ...(scene.overrides ?? {}), wardrobeOverrides: scene.overrides?.wardrobeOverrides ?? {} };
    if (value === "inherit") { delete overrides.artDirectionPresetId; overrides.artDirectionMode = "inherit-summary"; }
    else if (value === "story-default") { delete overrides.artDirectionPresetId; overrides.artDirectionMode = "story-default"; }
    else if (value.startsWith("preset:")) { delete overrides.artDirectionMode; overrides.artDirectionPresetId = value.slice(7); }
    edit(scene.id, { overrides });
  };
  const directionFor = (scene: Scene) => ({ characterExpressions: {}, useCharacterReferences: true, useCreatureReferences: true, useLocationReferences: true, preserveWardrobeEquipment: true, useStoryArtDirection: true, ...(scene.direction ?? {}) });
  const overridesFor = (scene: Scene) => ({ wardrobeOverrides: {}, ...(scene.overrides ?? {}) });
  const updateDirection = (scene: Scene, patch: Partial<NonNullable<Scene["direction"]>>) => edit(scene.id, { direction: { ...directionFor(scene), ...patch } });
  const updateOverrides = (scene: Scene, patch: Partial<NonNullable<Scene["overrides"]>>) => edit(scene.id, { overrides: { ...overridesFor(scene), ...patch } });
  return <section className="summary-media-editor"><header><span className="eyebrow">Recap storyboard</span><h3>Scenes & timing</h3><p>Narration sets the beats. Canonical Story Bible identities guide the visuals.</p></header>
    <div className="summary-art-direction-control"><label>Summary Art Direction<select aria-label="Summary Art Direction" value={summaryDirectionValue} disabled={working || savingArtDirection || !artDirection} onChange={(event) => void saveSummaryDirection(event.target.value)}>
      <option value="story-default">Story Default{defaultPreset ? ` · ${defaultPreset.name}` : ""}</option>{(artDirection?.presets ?? []).filter((preset) => preset.id !== defaultPreset?.id).map((preset) => <option key={preset.id} value={`preset:${preset.id}`}>{preset.name}</option>)}<option value="disabled">No Story Art Direction</option>{missingSummaryPreset && <option value={`preset:${summaryDirection.presetId}`}>Missing preset · {summaryDirection.presetId} (using Story Default)</option>}
    </select><small>Applies to scenes that inherit direction. A scene-specific preset takes precedence. Saving this setting does not call a provider.</small></label>{savingArtDirection && <span role="status">Saving art direction…</span>}</div>
    {missingSummaryPreset && <p className="summary-media-warning">The saved summary preset is missing. Affected scenes safely fall back to Story Default until you choose an available preset.</p>}{artDirectionError && <div className="error-box">{artDirectionError}</div>}
    <div className="summary-form-row"><label>Scene pacing<select value={pacing} onChange={(event) => setPacing(event.target.value as typeof pacing)}>{["automatic", "slow", "balanced", "fast", "custom"].map((value) => <option key={value} value={value}>{value[0]!.toUpperCase() + value.slice(1)}</option>)}</select></label>
      {pacing === "custom" && <><label>Custom target<select value={custom} onChange={(event) => setCustom(event.target.value)}><option value="count">Scene count</option><option value="seconds">Seconds per scene</option></select></label><label>{custom === "count" ? "Target scenes" : "Seconds per scene"}<input type="number" min={custom === "count" ? 1 : 3} max={custom === "count" ? 100 : 120} value={custom === "count" ? count : seconds} onChange={(event) => { const value = Math.max(custom === "count" ? 1 : 3, Math.min(custom === "count" ? 100 : 120, Number(event.target.value) || 1)); custom === "count" ? setCount(value) : setSeconds(value); }} /></label></>}</div>
    <div className="summary-meta"><span>{estimate.durationSource === "mastered-audio" ? "Audio" : "Estimated audio"}: {clock(estimate.durationSeconds)}</span><span>Target {estimate.sceneCount} scenes</span><span>Average ~{estimate.averageDurationSeconds.toFixed(1)} sec</span><span>{summary.scenes?.status ?? "Not generated"} · {summary.scenePlan?.timingMethod ?? "estimated"} timing</span></div>
    {summary.alignment?.warning && <p className="summary-media-warning">Estimated timing: {summary.alignment.warning}</p>}{summary.scenes?.error && <div className="error-box">{summary.scenes.error}</div>}
    {summary.narration?.status === "stale" && summaryNarrationTextAvailable(summary) && <p className="summary-media-warning">Using stale narration — scenes can still be generated from the existing narration; regenerate narration first only if you want the plan based on the latest changes.</p>}
    {planDirty && <p className="summary-media-warning">Scene order or deletion has unsaved changes. Save all scene edits to apply the new plan.</p>}
    {planError && <div className="error-box">{planError}</div>}
    <div className="summary-visual-actions"><button className="button primary" disabled={working || anyDirty || !summaryNarrationTextAvailable(summary)} onClick={() => { if (!summary.scenePlan || confirm("Regenerate all scenes? Manual visual directions may be replaced; approved artwork is preserved for review.")) void run("scenes", { ...input, force: Boolean(summary.scenePlan) }); }}>{summary.scenePlan ? "Regenerate all scenes" : "Generate scenes"}</button>
      <button className="button" disabled={working || anyDirty || !summary.scenePlan || summary.audio?.status !== "current"} onClick={() => void run("scenes", { ...summary.scenePacing, force: false })}>Update timing</button>
      {summary.scenes?.status === "stale" && <button className="button" disabled={working || anyDirty || summary.narration?.status !== "current"} onClick={() => { if (confirm("Accept the existing scene visuals against the current narration and settings? Timing will be refreshed locally.")) void run("scenes", { acceptCurrent: true }, true); }}>Review / mark current</button>}
      <button className="button" disabled={working || !anyDirty} onClick={() => void saveAll()}>{savingAll ? "Saving…" : "Save all scene edits"}</button>{savedScene === "all" && <span role="status">Saved</span>}</div>
    {draft.map((scene, index) => <article id={`summary-scene-${summary.id}-${scene.id}`} tabIndex={-1} className="summary-scene-card" key={scene.id}><header><span className="eyebrow">Scene {String(index + 1).padStart(2, "0")}</span><span>{clock(scene.startSeconds)}–{clock(scene.endSeconds)} · {scene.disabled ? "disabled" : summary.scenePlan?.timingMethod ?? "estimated"}</span><span className="summary-scene-save-state" role="status">{savingScene === scene.id ? "Saving…" : dirtyIds.has(scene.id) ? "Unsaved changes" : savedScene === scene.id ? "Saved" : ""}</span></header>
      <blockquote>{scene.narrationText ?? scene.summary}</blockquote><label>Visual beat<input disabled={working} value={scene.summary} onChange={(event) => edit(scene.id, { summary: event.target.value })} /></label><label>Image prompt<textarea disabled={working} value={scene.visualPrompt} onChange={(event) => edit(scene.id, { visualPrompt: event.target.value })} /></label>
      <div className="summary-form-row"><label>Characters (comma separated)<input disabled={working} value={scene.characters.join(", ")} onChange={(event) => edit(scene.id, { characters: event.target.value.split(",").map((name) => name.trim()).filter(Boolean), entityIds: [] })} /></label><label>Location<input disabled={working} value={scene.location ?? ""} onChange={(event) => edit(scene.id, { location: event.target.value })} /></label></div>
      <div className="summary-form-row"><label>Start seconds<input disabled={working} type="number" step="0.1" min={0} value={scene.startSeconds} onChange={(event) => edit(scene.id, { startSeconds: Number(event.target.value) })} /></label><label>End seconds<input disabled={working} type="number" step="0.1" min={0} value={scene.endSeconds} onChange={(event) => edit(scene.id, { endSeconds: Number(event.target.value) })} /></label></div>
      <details className="summary-scene-direction"><summary>Advanced visual direction</summary><p className="summary-direction-inheritance">{sceneDirectionLabel(scene)}</p>
        <label className="summary-direction-toggle"><input type="checkbox" checked={directionFor(scene).useStoryArtDirection !== false} disabled={working} onChange={(event) => updateDirection(scene, { useStoryArtDirection: event.target.checked })} /> Use Story / Summary Art Direction</label>
        <label>Art direction preset<select disabled={working || directionFor(scene).useStoryArtDirection === false || !artDirection} value={scene.overrides?.artDirectionPresetId ? artDirection?.presets.some((preset) => preset.id === scene.overrides?.artDirectionPresetId) ? `preset:${scene.overrides.artDirectionPresetId}` : `missing:${scene.overrides.artDirectionPresetId}` : scene.overrides?.artDirectionMode === "story-default" ? "story-default" : "inherit"} onChange={(event) => setScenePreset(scene, event.target.value)}>{directionOptions(scene).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>Inherit the summary setting, use Story Default, or choose a scene-only preset.</small></label>
        <div className="summary-form-row"><label>Shot type<select disabled={working} value={directionFor(scene).shotType ?? ""} onChange={(event) => updateDirection(scene, { shotType: (event.target.value || undefined) as NonNullable<Scene["direction"]>["shotType"] })}><option value="">Automatic</option>{["extreme_wide", "wide", "medium_wide", "medium", "medium_close_up", "close_up", "extreme_close_up"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label><label>Camera angle<select disabled={working} value={directionFor(scene).cameraAngle ?? ""} onChange={(event) => updateDirection(scene, { cameraAngle: (event.target.value || undefined) as NonNullable<Scene["direction"]>["cameraAngle"] })}><option value="">Automatic</option>{["eye_level", "low_angle", "high_angle", "overhead", "dutch_angle", "pov", "over_shoulder"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label><label>Composition<select disabled={working} value={directionFor(scene).composition ?? ""} onChange={(event) => updateDirection(scene, { composition: (event.target.value || undefined) as NonNullable<Scene["direction"]>["composition"] })}><option value="">Automatic</option>{["balanced", "centered", "rule_of_thirds", "dynamic", "symmetrical", "environmental", "character_focused"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label></div>
        <div className="summary-form-row"><label>Lighting<input disabled={working} value={directionFor(scene).lighting ?? ""} onChange={(event) => updateDirection(scene, { lighting: event.target.value || undefined })} /></label><label>Time / environment<select disabled={working} value={directionFor(scene).timeEnvironment ?? ""} onChange={(event) => updateDirection(scene, { timeEnvironment: (event.target.value || undefined) as NonNullable<Scene["direction"]>["timeEnvironment"] })}><option value="">Automatic</option>{["dawn", "day", "sunset", "dusk", "night", "interior", "custom"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label></div>
        <div className="summary-direction-toggles">{([["useCharacterReferences", "Use character references"], ["useCreatureReferences", "Use creature references"], ["useLocationReferences", "Use location references"], ["preserveWardrobeEquipment", "Preserve wardrobe / equipment"]] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={directionFor(scene)[key] !== false} disabled={working} onChange={(event) => updateDirection(scene, { [key]: event.target.checked })} /> {label}</label>)}</div>
        <label>Custom visual prompt<textarea disabled={working} value={overridesFor(scene).customVisualPrompt ?? ""} onChange={(event) => updateOverrides(scene, { customVisualPrompt: event.target.value || undefined })} /></label><label>Custom negative prompt<textarea disabled={working} value={overridesFor(scene).customNegativePrompt ?? ""} onChange={(event) => updateOverrides(scene, { customNegativePrompt: event.target.value || undefined })} /></label>
        <label>Wardrobe / equipment overrides<textarea disabled={working} value={Object.entries(overridesFor(scene).wardrobeOverrides).map(([name, outfit]) => `${name}: ${outfit}`).join("\n")} onChange={(event) => { const wardrobeOverrides = Object.fromEntries(event.target.value.split("\n").map((line) => { const index = line.indexOf(":"); return index > 0 ? [line.slice(0, index).trim(), line.slice(index + 1).trim()] : ["", ""]; }).filter(([name, outfit]) => name && outfit)); updateOverrides(scene, { wardrobeOverrides }); }} /><small>One entry per line: Character: outfit or equipment detail.</small></label>
      </details>
      {sceneError[scene.id] && <div className="error-box">{sceneError[scene.id]}</div>}
      <div className="summary-visual-actions"><button className="button primary" disabled={working || !dirtyIds.has(scene.id)} onClick={() => void saveScene(scene)}>Save this scene</button>
        <button className="button" disabled={working || !dirtyIds.has(scene.id)} onClick={() => { const persisted = savedRef.current.find((item) => item.id === scene.id); if (persisted) setDraft((scenes) => scenes.map((item) => item.id === scene.id ? structuredClone(persisted) : item)); setSceneError((errors) => ({ ...errors, [scene.id]: "" })); }}>Revert changes</button>
        <select aria-label={`Regeneration mode for ${scene.id}`} disabled={working} value={modeByScene[scene.id] ?? "image_prompt"} onChange={(event) => setModeByScene((values) => ({ ...values, [scene.id]: event.target.value as SummarySceneRegenerationProposal["mode"] }))}><option value="image_prompt">Image prompt only</option><option value="full_visual_direction">Full visual direction</option></select>
        <button className="button" title={dirtyIds.has(scene.id) ? "Save or revert this scene before regenerating it." : planDirty ? "Save all plan changes before regenerating a scene." : undefined} disabled={working || dirtyIds.has(scene.id) || planDirty} onClick={() => void previewRegeneration(scene)}>Regenerate scene</button>
        <button className="button" disabled={working || index === 0} onClick={() => move(index, -1)}>Move up</button><button className="button" disabled={working || index === draft.length - 1} onClick={() => move(index, 1)}>Move down</button><button className="button" disabled={working || (!scene.disabled && draft.filter((item) => !item.disabled).length === 1)} onClick={() => edit(scene.id, { disabled: !scene.disabled })}>{scene.disabled ? "Enable" : "Disable"}</button><button className="button" disabled={working || draft.length === 1} onClick={() => { if (confirm("Delete this visual beat and redistribute its narration coverage?")) setDraft((scenes) => scenes.filter((item) => item.id !== scene.id)); }}>Delete scene</button></div>
      {proposal?.sceneId === scene.id && <div className="summary-scene-proposal"><strong>Regeneration proposal · {proposal.mode === "image_prompt" ? "Image prompt only" : "Full visual direction"}</strong><small>{proposal.provider} · {proposal.model} · Preview only; your saved scene has not changed.</small>
        {([ ["Visual beat", "summary"], ["Image prompt", "visualPrompt"], ["Characters", "characters"], ["Location", "location"], ["Importance", "importance"] ] as const).map(([label, key]) => <div className="summary-proposal-row" key={key}><b>{label}</b><span><small>Current</small>{Array.isArray(proposal.current[key]) ? proposal.current[key].join(", ") : proposal.current[key] ?? "—"}</span><span><small>Proposed</small>{Array.isArray(proposal.proposed[key]) ? proposal.proposed[key].join(", ") : proposal.proposed[key] ?? "—"}</span></div>)}
        <div className="summary-visual-actions"><button className="button primary" disabled={working || dirtyIds.has(scene.id) || planDirty} onClick={() => void applyRegeneration(scene.id)}>Apply regeneration</button><button className="button" disabled={working} onClick={() => setProposal(undefined)}>Cancel</button></div></div>}
      {summary.audio?.outputFingerprint && <audio controls preload="none" aria-label={`Preview ${scene.id} timing`} src={`/api${props.base}/export/audio#t=${scene.startSeconds},${scene.endSeconds}`} />}</article>)}
    {pending && <p role="status">Starting scene job…</p>}
  </section>;
}

export function SummaryArtworkPanel(props: SummaryVisualProps) {
  const { summary } = props; const { run, disabled } = useActions(props); const [selected, setSelected] = useState<string[]>([]);
  const [grounding, setGrounding] = useState<Array<{ sceneId: string; status: "current" | "stale" | "missing"; grounding: Array<{ entityId?: string; name: string; source: string; reference: boolean; primaryReference?: boolean }>; groundingRecorded?: boolean; legacyGroundingUnknown?: boolean; artDirection?: { source: "story-default" | "summary-override" | "scene-override" | "disabled"; presetName?: string; missingPresetId?: string; fingerprint?: string }; approvedHistoricalVersion: boolean }>>([]);
  const [preflight, setPreflight] = useState<VisualPreflightReport>();
  const [pendingArtworkRequest, setPendingArtworkRequest] = useState<Record<string, unknown>>();
  const [oneTimeFallbackIds, setOneTimeFallbackIds] = useState<string[]>([]);
  const [checkingProfiles, setCheckingProfiles] = useState(false);
  useEffect(() => {
    let active = true;
    void api<{ scenes: typeof grounding }>(`${props.base}/scenes/grounding`).then((result) => { if (active) setGrounding(result.scenes); }).catch((error) => { if (active) props.onError(error); });
    return () => { active = false; };
  }, [props.base, summary.scenePlan, summary.artwork]);
  const scenes = summary.scenePlan?.scenes.filter((scene) => !scene.disabled) ?? [];
  const requestArtwork = async (request: Record<string, unknown>) => {
    setCheckingProfiles(true);
    try {
      const report = await post<VisualPreflightReport>(`${props.base}/artwork/visual-preflight`, request);
      if (report.ready) { void run("artwork", request); return; }
      setPendingArtworkRequest(request); setPreflight(report); setOneTimeFallbackIds([]);
    } catch (error) { props.onError(error); }
    finally { setCheckingProfiles(false); }
  };
  const regenerate = (ids?: string[]) => { if (confirm("Regenerate artwork? Selected approved/manual images will be preserved as earlier versions.")) void requestArtwork({ force: true, ...(ids ? { scenes: ids } : {}) }); };
  const refreshPreflight = async () => {
    if (!pendingArtworkRequest) return;
    setCheckingProfiles(true);
    try { setPreflight(await post<VisualPreflightReport>(`${props.base}/artwork/visual-preflight`, pendingArtworkRequest)); }
    catch (error) { props.onError(error); }
    finally { setCheckingProfiles(false); }
  };
  const continueArtwork = async () => {
    if (!pendingArtworkRequest) return;
    setCheckingProfiles(true);
    try {
      const report = await post<VisualPreflightReport>(`${props.base}/artwork/visual-preflight`, { ...pendingArtworkRequest, allowUnprofiledEntityIds: oneTimeFallbackIds });
      setPreflight(report);
      if (!report.ready) return;
      const request = { ...pendingArtworkRequest, allowUnprofiledEntityIds: oneTimeFallbackIds };
      setPreflight(undefined); setPendingArtworkRequest(undefined); setOneTimeFallbackIds([]);
      void run("artwork", request);
    } catch (error) { props.onError(error); }
    finally { setCheckingProfiles(false); }
  };
  const cancelArtwork = () => { setPreflight(undefined); setPendingArtworkRequest(undefined); setOneTimeFallbackIds([]); };
  const artworkDisabled = disabled || checkingProfiles;
  return <section className="summary-media-editor"><header><span className="eyebrow">Canonical visual continuity</span><h3>Scene artwork</h3><p>Uses this book’s image provider, style, and canonical visual references. Approved work is protected unless you explicitly regenerate it.</p></header>
    <div className="summary-meta"><span>{grounding.some((item) => item.status === "stale") ? "stale" : summary.artwork?.status ?? "Not generated"}</span><span>{scenes.length} enabled scenes</span></div>{summary.artwork?.error && <div className="error-box">{summary.artwork.error}</div>}
    {summary.scenes?.status === "stale" && scenes.length > 0 && <p className="summary-media-warning">The scene plan is stale — artwork will use the existing plan; regenerate scenes first only if you want artwork based on the latest narration.</p>}
    <div className="summary-visual-actions"><button className="button primary" disabled={artworkDisabled || !scenes.length} onClick={() => void requestArtwork({ missingOnly: true })}>Generate missing artwork</button><button className="button" disabled={artworkDisabled || !selected.length || !scenes.length} onClick={() => regenerate(selected)}>Regenerate selected</button><button className="button" disabled={artworkDisabled || !scenes.length} onClick={() => regenerate()}>Regenerate all</button><button className="button" onClick={() => setSelected(selected.length === scenes.length ? [] : scenes.map((scene) => scene.id))}>Select all</button></div>
    {!scenes.length && <p>Generate scenes first.</p>}
    <p className="summary-media-note">Artwork uses the currently saved visual beat, image prompt, canonical identities, and available references. It does not regenerate the scene plan.</p>
    <div className="summary-artwork-grid">{scenes.map((scene) => { const url = `/api${props.base}/artwork/${scene.id}?v=${scene.artwork.imageFingerprint ?? ""}`; const state = grounding.find((item) => item.sceneId === scene.id); return <article className="summary-scene-card" key={scene.id}><header><label><input type="checkbox" checked={selected.includes(scene.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, scene.id] : selected.filter((id) => id !== scene.id))} /> {scene.id}</label><span>{state?.status === "stale" ? "Scene changed — artwork is stale" : state?.status === "missing" ? "Artwork missing" : state?.status === "current" ? "Artwork current" : scene.artwork.status} · {scene.artwork.review}</span></header>
      {scene.artwork.imageFingerprint ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={scene.summary} loading="lazy" /></a> : <p>No artwork yet.</p>}<h4>{scene.summary}</h4>{scene.artwork.error && <div className="error-box">{scene.artwork.error}</div>}<div className="summary-meta"><span>{scene.artwork.provider} {scene.artwork.model}</span>{scene.artwork.manuallyEdited && <span>Manually accepted</span>}</div>
      {state && <div className="summary-grounding"><small>Art direction</small>{state.artDirection ? <span>{state.artDirection.source === "summary-override" ? "Summary override" : state.artDirection.source === "scene-override" ? "Scene override" : state.artDirection.source === "disabled" ? "Disabled" : "Story default"}{state.artDirection.presetName ? ` · ${state.artDirection.presetName}` : ""}{state.artDirection.missingPresetId ? ` · missing preset ${state.artDirection.missingPresetId}; fallback used` : ""}</span> : <span>{state.status === "missing" ? "Not generated yet" : "Legacy artwork — art direction not recorded"}</span>}<small>Visual grounding</small>{state.legacyGroundingUnknown ? <span>Legacy artwork — visual grounding not recorded</span> : state.grounding.length ? state.grounding.map((item) => <span key={item.entityId ?? item.name}>{item.name} — {item.source}{item.primaryReference ? " · primary reference" : item.reference ? " · approved reference" : ""}</span>) : <span>No resolved canonical entities for this scene</span>}{state.approvedHistoricalVersion && <span>Approved historical version retained</span>}</div>}
      <div className="summary-visual-actions"><button className="button" disabled={artworkDisabled || !scenes.length} onClick={() => scene.artwork.imageFingerprint ? regenerate([scene.id]) : void requestArtwork({ scenes: [scene.id] })}>{scene.artwork.imageFingerprint ? "Regenerate artwork from current saved scene" : "Generate artwork from current saved scene"}</button><button className="button" onClick={() => props.onEditScene?.(scene.id)}>Edit scene</button>{scene.artwork.imageFingerprint && <><button className="button" disabled={disabled} onClick={() => { if (confirm("Approve this image for the current scene and visual settings?")) void run(`artwork/${scene.id}`, { review: "approved" }, true); }}>Approve / retain</button><button className="button" disabled={disabled} onClick={() => void run(`artwork/${scene.id}`, { review: "rejected" }, true)}>Reject</button><a className="button" download href={`${url}&download=1`}>Download PNG</a></>}</div></article>; })}</div>
    {checkingProfiles && <p className="summary-media-working" role="status">Checking Visual Profiles for scenes that need new artwork…</p>}
    {preflight && <VisualProfileCheckDialog slug={props.slug ?? props.base.split("/")[2] ?? ""} report={preflight} oneTimeEntityIds={oneTimeFallbackIds} onOneTimeEntityIds={setOneTimeFallbackIds} onCancel={cancelArtwork} onContinue={() => void continueArtwork()} onRefresh={() => void refreshPreflight()} onError={props.onError} />}
  </section>;
}

export function SummaryVideoPanel(props: SummaryVisualProps) {
  const { summary } = props; const { run, disabled } = useActions(props);
  const [preflight, setPreflight] = useState<VisualPreflightReport>();
  const [pendingProduceRequest, setPendingProduceRequest] = useState<Record<string, unknown>>();
  const [oneTimeFallbackIds, setOneTimeFallbackIds] = useState<string[]>([]);
  const [checkingProfiles, setCheckingProfiles] = useState(false);
  useEffect(() => {
    if (props.produceBlocked?.id !== summary.id) return;
    setPendingProduceRequest({}); setPreflight(props.produceBlocked.preflight); setOneTimeFallbackIds([]);
  }, [props.produceBlocked, summary.id]);
  const produce = (request: Record<string, unknown>) => void run("produce", request);
  const refreshPreflight = async () => {
    if (!pendingProduceRequest) return;
    setCheckingProfiles(true);
    try { setPreflight(await post<VisualPreflightReport>(`${props.base}/artwork/visual-preflight`, pendingProduceRequest)); }
    catch (error) { props.onError(error); }
    finally { setCheckingProfiles(false); }
  };
  const continueProduce = async () => {
    if (!pendingProduceRequest) return;
    setCheckingProfiles(true);
    try {
      const request = { ...pendingProduceRequest, allowUnprofiledEntityIds: oneTimeFallbackIds };
      const report = await post<VisualPreflightReport>(`${props.base}/artwork/visual-preflight`, request);
      setPreflight(report);
      if (!report.ready) return;
      setPreflight(undefined); setPendingProduceRequest(undefined); setOneTimeFallbackIds([]);
      produce(request);
    } catch (error) { props.onError(error); }
    finally { setCheckingProfiles(false); }
  };
  const cancelProduce = () => { setPreflight(undefined); setPendingProduceRequest(undefined); setOneTimeFallbackIds([]); };
  return <section className="summary-media-editor"><header><span className="eyebrow">Recap screening room</span><h3>Summary video</h3><p>Uses mastered recap audio, scene artwork, and this book’s video settings. The recap has no silent intro; video length matches its audio.</p></header>
    <div className="summary-meta"><span>{summary.video?.status ?? "Not generated"}</span>{summary.video?.durationSeconds && <span>{clock(summary.video.durationSeconds)}</span>}{summary.video?.width && <span>{summary.video.width} × {summary.video.height}</span>}{summary.video?.sceneCount && <span>{summary.video.sceneCount} scenes</span>}{summary.video?.generatedAt && <span>{new Date(summary.video.generatedAt).toLocaleString()}</span>}<span>Audio: mastered summary narration</span></div>
    {summary.video?.status === "stale" && <p className="summary-media-warning">This video uses older inputs. Produce again to update only missing/stale stages.</p>}{summary.video?.error && <div className="error-box">{summary.video.error}</div>}
    {(summary.audio?.status === "stale" || summary.scenes?.status === "stale") && summaryAudioAvailable(summary) && summaryScenePlanAvailable(summary) && <p className="summary-media-warning">Video will render from the existing stale audio/scene inputs without regenerating them; regenerate those stages first only if you want the video based on the latest changes.</p>}
    {summary.video?.outputFingerprint && <video controls preload="metadata" aria-label="Summary video preview" src={`/api${props.base}/export/video?v=${summary.video.outputFingerprint}`} />}
    <div className="summary-visual-actions"><button className="button primary" disabled={disabled || checkingProfiles || summary.status !== "complete"} onClick={() => produce({})}>Produce summary video</button><button className="button" disabled={disabled || !summaryAudioAvailable(summary) || !summaryScenePlanAvailable(summary)} onClick={() => void run("video", { force: false })}>Generate / update video</button><button className="button" disabled={disabled || !summary.video} onClick={() => { if (confirm("Re-render the video using the existing audio and artwork?")) void run("video", { force: true }); }}>Regenerate video</button>{summary.video?.outputFingerprint && <a className="button" download href={`/api${props.base}/export/video?download=1`}>Download MP4</a>}</div>
    {checkingProfiles && <p className="summary-media-working" role="status">Checking Visual Profiles for summary scenes…</p>}
    {preflight && <VisualProfileCheckDialog slug={props.slug ?? props.base.split("/")[2] ?? ""} report={preflight} oneTimeEntityIds={oneTimeFallbackIds} onOneTimeEntityIds={setOneTimeFallbackIds} onCancel={cancelProduce} onContinue={() => void continueProduce()} onRefresh={() => void refreshPreflight()} onError={props.onError} />}
  </section>;
}
