import { useId } from "react";
import type { Model } from "./api.js";
import { modelEfforts } from "../../../src/llm/effort.js";
import { OPENAI_TEXT_MODELS } from "../../../src/llm/openai/models.js";

export function effortLabel(value?: string) {
  return value === "enabled" ? "Thinking on" : value === "disabled" ? "Thinking off" : value === "xhigh" ? "Extra high" : value ? value.charAt(0).toUpperCase() + value.slice(1) : "Provider default";
}
export function ModelFields({ label, value, onChange }: { label: string; value: Model; onChange: (value: Model) => void }) {
  const id = useId();
  const levels = modelEfforts(value.provider, value.model);
  const change = (patch: Partial<Model>) => {
    const next = { ...value, ...patch };
    if (next.effort && !modelEfforts(next.provider, next.model).includes(next.effort)) next.effort = undefined;
    onChange(next);
  };
  return <div className="model-fields" role="group" aria-label={`${label} model configuration`}>
    <label className="model-field-provider"><span>Provider</span><select aria-label={`${label} provider`} value={value.provider} onChange={e => change({ provider: e.target.value as Model["provider"] })}><option value="openai">OpenAI</option><option value="gemini">Gemini</option><option value="kimi">Kimi</option></select></label>
    <label className="model-field-id"><span>Model</span><input aria-label={`${label} model ID`} list={value.provider === "openai" ? id : undefined} value={value.model} onChange={e => change({ model: e.target.value })} /></label>
    {value.provider === "openai" && <datalist id={id}>{OPENAI_TEXT_MODELS.map(model => <option key={model} value={model} />)}</datalist>}
    <label className="model-field-effort"><span>Effort</span><select aria-label={`${label} effort`} value={value.effort ?? ""} disabled={!levels.length} onChange={e => change({ effort: (e.target.value || undefined) as Model["effort"] })}><option value="">Provider default</option>{levels.map(level => <option value={level} key={level}>{effortLabel(level)}</option>)}</select></label>
    {!levels.length && <small className="model-effort-note">Effort controls aren’t available for this model. Provider defaults apply.</small>}
  </div>;
}
