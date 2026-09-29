import React, { useState, useEffect, useRef } from "react";
import {
  VisualEntityProfile,
  VisualRole,
  VisualEntityType,
  getVisualProfile,
  updateVisualProfile,
  uploadVisualReference,
  generateStyleSheet,
  approveVisualReference,
  deleteVisualReference,
  getVisualProfilePolicy,
  updateVisualProfilePolicy,
  applyVisualProfileProposal,
  inspectVisualProfile,
  proposeVisualProfile,
  resolveVisualProfileConflict,
  VisualProfileFieldState,
  VisualProfileProposal,
} from "./api.js";

interface VisualProfileModalProps {
  slug: string;
  entityId: string;
  entityName?: string;
  onClose: () => void;
  onUpdated?: (profile: VisualEntityProfile) => void;
}

const VISUAL_ROLES: { value: VisualRole; label: string }[] = [
  { value: "primary_reference", label: "Primary Reference" },
  { value: "front", label: "Front View" },
  { value: "three_quarter", label: "Three-Quarter View" },
  { value: "side", label: "Side Profile" },
  { value: "back", label: "Back View" },
  { value: "face_portrait", label: "Face Portrait / Close-up" },
  { value: "full_body", label: "Full Body" },
  { value: "expression_sheet", label: "Expression Sheet" },
  { value: "outfit_sheet", label: "Outfit Sheet" },
  { value: "equipment_reference", label: "Equipment / Weapon Reference" },
  { value: "environment_reference", label: "Environment Reference" },
  { value: "general_reference", label: "General Reference" },
];

const VISUAL_ENTITY_TYPES: { value: VisualEntityType; label: string }[] = [
  { value: "character", label: "Character" },
  { value: "creature", label: "Creature / Monster" },
  { value: "location", label: "Location / Setting" },
  { value: "item", label: "Item / Artifact" },
  { value: "weapon", label: "Weapon / Equipment" },
  { value: "object", label: "Object / Vehicle" },
  { value: "faction", label: "Faction / Group" },
  { value: "other", label: "Other" },
];

export function genderSelectionValue(value?: string): "male" | "female" | "" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "male" || normalized === "man") return "male";
  if (normalized === "female" || normalized === "woman") return "female";
  return "";
}

export function GenderSelect({ id, value, onChange }: { id?: string; value?: string; onChange: (value: "male" | "female") => void }) {
  return <select id={id} aria-label="Gender" value={genderSelectionValue(value)} onChange={(event) => onChange(event.target.value as "male" | "female")}>
    <option value="" disabled hidden>Select gender</option>
    <option value="male">Male</option>
    <option value="female">Female</option>
  </select>;
}

export function FigureSettings({ gender, figure, onChange }: { gender?: string; figure?: "smaller" | "normal" | "larger"; onChange: (value: "smaller" | "normal" | "larger") => void }) {
  if (genderSelectionValue(gender) !== "female") return null;
  return <details className="figure-settings">
    <summary>Figure (mature styling)</summary>
    <p className="hint-text">Only applies when the story's Mature (21+) artwork style is enabled.</p>
    <div className="figure-options">
      {([["smaller", "Smaller · default proportions"], ["normal", "Normal · curvy"], ["larger", "Larger · very curvy"]] as const).map(([value, label]) => (
        <label className="proposal-field" key={value}>
          <input type="radio" name="visual-profile-figure" value={value} checked={(figure ?? "normal") === value} onChange={() => onChange(value)} />
          <span>{label}</span>
        </label>
      ))}
    </div>
  </details>;
}

