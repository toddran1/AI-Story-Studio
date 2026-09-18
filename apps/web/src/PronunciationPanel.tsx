import { useEffect, useRef, useState } from "react";
import { api, post, put, type Job } from "./api.js";
import { LanguageSelect } from "./languages.js";
import { hasActivePronunciation, type CanonicalEntity, type EntityPronunciation } from "../../../src/domain/story-bible.js";
import "./pronunciation.css";

export function PronunciationFields({ value, onChange }: { value?: EntityPronunciation; onChange: (value: EntityPronunciation | undefined) => void }) {
  const p = value ?? { mode: "automatic" as const };
  const edit = (patch: Partial<EntityPronunciation>) => onChange({ ...p, ...patch, source: "manual", updatedAt: new Date().toISOString() });
  const field = (key: "originalText" | "romanization" | "ipa" | "phoneticHint" | "customPronunciation", label: string) => <label>{label}<input value={p[key] ?? ""} maxLength={key === "originalText" || key === "romanization" ? 300 : 500} onChange={event => edit({ [key]: event.target.value || undefined })} /></label>;
  return <fieldset className="pronunciation-fields"><legend>Pronunciation</legend><p>Controls how the name sounds. Displayed narration stays unchanged.</p><label>Source language<LanguageSelect value={p.sourceLanguage ?? ""} onChange={sourceLanguage => edit({ sourceLanguage })} /></label>{field("originalText", "Original text")}{field("romanization", "Romanization")}<label>Mode<select value={p.mode} onChange={event => edit({ mode: event.target.value as EntityPronunciation["mode"] })}><option value="automatic">Automatic</option><option value="original_language">Original-language pronunciation</option><option value="custom">Custom</option></select></label>{p.mode === "custom" && field("customPronunciation", "Custom spoken form")}<details><summary>Advanced pronunciation</summary>{field("ipa", "IPA")}{field("phoneticHint", "Phonetic hint for speech synthesis")}</details>{p.evidence?.length ? <details><summary>AI source evidence</summary>{p.evidence.map((item, index) => <p key={index}><b>Chapter {item.chapter}</b> · {item.reason}<br /><small>{item.sourceText}</small></p>)}</details> : null}<label><input type="checkbox" checked={p.locked ?? false} onChange={event => edit({ locked: event.target.checked })} /> Lock pronunciation</label><small>{p.source ?? "Not enriched"}{p.confidence !== undefined ? ` · ${Math.round(p.confidence * 100)}% confidence` : ""}{p.needsReview ? " · Needs review" : ""}</small><button type="button" onClick={() => onChange(undefined)}>Use default TTS (clear configuration)</button></fieldset>;
}

function SuggestionCard({ suggestion, busy, onAccept, onEdit, onIgnore }: { suggestion: EntityPronunciation; busy: boolean; onAccept: () => void; onEdit: () => void; onIgnore: () => void }) {
  return <fieldset className="pronunciation-fields"><legend>AI suggestion (optional)</legend>
    <p>Default TTS is used unless you accept or edit this suggestion. It creates no review obligation.</p>
    <p><b>{suggestion.romanization ?? suggestion.phoneticHint ?? suggestion.customPronunciation ?? suggestion.originalText ?? "No guidance needed"}</b>{suggestion.confidence !== undefined ? ` · ${Math.round(suggestion.confidence * 100)}% confidence` : ""}{suggestion.needsReview ? " · Uncertain" : ""}</p>
    {suggestion.originalText && <small>Original: {suggestion.originalText}</small>}
    {suggestion.evidence?.length ? <details><summary>AI source evidence</summary>{suggestion.evidence.map((item, index) => <p key={index}><b>Chapter {item.chapter}</b> · {item.reason}<br /><small>{item.sourceText}</small></p>)}</details> : null}
    <div className="pronunciation-tools"><button type="button" disabled={busy} onClick={onAccept}>Use suggestion</button><button type="button" disabled={busy} onClick={onEdit}>Edit as configuration</button><button type="button" disabled={busy} onClick={onIgnore}>Ignore (keep default TTS)</button></div>
  </fieldset>;
}

type DeskData = { entities: CanonicalEntity[]; suggestions: Record<string, EntityPronunciation> };

