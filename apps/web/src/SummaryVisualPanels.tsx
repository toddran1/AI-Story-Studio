import { useEffect, useRef, useState } from "react";
import { api, del, getArtDirection, post, put, type Job, type StoryArtDirection, type StoryConfig, type StorySummary } from "./api.js";
import { estimateScenePacing } from "../../../src/scenes/pacing.js";
import { summaryAudioAvailable, summaryNarrationTextAvailable, summaryScenePlanAvailable } from "../../../src/summaries/types.js";
import type { SummarySceneRegenerationProposal } from "../../../src/summaries/media.js";
import type { Scene } from "../../../src/scenes/types.js";
import { dirtySceneIds, reconcileSceneDrafts, sceneEditableValues, scenePlanStructureDirty } from "./summary-scene-draft.js";
import { VisualProfileCheckDialog, type VisualPreflightReport } from "./VisualProfileCheckDialog.js";
import { SceneFilmstrip } from "./SceneFilmstrip.js";
import { AdvancedVisualDirection } from "./AdvancedVisualDirection.js";
import { VideoReadinessPanel, type ReadinessCheck } from "./VideoReadinessPanel.js";
import { VisualGroundingPanel } from "./VisualGroundingPanel.js";
import { VisualProfileModal } from "./VisualProfileModal.js";
import type { ResolvedSceneContinuity } from "../../../src/visual-canon/continuity-state.js";

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
function SummaryContinuityEditor({ continuity, busy, onSave, onReset }: { continuity?: ResolvedSceneContinuity; busy: boolean; onSave: (input: { note?: string; usePreviousReference?: "prefer" | "avoid" }) => void; onReset: () => void }) {
  const [note, setNote] = useState(continuity?.manualOverride?.note ?? "");
  const [reference, setReference] = useState<"inherit" | "prefer" | "avoid">(continuity?.manualOverride?.usePreviousReference ?? "inherit");
  const stateText = (state?: ResolvedSceneContinuity["startState"]) => state ? [
    ...state.characters.map((character) => `${character.name}${character.condition ? ` · ${character.condition}` : ""}${character.wardrobe ? ` · ${character.wardrobe}` : ""}`),
    state.environment && `Environment · ${Object.values(state.environment).filter(Boolean).join(" · ")}`,
    ...state.objects.map((object) => `Object · ${object.name}${object.condition ? ` · ${object.condition}` : ""}`),
    state.spatial && `Spatial · ${state.spatial}`,
  ].filter(Boolean).join("\n") || "No state recorded" : "No state recorded";
  return <details className="scene-direction-panel scene-continuity-panel"><summary>Visual continuity {continuity?.manualOverride && <span className="manual-badge">Manual override{continuity.manualOverride.stale ? " · stale" : ""}</span>}</summary><div className="scene-direction-content">
    <div className="continuity-state"><h5>Entering state</h5><pre>{stateText(continuity?.startState)}</pre></div>
    {continuity?.changes && <div className="continuity-state"><h5>Changes in this scene</h5><pre>{JSON.stringify(continuity.changes, null, 2)}</pre></div>}
    <div className="continuity-state"><h5>Ending state</h5><pre>{stateText(continuity?.endState)}</pre></div>
    <p className="continuity-reference">Previous reference: {continuity?.referenceDecision?.reason ?? "No previous reference"}</p>
    <label>Continuity note<input value={note} maxLength={1000} disabled={busy} onChange={(event) => setNote(event.target.value)} placeholder="Carry a visible change into this scene" /></label>
    <label>Previous-scene reference<select value={reference} disabled={busy} onChange={(event) => setReference(event.target.value as typeof reference)}><option value="inherit">Automatic</option><option value="prefer">Prefer previous artwork</option><option value="avoid">Avoid previous artwork</option></select></label>
    <div className="summary-visual-actions"><button type="button" className="button" disabled={busy} onClick={() => onSave({ ...(note.trim() ? { note: note.trim() } : {}), ...(reference === "inherit" ? {} : { usePreviousReference: reference }) })}>{busy ? "Saving…" : "Save continuity override"}</button>{continuity?.manualOverride && <button type="button" className="button" disabled={busy} onClick={onReset}>Reset override</button>}</div>
  </div></details>;
}
export function summaryArtDirectionChoiceOptions(direction?: StoryArtDirection) {
  const defaultPreset = direction?.presets.find((preset) => preset.isDefault) ?? direction?.presets.find((preset) => preset.id === direction.activePresetId) ?? direction?.presets[0];
  return [
    { value: "story-default", label: `Story Default${defaultPreset ? ` · ${defaultPreset.name}` : ""}` },
    ...(direction?.presets ?? []).map((preset) => ({ value: `preset:${preset.id}`, label: `Preset · ${preset.name}` })),
    { value: "disabled", label: "No Story Art Direction" },
  ];
}

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
  const [resolvedCharacters, setResolvedCharacters] = useState<Record<string, Array<{ name: string; entityId?: string; canonicalName?: string; profileStatus?: "draft" | "approved" | "missing" }>>>({});
  const [activeProfile, setActiveProfile] = useState<{ id: string; name: string }>();
  const [continuity, setContinuity] = useState<Record<string, ResolvedSceneContinuity>>({});
  const [continuityBusy, setContinuityBusy] = useState<string>();
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  useEffect(() => {
    if (!props.slug) return;
    let active = true;
    void getArtDirection(props.slug).then((value) => { if (active) { setArtDirection(value); setArtDirectionError(""); } }).catch((error) => { if (active) setArtDirectionError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [props.slug]);
  useEffect(() => {
    let active = true;
    void api<{ scenes: Array<{ sceneId: string; characters: Array<{ name: string; entityId?: string; canonicalName?: string; profileStatus?: "draft" | "approved" | "missing" }> }> }>(`${props.base}/scenes/identities`)
      .then((result) => { if (active) setResolvedCharacters(Object.fromEntries(result.scenes.map((scene) => [scene.sceneId, scene.characters]))); })
      .catch(() => { if (active) setResolvedCharacters({}); });
    return () => { active = false; };
  }, [props.base, summary.scenePlan]);
  useEffect(() => {
    let active = true;
    void api<{ scenes: Array<{ sceneId: string; continuity?: ResolvedSceneContinuity }> }>(`${props.base}/scenes/continuity`)
      .then((result) => { if (active) setContinuity(Object.fromEntries(result.scenes.filter((scene) => scene.continuity).map((scene) => [scene.sceneId, scene.continuity!]))); })
      .catch((error) => { if (active) props.onError(error); });
    return () => { active = false; };
  }, [props.base, summary.scenePlan]);
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
  const updateContinuity = async (sceneId: string, input?: { note?: string; usePreviousReference?: "prefer" | "avoid" }) => {
    setContinuityBusy(sceneId);
    try {
      const result = input ? await put<{ scenes: Array<{ sceneId: string; continuity?: ResolvedSceneContinuity }> }>(`${props.base}/scenes/${sceneId}/continuity`, input) : await del<{ scenes: Array<{ sceneId: string; continuity?: ResolvedSceneContinuity }> }>(`${props.base}/scenes/${sceneId}/continuity`);
      setContinuity(Object.fromEntries(result.scenes.filter((scene) => scene.continuity).map((scene) => [scene.sceneId, scene.continuity!])));
      props.onChange((await api<{ summary: StorySummary }>(props.base)).summary);
    } catch (error) { setSceneError((errors) => ({ ...errors, [sceneId]: error instanceof Error ? error.message : String(error) })); }
    finally { setContinuityBusy(undefined); }
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
  const inheritedDirectionLabel = () => summaryDirection?.mode === "disabled" ? "No Story Art Direction" : summaryDirection?.mode === "preset" ? missingSummaryPreset ? "Missing summary preset (using Story Default)" : artDirection?.presets.find((preset) => preset.id === summaryDirection.presetId)?.name ?? "Summary preset" : `Story Default · ${defaultPreset?.name ?? "loading"}`;
  const directionFor = (scene: Scene) => ({ characterExpressions: {}, useCharacterReferences: true, useCreatureReferences: true, useLocationReferences: true, preserveWardrobeEquipment: true, useStoryArtDirection: true, ...(scene.direction ?? {}) });
  const overridesFor = (scene: Scene) => ({ wardrobeOverrides: {}, ...(scene.overrides ?? {}) });
  const updateDirection = (scene: Scene, patch: Partial<NonNullable<Scene["direction"]>>) => edit(scene.id, { direction: { ...directionFor(scene), ...patch } });
  const updateOverrides = (scene: Scene, patch: Partial<NonNullable<Scene["overrides"]>>) => edit(scene.id, { overrides: { ...overridesFor(scene), ...patch } });
  return <section className="summary-media-editor"><header><span className="eyebrow">Recap storyboard</span><h3>Scenes & timing</h3><p>Narration sets the beats. Canonical Story Bible identities guide the visuals.</p></header>
    <div className="summary-art-direction-control"><label>Summary Art Direction<select aria-label="Summary Art Direction" value={summaryDirectionValue} disabled={working || savingArtDirection || !artDirection} onChange={(event) => void saveSummaryDirection(event.target.value)}>
      {summaryArtDirectionChoiceOptions(artDirection).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}{missingSummaryPreset && <option value={`preset:${summaryDirection.presetId}`}>Missing preset · {summaryDirection.presetId} (using Story Default)</option>}
    </select><small>Applies to scenes that inherit direction. A scene-specific preset takes precedence. Saving this setting does not call a provider.</small></label>{savingArtDirection && <span role="status">Saving art direction…</span>}</div>
    {missingSummaryPreset && <p className="summary-media-warning">The saved summary preset is missing. Affected scenes safely fall back to Story Default until you choose an available preset.</p>}{artDirectionError && <div className="error-box">{artDirectionError}</div>}
    <div className="summary-form-row"><label>Scene pacing<select value={pacing} onChange={(event) => setPacing(event.target.value as typeof pacing)}>{["automatic", "slow", "balanced", "fast", "custom"].map((value) => <option key={value} value={value}>{value[0]!.toUpperCase() + value.slice(1)}</option>)}</select></label>
      {pacing === "custom" && <><label>Custom target<select value={custom} onChange={(event) => setCustom(event.target.value)}><option value="count">Scene count</option><option value="seconds">Seconds per scene</option></select></label><label>{custom === "count" ? "Target scenes" : "Seconds per scene"}<input type="number" min={custom === "count" ? 1 : 3} max={custom === "count" ? 100 : 120} value={custom === "count" ? count : seconds} onChange={(event) => { const value = Math.max(custom === "count" ? 1 : 3, Math.min(custom === "count" ? 100 : 120, Number(event.target.value) || 1)); custom === "count" ? setCount(value) : setSeconds(value); }} /></label></>}</div>
    <div className="summary-meta"><span>{estimate.durationSource === "mastered-audio" ? "Audio" : "Estimated audio"}: {clock(estimate.durationSeconds)}</span><span>Target {estimate.sceneCount} scenes</span><span>Average ~{estimate.averageDurationSeconds.toFixed(1)} sec</span><span>{summary.scenes?.status ?? "Not generated"} · {summary.scenePlan?.timingMethod ?? "estimated"} timing</span></div>
    {summary.alignment?.warning && <p className="summary-media-warning">Estimated timing: {summary.alignment.warning}</p>}{summary.scenes?.error && <div className="error-box">{summary.scenes.error}</div>}
    {summary.narration?.status === "stale" && summaryNarrationTextAvailable(summary) && <p className="summary-media-warning">Using stale narration — scenes can still be generated from the existing narration; regenerate narration first only if you want the plan based on the latest changes.</p>}
    {planDirty && <p className="summary-media-warning">Scene order or deletion has unsaved changes. Save all scene edits to apply the new plan.</p>}
    {planError && <div className="error-box">{planError}</div>}
    {draft.length > 0 && <SceneFilmstrip scenes={draft} imageFor={(scene) => scene.artwork.imageFingerprint ? `/api${props.base}/artwork/${scene.id}?v=${scene.artwork.imageFingerprint}` : undefined} statusFor={(scene) => scene.disabled ? "Disabled" : `${scene.artwork.review} artwork`} onSelect={(scene) => document.getElementById(`summary-scene-${summary.id}-${scene.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" })} />}
    <div className="summary-visual-actions"><button className="button primary" disabled={working || anyDirty || !summaryNarrationTextAvailable(summary)} onClick={() => { if (!summary.scenePlan || confirm("Regenerate all scenes? Manual visual directions may be replaced; approved artwork is preserved for review.")) void run("scenes", { ...input, force: Boolean(summary.scenePlan) }); }}>{summary.scenePlan ? "Regenerate all scenes" : "Generate scenes"}</button>
      <button className="button" disabled={working || anyDirty || !summary.scenePlan || summary.audio?.status !== "current"} onClick={() => void run("scenes", { ...summary.scenePacing, force: false })}>Update timing</button>
      {summary.scenes?.status === "stale" && <button className="button" disabled={working || anyDirty || summary.narration?.status !== "current"} onClick={() => { if (confirm("Accept the existing scene visuals against the current narration and settings? Timing will be refreshed locally.")) void run("scenes", { acceptCurrent: true }, true); }}>Review / mark current</button>}
      <button className="button" disabled={working || !anyDirty} onClick={() => void saveAll()}>{savingAll ? "Saving…" : "Save all scene edits"}</button>{savedScene === "all" && <span role="status">Saved</span>}</div>
    {draft.map((scene, index) => <article id={`summary-scene-${summary.id}-${scene.id}`} tabIndex={-1} className="summary-scene-card" key={scene.id}><header><span className="eyebrow">Scene {String(index + 1).padStart(2, "0")}</span><span>{clock(scene.startSeconds)}–{clock(scene.endSeconds)} · {scene.disabled ? "disabled" : summary.scenePlan?.timingMethod ?? "estimated"}</span><span className="summary-scene-save-state" role="status">{savingScene === scene.id ? "Saving…" : dirtyIds.has(scene.id) ? "Unsaved changes" : savedScene === scene.id ? "Saved" : ""}</span></header>
      <blockquote>{scene.narrationText ?? scene.summary}</blockquote><label>Visual beat<input disabled={working} value={scene.summary} onChange={(event) => edit(scene.id, { summary: event.target.value })} /></label><label>Image prompt<textarea disabled={working} value={scene.visualPrompt} onChange={(event) => edit(scene.id, { visualPrompt: event.target.value })} /></label>
      <div className="summary-form-row"><label>Characters (comma separated)<input disabled={working} value={scene.characters.join(", ")} onChange={(event) => edit(scene.id, { characters: event.target.value.split(",").map((name) => name.trim()).filter(Boolean), entityIds: [] })} /></label><label>Location<input disabled={working} value={scene.location ?? ""} onChange={(event) => edit(scene.id, { location: event.target.value })} /></label></div>
      {scene.characters.length > 0 && <div className="entity-chip-list">{scene.characters.map((name, characterIndex) => { const resolved = resolvedCharacters[scene.id]?.[characterIndex]; return resolved?.entityId && resolved.name === name ? <button type="button" className={`entity-chip ${resolved.profileStatus === "approved" ? "approved" : ""}`} key={`${name}-${characterIndex}`} onClick={() => setActiveProfile({ id: resolved.entityId!, name: resolved.canonicalName ?? name })} title={`Visual Profile for ${resolved.canonicalName ?? name} [${resolved.entityId}]`}><span className="chip-canon-icon">✦</span><span>{resolved.canonicalName && resolved.canonicalName !== name ? `${name} (${resolved.canonicalName})` : name}</span><small>({resolved.profileStatus ?? "no profile"})</small></button> : <span className="entity-chip unlinked" key={`${name}-${characterIndex}`}><span className="chip-canon-icon">?</span><span>{name}</span><small>(unlinked)</small></span>; })}</div>}
      <div className="summary-form-row"><label>Start seconds<input disabled={working} type="number" step="0.1" min={0} value={scene.startSeconds} onChange={(event) => edit(scene.id, { startSeconds: Number(event.target.value) })} /></label><label>End seconds<input disabled={working} type="number" step="0.1" min={0} value={scene.endSeconds} onChange={(event) => edit(scene.id, { endSeconds: Number(event.target.value) })} /></label></div>
      <AdvancedVisualDirection source="summary" direction={scene.direction} overrides={scene.overrides} artDirection={artDirection} summaryPreset={inheritedDirectionLabel()}
        disabled={working} onDirection={(patch) => updateDirection(scene, patch)} onOverrides={(patch) => updateOverrides(scene, patch)} />
      <SummaryContinuityEditor key={`${scene.id}:${continuity[scene.id]?.manualOverride?.revision ?? 0}`} continuity={continuity[scene.id]} busy={continuityBusy === scene.id} onSave={(input) => void updateContinuity(scene.id, input)} onReset={() => void updateContinuity(scene.id)} />
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
    {activeProfile && props.slug && <VisualProfileModal slug={props.slug} entityId={activeProfile.id} entityName={activeProfile.name} onClose={() => setActiveProfile(undefined)} />}
  </section>;
}

export function SummaryArtworkPanel(props: SummaryVisualProps) {
  const { summary } = props; const { run, disabled } = useActions(props); const [selected, setSelected] = useState<string[]>([]);
  const [selectedVersionByScene, setSelectedVersionByScene] = useState<Record<string, string>>({});
  const [versionBusy, setVersionBusy] = useState<string>();
  const [bulkReviewBusy, setBulkReviewBusy] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<"all" | "needs-review" | "approved" | "video-ready">("all");
  const [estimate, setEstimate] = useState<{ imagesToGenerate: number; reusable: number; derivativesToBuild: number; missing: number; stale: number; blockedByVisualProfiles: number; provider: string; model: string }>();
  const [estimating, setEstimating] = useState(false);
  const [reupscaling, setReupscaling] = useState(false);
  const [reupscaleMessage, setReupscaleMessage] = useState("");
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
  const statusFor = (scene: Scene) => grounding.find((item) => item.sceneId === scene.id)?.status ?? "missing";
  const videoReady = (scene: Scene) => scene.artwork.status === "complete" && Boolean(scene.artwork.imageFingerprint) && statusFor(scene) === "current" && !["rejected", "needs-regeneration"].includes(scene.artwork.review);
  const needsReview = (scene: Scene) => scene.artwork.status === "complete" && (scene.artwork.review === "unreviewed" || scene.artwork.review === "needs-regeneration" || statusFor(scene) === "stale");
  const visibleScenes = scenes.filter((scene) => reviewFilter === "all" || reviewFilter === "needs-review" && needsReview(scene) || reviewFilter === "approved" && scene.artwork.review === "approved" || reviewFilter === "video-ready" && videoReady(scene));
  const estimateArtwork = async () => {
    setEstimating(true);
    try { setEstimate(await post<typeof estimate>(`${props.base}/artwork/estimate`, { missingOnly: true })); }
    catch (error) { props.onError(error); }
    finally { setEstimating(false); }
  };
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
  const approveVersion = async (sceneId: string, versionId: string) => {
    setVersionBusy(sceneId);
    try {
      const result = await put<{ summary: StorySummary }>(`${props.base}/artwork/${sceneId}/versions/${versionId}`, {});
      props.onChange(result.summary);
    } catch (error) { props.onError(error); }
    finally { setVersionBusy(undefined); }
  };
  const reupscale = async (ids?: string[]) => {
    setReupscaling(true); setReupscaleMessage("");
    try {
      const targets = ids?.length ? ids.map((sceneId) => ({ sceneId })) : [{}];
      let count = 0; const warnings: string[] = [];
      for (const input of targets) {
        const result = await post<{ rederived: unknown[]; warnings: string[] }>(`${props.base}/reupscale`, input);
        count += result.rederived.length; warnings.push(...result.warnings);
      }
      setReupscaleMessage(`${count} production image${count === 1 ? "" : "s"} updated from preserved originals. ${warnings.join(" ")}`.trim());
      props.onChange((await api<{ summary: StorySummary }>(props.base)).summary);
    } catch (error) { props.onError(error); }
    finally { setReupscaling(false); }
  };
  const markSelectedNeedsRegeneration = async () => {
    if (!selected.length || !confirm(`Mark ${selected.length} selected scene${selected.length === 1 ? "" : "s"} as needing artwork regeneration? This changes review state only; no image provider is called.`)) return;
    setBulkReviewBusy(true);
    try {
      let latest: StorySummary | undefined;
      for (const id of selected) latest = (await put<{ summary: StorySummary }>(`${props.base}/artwork/${id}`, { review: "needs-regeneration" })).summary;
      if (latest) props.onChange(latest);
      setSelected([]);
    } catch (error) { props.onError(error); }
    finally { setBulkReviewBusy(false); }
  };
  return <section className="summary-media-editor"><header><span className="eyebrow">Canonical visual continuity</span><h3>Scene artwork</h3><p>Uses this book’s image provider, style, and canonical visual references. Approved work is protected unless you explicitly regenerate it.</p></header>
    <div className="summary-meta"><span>{grounding.some((item) => item.status === "stale") ? "stale" : summary.artwork?.status ?? "Not generated"}</span><span>{scenes.length} enabled scenes</span></div>{summary.artwork?.error && <div className="error-box">{summary.artwork.error}</div>}
    {summary.scenes?.status === "stale" && scenes.length > 0 && <p className="summary-media-warning">The scene plan is stale — artwork will use the existing plan; regenerate scenes first only if you want artwork based on the latest narration.</p>}
    <div className="summary-visual-actions"><button className="button primary" disabled={artworkDisabled || !scenes.length} onClick={() => void requestArtwork({ missingOnly: true })}>Generate missing artwork</button><button className="button" disabled={artworkDisabled || !selected.length || !scenes.length} onClick={() => regenerate(selected)}>Regenerate selected</button><button className="button" disabled={artworkDisabled || bulkReviewBusy || !selected.length} onClick={() => void markSelectedNeedsRegeneration()}>{bulkReviewBusy ? "Updating review…" : "Mark selected needs regeneration"}</button><button className="button" disabled={artworkDisabled || !scenes.length} onClick={() => regenerate()}>Regenerate all</button><button className="button" disabled={artworkDisabled || estimating || !scenes.length} onClick={() => void estimateArtwork()}>{estimating ? "Estimating…" : "Estimate artwork"}</button><button className="button" disabled={artworkDisabled || reupscaling || !selected.length} onClick={() => void reupscale(selected)}>{reupscaling ? "Re-upscaling…" : `Re-upscale selected (${selected.length})`}</button><button className="button" disabled={artworkDisabled || reupscaling || !scenes.length} onClick={() => void reupscale()}>Re-upscale all</button><button className="button" onClick={() => setSelected(selected.length === visibleScenes.length ? [] : visibleScenes.map((scene) => scene.id))}>Select visible</button></div>
    {reupscaleMessage && <p role="status" className="summary-media-note">{reupscaleMessage}</p>}
    {estimate && <div className="summary-meta" role="status"><span>{estimate.imagesToGenerate} images to generate</span><span>{estimate.missing} missing · {estimate.stale} stale candidates</span><span>{estimate.reusable} reusable</span><span>{estimate.derivativesToBuild} local derivatives</span><span>{estimate.blockedByVisualProfiles} Visual Profile decisions</span><span>{estimate.provider} · {estimate.model}</span><span>Dry run · no image requests</span></div>}
    <div className="scene-filter-bar" aria-label="Artwork review filter">{([["all", "All"], ["needs-review", "Needs Review"], ["approved", "Approved"], ["video-ready", "Video Ready"]] as const).map(([value, label]) => <button key={value} type="button" className={`filter-btn ${reviewFilter === value ? "active" : ""}`} onClick={() => { setReviewFilter(value); setSelected([]); }}>{label}</button>)}</div>
    {!scenes.length && <p>Generate scenes first.</p>}
    <p className="summary-media-note">Artwork uses the currently saved visual beat, image prompt, canonical identities, and available references. It does not regenerate the scene plan.</p>
    <div className="summary-artwork-grid">{visibleScenes.map((scene) => { const versions = scene.artwork.versions ?? []; const chosen = versions.find((item) => item.id === selectedVersionByScene[scene.id]) ?? versions.find((item) => item.id === scene.artwork.approvedVersionId) ?? versions.at(-1); const url = chosen ? `/api${props.base}/artwork/${scene.id}/versions/${chosen.id}` : `/api${props.base}/artwork/${scene.id}?v=${scene.artwork.imageFingerprint ?? ""}`; const state = grounding.find((item) => item.sceneId === scene.id); return <article className="summary-scene-card" key={scene.id}><header><label><input type="checkbox" checked={selected.includes(scene.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, scene.id] : selected.filter((id) => id !== scene.id))} /> {scene.id}</label><span>{state?.status === "stale" ? "Scene changed — artwork is stale" : state?.status === "missing" ? "Artwork missing" : state?.status === "current" ? "Artwork current" : scene.artwork.status} · {scene.artwork.review}</span></header>
      {versions.length > 0 && <div className="version-tabs-bar"><div className="version-tabs">{versions.map((version) => <button type="button" key={version.id} className={`version-tab ${chosen?.id === version.id ? "active" : ""} ${scene.artwork.approvedVersionId === version.id ? "is-approved" : ""}`} onClick={() => setSelectedVersionByScene((current) => ({ ...current, [scene.id]: version.id }))}>v{version.versionNumber}{scene.artwork.approvedVersionId === version.id ? " ✓" : ""}</button>)}</div>{chosen && scene.artwork.approvedVersionId !== chosen.id && <button type="button" className="button small" disabled={artworkDisabled || versionBusy === scene.id} onClick={() => void approveVersion(scene.id, chosen.id)}>Approve v{chosen.versionNumber}</button>}</div>}
      {chosen && <div className="summary-meta"><span>{new Date(chosen.createdAt).toLocaleString()}</span><span>{chosen.provider} · {chosen.model}</span>{chosen.original && <span>Original {chosen.original.width}×{chosen.original.height}</span>}<span>Upscale: {chosen.upscale?.status ?? "not applied"}</span><span>{scene.artwork.approvedVersionId === chosen.id ? "Approved version" : chosen.id === versions.at(-1)?.id ? "Latest version" : "Historical version"}</span></div>}
      {(chosen || scene.artwork.imageFingerprint) ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={scene.summary} loading="lazy" /></a> : <p>No artwork yet.</p>}<h4>{scene.summary}</h4>{scene.artwork.error && <div className="error-box">{scene.artwork.error}</div>}<div className="summary-meta"><span>{scene.artwork.provider} {scene.artwork.model}</span>{scene.artwork.manuallyEdited && <span>Manually accepted</span>}</div>
      {state && scene.artwork.imageFingerprint && <VisualGroundingPanel label="Grounding recorded for production version" recorded={!state.legacyGroundingUnknown && Boolean(state.groundingRecorded)}>{chosen && scene.artwork.approvedVersionId !== chosen.id && <span>Grounding below describes the approved production version, not the selected historical preview.</span>}<small>Art direction · production version</small>{state.artDirection ? <span>{state.artDirection.source === "summary-override" ? "Summary override" : state.artDirection.source === "scene-override" ? "Scene override" : state.artDirection.source === "disabled" ? "Disabled" : "Story default"}{state.artDirection.presetName ? ` · ${state.artDirection.presetName}` : ""}{state.artDirection.missingPresetId ? ` · missing preset ${state.artDirection.missingPresetId}; fallback used` : ""}</span> : <span>{state.status === "missing" ? "Not generated yet" : "Legacy artwork — art direction not recorded"}</span>}<small>Visual grounding · production version</small>{state.legacyGroundingUnknown ? <span>Legacy artwork — visual grounding not recorded</span> : state.grounding.length ? state.grounding.map((item) => <span key={item.entityId ?? item.name}>{item.name} — {item.source}{item.primaryReference ? " · primary reference" : item.reference ? " · approved reference" : ""}</span>) : <span>No resolved canonical entities for this scene</span>}{state.approvedHistoricalVersion && <span>Approved historical version retained</span>}</VisualGroundingPanel>}
      <div className="summary-visual-actions"><button className="button" disabled={artworkDisabled || !scenes.length} onClick={() => scene.artwork.imageFingerprint ? regenerate([scene.id]) : void requestArtwork({ scenes: [scene.id] })}>{scene.artwork.imageFingerprint ? "Regenerate artwork from current saved scene" : "Generate artwork from current saved scene"}</button><button className="button" onClick={() => props.onEditScene?.(scene.id)}>Edit scene</button>{scene.artwork.imageFingerprint && <><button className="button" disabled={disabled || versionBusy === scene.id} onClick={() => { if (!confirm(`Approve ${chosen ? `version ${chosen.versionNumber}` : "the production image"} for this scene?`)) return; if (chosen) void approveVersion(scene.id, chosen.id); else void run(`artwork/${scene.id}`, { review: "approved" }, true); }}>Approve displayed image</button><button className="button" disabled={disabled} onClick={() => void run(`artwork/${scene.id}`, { review: "rejected" }, true)}>Reject</button><button className="button" disabled={disabled} onClick={() => void run(`artwork/${scene.id}`, { review: "needs-regeneration" }, true)}>Needs regeneration</button><a className="button" download href={`${url}${url.includes("?") ? "&" : "?"}download=1`}>Download PNG</a></>}</div></article>; })}</div>
    {checkingProfiles && <p className="summary-media-working" role="status">Checking Visual Profiles for scenes that need new artwork…</p>}
    {preflight && <VisualProfileCheckDialog slug={props.slug ?? props.base.split("/")[2] ?? ""} report={preflight} oneTimeEntityIds={oneTimeFallbackIds} onOneTimeEntityIds={setOneTimeFallbackIds} onCancel={cancelArtwork} onContinue={() => void continueArtwork()} onRefresh={() => void refreshPreflight()} onError={props.onError} />}
  </section>;
}

export function SummaryVideoPanel(props: SummaryVisualProps) {
  const { summary } = props; const { run, disabled } = useActions(props);
  const [videoSettings, setVideoSettings] = useState<StoryConfig["video"]>();
  const [preflight, setPreflight] = useState<VisualPreflightReport>();
  const [pendingProduceRequest, setPendingProduceRequest] = useState<Record<string, unknown>>();
  const [oneTimeFallbackIds, setOneTimeFallbackIds] = useState<string[]>([]);
  const [checkingProfiles, setCheckingProfiles] = useState(false);
  useEffect(() => {
    if (!props.slug) return;
    let active = true;
    void api<{ story: StoryConfig }>(`/stories/${props.slug}`).then((result) => { if (active) setVideoSettings(result.story.video); }).catch((error) => { if (active) props.onError(error); });
    return () => { active = false; };
  }, [props.slug]);
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
  const enabledScenes = summary.scenePlan?.scenes.filter((scene) => !scene.disabled) ?? [];
  const missingArtwork = enabledScenes.filter((scene) => scene.artwork.status !== "complete" || !scene.artwork.imageFingerprint).length;
  const rejectedArtwork = enabledScenes.filter((scene) => ["rejected", "needs-regeneration"].includes(scene.artwork.review)).length;
  const unreviewedArtwork = enabledScenes.filter((scene) => scene.artwork.review === "unreviewed").length;
  const checks: ReadinessCheck[] = [
    { label: "Audio", state: !summaryAudioAvailable(summary) ? "blocker" : summary.audio?.status === "stale" ? "warning" : "ready", detail: !summaryAudioAvailable(summary) ? "Mastered audio is missing" : summary.audio?.status === "stale" ? "Retained stale audio will be used" : "Mastered audio available" },
    { label: "Scene plan", state: !summaryScenePlanAvailable(summary) || !enabledScenes.length ? "blocker" : summary.scenes?.status === "stale" ? "warning" : "ready", detail: !enabledScenes.length ? "No enabled scenes" : summary.scenes?.status === "stale" ? "Retained scene plan will be used" : `${enabledScenes.length} enabled scenes` },
    { label: "Artwork", state: missingArtwork || rejectedArtwork || summary.artwork?.status !== "current" ? "blocker" : "ready", detail: missingArtwork ? `${missingArtwork} scene image${missingArtwork === 1 ? "" : "s"} missing` : rejectedArtwork ? `${rejectedArtwork} rejected or needing regeneration` : summary.artwork?.status !== "current" ? "At least one image is stale or damaged; renderer requires current artwork" : "Scene images current" },
    { label: "Review", state: unreviewedArtwork ? "warning" : "ready", detail: unreviewedArtwork ? `${unreviewedArtwork} unreviewed image${unreviewedArtwork === 1 ? "" : "s"}` : "No unreviewed images" },
    { label: "Subtitle timing", state: summary.alignment?.warning ? "warning" : "ready", detail: videoSettings?.subtitleMode === "none" ? "Subtitles disabled" : summary.alignment?.warning ?? "Generated from alignment or narration during render" },
    { label: "Video", state: summary.video?.status === "current" ? "ready" : "warning", detail: summary.video?.status === "current" ? "Current render available" : "Render needed" },
  ];
  return <section className="summary-media-editor"><header><span className="eyebrow">Recap screening room</span><h3>Summary video</h3><p>Uses mastered recap audio, scene artwork, and this book’s video settings. The recap has no silent intro; video length matches its audio.</p></header>
    <VideoReadinessPanel checks={checks} />
    {videoSettings && <div className="summary-meta" aria-label="Effective summary video settings"><span>{videoSettings.resolution ?? `${videoSettings.width}×${videoSettings.height}`} · {videoSettings.fps} FPS</span><span>Subtitles: {videoSettings.subtitleMode}</span><span>Background: {videoSettings.backgroundMode}</span><span>No silent intro</span></div>}
    <div className="summary-meta"><span>{summary.video?.status ?? "Not generated"}</span>{summary.video?.durationSeconds && <span>{clock(summary.video.durationSeconds)}</span>}{summary.video?.width && <span>{summary.video.width} × {summary.video.height}</span>}{summary.video?.sceneCount && <span>{summary.video.sceneCount} scenes</span>}{summary.video?.generatedAt && <span>{new Date(summary.video.generatedAt).toLocaleString()}</span>}<span>Audio: mastered summary narration</span></div>
    {summary.video?.status === "stale" && <p className="summary-media-warning">This video uses older inputs. Produce again to update only missing/stale stages.</p>}{summary.video?.error && <div className="error-box">{summary.video.error}</div>}
    {(summary.audio?.status === "stale" || summary.scenes?.status === "stale") && summaryAudioAvailable(summary) && summaryScenePlanAvailable(summary) && <p className="summary-media-warning">Video will render from the existing stale audio/scene inputs without regenerating them; regenerate those stages first only if you want the video based on the latest changes.</p>}
    {summary.video?.outputFingerprint && <video controls preload="metadata" aria-label="Summary video preview" src={`/api${props.base}/export/video?v=${summary.video.outputFingerprint}`} />}
    <div className="summary-visual-actions"><button className="button primary" disabled={disabled || checkingProfiles || summary.status !== "complete"} onClick={() => produce({})}>Produce summary video</button><button className="button" disabled={disabled || !summaryAudioAvailable(summary) || !summaryScenePlanAvailable(summary)} onClick={() => void run("video", { force: false })}>Generate / update video</button><button className="button" disabled={disabled || !summary.video} onClick={() => { if (confirm("Re-render the video using the existing audio and artwork?")) void run("video", { force: true }); }}>Regenerate video</button>{summary.video?.outputFingerprint && <a className="button" download href={`/api${props.base}/export/video?download=1`}>Download MP4</a>}</div>
    {checkingProfiles && <p className="summary-media-working" role="status">Checking Visual Profiles for summary scenes…</p>}
    {preflight && <VisualProfileCheckDialog slug={props.slug ?? props.base.split("/")[2] ?? ""} report={preflight} oneTimeEntityIds={oneTimeFallbackIds} onOneTimeEntityIds={setOneTimeFallbackIds} onCancel={cancelProduce} onContinue={() => void continueProduce()} onRefresh={() => void refreshPreflight()} onError={props.onError} />}
  </section>;
}
