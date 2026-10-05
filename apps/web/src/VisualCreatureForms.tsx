import type { CreatureForm, VisualEntityProfile } from "./api.js";

export function VisualCreatureForms({ profile, onChange, busy, onGenerate, onApprove, referenceUrl }: {
  profile: VisualEntityProfile; onChange: (profile: VisualEntityProfile) => void; busy: boolean;
  onGenerate: (id: string) => void; onApprove: (id: string, reference: string) => void; referenceUrl: (id: string) => string;
}) {
  const forms = profile.creatureForms ?? [];
  const update = (id: string, patch: Partial<CreatureForm>) => onChange({ ...profile, creatureForms: forms.map(form => form.id === id ? { ...form, ...patch } : form) });
  return <div className="appearance-eras"><h4>Creature identity and forms</h4>
    <label>Creature identity<select disabled={busy} value={profile.creatureIdentity ?? ""} onChange={event => onChange({ ...profile, creatureIdentity: event.target.value ? event.target.value as "individual" | "template" : undefined })}><option value="">Unspecified — review identity type</option><option value="individual">One identifiable creature</option><option value="template">Species / interchangeable creatures</option></select></label>
    <p>Templates share a design across individuals. Forms are selected per scene group and can coexist; they never change every member of a species by chapter. Use appearance eras for a lasting change to one identifiable creature.</p>
    {forms.map(form => <fieldset className="appearance-era-card" key={form.id} disabled={busy}><legend>{form.name} · {form.status}</legend>
      <small>Form ID: {form.id}</small>
      <label>Name<input value={form.name} onChange={event => update(form.id, { name: event.target.value })} /></label>
      <label>State<select value={form.state} onChange={event => update(form.id, { state: event.target.value as CreatureForm["state"] })}>{["living", "dead", "zombie", "skeleton", "undead", "other"].map(state => <option key={state}>{state}</option>)}</select></label>
      <label>Full appearance<textarea rows={4} value={form.appearance} onChange={event => update(form.id, { appearance: event.target.value })} /><small>Describe the complete form. Incompatible living anatomy and references are not inherited.</small></label>
      <label>Artwork direction<textarea value={form.visualPrompt} onChange={event => update(form.id, { visualPrompt: event.target.value })} /></label>
      <label>Exclude<input value={form.negativePrompt ?? ""} onChange={event => update(form.id, { negativePrompt: event.target.value })} /></label>
      <label>Status<select value={form.status} onChange={event => update(form.id, { status: event.target.value as CreatureForm["status"] })}><option value="draft">Draft — review needed</option><option value="approved">Approved for artwork</option></select></label>
      {form.detectedSource?.needsReview && <p role="alert">The scene evidence that prepared this form changed. <button type="button" onClick={() => update(form.id, { detectedSource: { ...form.detectedSource!, needsReview: false } })}>I reviewed it; keep as my editorial design</button> Save to record this decision.</p>}
      {form.sourceExcerpts?.map((excerpt,index) => <blockquote key={index}>{excerpt}</blockquote>)}
      <button type="button" onClick={() => onGenerate(form.id)}>{busy ? "Working…" : "Save and generate form reference sheet"}</button>
      {profile.references.filter(reference => form.referenceIds.includes(reference.id)).map(reference => <div key={reference.id}><a href={referenceUrl(reference.id)} target="_blank" rel="noopener noreferrer"><img src={referenceUrl(reference.id)} alt={`${form.name} reference`} style={{ maxHeight:260,maxWidth:"100%" }} /></a><p>{reference.provenance?.identityMode === "image-conditioned" ? "Generated with an approved identity image" : reference.provenance?.identityReason as string}</p><p>{reference.approved ? "Approved reference" : "Candidate — review before approval"}</p>{(!reference.approved || form.status !== "approved") && <button type="button" onClick={() => onApprove(form.id,reference.id)}>Approve sheet, form and profile</button>}</div>)}
      <fieldset><legend>Assign approved references to this form</legend>{profile.references.filter(reference => reference.approved).map(reference => <label key={reference.id}><input type="checkbox" checked={form.referenceIds.includes(reference.id)} onChange={event => update(form.id,{ referenceIds:event.target.checked ? [...form.referenceIds,reference.id] : form.referenceIds.filter(id => id !== reference.id) })} />{reference.role} · {reference.id}</label>)}</fieldset>
      <button type="button" onClick={() => onChange({ ...profile, creatureForms: forms.filter(item => item.id !== form.id), dismissedAppearanceEraIds: [...(profile.dismissedAppearanceEraIds ?? []),form.id] })}>Remove / dismiss form</button>
    </fieldset>)}
    <button type="button" disabled={busy} onClick={() => onChange({ ...profile,creatureForms:[...forms,{ id:crypto.randomUUID(),name:"New creature form",state:"living",status:"draft",appearance:"",visualPrompt:"",referenceIds:[] }] })}>Add form</button>
  </div>;
}
