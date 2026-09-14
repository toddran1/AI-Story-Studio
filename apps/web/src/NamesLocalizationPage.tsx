import { useDeferredValue, useEffect, useRef, useState } from "react";
import { api, Job, post, put } from "./api.js";
import { pretty } from "./format.js";
import "./names-localization.css";

type Entity = {
  id: string; type: string; canonicalName: string; originalName: string; aliases: string[]; description: string; status: string;
  preferredNarrationName?: string; firstAppearance: number; lastKnownAppearance: number;
  localizedNaming?: { locale: string; fullName?: string; shortName?: string; usageMode: UsageMode; notes?: string };
};
type UsageMode = "ai_contextual" | "always_full" | "always_short" | "manual";
type Draft = { locale: string; fullName: string; shortName: string; usageMode: UsageMode; notes: string };
type Suggestion = { fullName: string; shortName?: string; rationale: string };

export function NamesLocalizationPage({ slug, onJob, navigate }: { slug: string; onJob: (job: Job) => void; navigate: (path: string) => void }) {
  const requested = new URLSearchParams(location.search).get("entity");
  const [story, setStory] = useState<any>(); const [view, setView] = useState<any>(); const [detail, setDetail] = useState<any>();
  const [selected, setSelected] = useState<string | undefined>(requested ?? undefined); const [query, setQuery] = useState(""); const deferred = useDeferredValue(query);
  const [type, setType] = useState("all"); const [page, setPage] = useState(1); const [draft, setDraft] = useState<Draft>();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]); const [generating, setGenerating] = useState(false); const [saving, setSaving] = useState(false);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const fullNameRef = useRef<HTMLInputElement>(null); const pollTimer = useRef<number | undefined>(undefined);
  const loadEntities = () => api<any>(`/stories/${slug}/story-bible/entities?page=${page}&pageSize=50&type=${type}&sort=name&q=${encodeURIComponent(deferred)}`).then(setView);

  useEffect(() => { api<any>(`/stories/${slug}`).then((value) => setStory(value.story)).catch((value) => setError(message(value))); }, [slug]);
  useEffect(() => { setError(""); void loadEntities().catch((value) => setError(message(value))); }, [slug, page, type, deferred]);
  useEffect(() => { if (!selected) { setDetail(undefined); setDraft(undefined); return; } api<any>(`/stories/${slug}/story-bible/entities/${selected}`).then((value) => {
    setDetail(value); const naming = value.entity.localizedNaming; setDraft({ locale: naming?.locale ?? defaultLocale(story?.outputLanguage), fullName: naming?.fullName ?? value.entity.preferredNarrationName ?? "", shortName: naming?.shortName ?? "", usageMode: naming?.usageMode ?? "ai_contextual", notes: naming?.notes ?? "" });
  }).catch((value) => setError(message(value))); }, [slug, selected, story?.outputLanguage]);
  useEffect(() => () => { if (pollTimer.current !== undefined) clearTimeout(pollTimer.current); }, []);

  const choose = (id: string) => { setSelected(id); setSuggestions([]); setNotice(""); history.replaceState({}, "", `/stories/${slug}/names?entity=${id}`); };
  const save = async () => { if (!draft || !selected || saving) return; try { setSaving(true); setError(""); const response = await put<any>(`/stories/${slug}/story-bible/entities/${selected}`, { localizedNaming: { locale: draft.locale.trim(), fullName: draft.fullName.trim() || undefined, shortName: draft.shortName.trim() || undefined, usageMode: draft.usageMode, notes: draft.notes.trim() || undefined } }); const affected = response.invalidation?.affectedChapters?.length ?? 0; const manual = response.invalidation?.manualNarrationChapters?.length ?? 0; setNotice(affected ? `Saved. ${affected} affected chapter${affected === 1 ? "" : "s"} marked for regeneration.${manual ? ` ${manual} manual narration edit${manual === 1 ? " was" : "s were"} preserved for review.` : ""}` : "Localization saved."); setDetail({ ...detail, entity: response.entity }); await loadEntities(); } catch (value) { setError(message(value)); } finally { setSaving(false); } };
  const remove = async () => { if (!selected || !confirm("Remove this localized naming rule? Canonical and original names will remain unchanged.")) return; try { setSaving(true); const response = await put<any>(`/stories/${slug}/story-bible/entities/${selected}`, { localizedNaming: null }); setDetail({ ...detail, entity: response.entity }); setDraft({ locale: defaultLocale(story?.outputLanguage), fullName: "", shortName: "", usageMode: "ai_contextual", notes: "" }); setSuggestions([]); setNotice("Localization removed. Affected generated outputs were marked stale."); await loadEntities(); } catch (value) { setError(message(value)); } finally { setSaving(false); } };
  const generate = async (count = 5) => { if (!selected || !draft || generating) return; try { setGenerating(true); setError(""); const job = await post<Job>(`/stories/${slug}/story-bible/entities/${selected}/localization-suggestions`, { locale: draft.locale.trim(), count }); onJob(job); poll(job.id); } catch (value) { setGenerating(false); setError(message(value)); } };
  const poll = (id: string) => { const check = async () => { try { const job = await api<Job>(`/jobs/${id}`); onJob(job); if (job.status === "completed") { setSuggestions(job.result?.suggestions ?? []); setGenerating(false); return; } if (job.status === "failed" || job.status === "paused") { setError(job.error ?? "Name suggestions did not finish"); setGenerating(false); return; } pollTimer.current = window.setTimeout(check, 800); } catch (value) { setError(message(value)); setGenerating(false); } }; void check(); };
  const useSuggestion = (suggestion: Suggestion, focus = false) => { if (!draft) return; setDraft({ ...draft, fullName: suggestion.fullName, shortName: suggestion.shortName ?? "" }); if (focus) window.setTimeout(() => fullNameRef.current?.focus(), 0); };
  const entity = detail?.entity as Entity | undefined;

  return <section className="page localization-page">
    <div className="section-heading localization-heading"><div><span className="eyebrow">Target-language identity desk</span><h2>Names / Localization</h2><p>Shape how established entities are named without changing who they are.</p></div><button className="button" onClick={() => navigate(`/stories/${slug}/bible`)}>Open Story Bible</button></div>
    {error && <div className="error-box">{error}</div>}{notice && <div className="naming-notice">{notice}</div>}
    <div className="localization-workspace">
      <aside className="localization-index">
        <div className="localization-search"><input className="search" value={query} placeholder="Search any name" onChange={(event) => { setQuery(event.target.value); setPage(1); }} /><select value={type} onChange={(event) => { setType(event.target.value); setPage(1); }}><option value="all">All entity types</option>{["character","location","organization","ability","item","concept"].map((value) => <option key={value} value={value}>{pretty(value)}</option>)}</select></div>
        <div className="localization-list">{view?.items?.map((item: Entity) => <button key={item.id} className={selected === item.id ? "active" : ""} onClick={() => choose(item.id)}><span className="entity-glyph">{item.type.slice(0, 1).toUpperCase()}</span><span><b>{item.localizedNaming?.fullName ?? item.localizedNaming?.shortName ?? item.canonicalName}</b><small>{item.canonicalName}{item.originalName ? ` · ${item.originalName}` : ""}</small></span>{item.localizedNaming && <i>{item.localizedNaming.locale}</i>}</button>)}</div>
        {view && <div className="localization-pagination"><button disabled={view.page <= 1} onClick={() => setPage(view.page - 1)}>←</button><span>{view.page} / {view.pages}</span><button disabled={view.page >= view.pages} onClick={() => setPage(view.page + 1)}>→</button></div>}
      </aside>
      <main className="localization-sheet">
        {!entity || !draft ? <div className="localization-empty"><span>文 / A</span><h3>Select an entity to localize</h3><p>Original identity stays fixed. You are choosing how it should read in {story?.outputLanguage ?? "the output locale"}.</p></div> : <>
          <header className="identity-stack">
            <div><span>01 · Original identity</span><b>{entity.originalName || "Not recorded"}</b></div>
            <div><span>02 · Canonical translated identity</span><b>{entity.canonicalName}</b><small>{entity.aliases.length ? entity.aliases.join(" · ") : "No aliases recorded"}</small></div>
            <div className="localized"><span>03 · Localized preferred identity</span><b>{draft.fullName || draft.shortName || "Not localized yet"}</b><small>{draft.shortName && draft.fullName ? `Short form · ${draft.shortName}` : `${pretty(draft.usageMode)} · ${draft.locale}`}</small></div>
          </header>
          <div className="localization-body">
            <section className="localization-form">
              <div className="localization-form-head"><div><span className="eyebrow">{pretty(entity.type)} · Ch. {entity.firstAppearance}—{entity.lastKnownAppearance}</span><h3>Localized naming rule</h3></div>{entity.localizedNaming && <button onClick={() => void remove()}>Remove</button>}</div>
              <label><span>Target locale</span><input value={draft.locale} onChange={(event) => setDraft({ ...draft, locale: event.target.value })} placeholder="en-US" /></label>
              <div className="localized-name-pair"><label><span>{entity.type === "character" ? "Full name" : "Localized name"}</span><input ref={fullNameRef} value={draft.fullName} onChange={(event) => setDraft({ ...draft, fullName: event.target.value })} placeholder={entity.canonicalName} /></label>{entity.type === "character" && <label><span>Short name</span><input value={draft.shortName} onChange={(event) => setDraft({ ...draft, shortName: event.target.value })} placeholder="Familiar form" /></label>}</div>
              <label><span>Usage mode</span><select value={draft.usageMode} onChange={(event) => setDraft({ ...draft, usageMode: event.target.value as UsageMode })}><option value="ai_contextual">AI contextual</option><option value="always_full">Always full name</option><option value="always_short">Always short name</option><option value="manual">Manual rules</option></select><small>{modeHelp(draft.usageMode)}</small></label>
              <label><span>{draft.usageMode === "manual" ? "Required output rules" : "Localization notes"}</span><textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder={draft.usageMode === "manual" ? "Describe exactly when each form should be used…" : "Optional cultural, pronunciation, title, or formality guidance…"} /></label>
              {entity.preferredNarrationName && !entity.localizedNaming && <div className="legacy-name-note"><b>Existing narration preference · {entity.preferredNarrationName}</b><span>It remains active until you save a localization rule. First-class localization then takes precedence.</span></div>}
              <button className="button primary localization-save" disabled={saving || (!draft.fullName.trim() && !draft.shortName.trim()) || (draft.usageMode === "always_full" && !draft.fullName.trim()) || (draft.usageMode === "always_short" && !draft.shortName.trim())} onClick={() => void save()}>{saving ? "Saving…" : "Save localization"}</button>
            </section>
            <aside className="suggestion-studio"><div><span className="eyebrow">AI naming room</span><h3>Locale-aware suggestions</h3><p>Uses Story Bible context, relationships, and your configured narration model.</p></div><button className="button" disabled={generating || !draft.locale.trim()} onClick={() => void generate(suggestions.length ? 8 : 5)}>{generating ? "Generating…" : suggestions.length ? "Generate more" : "Generate suggestions"}</button>
              <div className="suggestion-list">{suggestions.map((suggestion, index) => <article key={`${suggestion.fullName}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><div><b>{suggestion.fullName}</b>{suggestion.shortName && <small>Short · {suggestion.shortName}</small>}<p>{suggestion.rationale}</p><footer><button onClick={() => useSuggestion(suggestion)}>Use suggestion</button><button onClick={() => useSuggestion(suggestion, true)}>Edit suggestion</button></footer></div></article>)}</div>
            </aside>
          </div>
        </>}
      </main>
    </div>
  </section>;
}

function modeHelp(mode: UsageMode) { return ({ ai_contextual: "The model chooses full or short form from familiarity, formality, introductions, dialogue, and ambiguity.", always_full: "Use the full localized name whenever this entity is named.", always_short: "Use the short localized name whenever this entity is named.", manual: "Follow the explicit rules below for every generated narration." } as const)[mode]; }
function defaultLocale(language?: string) { const value = language?.trim(); if (value && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)) return value; return ({ english: "en-US", chinese: "zh-CN", spanish: "es-ES", french: "fr-FR", german: "de-DE", japanese: "ja-JP", korean: "ko-KR", portuguese: "pt-BR", italian: "it-IT", russian: "ru-RU" } as Record<string, string>)[value?.toLocaleLowerCase() ?? ""] ?? "en-US"; }
function message(value: unknown) { return value instanceof Error ? value.message : String(value); }
