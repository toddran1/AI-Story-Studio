import { useState } from "react";
import { put } from "./api.js";
import { VisualProfileModal } from "./VisualProfileModal.js";

export type VisualPreflightEntity = { entityId: string; name: string; type: string; state: "missing_profile" | "draft_profile" | "approved_profile" | "skip_profile"; affectedSceneIds: string[] };
export type VisualPreflightReport = { ready: boolean; entities: VisualPreflightEntity[]; requiresDecision: VisualPreflightEntity[]; fingerprint: string };

export function VisualProfileCheckDialog(props: {
  slug: string;
  report: VisualPreflightReport;
  oneTimeEntityIds: string[];
  onOneTimeEntityIds: (ids: string[] | ((current: string[]) => string[])) => void;
  onCancel: () => void;
  onContinue: () => void;
  onRefresh: () => void;
  onError: (error: unknown) => void;
}) {
  const [activeProfile, setActiveProfile] = useState<VisualPreflightEntity>();
  const [savingPolicy, setSavingPolicy] = useState<string>();
  const toggleOneTime = (id: string) => props.onOneTimeEntityIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const persistSkip = async (id: string) => {
    try { setSavingPolicy(id); await put(`/stories/${props.slug}/visual-profiles/${id}/policy`, { mode: "skip" }); props.onRefresh(); }
    catch (error) { props.onError(error); }
    finally { setSavingPolicy(undefined); }
  };
  return <>
    {!activeProfile && <div className="visual-preflight-backdrop" role="presentation">
      <section className="visual-preflight-modal" role="dialog" aria-modal="true" aria-labelledby="visual-profile-check-title">
        <header><div><span className="eyebrow">Artwork gate · no provider calls yet</span><h3 id="visual-profile-check-title">Visual Profile Check</h3></div><button type="button" className="button" onClick={props.onCancel}>Cancel</button></header>
        <p>These on-screen entities do not have approved Visual Profiles. A profile improves continuity, but you can deliberately use the Story Bible fallback instead.</p>
        {props.report.requiresDecision.length ? <div className="visual-preflight-list">
          {props.report.requiresDecision.map((entity) => {
            const oneTime = props.oneTimeEntityIds.includes(entity.entityId);
            return <article key={entity.entityId} className="visual-preflight-entity"><div><span className="visual-preflight-type">{entity.type}</span><h4>{entity.name}</h4><small>{entity.state === "draft_profile" ? "Draft Visual Profile" : "No Visual Profile"} · {entity.affectedSceneIds.length} candidate scene{entity.affectedSceneIds.length === 1 ? "" : "s"}</small></div><div className="visual-preflight-actions"><button type="button" className="button" onClick={() => setActiveProfile(entity)}>{entity.state === "draft_profile" ? "Review / approve profile" : "Create Visual Profile"}</button><button type="button" className={oneTime ? "button active" : "button"} onClick={() => toggleOneTime(entity.entityId)}>{oneTime ? "Will use fallback" : "Generate without profile"}</button><button type="button" className="button subtle-warning" disabled={savingPolicy === entity.entityId} onClick={() => void persistSkip(entity.entityId)}>{savingPolicy === entity.entityId ? "Saving…" : "Always use fallback"}</button></div></article>;
          })}
        </div> : <p className="visual-preflight-ready">Every candidate scene has an approved profile or a saved fallback policy. Continue when you are ready to generate.</p>}
        <footer><small>“Generate without profile” applies only to this request. “Always use fallback” can be reset in the entity’s Visual Profile. Profile edits return here; generation will not start automatically.</small><button type="button" className="button primary" disabled={props.report.requiresDecision.some((entity) => !props.oneTimeEntityIds.includes(entity.entityId))} onClick={props.onContinue}>Continue generation</button></footer>
      </section>
    </div>}
    {activeProfile && <VisualProfileModal slug={props.slug} entityId={activeProfile.entityId} entityName={activeProfile.name} onClose={() => { setActiveProfile(undefined); props.onRefresh(); }} onUpdated={props.onRefresh} />}
  </>;
}