export function PronunciationPanel({ slug }: { slug: string }) {
  const [entities, setEntities] = useState<CanonicalEntity[]>([]), [suggestions, setSuggestions] = useState<Record<string, EntityPronunciation>>({}), [selected, setSelected] = useState<string>(), [draft, setDraft] = useState<EntityPronunciation>(), [query, setQuery] = useState(""), [filter, setFilter] = useState("all"), [error, setError] = useState(""), [busy, setBusy] = useState(false), [audio, setAudio] = useState<string>(), [notice, setNotice] = useState("");
  const generation = useRef(0), mounted = useRef(true), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true; setEntities([]); setSuggestions({}); setSelected(undefined); setDraft(undefined); setBusy(false); setError(""); setAudio(undefined); setNotice("");
    const token = ++generation.current;
    api<DeskData>(`/stories/${slug}/pronunciation`).then(result => { if (token === generation.current && mounted.current) { setEntities(result.entities); setSuggestions(result.suggestions ?? {}); } }).catch(e => { if (token === generation.current && mounted.current) setError(String(e)); });
    return () => { mounted.current = false; generation.current++; clearTimeout(timer.current); };
  }, [slug]);
  const reload = async (token: number) => {
    const result = await api<DeskData>(`/stories/${slug}/pronunciation`);
    if (!mounted.current || token !== generation.current) return;
    setEntities(result.entities); setSuggestions(result.suggestions ?? {});
    setDraft(result.entities.find(e => e.id === selected)?.pronunciation);
  };
  const choose = (entity: CanonicalEntity) => { generation.current++; clearTimeout(timer.current); setBusy(false); setSelected(entity.id); setDraft(entity.pronunciation); setAudio(undefined); setNotice(""); setError(""); };
  const run = async (test: boolean, bulk = false) => {
    const token = ++generation.current; setBusy(true); setError(""); setNotice(test ? "Generating pronunciation preview…" : "Enriching pronunciation…");
    try {
      const job = await post<Job>(bulk ? `/stories/${slug}/pronunciation` : `/stories/${slug}/pronunciation/${selected}/${test ? "test" : "enrich"}`, {});
      let failures = 0;
      const poll = async () => {
        if (!mounted.current || token !== generation.current) return;
        try {
          const next = await api<Job>(`/jobs/${job.id}`);
          if (!mounted.current || token !== generation.current) return;
          failures = 0;
          if (next.status === "failed" || next.status === "paused") { setError(next.error ?? "Pronunciation job stopped"); setBusy(false); return; }
          if (next.status === "completed") {
            if (test) { setAudio(next.result?.audioUrl); setNotice(next.result?.cached ? "Replaying cached preview" : "Preview ready"); }
            else { await reload(token); const summary = next.result?.summary; setNotice(summary ? `${summary.successful ?? 0} suggestion(s) stored. Accept a suggestion to activate it; manual and locked records were preserved.` : "Pronunciation enrichment completed. Manual and locked records were preserved."); }
            setBusy(false); return;
          }
        } catch (e) { if (!mounted.current || token !== generation.current) return; if (++failures >= 5 || String(e).includes("job stopped") || String(e).includes("Pronunciation")) { setError(String(e)); setBusy(false); return; } }
        timer.current = setTimeout(() => void poll(), 1000);
      }; void poll();
    } catch (e) { if (mounted.current && token === generation.current) { setError(String(e)); setBusy(false); } }
  };
  const save = async () => { const token = generation.current; setBusy(true); try { const result = await put<any>(`/stories/${slug}/pronunciation/${selected}`, draft ?? null); if (!mounted.current || token !== generation.current) return; setEntities(items => items.map(e => e.id === selected ? result.entity : e)); setNotice(draft ? "Pronunciation saved. Referenced audio is marked stale." : "Cleared. Default TTS pronunciation is used; no review is required."); setAudio(undefined); } catch (e) { if (mounted.current && token === generation.current) setError(String(e)); } finally { if (mounted.current && token === generation.current) setBusy(false); } };
  const suggestionAction = async (action: "accept-suggestion" | "dismiss-suggestion") => {
    const token = generation.current; setBusy(true); setError("");
    try {
      await post(`/stories/${slug}/pronunciation/${selected}/${action}`, {});
      await reload(token);
      if (mounted.current && token === generation.current) setNotice(action === "accept-suggestion" ? "Suggestion accepted and activated. Referenced audio is marked stale." : "Suggestion ignored. Default TTS pronunciation is used.");
    } catch (e) { if (mounted.current && token === generation.current) setError(String(e)); } finally { if (mounted.current && token === generation.current) setBusy(false); }
  };
  const active = (e: CanonicalEntity) => hasActivePronunciation(e.pronunciation);
  const visible = entities
    .filter(e => [e.canonicalName, e.originalName, e.localizedNaming?.fullName ?? "", e.preferredNarrationName ?? "", e.pronunciation?.romanization ?? "", suggestions[e.id]?.romanization ?? ""].join(" ").toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .filter(e => filter === "all" || filter === e.type
      || (filter === "configured" && active(e))
      || (filter === "default" && !active(e))
      || (filter === "suggestions" && !active(e) && Boolean(suggestions[e.id]))
      || (filter === "review" && active(e) && Boolean(e.pronunciation?.needsReview))
      || (filter === "manual" && e.pronunciation?.source === "manual")
      || (filter === "locked" && Boolean(e.pronunciation?.locked)));
  const status = (e: CanonicalEntity) => {
    if (active(e)) {
      const p = e.pronunciation!;
      return `${p.romanization ?? p.customPronunciation ?? p.phoneticHint ?? "Configured"} · ${p.source === "ai" ? `AI · ${p.confidence !== undefined ? `${Math.round(p.confidence * 100)}% confidence` : "Configured"}` : p.source ?? "Configured"}${p.needsReview ? " · Needs review" : ""}${p.locked ? " · Locked" : ""}`;
    }
    if (suggestions[e.id]) return "Suggestion available · Default TTS";
    return "Default TTS";
  };
  const selectedEntity = entities.find(e => e.id === selected);
  const suggestion = selected ? suggestions[selected] : undefined;
  return <details className="pronunciation-management"><summary>Pronunciation desk · {entities.length} entities</summary><p>Pronunciation is opt-in: entities use default TTS unless you configure them. AI suggestions are optional and create no review obligation. Manual and locked records are protected.</p>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}<div className="pronunciation-tools"><input aria-label="Search pronunciations" placeholder="Search name, original or romanization" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Filter pronunciations" value={filter} onChange={e => setFilter(e.target.value)}>{[["all", "All"], ["configured", "Configured"], ["suggestions", "Suggestions"], ["default", "Default TTS"], ["review", "Needs review"], ["manual", "Manual"], ["locked", "Locked"], ["character", "Character"], ["location", "Location"], ["organization", "Organization"], ["ability", "Ability"], ["item", "Item"], ["concept", "Concept"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button disabled={busy} onClick={() => void run(false, true)}>✨ Generate pronunciation suggestions</button></div><div className="pronunciation-desk"><div className="pronunciation-list">{visible.map(e => <button key={e.id} disabled={busy} aria-pressed={selected === e.id} onClick={() => choose(e)}><b>{e.localizedNaming?.fullName ?? e.preferredNarrationName ?? e.canonicalName}</b><small>{e.type} · Original: {(e.pronunciation?.originalText ?? suggestions[e.id]?.originalText ?? e.originalName) || "—"}</small><span>{status(e)}</span></button>)}</div>{selected && selectedEntity && <div>{!active(selectedEntity) && suggestion && <SuggestionCard suggestion={suggestion} busy={busy} onAccept={() => void suggestionAction("accept-suggestion")} onEdit={() => setDraft({ ...suggestion })} onIgnore={() => void suggestionAction("dismiss-suggestion")} />}<PronunciationFields value={draft} onChange={setDraft} /><div className="pronunciation-tools"><button disabled={busy || (draft?.mode === "custom" && !draft.customPronunciation)} onClick={() => void save()}>{draft ? "Save pronunciation" : "Use default TTS"}</button><button disabled={busy || draft?.locked || draft?.source === "manual"} onClick={() => void run(false)}>{suggestion ? "✨ Regenerate suggestion" : "✨ Generate suggestion with AI"}</button><button disabled={busy} onClick={() => void run(true)}>▶ Test pronunciation</button></div>{audio && <audio controls src={audio} />}</div>}</div></details>;
}
