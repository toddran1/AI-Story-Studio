import { useEffect, useRef, useState } from "react";
import type { SourceInspectionProgress } from "../../../src/source/types.js";
import { cancelSourceVerification, completeSourceVerification, openSourceVerification } from "./api.js";

export function SourceInspectionModal({ progress, error, sourceUrl, onRetry, onClose }: { progress: SourceInspectionProgress; error?: string; sourceUrl?: string; onRetry?: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current; if (!element) return;
    element.showModal();
    return () => { element.close(); };
  }, []);
  const [verification, setVerification] = useState<"idle" | "opening" | "open" | "verifying">("idle");
  const [verificationError, setVerificationError] = useState("");
  const chapters = progress.phase === "chapters" && progress.total !== undefined && progress.total > 0;
  const percent = chapters ? Math.min(100, Math.round((progress.completed ?? 0) / progress.total! * 100)) : undefined;
  const challenge = !!error && /browser verification|CHALLENGE_REQUIRED|just a moment|challenge required/iu.test(error);
  let challengeUrl: string | undefined;
  try { const parsed = new URL(sourceUrl ?? ""); if (parsed.protocol === "https:" && !parsed.username && !parsed.password) challengeUrl = parsed.href; } catch { /* File imports have no website. */ }
  const openVerification = async () => {
    if (!challengeUrl) return;
    setVerification("opening"); setVerificationError("");
    try { await openSourceVerification(challengeUrl); setVerification("open"); }
    catch (cause) { setVerification("idle"); setVerificationError(cause instanceof Error ? cause.message : "The verification window could not be opened."); }
  };
  const completeVerification = async () => {
    setVerification("verifying"); setVerificationError("");
    try { await completeSourceVerification(); setVerification("idle"); onRetry?.(); }
    catch (cause) { setVerification("open"); setVerificationError(cause instanceof Error ? cause.message : "Verification could not be completed."); }
  };
  const cancelVerification = async () => {
    setVerificationError("");
    try { await cancelSourceVerification(); } catch { /* Closing the local session is best effort. */ }
    setVerification("idle");
  };
  const label = {
    preparing: "Preparing your source…", metadata: "Reading book details…",
    directory: `Loading chapter directory${progress.pagesChecked ? ` · ${progress.pagesChecked} pages checked` : ""}…`,
    chapters: `Inspecting chapter ${progress.current ?? 0} of ${progress.total ?? 0}`,
    fallback: "Checking another configured source…", preview: "Preparing your update preview…",
  }[progress.phase];
  return <dialog ref={dialog} className="source-inspection-modal" aria-labelledby="source-inspection-title" aria-describedby="source-inspection-description" onCancel={(event) => { event.preventDefault(); if (error) onClose(); }}>
    <span className="eyebrow">Chapter intake</span>
    <h3 id="source-inspection-title">{error ? "Inspection needs attention" : "Inspecting chapters"}</h3>
    <div className="source-inspection-status" role="status" aria-live="polite" aria-atomic="true">
      <strong>{error ? "Unable to finish inspection" : label}</strong>
      {!error && chapters && <p>Chapter {progress.chapter}{progress.title ? ` · ${progress.title}` : ""}</p>}
      {!error && progress.provider && <small>{progress.provider.toUpperCase()} source</small>}
    </div>
    {!error && <progress aria-label="Chapter inspection progress" max={chapters ? progress.total : undefined} value={chapters ? progress.completed ?? 0 : undefined} />}
    {!error && chapters && <div className="source-inspection-completion"><span>{progress.completed ?? 0} of {progress.total} chapters checked</span><span>{percent}%</span></div>}
    <p id="source-inspection-description">{error ? "Your stored chapters have not been changed." : "Keep this page open. The update preview will appear when inspection finishes. Your stored chapters remain unchanged until you import."}</p>
    {error && <><p className="intake-error" role="alert">{error}</p>
      {challenge && challengeUrl && <div className="source-challenge-actions">
        <p>Open a verification window (a visible Chrome window controlled by the studio), solve the website's browser challenge there, then return here. The studio reuses that window's session for its own requests.</p>
        <button className="button primary" disabled={verification === "opening" || verification === "open" || verification === "verifying"} onClick={() => void openVerification()}>{verification === "opening" ? "Opening verification window…" : verification === "open" || verification === "verifying" ? "Verification window open" : "Open verification window"}</button>
        {(verification === "open" || verification === "verifying") && <>
          <button className="button primary" disabled={verification === "verifying"} onClick={() => void completeVerification()}>{verification === "verifying" ? "Verifying…" : "I've cleared the challenge — retry"}</button>
          <button className="button" disabled={verification === "verifying"} onClick={() => void cancelVerification()}>Cancel verification</button>
        </>}
        {verificationError && <p className="intake-error" role="alert">{verificationError}</p>}
        <p>Prefer to look at the site yourself? Open the source website in your own browser — note it uses a separate session, so verification there will not unblock the studio.</p>
        <a className="button" href={challengeUrl} target="_blank" rel="noopener noreferrer">Open source website</a>
        {onRetry && <button className="button" onClick={onRetry}>Retry inspection</button>}
      </div>}
      <button className="button" autoFocus onClick={onClose}>Close</button></>}
  </dialog>;
}
