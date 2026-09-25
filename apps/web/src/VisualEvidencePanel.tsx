import { useEffect, useState } from "react";
import type { CanonicalEntity, VisualEvidence } from "../../../src/domain/story-bible.js";
import { resolveEntityVisualEvidence } from "../../../src/story-bible/visual-evidence.js";
import { api, post } from "./api.js";

function label(path: string): string {
  return path.split(".")[1]?.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase()) ?? path;
}

export function VisualEvidencePanel({ slug, entity, chapter, readOnly = false }: { slug: string; entity: CanonicalEntity; chapter: number; readOnly?: boolean }) {
  const [current, setCurrent] = useState(entity);
  useEffect(() => setCurrent(entity), [entity]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expandedFields, setExpandedFields] = useState<string[]>([]);
  const shown = readOnly ? entity : current;
  const resolved = resolveEntityVisualEvidence(shown, chapter);
  const decisions = shown.visualEvidenceDecisions ?? [];
  const dismissedIds = new Set(decisions.filter((decision) => decision.action === "dismiss").map((decision) => decision.evidenceId));
  const persistent = (shown.visualEvidence ?? []).filter((item) => item.persistence !== "temporary" && item.chapter <= chapter);
  const groups = Object.entries(persistent.reduce<Record<string, VisualEvidence[]>>((byField, item) => {
    (byField[item.field] ??= []).push(item);
    return byField;
  }, {})).sort(([a], [b]) => a.localeCompare(b));

  const decide = async (item: VisualEvidence, action: "select" | "change" | "dismiss" | "clear" | "restore") => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await post(`/stories/${slug}/story-bible/entities/${shown.id}/visual-evidence/decisions`, { field: item.field, evidenceId: item.id, action });
      const detail = await api<{ entity: CanonicalEntity }>(`/stories/${slug}/story-bible/entities/${shown.id}`);
      setCurrent(detail.entity);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  if (!groups.length && !resolved.temporary.length) return <p className="empty-text">No source-grounded visual observations yet.</p>;

  return <section className="entity-detail-section visual-evidence-panel">
    <p className="empty-text">Source observations are story knowledge. Visual Profile approval remains separate.</p>
    {groups.map(([field, records]) => {
      const items = [...(records ?? [])].sort((a, b) => a.chapter - b.chapter);
      const relevantItems = items.filter((item) => !dismissedIds.has(item.id));
      const competingObservations = relevantItems.length > 1;
      const latestEditorialDecision = [...decisions].reverse().find((decision) => decision.field === field && decision.action !== "dismiss" && items.some((item) => item.id === decision.evidenceId));
      const hasEditorialDecision = Boolean(latestEditorialDecision);
      const visibleItems = expandedFields.includes(field) || items.length <= 40 ? items : [items[0]!, ...items.slice(-39)];
      const chosen = resolved.values[field];
      const conflict = resolved.conflicts[field];
      return <div className="visual-evidence-field" key={field}>
        <strong>{label(field)}</strong>
        {chosen
          ? <p><span>Current: {chosen.value}</span> <small>· Since Chapter {chosen.chapter}{chosen.lastObservedChapter > chosen.chapter ? `–${chosen.lastObservedChapter}` : ""} · {Math.round(chosen.confidence * 100)}% confidence · {chosen.provenance.length} source{chosen.provenance.length === 1 ? "" : "s"}</small></p>
          : <p><span>Current: Unresolved</span>{conflict ? <small className="visual-evidence-unresolved"> · Conflicting source observations</small> : <small className="visual-evidence-unresolved"> · No active source observation</small>}</p>}
        {conflict && <p className="empty-text">Choose a current value or mark a later change to resolve this conflict.</p>}
        {items.length > 1 && <p className="empty-text">History / evidence: {items.slice(0, 5).map((item) => `Ch. ${item.chapter}: ${item.value}`).join(" → ")}{items.length > 10 ? ` → … ${items.length - 10} more → ` : items.length > 5 ? " → " : ""}{items.length > 5 ? items.slice(Math.max(5, items.length - 5)).map((item) => `Ch. ${item.chapter}: ${item.value}`).join(" → ") : ""}</p>}
        {visibleItems.map((item) => {
          const ignored = dismissedIds.has(item.id);
          const isConflict = conflict?.some((entry) => entry.id === item.id) ?? false;
          const isCurrent = !ignored && chosen?.id === item.id;
          const editorial = isCurrent ? [...decisions].reverse().find((decision) => decision.evidenceId === item.id && decision.action !== "dismiss") : undefined;
          const status = ignored ? "IGNORED"
            : isConflict ? "CONFLICT"
              : editorial?.action === "change" ? "EDITORIAL CHANGE"
                : editorial?.action === "select" ? "EDITORIAL CURRENT"
                  : isCurrent ? "CURRENT" : "HISTORICAL";
          const statusClass = ignored || status === "HISTORICAL" ? "muted" : isConflict ? "warn" : isCurrent ? "ok" : "";
          return <details key={item.id} className="visual-evidence-source">
            <summary>
              <span>Chapter {item.chapter}: {item.value}</span>
              <span className={`entity-chip visual-evidence-status ${statusClass}`}>{status}</span>
            </summary>
            <p>{item.provenance.slice(-5).map((source) => `Ch. ${source.chapter}: ${source.excerpt}`).join(" · ")}</p>
            {!readOnly && <div className="visual-evidence-actions">
              {!ignored && competingObservations && <>
                <button disabled={busy} onClick={() => void decide(item, "select")}>Keep as current</button>
                <button disabled={busy} onClick={() => void decide(item, "change")}>Mark later change</button>
              </>}
              {ignored
                ? <button disabled={busy} onClick={() => void decide(item, "restore")}>Restore observation</button>
                : <button disabled={busy} onClick={() => void decide(item, "dismiss")}>Ignore observation</button>}
              {hasEditorialDecision && <button disabled={busy} onClick={() => void decide(item, "clear")}>Leave unresolved</button>}
            </div>}
          </details>;
        })}
        {items.length > 40 && !expandedFields.includes(field) && <button type="button" className="inline-action-link" onClick={() => setExpandedFields([...expandedFields, field])}>Show all {items.length} observations</button>}
      </div>;
    })}
    {resolved.temporary.length > 0 && <details><summary>Temporary observations ({resolved.temporary.length})</summary>{resolved.temporary.map((item) => <p key={item.id}>{label(item.field)}: {item.value} <span className="entity-chip visual-evidence-status">TEMPORARY</span> · Chapter {item.chapter}</p>)}</details>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
