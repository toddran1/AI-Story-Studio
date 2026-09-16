import { useEffect, useState, type ReactNode } from "react";
import { api, post, put, type Job, type StorySummary } from "./api.js";
import { estimateSummaryMinutes, SUMMARY_WORDS_PER_MINUTE } from "../../../src/summaries/types.js";
import { AudioDeck } from "./AudioDeck.js";
import { SummaryScenePanel, SummaryArtworkPanel, SummaryVideoPanel } from "./SummaryVisualPanels.js";

type Props = { slug: string; summary: StorySummary; busy: boolean; children: ReactNode;
  onChange: (summary: StorySummary) => void; onGenerate: (job: Job) => void; onError: (error: unknown) => void };

export function SummaryLayers({ slug, summary, busy, children, onChange, onGenerate, onError }: Props) {
  const [tab, setTab] = useState<"summary" | "narration" | "audio" | "scenes" | "artwork" | "video">("summary");
  const [text, setText] = useState(summary.narration?.text ?? "");
  const [working, setWorking] = useState(false);
  const [spokenText, setSpokenText] = useState<string>();
  useEffect(() => { setText(summary.narration?.text ?? ""); }, [summary.id, summary.narration?.text]);
  useEffect(() => { setSpokenText(undefined); if (tab === "narration" && summary.narration?.text) void api<{ spokenText: string }>(`/stories/${slug}/summaries/${summary.id}/spoken-text`).then(value => setSpokenText(value.spokenText)).catch(onError); }, [slug, summary.id, summary.narration?.text, tab]);
  const base = `/stories/${slug}/summaries/${summary.id}`;
  const download = (type: string) => `/api${base}/export/${type}?download=1`;
  const action = async (stage: "narration" | "audio") => {
    if (stage === "narration" && summary.narration?.manuallyEdited && !confirm("Replace your manual narration with a newly generated version?")) return;
    try { setWorking(true); onGenerate(await post<Job>(`${base}/${stage}`, { force: stage === "narration" ? Boolean(summary.narration) : summary.audio?.status === "current" })); }
    catch (error) { onError(error); } finally { setWorking(false); }
  };
  const save = async (acceptCurrent = false) => {
    try { setWorking(true); const result = await put<{ summary: StorySummary }>(`${base}/narration`, acceptCurrent ? { acceptCurrent: true } : { text }); onChange(result.summary); }
    catch (error) { onError(error); } finally { setWorking(false); }
  };
  const disabled = busy || working;
  return <div className="summary-layers"><nav className="summary-layer-tabs" aria-label="Summary layers">
    {(["summary", "narration", "audio", "scenes", "artwork", "video"] as const).map((value) => <button key={value} aria-pressed={tab === value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{value[0]!.toUpperCase() + value.slice(1)}<small>{value === "summary" ? "Canonical text" : summary[value]?.status ?? "Not generated"}</small></button>)}
  </nav>
    {tab === "summary" ? <><div className="summary-layer-note">Canonical recap · naming and voice settings do not change this text.<a className="button" download href={download("summary")}>Download TXT</a></div>{children}</> : tab === "narration" ? <div className="summary-media-editor">
      <header><span className="eyebrow">Text used for audio</span><h3>Narration recap</h3><p>Uses this book’s localization, preferred names, alias rules, and narration preferences.</p></header>
      <div className="summary-meta"><span>{summary.narration?.status ?? "Not generated"}</span>{summary.narration?.manuallyEdited && <span>Manual edit</span>}<span>About {estimateSummaryMinutes(text).toFixed(1)} minutes · 150 words/min</span>{summary.narration?.model && <span>{summary.narration.provider} · {summary.narration.model}</span>}</div>
      {summary.narration?.reviewRequired && <div className="summary-media-warning">Naming or narration settings changed. Your manual text is preserved; review and retain it, or regenerate.</div>}
      {summary.narration?.error && <div className="error-box">{summary.narration.error}</div>}
      <textarea aria-label="Edit summary narration" value={text} onChange={(event) => setText(event.target.value)} placeholder="Generate narration from the canonical summary first." />
      {spokenText && spokenText !== text && <details className="spoken-text-preview"><summary>View spoken text</summary><p>This is the provider-neutral representation sent through pronunciation and TTS processing. Your visible narration remains unchanged.</p><pre>{spokenText}</pre></details>}
      <footer><button className="button" disabled={disabled} onClick={() => void action("narration")}>{summary.narration ? "Regenerate narration" : "Generate narration"}</button>{summary.narration?.reviewRequired && <button className="button" disabled={disabled} onClick={() => void save(true)}>Retain / mark current</button>}<button className="button primary" disabled={disabled || !text.trim()} onClick={() => void save()}>Save narration edits</button>{summary.narration?.text && <a className="button" download href={download("narration")}>Download TXT</a>}</footer>
    </div> : tab === "scenes" ? <SummaryScenePanel key={summary.id} summary={summary} base={base} disabled={disabled} onChange={onChange} onGenerate={onGenerate} onError={onError} /> : tab === "artwork" ? <SummaryArtworkPanel key={summary.id} summary={summary} base={base} disabled={disabled} onChange={onChange} onGenerate={onGenerate} onError={onError} /> : tab === "video" ? <SummaryVideoPanel key={summary.id} summary={summary} base={base} disabled={disabled} onChange={onChange} onGenerate={onGenerate} onError={onError} /> : <div className="summary-media-editor">
      <header><span className="eyebrow">Listening copy</span><h3>Summary audio</h3><p>Generated from narration, using this book’s configured voice, delivery, censoring, and mastering.</p></header>
      <div className="summary-meta"><span>{summary.audio?.status ?? "Not generated"}</span>{summary.audio?.durationSeconds !== undefined && <span>{(summary.audio.durationSeconds / 60).toFixed(1)} minutes · MP3</span>}{summary.audio?.model && <span>{summary.audio.provider} · {summary.audio.model}</span>}{summary.audio?.voice && <span>Voice {summary.audio.voice}</span>}</div>
      {summary.audio?.status === "stale" && <div className="summary-media-warning">This audio uses older inputs. Regenerate to apply the current settings.</div>}
      {(summary.audio?.error || summary.tts?.error) && <div className="error-box">{summary.audio?.error ?? summary.tts?.error}</div>}
      {summary.audio?.outputFingerprint ? <AudioDeck key={summary.audio.outputFingerprint} title={summary.title} src={`/api${base}/export/audio?v=${summary.audio.outputFingerprint}`} /> : <p>No audio yet. Generate a listening copy below.</p>}
      <footer><button className="button primary" disabled={disabled || summary.status !== "complete"} onClick={() => void action("audio")}>{summary.audio ? "Generate / update audio" : "Generate audio"}</button>{summary.audio?.outputFingerprint && <a className="button" download href={download("audio")}>Download MP3</a>}</footer>
    </div>}
    {disabled && <p className="summary-media-working" role="status">Working… this may take a few minutes. You can track progress in the job panel.</p>}
  </div>;
}
export function SummaryLength({ words, onChange }: { words: number; onChange: (words: number) => void }) {
  const [mode, setMode] = useState("words");
  return <div className="summary-form-row"><label>Target length<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="words">Words</option><option value="minutes">Audio minutes (estimate)</option></select></label><label>{mode === "words" ? "Words" : "Minutes"}<input type="number" min={mode === "words" ? 50 : 0.34} max={mode === "words" ? 20000 : 133.33} step={mode === "words" ? 1 : 0.1} value={mode === "words" ? words : Number((words / SUMMARY_WORDS_PER_MINUTE).toFixed(2))} onChange={(event) => onChange(Math.round(Number(event.target.value) * (mode === "words" ? 1 : SUMMARY_WORDS_PER_MINUTE)))} /><small>Approximately {(words / SUMMARY_WORDS_PER_MINUTE).toFixed(1)} minutes at 150 words/min. Actual audio duration may vary.</small></label></div>;
}
