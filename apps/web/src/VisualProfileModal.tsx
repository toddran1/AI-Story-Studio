import React, { useState, useEffect, useRef } from "react";
import {
  VisualEntityProfile,
  VisualRole,
  VisualEntityType,
  VisualProfileStatus,
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

export function VisualProfileModal({
  slug,
  entityId,
  entityName,
  onClose,
  onUpdated,
}: VisualProfileModalProps) {
  const [profile, setProfile] = useState<VisualEntityProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generatingSheet, setGeneratingSheet] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [completeness, setCompleteness] = useState<{ eligibleFields: string[]; protectedFields: string[]; fields: VisualProfileFieldState[]; coreComplete: number; coreTotal: number; conflicts: NonNullable<VisualEntityProfile["conflicts"]> } | null>(null);
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
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setViewingReference(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewingReference]);

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!profile) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateVisualProfile(slug, entityId, profile);
      setProfile(updated);
      onUpdated?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleStatusToggle = async () => {
    if (!profile) return;
    const nextStatus: VisualProfileStatus = profile.status === "approved" ? "draft" : "approved";
    const nextProfile = { ...profile, status: nextStatus };
    setProfile(nextProfile);
    try {
      const updated = await updateVisualProfile(slug, entityId, { status: nextStatus });
      setProfile(updated);
      onUpdated?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
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

      const ref = await uploadVisualReference(slug, entityId, {
        filename: file.name,
        dataBase64,
        role: uploadRole,
      });

      if (profile) {
        const nextProfile = {
          ...profile,
          references: [...profile.references, ref],
        };
        setProfile(nextProfile);
        onUpdated?.(nextProfile);
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
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

  const handlePropose = async (regenerate = false) => {
    if (!profile) return;
    setProposing(true);
    setError(null);
    try {
      const fields = regenerate ? selectedRegenerationFields : undefined;
      const next = await proposeVisualProfile(slug, entityId, { fields, regenerate });
      setProposal(next);
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
        <div className="modal-content visual-profile-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Visual Profile: {entityName || entityId}</h3>
            <button className="btn-close" onClick={onClose}>✕</button>
          </div>
          <div className="modal-body loading-indicator">Loading visual profile...</div>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal-content visual-profile-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Visual Profile</h3>
            <button className="btn-close" onClick={onClose}>✕</button>
          </div>
          <div className="modal-body error-box">{error || "Could not load profile"}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content visual-profile-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-row">
            <h3>Visual Profile: {entityName || profile.entityId}</h3>
            <span
              className={`badge status-${profile.status}`}
              style={{
                cursor: "pointer",
                padding: "4px 10px",
                borderRadius: "4px",
                fontWeight: "bold",
                backgroundColor: profile.status === "approved" ? "#2e7d32" : "#ed6c02",
                color: "#fff",
              }}
              onClick={handleStatusToggle}
              title="Click to toggle Draft / Approved"
            >
              {profile.status === "approved" ? "✓ Approved Canon" : "Draft (Not Enforced)"}
            </span>
          </div>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>

        {error && <div className="error-banner">{error}</div>}

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
          {activeTab === "appearance" && (
            <div className="form-group-stack">
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
              {(profile.visualType === "character" || profile.visualType === "location") && (
                <section className="visual-completion-panel">
                  <div>
                    <strong>Persistent visual identity</strong>
                    <p className="hint-text">{completeness ? `${completeness.coreComplete} / ${completeness.coreTotal} core details established.` : "Checking missing details…"} Existing and locked details stay protected until you explicitly apply a proposal.</p>
                  </div>
                  <button type="button" className="btn btn-primary" disabled={proposing} onClick={() => handlePropose(false)}>{proposing ? "Preparing proposal…" : "Generate missing details with AI"}</button>
                </section>
              )}
              {completeness?.conflicts.filter((conflict) => conflict.status === "needs_review").map((conflict) => (
                <section className="visual-conflict-panel" key={conflict.id}>
                  <strong>Source conflict · {conflict.field.replace(/^character\.|^location\./, "")}</strong>
                  <p className="hint-text">Source-backed value: <b>{conflict.canonicalValue}</b><br />Earlier AI suggestion: <b>{conflict.visualValue}</b></p>
                  <div className="proposal-actions"><button type="button" className="btn btn-primary" disabled={saving} onClick={() => handleResolveConflict(conflict.id, "accept_canonical")}>Use source-backed value</button><button type="button" className="btn btn-outline" disabled={saving} onClick={() => handleResolveConflict(conflict.id, "retain_manual_override")}>Keep as manual override</button></div>
                </section>
              ))}
              {completeness?.fields.some((field) => field.regenerable) && (
                <section className="visual-regeneration-panel">
                  <strong>Regenerate selected AI details</strong>
                  <p className="hint-text">Only unlocked AI suggestions are eligible. Source-backed and manual fields stay protected.</p>
                  {completeness.fields.filter((field) => field.regenerable).map((field) => <label className="proposal-field" key={field.path}><input type="checkbox" checked={selectedRegenerationFields.includes(field.path)} onChange={(event) => setSelectedRegenerationFields((items) => event.target.checked ? [...items, field.path] : items.filter((item) => item !== field.path))} /><span>{field.path.replace(/^character\.|^location\./, "")} <small>AI suggestion</small></span></label>)}
                  <button type="button" className="btn btn-secondary" disabled={proposing || !selectedRegenerationFields.length} onClick={() => handlePropose(true)}>{proposing ? "Preparing proposal…" : "Regenerate selected details"}</button>
                </section>
              )}
              {proposal && (
                <section className="visual-proposal-panel">
                  <strong>AI visual proposal</strong>
                  {proposal.rationale && <p className="hint-text">{proposal.rationale}</p>}
                  {Object.entries(proposal.values).map(([field, value]) => (
                    <label key={field} className="proposal-field"><input type="checkbox" checked={selectedProposalFields.includes(field)} onChange={(event) => setSelectedProposalFields((items) => event.target.checked ? [...items, field] : items.filter((item) => item !== field))} /><span><b>{field.replace(/^character\.|^location\./, "")}</b><br />{value}</span></label>
                  ))}
                  {!Object.keys(proposal.values).length && <p className="hint-text">No safe missing details were proposed.</p>}
                  <div className="proposal-actions"><button type="button" className="btn btn-primary" onClick={handleApplyProposal} disabled={saving || !selectedProposalFields.length}>Apply selected</button><button type="button" className="btn btn-outline" onClick={() => setProposal(null)}>Cancel</button></div>
                </section>
              )}
              {profile.visualType === "character" && (
                <>
                  <div className="form-grid-2col">
                    <div>
                      <label>Apparent Age</label>
                      <input
                        type="text"
                        value={profile.character?.apparentAge || ""}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            character: {
                              ...profile.character,
                              apparentAge: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                    <div>
                      <label>Gender / Presentation</label>
                      <input
                        type="text"
                        value={profile.character?.gender || ""}
                        onChange={(e) =>
                          setProfile({
                            ...profile,
                            character: {
                              ...profile.character,
                              gender: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
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
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
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
