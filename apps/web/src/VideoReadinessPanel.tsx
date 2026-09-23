export type ReadinessCheck = { label: string; state: "ready" | "warning" | "blocker"; detail: string };

/** Read-only presentation of existing stage/artifact facts, never an alternate render gate. */
export function VideoReadinessPanel({ checks }: { checks: ReadinessCheck[] }) {
  const blockers = checks.filter((check) => check.state === "blocker").length;
  const warnings = checks.filter((check) => check.state === "warning").length;
  return <section className="video-readiness-panel" aria-label="Video readiness">
    <header><span className="eyebrow">Video readiness</span><strong>{blockers ? `${blockers} blocker${blockers === 1 ? "" : "s"}` : warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "Inputs available"}</strong></header>
    <div className="video-readiness-grid">{checks.map((check) => <div className={`video-readiness-check ${check.state}`} key={check.label}>
      <span aria-hidden="true">{check.state === "ready" ? "✓" : check.state === "warning" ? "!" : "×"}</span><b>{check.label}</b><small>{check.detail}</small>
    </div>)}</div>
    <p>Final file integrity and input fingerprints are checked by the renderer. This panel does not accept or regenerate any input.</p>
  </section>;
}
