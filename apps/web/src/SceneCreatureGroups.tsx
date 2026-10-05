import { useEffect, useId, useState } from "react";
import { getVisualCatalog, referenceUrl, type VisualCatalogEntity } from "./visual-workflow.js";
import type { SceneCreatureGroup } from "./api.js";

export function SceneCreatureGroups({ slug, groups = [], onChange, disabled }: { slug?: string; groups?: SceneCreatureGroup[]; onChange: (groups: SceneCreatureGroup[]) => void; disabled?: boolean }) {
  const [catalog, setCatalog] = useState<VisualCatalogEntity[]>([]);
  const [error, setError] = useState(""); const listId = useId();
  useEffect(() => { let active = true; if (slug) getVisualCatalog(slug).then(result => { if (active) setCatalog(result.filter(entity => entity.type === "creature")); }).catch(error => { if (active) setError(String(error)); }); return () => { active = false; }; }, [slug]);
  const update = (id: string, patch: Partial<SceneCreatureGroup>) => onChange(groups.map(group => group.id === id ? { ...group, ...patch } : group));
  return <details className="scene-creature-groups" open={groups.length > 0}><summary>Creature groups and forms ({groups.length})</summary>
    <p>Each group has its own living, dead, or undead form. A blank count means the narration does not specify an exact number.</p>
    {error && <p role="alert">Creature choices unavailable: {error}</p>}
    <datalist id={listId}>{catalog.map(entity => <option key={entity.id} value={entity.name} />)}</datalist>
    {groups.map(group => { const entity = catalog.find(entity => entity.id === group.entity || entity.name === group.entity); const forms = entity?.profile?.creatureForms?.filter(form => form.status === "approved" && form.state === group.state) ?? []; const selected = forms.find(form => form.id === group.formId) ?? (!group.formId && forms.length === 1 ? forms[0] : undefined); return <fieldset key={group.id} disabled={disabled}><legend>{group.label || "Creature group"}</legend>
      <label>Canonical creature name<input list={listId} value={entity?.name ?? group.entity} onChange={event => update(group.id, { entity: catalog.find(item => item.name === event.target.value)?.id ?? event.target.value, formId: undefined })} /></label>
      <label>Group label<input value={group.label} onChange={event => update(group.id, { label: event.target.value })} /></label>
      <label>Form<select value={group.state} onChange={event => update(group.id, { state: event.target.value as SceneCreatureGroup["state"], formId: undefined, excerpt: "" })}>{["living", "dead", "zombie", "skeleton", "undead", "other"].map(state => <option key={state}>{state}</option>)}</select></label>
      <label>Count (blank = unspecified)<input type="number" min="1" max="10000" value={group.count ?? ""} onChange={event => update(group.id, { count: event.target.value ? Number(event.target.value) : undefined })} /></label>
      <label>Appearance in this scene<textarea value={group.appearance} onChange={event => update(group.id, { appearance: event.target.value })} /></label>
      <label>Approved design<select value={group.formId ?? ""} onChange={event => update(group.id, { formId: event.target.value || undefined })}><option value="">Automatic · {forms.length === 1 ? forms[0]!.name : forms.length ? "choose a design" : "no approved form"}</option>{group.formId && !forms.some(form => form.id === group.formId) && <option value={group.formId}>Unavailable design · review required</option>}{forms.map(form => <option key={form.id} value={form.id}>{form.name}</option>)}</select></label>
      {selected && <div><p>{selected.appearance || selected.visualPrompt}</p>{selected.referenceIds.map(id => entity?.profile?.references.find(ref => ref.id === id && ref.approved)).filter(Boolean).map(ref => <img key={ref!.id} alt={selected.name} width="100" src={referenceUrl(slug!, entity!.id, ref!.id)} />)}</div>}
      {!entity && group.entity && <p role="status">Select a canonical creature from the suggestions.</p>}
      {group.excerpt && <blockquote>{group.excerpt}</blockquote>}
      <button type="button" onClick={() => onChange(groups.filter(item => item.id !== group.id))}>Remove group</button>
    </fieldset>; })}
    <button type="button" disabled={disabled} onClick={() => onChange([...groups, { id: crypto.randomUUID(), entity: "", label: "New creature group", state: "living", appearance: "", excerpt: "" }])}>Add creature group</button>
  </details>;
}