export function VisualProfileModal({
  slug,
  entityId,
  entityName,
  onClose,
  onUpdated,
}: VisualProfileModalProps) {
  const [profile, setProfile] = useState<VisualEntityProfile | null>(null);
  const loadedProfile = useRef<VisualEntityProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generatingSheet, setGeneratingSheet] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [completeness, setCompleteness] = useState<Awaited<ReturnType<typeof inspectVisualProfile>> | null>(null);
  const [regenerationExpanded, setRegenerationExpanded] = useState(false);
  const [proposalExpanded, setProposalExpanded] = useState(true);
  const [proposal, setProposal] = useState<VisualProfileProposal | null>(null);
  const [selectedProposalFields, setSelectedProposalFields] = useState<string[]>([]);
  const [proposing, setProposing] = useState(false);
  const [selectedRegenerationFields, setSelectedRegenerationFields] = useState<string[]>([]);
  const [viewingReference, setViewingReference] = useState<VisualEntityProfile["references"][number] | null>(null);
  const [referenceZoom, setReferenceZoom] = useState(1);
  const [visualProfilePolicy, setVisualProfilePolicy] = useState<"prompt" | "skip">("prompt");
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"appearance" | "details" | "references">("appearance");
  const [uploadRole, setUploadRole] = useState<VisualRole>("general_reference");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const referenceUrl = (refId: string, download = false) => `/api/stories/${encodeURIComponent(slug)}/visual-profiles/${encodeURIComponent(entityId)}/references/${encodeURIComponent(refId)}${download ? "?download=1" : ""}`;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getVisualProfile(slug, entityId)
      .then((res) => {
        if (active) {
          loadedProfile.current = res;
          setProfile(res);
          inspectVisualProfile(slug, entityId).then(setCompleteness).catch(() => undefined);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
            const now = new Date().toISOString();
            inspectVisualProfile(slug, entityId).then((inspection) => {
              if (!active) return;
              setCompleteness(inspection);
              setProfile({
                id: `vprof_draft_${entityId}`, entityId, visualType: inspection.profile.visualType, status: "draft", appearance: "", visualPrompt: "", negativePrompt: "", notes: "", variants: [], references: [], conflicts: [], revision: 1, createdAt: now, updatedAt: now,
              });
              setLoading(false);
            }).catch((inspectionError) => { if (active) { setError(inspectionError instanceof Error ? inspectionError.message : String(inspectionError)); setLoading(false); } });
          } else {
            setError(msg);
            setLoading(false);
          }
        }
      });
    return () => {
      active = false;
    };
  }, [slug, entityId]);

  useEffect(() => {
    let active = true;
    void getVisualProfilePolicy(slug, entityId).then((policy) => { if (active) setVisualProfilePolicy(policy.mode); }).catch(() => undefined);
    return () => { active = false; };
  }, [slug, entityId]);

  const handleVisualProfilePolicy = async (mode: "prompt" | "skip") => {
    try {
      setError(null);
      await updateVisualProfilePolicy(slug, entityId, mode);
      setVisualProfilePolicy(mode);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  useEffect(() => {
    if (!viewingReference) return;
    document.querySelector<HTMLElement>(".reference-viewer .btn-close")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setViewingReference(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [viewingReference]);

  const reloadSavedProfile = async () => {
    if (profile && loadedProfile.current && JSON.stringify(profile) !== JSON.stringify(loadedProfile.current) && !window.confirm("Discard unsaved Visual Profile changes and load the latest saved version?")) return;
    setLoading(true); setError(null);
    try { const latest = await getVisualProfile(slug, entityId); loadedProfile.current = latest; setProfile(latest); setCompleteness(await inspectVisualProfile(slug, entityId)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  };

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!profile) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateVisualProfile(slug, entityId, profile);
      loadedProfile.current = updated;
      setProfile(updated);
      onUpdated?.(updated);
      await inspectVisualProfile(slug, entityId).then(setCompleteness);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const useStoryBibleEvidence = () => {
    if (!profile || profile.status === "approved") return;
    const facts = completeness?.context?.storyBibleVisualEvidence?.values ?? {};
    const next = structuredClone(profile);
    for (const [path, evidence] of Object.entries(facts)) {
      const [section, field] = path.split(".") as ["character" | "location" | "creature" | "item", string];
      if (!["character", "location", "creature", "item"].includes(section)) continue;
      if (section !== (["weapon", "object"].includes(profile.visualType) ? "item" : profile.visualType)) continue;
      if (!completeness?.fields.some((item) => item.path === path)) continue;
      const existing = (next[section] as Record<string, string | undefined> | undefined)?.[field];
      if (existing?.trim() || next.fieldProvenance?.[path]?.locked) continue;
      (next as unknown as Record<string, Record<string, string>>)[section] ??= {};
      (next as unknown as Record<string, Record<string, string>>)[section]![field] = evidence.value;
      next.fieldProvenance ??= {};
      next.fieldProvenance[path] = { source: "source_text", locked: false };
    }
    setProfile(next);
    setActiveTab("details");
  };

  const handleStatusToggle = async () => {
    if (!profile) return;
    const nextStatus = profile.status === "approved" ? "draft" : "approved";
    setSaving(true);
    setError(null);
    try {
      const updated = await updateVisualProfile(slug, entityId, { ...profile, status: nextStatus });
      setProfile(updated);
      onUpdated?.(updated);
      await inspectVisualProfile(slug, entityId).then(setCompleteness);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setSaving(false); }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      if (file.size > 26 * 1024 * 1024) throw new Error("Reference image exceeds 15 MB. Choose a smaller image.");
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const res = reader.result as string;
          const base64 = res.includes(",") ? res.split(",")[1] : res;
          resolve(base64!);
        };
        reader.onerror = (error) => reject(error);
      });
      reader.readAsDataURL(file);
      const dataBase64 = await base64Promise;

      const uploaded = await uploadVisualReference(slug, entityId, {
        filename: file.name,
        dataBase64,
        ext: file.name.split(".").pop()?.toLowerCase(),
        role: uploadRole,
      });

      setProfile(uploaded.profile);
      onUpdated?.(uploaded.profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
      setUploading(false);
    }
  };

  const handleGenerateStyleSheet = async () => {
    setGeneratingSheet(true);
    setError(null);
    try {
      const res = await generateStyleSheet(slug, entityId);
      setProfile(res.profile);
      onUpdated?.(res.profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingSheet(false);
    }
  };

  const openReference = (reference: VisualEntityProfile["references"][number]) => { setReferenceZoom(1); setViewingReference(reference); };
  const handleDownloadReference = async (reference: VisualEntityProfile["references"][number]) => {
    setError(null);
    try {
      const response = await fetch(referenceUrl(reference.id, true));
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(typeof payload.error === "string" ? payload.error : "Reference image could not be downloaded");
      }
      const blob = await response.blob();
      const header = response.headers.get("content-disposition") ?? "";
      const filename = /filename="?([^";]+)"?/i.exec(header)?.[1] ?? `${entityName || "reference"}-${reference.role.replaceAll("_", "-")}.png`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = filename; link.click();
      URL.revokeObjectURL(url);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const handleDeleteReference = async (reference: VisualEntityProfile["references"][number]) => {
    const confirmation = reference.role === "primary_reference"
      ? "This is the current Primary Reference for this character. Deleting it may reduce visual consistency in future artwork. Delete it anyway?"
      : "Delete this reference image? This will remove it from the Visual Profile and delete its stored image file.";
    if (!window.confirm(confirmation)) return;
    setSaving(true);
    setError(null);
    try {
      const result = await deleteVisualReference(slug, entityId, reference.id);
      if (!result.deleted) throw new Error("This reference image was already removed. Refresh the profile and try again.");
      setProfile(result.profile);
      onUpdated?.(result.profile);
      if (viewingReference?.id === reference.id) setViewingReference(null);
      if (result.cleanupWarnings?.length) setError(result.cleanupWarnings.join(" "));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handlePropose = async (regenerate = false, requestedFields?: string[]) => {
    if (!profile) return;
    setProposing(true);
    setError(null);
    try {
      const fields = requestedFields ?? (regenerate ? selectedRegenerationFields : undefined);
      const next = await proposeVisualProfile(slug, entityId, { fields, regenerate });
      setProposal(next); setProposalExpanded(true);
      setSelectedProposalFields(Object.keys(next.values));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProposing(false);
    }
  };

  const refreshInspection = async () => setCompleteness(await inspectVisualProfile(slug, entityId));

  const handleResolveConflict = async (conflictId: string, action: "accept_canonical" | "retain_manual_override") => {
    setSaving(true); setError(null);
    try {
      const updated = await resolveVisualProfileConflict(slug, entityId, conflictId, action);
      setProfile(updated); onUpdated?.(updated); await refreshInspection();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };

  const handleApplyProposal = async () => {
    if (!proposal) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await applyVisualProfileProposal(slug, entityId, proposal, selectedProposalFields);
      setProfile(updated);
      setProposal(null);
      setRegenerationExpanded(false); setSelectedRegenerationFields([]);
      setSelectedProposalFields([]);
      onUpdated?.(updated);
      await refreshInspection();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleApproveReference = async (refId: string, primary: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await approveVisualReference(slug, entityId, refId, primary);
      setProfile(updated);
      onUpdated?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal-content visual-profile-modal" role="dialog" aria-modal={!viewingReference} aria-label={`Visual Profile: ${entityName || entityId}`} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Visual Profile: {entityName || entityId}</h3>
            <button className="btn-close" aria-label="Close Visual Profile" onClick={onClose}>✕</button>
          </div>
          <div className="modal-body loading-indicator">Loading visual profile...</div>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal-content visual-profile-modal" role="dialog" aria-modal={!viewingReference} aria-label={`Visual Profile: ${entityName || entityId}`} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Visual Profile</h3>
            <button className="btn-close" aria-label="Close Visual Profile" onClick={onClose}>✕</button>
          </div>
          <div className="modal-body error-box">{error || "Could not load profile"}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content visual-profile-modal" role="dialog" aria-modal={!viewingReference} aria-label={`Visual Profile: ${entityName || entityId}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-row">
            <h3>Visual Profile: {entityName || profile.entityId}</h3>
            <span
              className={`badge status-${profile.status}`}

            >
              {profile.status === "approved" ? "✓ Approved Canon" : "Draft (Not Enforced)"}
            </span>
            {completeness && <small>{completeness.coreComplete} / {completeness.coreTotal} core details established</small>}
            {Boolean(Object.keys(completeness?.context?.storyBibleVisualEvidence?.values ?? {}).length) && <small>Story Bible visual evidence available</small>}
            {Boolean(Object.keys(completeness?.context?.storyBibleVisualEvidence?.conflicts ?? {}).length) && <small>Story Bible visual facts conflict; review source chapters</small>}
          </div>
          <div className="visual-profile-header-actions"><button type="button" className="btn btn-outline" onClick={() => void reloadSavedProfile()}>Reload saved profile</button><button className="btn-close" aria-label="Close Visual Profile" onClick={onClose}>✕</button></div>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {profile.status === "draft" && Boolean(Object.keys(completeness?.context?.storyBibleVisualEvidence?.values ?? {}).length) && <button type="button" className="btn-secondary" onClick={useStoryBibleEvidence}>Use Story Bible visual facts in this draft</button>}

        <div className="modal-tabs">
          <button
            className={`tab-btn ${activeTab === "appearance" ? "active" : ""}`}
            onClick={() => setActiveTab("appearance")}
          >
            Appearance & Prompts
          </button>
          <button
            className={`tab-btn ${activeTab === "details" ? "active" : ""}`}
            onClick={() => setActiveTab("details")}
          >
            Specific Visual Traits{completeness ? ` · ${completeness.coreComplete}/${completeness.coreTotal}` : ""}
          </button>
          <button
            className={`tab-btn ${activeTab === "references" ? "active" : ""}`}
            onClick={() => setActiveTab("references")}
          >
            Reference Images ({profile.references.length})
          </button>
        </div>

        <div className="modal-body">
              {proposal && activeTab !== "references" && (
                <details className="visual-proposal-panel" open={proposalExpanded} onToggle={(event) => setProposalExpanded(event.currentTarget.open)}>
                  <summary>AI visual proposal · {selectedProposalFields.length} selected</summary>
                  {proposal.rationale && <p className="hint-text">{proposal.rationale}</p>}
                  {Object.entries(proposal.values).map(([field, value]) => (
                    <label key={field} className="proposal-field"><input type="checkbox" checked={selectedProposalFields.includes(field)} onChange={(event) => setSelectedProposalFields((items) => event.target.checked ? [...items, field] : items.filter((item) => item !== field))} /><span><b>{field.replace(/^(character|location|creature|item)\./, "").replace(/([a-z])([A-Z])/g, "$1 $2")}</b><br />{value}</span></label>
                  ))}
                  {!Object.keys(proposal.values).length && <p className="hint-text">No safe missing details were proposed.</p>}
                  <div className="proposal-actions"><button type="button" className="btn btn-primary" onClick={handleApplyProposal} disabled={saving || !selectedProposalFields.length}>Apply selected</button><button type="button" className="btn btn-outline" onClick={() => setProposal(null)}>Cancel</button></div>
                </details>
              )}

          {activeTab === "appearance" && (
            <div className="form-group-stack">
              <section className="visual-completion-panel">
                <div><strong>Generate appearance &amp; prompts</strong><p className="hint-text">Propose missing appearance, visual prompt, and negative prompt fields. Review suggestions before applying. Internal studio notes are manual.</p></div>
                <button type="button" className="btn btn-primary" disabled={proposing || saving} onClick={() => handlePropose(false, ["appearance", "visualPrompt", "negativePrompt"])}>{proposing ? "Preparing proposal…" : "Generate appearance & prompts with AI"}</button>
              </section>
              <div className="form-row">
                <label>Visual Entity Type</label>
                <select
                  value={profile.visualType}
                  onChange={(e) =>
                    setProfile({
                      ...profile,
                      visualType: e.target.value as VisualEntityType,
                    })
                  }
                >
                  {VISUAL_ENTITY_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-row">
                <label>Visual Prompt Snippet (Used in artwork prompts)</label>
                <textarea
                  rows={3}
                  value={profile.visualPrompt}
                  onChange={(e) =>
                    setProfile({ ...profile, visualPrompt: e.target.value })
                  }
                  placeholder="e.g. sharp jawline, pale skin, silver hair tied in a loose ponytail, piercing dark violet eyes..."
                />
              </div>

              <div className="form-row">
                <label>Appearance Description (Full canonical physical description)</label>
                <textarea
                  rows={4}
                  value={profile.appearance}
                  onChange={(e) =>
                    setProfile({ ...profile, appearance: e.target.value })
                  }
                  placeholder="Detailed narrative description of appearance, build, clothing, demeanor..."
                />
              </div>

              <div className="form-row">
                <label>Negative Prompt Additions</label>
                <input
                  type="text"
                  value={profile.negativePrompt}
                  onChange={(e) =>
                    setProfile({ ...profile, negativePrompt: e.target.value })
                  }
                  placeholder="e.g. beard, smiling, modern clothes, blonde hair"
                />
              </div>

              <div className="form-row">
                <label>Internal Studio Notes</label>
                <textarea
                  rows={2}
                  value={profile.notes}
                  onChange={(e) =>
                    setProfile({ ...profile, notes: e.target.value })
                  }
                  placeholder="Notes for production staff or visual continuity..."
                />
              </div>
            </div>
          )}

          {activeTab === "details" && (
            <div className="form-group-stack">
              {["character", "location", "creature", "item", "weapon", "object"].includes(profile.visualType) && (
                <section className="visual-completion-panel">
                  <div>
                    <strong>Persistent visual identity</strong>
                    <p className="hint-text">{completeness ? `${completeness.coreComplete} / ${completeness.coreTotal} core details established.` : "Checking missing details…"} More details are optional. Existing and locked details stay protected until you explicitly apply a proposal.</p>
                  </div>
                  <button type="button" className="btn btn-primary" disabled={proposing} onClick={() => handlePropose(false)}>{proposing ? "Preparing proposal…" : "Generate missing details with AI"}</button>
                </section>
              )}
              {completeness?.conflicts.filter((conflict) => conflict.status === "needs_review").map((conflict) => (
                <section className="visual-conflict-panel" key={conflict.id}>
                  <strong>Source conflict · {conflict.field.replace(/^(character|location|creature|item)\./, "").replace(/([a-z])([A-Z])/g, "$1 $2")}</strong>
                  <p className="hint-text">Source-backed value: <b>{conflict.canonicalValue}</b><br />Earlier AI suggestion: <b>{conflict.visualValue}</b></p>
                  <div className="proposal-actions"><button type="button" className="btn btn-primary" disabled={saving} onClick={() => handleResolveConflict(conflict.id, "accept_canonical")}>Use source-backed value</button><button type="button" className="btn btn-outline" disabled={saving} onClick={() => handleResolveConflict(conflict.id, "retain_manual_override")}>Keep as manual override</button></div>
                </section>
              ))}
              {completeness?.fields.some((field) => field.regenerable) && (
                <details className="visual-regeneration-panel" open={regenerationExpanded} onToggle={(event) => setRegenerationExpanded(event.currentTarget.open)}>
                  <summary>Regenerate selected AI details</summary>
                  <p className="hint-text">Only unlocked AI suggestions are eligible. Source-backed and manual fields stay protected.</p>
                  {completeness.fields.filter((field) => field.regenerable).map((field) => <label className="proposal-field" key={field.path}><input type="checkbox" checked={selectedRegenerationFields.includes(field.path)} onChange={(event) => setSelectedRegenerationFields((items) => event.target.checked ? [...items, field.path] : items.filter((item) => item !== field.path))} /><span>{field.path.replace(/^(character|location|creature|item)\./, "").replace(/([a-z])([A-Z])/g, "$1 $2")} <small>AI suggestion</small></span></label>)}
                  <button type="button" className="btn btn-secondary" disabled={proposing || !selectedRegenerationFields.length} onClick={() => handlePropose(true)}>{proposing ? "Preparing proposal…" : "Regenerate selected details"}</button>
                </details>
              )}
              {profile.visualType === "character" && (
                <>
                  <div className="form-grid-2col">
                    <div>
                      <label>Apparent Age (years)</label>
                      {profile.character?.apparentAge && !/^\d+$/.test(profile.character.apparentAge) && <small className="hint-text">Saved age “{profile.character.apparentAge}” is kept until you enter a whole number.</small>}
                      <input
                        type="number"
                        min={0}
                        step={1}
                        inputMode="numeric"
                        aria-label="Apparent age"
                        value={/^\d+$/.test(profile.character?.apparentAge ?? "") ? profile.character!.apparentAge : ""}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            character: {
                              ...profile.character,
                              apparentAge: /^\d*$/.test(e.target.value) ? e.target.value : profile.character?.apparentAge,
                            },
                          })
                        }
                      />
                    </div>
                    <div>
                      <label htmlFor="visual-profile-gender">Gender</label>
                      <GenderSelect
                        id="visual-profile-gender"
                        value={profile.character?.gender || ""}
                        onChange={(gender) => setProfile({ ...profile, character: { ...profile.character, gender } })}
                      />
                      {profile.character?.gender && !genderSelectionValue(profile.character.gender) && <small className="hint-text">Saved value “{profile.character.gender}” is kept until you choose Male or Female.</small>}
                    </div>
                    <FigureSettings
                      gender={profile.character?.gender}
                      figure={profile.character?.figure}
                      onChange={(figure) => setProfile({ ...profile, character: { ...profile.character, figure } })}
                    />
                    <div>
                      <label>Height</label>
                      <input
                        type="text"
                        value={profile.character?.height || ""}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            character: {
                              ...profile.character,
                              height: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                    <div>
                      <label>Build / Physique</label>
                      <input
                        type="text"
                        value={profile.character?.build || ""}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            character: {
                              ...profile.character,
                              build: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                    <div>
                      <label>Hair Color</label>
                      <input
                        type="text"
                        value={profile.character?.hairColor || ""}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            character: {
                              ...profile.character,
                              hairColor: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                    <div>
                      <label>Hairstyle</label>
                      <input
                        type="text"
                        value={profile.character?.hairstyle || ""}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            character: {
                              ...profile.character,
                              hairstyle: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                    <div>
                      <label>Eye Color</label>
                      <input
                        type="text"
                        value={profile.character?.eyeColor || ""}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            character: {
                              ...profile.character,
                              eyeColor: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                    <div>
                      <label>Skin Tone</label>
                      <input
                        type="text"
                        value={profile.character?.skinTone || ""}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            character: {
                              ...profile.character,
                              skinTone: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="form-row">
                    <label>Default Outfit / Garments</label>
                    <textarea
                      rows={2}
                      value={profile.character?.defaultOutfit || ""}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          character: {
                            ...profile.character,
                            defaultOutfit: e.target.value,
                          },
                        })
                      }
                      placeholder="e.g. Midnight blue high-collared coat with silver embroidery, black leather boots..."
                    />
                  </div>

                  <div className="form-row">
                    <label>Weapons & Equipment</label>
                    <input
                      type="text"
                      value={profile.character?.weapons || ""}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          character: {
                            ...profile.character,
                            weapons: e.target.value,
                          },
                        })
                      }
                      placeholder="e.g. Ebony-hilted bone dagger, enchanted bronze ring"
                    />
                  </div>

                  <div className="form-row">
                    <label>Scars, Tattoos, or Marks</label>
                    <input
                      type="text"
                      value={profile.character?.distinguishingFeatures || ""}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          character: {
                            ...profile.character,
                            distinguishingFeatures: e.target.value,
                          },
                        })
                      }
                      placeholder="e.g. Thin scar across left eyebrow, runic tattoo on right wrist"
                    />
                  </div>
                </>
              )}

              {profile.visualType === "location" && (
                <>
                  <div className="form-row">
                    <label>Architecture & Structure</label>
                    <input
                      type="text"
                      value={profile.location?.architecture || ""}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          location: {
                            ...profile.location,
                            architecture: e.target.value,
                          },
                        })
                      }
                      placeholder="e.g. Ancient stone ramparts, towering gothic obsidian spires"
                    />
                  </div>
                  <div className="form-row">
                    <label>Terrain & Vegetation</label>
                    <input
                      type="text"
                      value={profile.location?.terrain || ""}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          location: {
                            ...profile.location,
                            terrain: e.target.value,
                          },
                        })
                      }
                      placeholder="e.g. Jagged limestone cliffs, dead leafless briars"
                    />
                  </div>
                  <div className="form-row">
                    <label>Lighting & Atmosphere</label>
                    <input
                      type="text"
                      value={profile.location?.lighting || ""}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          location: {
                            ...profile.location,
                            lighting: e.target.value,
                          },
                        })
                      }
                      placeholder="e.g. Dim sickly green moonlight through thick creeping fog"
                    />
                  </div>
                  <div className="form-row">
                    <label>Color Palette</label>
                    <input
                      type="text"
                      value={profile.location?.colorPalette || ""}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          location: {
                            ...profile.location,
                            colorPalette: e.target.value,
                          },
                        })
                      }
                      placeholder="e.g. Charcoal black, muted teal, phosphor green"
                    />
                  </div>
                  <div className="form-row">
                    <label>Canonical Environment Prompt</label>
                    <textarea
                      rows={3}
                      value={profile.location?.canonicalEnvironmentPrompt || ""}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          location: {
                            ...profile.location,
                            canonicalEnvironmentPrompt: e.target.value,
                          },
                        })
                      }
                    />
                  </div>
                </>
              )}

              {profile.visualType === "creature" && (
                <>
                  <div className="form-grid-2col">
                    <div>
                      <label>Species / Subtype</label>
                      <input
                        type="text"
                        value={profile.creature?.species || ""}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            creature: {
                              ...profile.creature,
                              species: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                    <div>
                      <label>Scale / Size Relative to Human</label>
                      <input
                        type="text"
                        value={profile.creature?.sizeRelativeToHuman || ""}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            creature: {
                              ...profile.creature,
                              sizeRelativeToHuman: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <label>Anatomy & Distinctive Features</label>
                    <textarea
                      rows={3}
                      value={profile.creature?.anatomy || ""}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          creature: {
                            ...profile.creature,
                            anatomy: e.target.value,
                          },
                        })
                      }
                    />
                  </div>
                  <div className="form-row">
                    <label>Canonical Creature Prompt</label>
                    <textarea
                      rows={2}
                      value={profile.creature?.canonicalCreaturePrompt || ""}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          creature: {
                            ...profile.creature,
                            canonicalCreaturePrompt: e.target.value,
                          },
                        })
                      }
                    />
                  </div>
                </>
              )}

              {(profile.visualType === "item" || profile.visualType === "weapon" || profile.visualType === "object") && (
                <>
                  <div className="form-grid-2col">
                    <div>
                      <label>Materials</label>
                      <input
                        type="text"
                        value={profile.item?.materials || ""}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            item: {
                              ...profile.item,
                              materials: e.target.value,
                            },
                          })
                        }
                        placeholder="e.g. Celestial iron, dragon bone"
                      />
                    </div>
                    <div>
                      <label>Dimensions / Shape</label>
                      <input
                        type="text"
                        value={profile.item?.dimensions || ""}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            item: {
                              ...profile.item,
                              dimensions: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <label>Magical Effects & Aura</label>
                    <input
                      type="text"
                      value={profile.item?.magicalEffects || ""}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          item: {
                            ...profile.item,
                            magicalEffects: e.target.value,
                          },
                        })
                      }
                      placeholder="e.g. Faint hum of violet lightning across the blade"
                    />
                  </div>
                  <div className="form-row">
                    <label>Canonical Object Prompt</label>
                    <textarea
                      rows={2}
                      value={profile.item?.canonicalObjectPrompt || ""}
                      onChange={(e) =>
                        setProfile({
                          ...profile,
                          item: {
                            ...profile.item,
                            canonicalObjectPrompt: e.target.value,
                          },
                        })
                      }
                    />
                  </div>
                </>
              )}

              {profile.visualType === "faction" || profile.visualType === "vehicle" || profile.visualType === "other" ? (
                <div className="hint-text">
                  General visual properties are defined in the Appearance & Prompts tab.
                </div>
              ) : null}
            </div>
          )}

          {activeTab === "references" && (
            <div className="references-section">
              <div className="references-toolbar">
                <div className="upload-controls">
                  <select
                    value={uploadRole}
                    onChange={(e) => setUploadRole(e.target.value as VisualRole)}
                  >
                    {VISUAL_ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="file"
                    ref={fileInputRef}
                    accept="image/png,image/jpeg,image/webp"
                    style={{ display: "none" }}
                    onChange={handleFileUpload}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploading ? "Uploading..." : "Upload Reference Image"}
                  </button>
                </div>
                <label className="visual-profile-policy">
                  <span>Artwork profile policy</span>
                  <select value={visualProfilePolicy} onChange={(event) => void handleVisualProfilePolicy(event.target.value as "prompt" | "skip") }>
                    <option value="prompt">Ask when needed</option>
                    <option value="skip">Generate without profile</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={generatingSheet}
                  onClick={handleGenerateStyleSheet}
                  title="Generate a multi-view visual reference sheet for this entity"
                >
                  {generatingSheet ? "Generating Style Sheet..." : "Create Style Sheet"}
                </button>
              </div>

              {profile.references.length === 0 ? (
                <div className="empty-state">
                  No visual reference images uploaded yet. Upload front/side portraits or generate a style sheet.
                </div>
              ) : (
                <div className="reference-grid">
                  {profile.references.map((ref) => (
                    <div key={ref.id} className="reference-card">
                      <button type="button" className="reference-image-wrapper" onClick={() => openReference(ref)} title="View full-size reference image" aria-label={`View ${ref.role.replace(/_/g, " ")} reference`}>
                        <img
                          src={referenceUrl(ref.id)}
                          alt={ref.role}
                          loading="lazy"
                          onError={() => setError("The stored reference image could not be loaded. It may have been removed.")}
                        />
                      </button>
                      <div className="reference-meta">
                        <span className="reference-role">{ref.role.replace(/_/g, " ")}</span>
                        <span className="reference-source">{ref.approved ? "Approved" : "Review required"} · {ref.source}</span>
                        {ref.replacesReferenceId && <span className="reference-source">Revision of {ref.replacesReferenceId}</span>}
                      </div>
                      {!ref.approved && (
                        <div className="reference-actions">
                          <button type="button" className="btn btn-outline" onClick={() => openReference(ref)}>View</button>
                          <button type="button" className="btn btn-outline" onClick={() => handleDownloadReference(ref)}>Download</button>
                          <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => handleApproveReference(ref.id, false)}>Approve</button>
                          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => handleApproveReference(ref.id, true)}>Set primary</button>
                          <button type="button" className="btn btn-danger" disabled={saving} onClick={() => void handleDeleteReference(ref)}>Delete</button>
                        </div>
                      )}
                      {ref.approved && ref.role !== "primary_reference" && (
                        <div className="reference-actions"><button type="button" className="btn btn-outline" onClick={() => openReference(ref)}>View</button><button type="button" className="btn btn-outline" onClick={() => handleDownloadReference(ref)}>Download</button><button type="button" className="btn btn-outline" disabled={saving} onClick={() => handleApproveReference(ref.id, true)}>Make primary</button><button type="button" className="btn btn-danger" disabled={saving} onClick={() => void handleDeleteReference(ref)}>Delete</button></div>
                      )}
                      {ref.approved && ref.role === "primary_reference" && <div className="reference-actions"><button type="button" className="btn btn-outline" onClick={() => openReference(ref)}>View</button><button type="button" className="btn btn-outline" onClick={() => handleDownloadReference(ref)}>Download</button><span className="reference-primary">Primary</span><button type="button" className="btn btn-danger" disabled={saving} onClick={() => void handleDeleteReference(ref)}>Delete</button></div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => void handleStatusToggle()}>
            {profile.status === "approved" ? "Return to draft" : "Approve Visual Profile"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() => handleSave()}
          >
            {saving ? "Saving..." : "Save Visual Profile"}
          </button>
        </div>
      </div>
      {viewingReference && (
        <div className="reference-viewer-backdrop" onClick={(event) => { event.stopPropagation(); setViewingReference(null); }} role="presentation">
          <section className="reference-viewer" role="dialog" aria-modal="true" aria-label="Full-size reference image" onClick={(event) => event.stopPropagation()}>
            <header><div><span className="reference-viewer-kicker">Visual reference · {viewingReference.role.replace(/_/g, " ")}</span><h4>{entityName || profile.entityId}</h4></div><button type="button" className="btn-close" onClick={() => setViewingReference(null)} aria-label="Close image viewer">×</button></header>
            <div className="reference-viewer-canvas"><img src={referenceUrl(viewingReference.id)} alt={viewingReference.role} style={{ transform: `scale(${referenceZoom})` }} onError={() => setError("The stored reference image could not be loaded. It may have been removed.")} /></div>
            <footer><div className="reference-viewer-zoom"><button type="button" className="btn btn-outline" onClick={() => setReferenceZoom((zoom) => Math.max(.5, Number((zoom - .25).toFixed(2))))}>−</button><button type="button" className="btn btn-outline" onClick={() => setReferenceZoom(1)}>Fit</button><button type="button" className="btn btn-outline" onClick={() => setReferenceZoom((zoom) => Math.min(3, Number((zoom + .25).toFixed(2))))}>+</button></div><button type="button" className="btn btn-primary" onClick={() => handleDownloadReference(viewingReference)}>Download original</button></footer>
          </section>
        </div>
      )}
    </div>
  );
}
