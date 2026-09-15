import { ReactNode } from "react";

export function ArtifactStatusNotice({ status, reason, generatedAt, children }: { status: "stale" | "failed"; reason?: string; generatedAt?: string; children?: ReactNode }) {
  return <div className={`artifact-status-notice ${status}`} role="status">
    <span className={`stage ${status}`}><i />{status === "stale" ? "Stale" : "Failed"}</span>
    <div className="artifact-status-body">
      {reason && <p>{reason}</p>}
      {generatedAt && <small>Generated {new Date(generatedAt).toLocaleString()}</small>}
      {children && <div className="artifact-status-actions">{children}</div>}
    </div>
  </div>;
}
