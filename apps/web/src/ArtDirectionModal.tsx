import React, { useState, useEffect } from "react";
import {
  StoryArtDirection,
  ArtDirectionPreset,
  ArtStyleOption,
  getArtDirection,
  updateArtDirection,
  createArtDirectionPreset,
  duplicateArtDirectionPreset,
  deleteArtDirectionPreset,
  setDefaultArtDirectionPreset,
} from "./api.js";

interface ArtDirectionModalProps {
  slug: string;
  onClose: () => void;
  onUpdated?: (artDirection: StoryArtDirection) => void;
}

const ART_STYLES: ArtStyleOption[] = [
  "Manhwa",
  "Cinematic anime",
  "Manga",
  "Semi-realistic",
  "Photorealistic",
  "Illustration",
  "Custom",
];

const ASPECT_RATIOS: Array<"16:9" | "1:1" | "9:16" | "4:3" | "21:9"> = [
  "16:9",
  "1:1",
  "9:16",
  "4:3",
  "21:9",
];

export function ArtDirectionModal({
  slug,
  onClose,
  onUpdated,
}: ArtDirectionModalProps) {
  const [artDirection, setArtDirection] = useState<StoryArtDirection | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    getArtDirection(slug)
      .then((data) => {
        if (active) {
          setArtDirection(data);
          setSelectedPresetId(data.activePresetId || data.presets[0]?.id || "");
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
  }, [slug]);

  const activePreset = artDirection?.presets.find((p) => p.id === selectedPresetId);

  const handleUpdatePresetField = <K extends keyof ArtDirectionPreset>(
    field: K,
    val: ArtDirectionPreset[K]
  ) => {
    if (!artDirection || !activePreset) return;
    const nextPresets = artDirection.presets.map((p) =>
      p.id === activePreset.id ? { ...p, [field]: val } : p
    );
    setArtDirection({ ...artDirection, presets: nextPresets });
  };

  const handleSave = async () => {
    if (!artDirection) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateArtDirection(slug, artDirection);
      setArtDirection(updated);
      onUpdated?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCreatePreset = async () => {
    if (!artDirection) return;
    setSaving(true);
    setError(null);
    try {
      const newId = `preset_${Date.now()}`;
      const newPreset: ArtDirectionPreset = {
        id: newId,
        name: `Preset ${artDirection.presets.length + 1}`,
        isDefault: false,
        artStyle: "Manhwa",
        customStylePrompt: "cinematic digital manhwa art, high quality webtoon illustration",
        visualTone: "Dark fantasy, progression fantasy",
        colorDirection: "Rich atmospheric palette, high contrast",
        lightingDirection: "Low-key cinematic lighting",
        cameraStyle: "Dynamic framing, cinematic depth",
        compositionTendencies: "Action-oriented, clear character focus",
        environmentStyle: "Atmospheric and detailed",
        characterRenderingGuidance: "Crisp line work, consistent proportions",
        aspectRatio: "16:9",
        characterConsistencyStrength: 0.8,
        environmentConsistencyStrength: 0.8,
        globalNegativePrompt: "text, watermark, signature, logo, blurry",
        additionalVisualInstructions: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const updated = await createArtDirectionPreset(slug, newPreset);
      setArtDirection(updated);
      setSelectedPresetId(newId);
      onUpdated?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDuplicate = async () => {
    if (!activePreset) return;
    setSaving(true);
    setError(null);
    try {
      const res = await duplicateArtDirectionPreset(slug, activePreset.id);
      setArtDirection(res.artDirection);
      setSelectedPresetId(res.preset.id);
      onUpdated?.(res.artDirection);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!activePreset || !artDirection) return;
    if (artDirection.presets.length <= 1) {
      setError("Cannot delete the only art direction preset.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await deleteArtDirectionPreset(slug, activePreset.id);
      setArtDirection(updated);
      setSelectedPresetId(updated.activePresetId || updated.presets[0]?.id || "");
      onUpdated?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async () => {
    if (!activePreset) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await setDefaultArtDirectionPreset(slug, activePreset.id);
      setArtDirection(updated);
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
        <div className="modal-content art-direction-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Story Art Direction</h3>
            <button className="btn-close" onClick={onClose}>✕</button>
          </div>
          <div className="modal-body loading-indicator">Loading art direction...</div>
        </div>
      </div>
    );
  }

  if (!artDirection) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal-content art-direction-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Story Art Direction</h3>
            <button className="btn-close" onClick={onClose}>✕</button>
          </div>
          <div className="modal-body error-box">{error || "Could not load art direction"}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content art-direction-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Story Art Direction Presets</h3>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="art-direction-layout">
          <div className="preset-sidebar">
            <div className="sidebar-header">
              <strong>Presets</strong>
              <button
                type="button"
                className="btn btn-sm btn-outline"
                onClick={handleCreatePreset}
                disabled={saving}
              >
                + New
              </button>
            </div>
            <div className="preset-list">
              {artDirection.presets.map((preset) => (
                <div
                  key={preset.id}
                  className={`preset-item ${preset.id === selectedPresetId ? "selected" : ""}`}
                  onClick={() => setSelectedPresetId(preset.id)}
                >
                  <div className="preset-item-title">{preset.name}</div>
                  <div className="preset-item-sub">
                    <span>{preset.artStyle}</span>
                    {preset.isDefault && <span className="badge badge-default">Default</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="preset-main">
            {activePreset ? (
              <div className="form-group-stack">
                <div className="preset-actions-bar">
                  <div className="preset-badges">
                    {activePreset.isDefault ? (
                      <span className="badge badge-success">✓ Story Default</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={handleSetDefault}
                        disabled={saving}
                      >
                        Set as Default
                      </button>
                    )}
                  </div>
                  <div className="preset-toolbar-btns">
                    <button
                      type="button"
                      className="btn btn-sm btn-outline"
                      onClick={handleDuplicate}
                      disabled={saving}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={handleDelete}
                      disabled={saving || artDirection.presets.length <= 1}
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <div className="form-grid-2col">
                  <div>
                    <label>Preset Name</label>
                    <input
                      type="text"
                      value={activePreset.name}
                      onChange={(e) => handleUpdatePresetField("name", e.target.value)}
                    />
                  </div>
                  <div>
                    <label>Art Style</label>
                    <select
                      value={activePreset.artStyle}
                      onChange={(e) =>
                        handleUpdatePresetField("artStyle", e.target.value as ArtStyleOption)
                      }
                    >
                      {ART_STYLES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="form-row">
                  <label>Custom Style Prompt (Base aesthetic definition)</label>
                  <textarea
                    rows={2}
                    value={activePreset.customStylePrompt}
                    onChange={(e) =>
                      handleUpdatePresetField("customStylePrompt", e.target.value)
                    }
                    placeholder="e.g. cinematic digital manhwa art, high quality webtoon illustration, crisp line art"
                  />
                </div>

                <div className="form-grid-2col">
                  <div>
                    <label>Visual Tone</label>
                    <input
                      type="text"
                      value={activePreset.visualTone}
                      onChange={(e) => handleUpdatePresetField("visualTone", e.target.value)}
                      placeholder="e.g. Dark fantasy, progression fantasy, action"
                    />
                  </div>
                  <div>
                    <label>Color Palette Direction</label>
                    <input
                      type="text"
                      value={activePreset.colorDirection}
                      onChange={(e) => handleUpdatePresetField("colorDirection", e.target.value)}
                      placeholder="e.g. High contrast, muted shadows, vibrant magical accents"
                    />
                  </div>
                  <div>
                    <label>Lighting Direction</label>
                    <input
                      type="text"
                      value={activePreset.lightingDirection}
                      onChange={(e) =>
                        handleUpdatePresetField("lightingDirection", e.target.value)
                      }
                      placeholder="e.g. Low-key dramatic lighting, glowing highlights"
                    />
                  </div>
                  <div>
                    <label>Camera Framing Style</label>
                    <input
                      type="text"
                      value={activePreset.cameraStyle}
                      onChange={(e) => handleUpdatePresetField("cameraStyle", e.target.value)}
                      placeholder="e.g. Dynamic wide angles, strong depth of field"
                    />
                  </div>
                </div>

                <div className="form-row">
                  <label>Composition Tendencies</label>
                  <input
                    type="text"
                    value={activePreset.compositionTendencies}
                    onChange={(e) =>
                      handleUpdatePresetField("compositionTendencies", e.target.value)
                    }
                    placeholder="e.g. Character-focused foreground, expansive background scale"
                  />
                </div>

                <div className="form-grid-2col">
                  <div>
                    <label>Character Rendering Guidance</label>
                    <input
                      type="text"
                      value={activePreset.characterRenderingGuidance}
                      onChange={(e) =>
                        handleUpdatePresetField("characterRenderingGuidance", e.target.value)
                      }
                      placeholder="e.g. Sharp anatomical contours, detailed eyes and hair"
                    />
                  </div>
                  <div>
                    <label>Environment Style Guidance</label>
                    <input
                      type="text"
                      value={activePreset.environmentStyle}
                      onChange={(e) =>
                        handleUpdatePresetField("environmentStyle", e.target.value)
                      }
                      placeholder="e.g. Immersive atmospheric backgrounds, painterly depth"
                    />
                  </div>
                </div>

                <div className="form-grid-2col">
                  <div>
                    <label>Aspect Ratio</label>
                    <select
                      value={activePreset.aspectRatio}
                      onChange={(e) =>
                        handleUpdatePresetField(
                          "aspectRatio",
                          e.target.value as "16:9" | "1:1" | "9:16" | "4:3" | "21:9"
                        )
                      }
                    >
                      {ASPECT_RATIOS.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label>
                      Character Consistency Strength ({activePreset.characterConsistencyStrength})
                    </label>
                    <input
                      type="range"
                      min="0.1"
                      max="1.0"
                      step="0.05"
                      value={activePreset.characterConsistencyStrength}
                      onChange={(e) =>
                        handleUpdatePresetField(
                          "characterConsistencyStrength",
                          parseFloat(e.target.value)
                        )
                      }
                    />
                  </div>
                </div>

                <div className="form-row">
                  <label>Global Negative Prompt</label>
                  <textarea
                    rows={2}
                    value={activePreset.globalNegativePrompt}
                    onChange={(e) =>
                      handleUpdatePresetField("globalNegativePrompt", e.target.value)
                    }
                    placeholder="e.g. text, watermark, signature, logo, malformed anatomy, blurry"
                  />
                </div>
              </div>
            ) : (
              <div className="empty-state">Select a preset to edit</div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={handleSave}
          >
            {saving ? "Saving..." : "Save Art Direction"}
          </button>
        </div>
      </div>
    </div>
  );
}

