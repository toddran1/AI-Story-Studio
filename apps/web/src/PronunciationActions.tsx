import { useEffect, useRef, useState } from "react";
import { api, post, type Job } from "./api.js";
import type { EntityPronunciation } from "../../../src/domain/story-bible.js";

export function PronunciationActions({ slug, id, locked, protectionReason = "locked", hasAutomatic = false, onEnriched }: { slug: string; id: string; locked: boolean; protectionReason?: "locked" | "manual"; hasAutomatic?: boolean; onEnriched: (p: EntityPronunciation | undefined) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [audio, setAudio] = useState<string>();
  const token = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { token.current++; setBusy(false); setError(""); setAudio(undefined); return () => { token.current++; clearTimeout(timer.current); }; }, [slug, id]);
  const run = async (test: boolean) => {
    const current = ++token.current; setError(""); setBusy(true); let failures = 0;
    try {
      const job = await post<Job>(`/stories/${slug}/pronunciation/${id}/${test ? "test" : "enrich"}`, {});
      const poll = async () => {
        if (current !== token.current) return;
        try {
          const next = await api<Job>(`/jobs/${job.id}`); if (current !== token.current) return;
          if (next.status === "failed" || next.status === "paused") { setError(next.error ?? "Pronunciation job stopped"); setBusy(false); return; }
          failures = 0;
          if (next.status === "completed") { if (test) setAudio(next.result?.audioUrl); else { const suggestion = next.result?.suggestions?.[id]; onEnriched(suggestion ? { ...suggestion, source: "manual" as const, needsReview: false } : undefined); } setBusy(false); return; }
        } catch (e) { if (current !== token.current) return; if (++failures >= 5) { setError(`${String(e)}. Try again after checking the local server.`); setBusy(false); return; } }
        timer.current = setTimeout(() => void poll(), 1000);
      }; void poll();
    } catch (e) { if (current === token.current) { setError(String(e)); setBusy(false); } }
  };
  return <div className="pronunciation-tools">{locked ? <div className="pronunciation-protection" role="note"><strong>{protectionReason === "manual" ? "Manual pronunciation protected" : "Pronunciation locked"}</strong><p>{protectionReason === "manual" ? "Your manually set spoken form is protected from AI replacement. You can edit it in Custom spoken form above, then save the record." : "AI generation is disabled while Lock pronunciation is checked. Uncheck it above and save to change the lock. Manual spoken forms remain protected."}</p><span>Save changes before testing the spoken form.</span></div> : <button type="button" disabled={busy} onClick={() => void run(false)}>{hasAutomatic ? "✨ Regenerate AI pronunciation" : "✨ Generate pronunciation with AI"}</button>}<button type="button" disabled={busy} onClick={() => void run(true)}>▶ Test pronunciation</button><small>AI uses source-novel evidence. Save field changes before testing; manual and locked records are never overwritten.</small>{busy && <p role="status">Working on pronunciation…</p>}{error && <p role="alert">{error}</p>}{audio && <audio controls src={audio} />}</div>;
}
