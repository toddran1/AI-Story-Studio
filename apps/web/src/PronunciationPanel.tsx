import { useEffect, useRef, useState } from "react";
import { api, post, put, type Job } from "./api.js";
import { LanguageSelect } from "./languages.js";
import type { CanonicalEntity, EntityPronunciation } from "../../../src/domain/story-bible.js";
import "./pronunciation.css";

export function PronunciationFields({ value, onChange }: { value?: EntityPronunciation; onChange: (value: EntityPronunciation | undefined) => void }) {
  const p = value ?? { mode: "automatic" as const };
  const edit = (patch: Partial<EntityPronunciation>) => onChange({ ...p, ...patch, source: "manual", updatedAt: new Date().toISOString() });
  const field = (key: "originalText" | "romanization" | "ipa" | "phoneticHint" | "customPronunciation", label: string) => <label>{label}<input value={p[key] ?? ""} maxLength={key === "originalText" || key === "romanization" ? 300 : 500} onChange={event => edit({ [key]: event.target.value || undefined })} /></label>;
  return <fieldset className="pronunciation-fields"><legend>Pronunciation</legend><p>Controls how the name sounds. Displayed narration stays unchanged.</p><label>Source language<LanguageSelect value={p.sourceLanguage ?? ""} onChange={sourceLanguage => edit({ sourceLanguage })} /></label>{field("originalText", "Original text")}{field("romanization", "Romanization")}<label>Mode<select value={p.mode} onChange={event => edit({ mode: event.target.value as EntityPronunciation["mode"] })}><option value="automatic">Automatic</option><option value="original_language">Original-language pronunciation</option><option value="custom">Custom</option></select></label>{p.mode === "custom" && field("customPronunciation", "Custom spoken form")}<details><summary>Advanced pronunciation</summary>{field("ipa", "IPA")}{field("phoneticHint", "Phonetic hint for speech synthesis")}</details><label><input type="checkbox" checked={p.locked ?? false} onChange={event => edit({ locked: event.target.checked })} /> Lock pronunciation</label><small>{p.source ?? "Not enriched"}{p.confidence !== undefined ? ` · ${Math.round(p.confidence * 100)}% confidence` : ""}</small><button type="button" onClick={() => onChange(undefined)}>Return to automatic enrichment</button></fieldset>;
}

export function PronunciationPanel({ slug }: { slug: string }) {
  const [entities, setEntities] = useState<CanonicalEntity[]>([]), [selected, setSelected] = useState<string>(), [draft, setDraft] = useState<EntityPronunciation>(), [query, setQuery] = useState(""), [filter, setFilter] = useState("all"), [error, setError] = useState(""), [busy, setBusy] = useState(false), [audio, setAudio] = useState<string>(), [notice, setNotice] = useState("");
  const generation = useRef(0), mounted = useRef(true), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { mounted.current = true; setEntities([]); setSelected(undefined); setDraft(undefined); setBusy(false); setError(""); setAudio(undefined); setNotice(""); const token = ++generation.current; api<{ entities: CanonicalEntity[] }>(`/stories/${slug}/pronunciation`).then(result => { if (token === generation.current && mounted.current) setEntities(result.entities); }).catch(e => { if (token === generation.current && mounted.current) setError(String(e)); }); return () => { mounted.current = false; generation.current++; clearTimeout(timer.current); }; }, [slug]);
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
            else { const result = await api<{ entities: CanonicalEntity[] }>(`/stories/${slug}/pronunciation`); if (!mounted.current || token !== generation.current) return; setEntities(result.entities); setDraft(result.entities.find(e => e.id === selected)?.pronunciation); setNotice("Pronunciation enrichment completed. Manual and locked records were preserved."); }
            setBusy(false); return;
          }
        } catch (e) { if (!mounted.current || token !== generation.current) return; if (++failures >= 5 || String(e).includes("job stopped") || String(e).includes("Pronunciation")) { setError(String(e)); setBusy(false); return; } }
        timer.current = setTimeout(() => void poll(), 1000);
      }; void poll();
    } catch (e) { if (mounted.current && token === generation.current) { setError(String(e)); setBusy(false); } }
  };
  const save = async () => { const token = generation.current; setBusy(true); try { const result = await put<any>(`/stories/${slug}/pronunciation/${selected}`, draft ?? null); if (!mounted.current || token !== generation.current) return; setEntities(items => items.map(e => e.id === selected ? result.entity : e)); setNotice("Pronunciation saved. Referenced audio is marked stale."); setAudio(undefined); } catch (e) { if (mounted.current && token === generation.current) setError(String(e)); } finally { if (mounted.current && token === generation.current) setBusy(false); } };
  const visible = entities.filter(e => [e.canonicalName, e.originalName, e.localizedNaming?.fullName ?? "", e.preferredNarrationName ?? "", e.pronunciation?.romanization ?? ""].join(" ").toLocaleLowerCase().includes(query.toLocaleLowerCase())).filter(e => filter === "all" || filter === e.type || (filter === "needs" && !e.pronunciation) || (filter === "low" && (e.pronunciation?.confidence ?? 0) < .7) || (filter === "manual" && e.pronunciation?.source === "manual") || (filter === "locked" && e.pronunciation?.locked));
  return <details className="pronunciation-management"><summary>Pronunciation desk · {entities.length} entities</summary><p>Inspect how preserved foreign names are spoken with this book’s configured voice.</p>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}<div className="pronunciation-tools"><input aria-label="Search pronunciations" placeholder="Search name, original or romanization" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Filter pronunciations" value={filter} onChange={e => setFilter(e.target.value)}>{["all", "character", "location", "organization", "ability", "item", "concept", "needs", "low", "manual", "locked"].map(f => <option key={f} value={f}>{f === "needs" ? "Needs pronunciation" : f === "low" ? "Low confidence" : f}</option>)}</select><button disabled={busy} onClick={() => void run(false, true)}>Enrich missing pronunciations · uses AI</button></div><div className="pronunciation-desk"><div className="pronunciation-list">{visible.map(e => <button key={e.id} disabled={busy} aria-pressed={selected === e.id} onClick={() => choose(e)}><b>{e.localizedNaming?.fullName ?? e.preferredNarrationName ?? e.canonicalName}</b><small>{e.type} · {e.originalName} · {e.pronunciation?.sourceLanguage ?? "Language not set"}</small><span>{e.pronunciation?.romanization ?? "Not enriched"} · {e.pronunciation?.mode ?? "automatic"}{e.pronunciation?.locked ? " · locked" : ""}{e.pronunciation?.confidence !== undefined ? ` · ${Math.round(e.pronunciation.confidence * 100)}%` : ""}</span></button>)}</div>{selected && <div><PronunciationFields value={draft} onChange={setDraft} /><div className="pronunciation-tools"><button disabled={busy || (draft?.mode === "custom" && !draft.customPronunciation)} onClick={() => void save()}>Save pronunciation</button><button disabled={busy || draft?.locked || draft?.source === "manual"} onClick={() => void run(false)}>Regenerate automatic · uses AI</button><button disabled={busy} onClick={() => void run(true)}>Test saved pronunciation</button></div>{audio && <audio controls src={audio} />}</div>}</div></details>;
}
