import type { SceneDirection, SceneOverrides, StoryArtDirection } from "./api.js";

type Props = {
  source: "chapter" | "summary";
  direction?: SceneDirection;
  overrides?: SceneOverrides;
  artDirection?: StoryArtDirection;
  summaryPreset?: string;
  disabled?: boolean;
  onDirection: (patch: Partial<SceneDirection>) => void;
  onOverrides: (patch: Partial<SceneOverrides>) => void;
};

const choices = {
  shotType: ["extreme_wide", "wide", "medium_wide", "medium", "medium_close_up", "close_up", "extreme_close_up"],
  cameraAngle: ["eye_level", "low_angle", "high_angle", "overhead", "dutch_angle", "pov", "over_shoulder"],
  composition: ["balanced", "centered", "rule_of_thirds", "dynamic", "symmetrical", "environmental", "character_focused"],
  timeEnvironment: ["dawn", "day", "sunset", "dusk", "night", "interior", "custom"],
} as const;
const title = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

/** One editor for the common scene direction contract; only inheritance is source-specific. */
export function AdvancedVisualDirection({ source, direction, overrides, artDirection, summaryPreset, disabled, onDirection, onOverrides }: Props) {
  const presets = artDirection?.presets ?? [];
  const defaultPreset = presets.find((preset) => preset.isDefault)
    ?? presets.find((preset) => preset.id === artDirection?.activePresetId)
    ?? presets[0];
  const selected = overrides?.artDirectionPresetId ? `preset:${overrides.artDirectionPresetId}`
    : overrides?.artDirectionMode === "story-default" ? "story-default"
    : source === "summary" ? "inherit-summary" : "story-default";
  const missingPreset = overrides?.artDirectionPresetId && !presets.some((preset) => preset.id === overrides.artDirectionPresetId);
  const setPreset = (value: string) => onOverrides({
    artDirectionPresetId: value.startsWith("preset:") ? value.slice(7) : undefined,
    artDirectionMode: value === "inherit-summary" ? "inherit-summary" : value === "story-default" ? "story-default" : undefined,
  });
  const selectField = <K extends keyof typeof choices>(key: K, label: string) => <label key={key}>{label}<select disabled={disabled} value={direction?.[key] ?? ""} onChange={(event) => onDirection({ [key]: event.target.value || undefined })}>
    <option value="">Automatic</option>{choices[key].map((value) => <option key={value} value={value}>{title(value)}</option>)}
  </select></label>;
  const wardrobe = Object.entries(overrides?.wardrobeOverrides ?? {}).map(([name, outfit]) => `${name}: ${outfit}`).join("\n");
  const expressions = Object.entries(direction?.characterExpressions ?? {}).map(([name, expression]) => `${name}: ${expression}`).join("\n");
  const parseLines = (value: string) => Object.fromEntries(value.split("\n").map((line) => {
    const divider = line.indexOf(":"); return divider > 0 ? [line.slice(0, divider).trim(), line.slice(divider + 1).trim()] : ["", ""];
  }).filter(([name, text]) => name && text));
  return <details className="summary-scene-direction scene-direction-panel"><summary>Advanced visual direction</summary>
    <p className="summary-direction-inheritance">{direction?.useStoryArtDirection === false ? "Art Direction disabled for this scene" : selected.startsWith("preset:") ? `Scene preset · ${presets.find((preset) => preset.id === overrides?.artDirectionPresetId)?.name ?? "missing preset; Story Default fallback"}` : selected === "inherit-summary" ? `Inherit Summary · ${summaryPreset ?? "Story Default"}` : `Story Default · ${defaultPreset?.name ?? "Main Style"}`}</p>
    <label className="summary-direction-toggle"><input type="checkbox" disabled={disabled} checked={direction?.useStoryArtDirection !== false} onChange={(event) => onDirection({ useStoryArtDirection: event.target.checked })} /> Apply Art Direction</label>
    <label>Art Direction preset<select disabled={disabled || direction?.useStoryArtDirection === false || !artDirection} value={selected} onChange={(event) => setPreset(event.target.value)}>
      {source === "summary" && <option value="inherit-summary">Inherit Summary · {summaryPreset ?? "Story Default"}</option>}
      <option value="story-default">Story Default · {defaultPreset?.name ?? "Main Style"}</option>
      {presets.map((preset) => <option key={preset.id} value={`preset:${preset.id}`}>Preset · {preset.name}</option>)}
      {missingPreset && <option value={selected}>Missing preset · {overrides.artDirectionPresetId} (fallback)</option>}
    </select><small>Choosing a preset pins this scene to it even if the story default later changes.</small></label>
    <div className="summary-form-row">{selectField("shotType", "Shot type")}{selectField("cameraAngle", "Camera angle")}{selectField("composition", "Composition")}</div>
    <div className="summary-form-row">{selectField("timeEnvironment", "Time / environment")}<label>Lighting<input disabled={disabled} maxLength={500} value={direction?.lighting ?? ""} onChange={(event) => onDirection({ lighting: event.target.value || undefined })} /></label></div>
    <div className="summary-direction-toggles">{([
      ["useCharacterReferences", "Use character references"], ["useCreatureReferences", "Use creature references"],
      ["useLocationReferences", "Use location references"], ["preserveWardrobeEquipment", "Preserve wardrobe / equipment"],
    ] as const).map(([key, label]) => <label key={key}><input type="checkbox" disabled={disabled} checked={direction?.[key] !== false} onChange={(event) => onDirection({ [key]: event.target.checked })} /> {label}</label>)}</div>
    <label>Character expressions<textarea disabled={disabled} value={expressions} onChange={(event) => onDirection({ characterExpressions: parseLines(event.target.value) })} /><small>One per line: Character: expression.</small></label>
    <label>Wardrobe / equipment overrides<textarea disabled={disabled} value={wardrobe} onChange={(event) => onOverrides({ wardrobeOverrides: parseLines(event.target.value) })} /><small>One per line: Character: outfit or equipment detail.</small></label>
    <label>Custom visual prompt<textarea disabled={disabled} maxLength={8000} value={overrides?.customVisualPrompt ?? ""} onChange={(event) => onOverrides({ customVisualPrompt: event.target.value || undefined })} /></label>
    <label>Custom negative prompt<textarea disabled={disabled} maxLength={2000} value={overrides?.customNegativePrompt ?? ""} onChange={(event) => onOverrides({ customNegativePrompt: event.target.value || undefined })} /></label>
  </details>;
}
