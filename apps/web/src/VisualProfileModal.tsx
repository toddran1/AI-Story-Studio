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
} from "./api.js";

interface VisualProfileModalProps {
  slug: string;
  entityId: string;
  entityName?: string;
  onClose: () => void;
  onUpdated?: (profile: VisualEntityProfile) => void;
}

const VISUAL_ROLES: { value: VisualRole; label: string }[] = [
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
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"appearance" | "details" | "references">("appearance");
  const [uploadRole, setUploadRole] = useState<VisualRole>("general_reference");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getVisualProfile(slug, entityId)
      .then((res) => {
        if (active) {
          setProfile(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [slug, entityId]);

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
            Specific Visual Traits
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
                      <div className="reference-image-wrapper">
                        <img
                          src={`/api/stories/${encodeURIComponent(slug)}/visual-profiles/${encodeURIComponent(entityId)}/references/${encodeURIComponent(ref.id)}`}
                          alt={ref.role}
                          loading="lazy"
                        />
                      </div>
                      <div className="reference-meta">
                        <span className="reference-role">{ref.role.replace(/_/g, " ")}</span>
                        <span className="reference-source">{ref.source}</span>
                      </div>
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
    </div>
  );
}

