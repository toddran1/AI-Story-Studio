import type { ReactNode } from "react";

/** Historical inputs belong to the image version, not the current scene resolver. */
export function VisualGroundingPanel({ label, recorded, children }: { label: string; recorded: boolean; children?: ReactNode }) {
  return <div className="summary-grounding" aria-label={label}>
    <small>{label}</small>
    {recorded ? children : <span>Legacy artwork — detailed grounding was not recorded for this version.</span>}
  </div>;
}
