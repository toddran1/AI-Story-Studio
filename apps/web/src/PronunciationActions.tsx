import { useEffect, useRef, useState } from "react";
import { api, post, type Job } from "./api.js";
import type { EntityPronunciation } from "../../../src/domain/story-bible.js";

export function PronunciationActions({ slug, id, locked, onEnriched }: { slug: string; id: string; locked: boolean; onEnriched: (p: EntityPronunciation | undefined) => void }) {
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
          if (next.status === "completed") { if (test) setAudio(next.result?.audioUrl); else onEnriched(next.result?.entities?.find((e: { id: string }) => e.id === id)?.pronunciation); setBusy(false); return; }
        } catch (e) { if (current !== token.current) return; if (++failures >= 5) { setError(`${String(e)}. Try again after checking the local server.`); setBusy(false); return; } }
        timer.current = setTimeout(() => void poll(), 1000);
      }; void poll();
    } catch (e) { if (current === token.current) { setError(String(e)); setBusy(false); } }
  };
  return <div className="pronunciation-tools"><button type="button" disabled={busy || locked} onClick={() => void run(false)}>Regenerate saved automatic pronunciation · uses AI</button><button type="button" disabled={busy} onClick={() => void run(true)}>Test saved pronunciation</button><small>Save field changes before testing. Manual or locked records are never overwritten.</small>{busy && <p role="status">Working on pronunciation…</p>}{error && <p role="alert">{error}</p>}{audio && <audio controls src={audio} />}</div>;
}
