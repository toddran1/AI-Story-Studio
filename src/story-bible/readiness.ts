import { CanonicalEntity, hasActivePronunciation } from "../domain/story-bible.js";

export type EntityReadinessState = "complete" | "attention" | "optional" | "na";
export type EntityReadinessKey = "identity" | "type" | "narration" | "localization" | "pronunciation" | "continuity" | "visualProfile" | "duplicates";

export interface EntityReadinessRow {
  key: EntityReadinessKey;
  state: EntityReadinessState;
  label: string;
  detail?: string;
}

export interface EntityReadinessContext {
  /** Open continuity findings that reference this entity. */
  continuityOpenCount?: number;
  /** Duplicate suggestions that include this entity. */
  duplicateCandidates?: number;
  /** A duplicate candidate exists whose type is incompatible with this entity's. */
  duplicateTypeConflict?: boolean;
  /** Persisted Visual Profile state; undefined when no profile exists. */
  visualProfile?: { status: "draft" | "approved"; needsReviewConflicts: number };
  /** An inert AI pronunciation suggestion awaits an explicit user decision. */
  pronunciationSuggestionPending?: boolean;
}

/**
 * Per-dimension readiness for a canonical entity. Pure and fs-free so the
 * server catalog and the web UI share one definition. States:
 * complete = configured and current; attention = needs a user decision;
 * optional = valid but not configured; na = not applicable by policy.
 */
export function entityReadiness(entity: CanonicalEntity, context: EntityReadinessContext = {}): EntityReadinessRow[] {
  const rows: EntityReadinessRow[] = [];

  rows.push(entity.originalName.trim()
    ? { key: "identity", state: "complete", label: "Identity", detail: "Canonical and original names recorded" }
    : { key: "identity", state: "optional", label: "Identity", detail: "No original name recorded" });

  rows.push(context.duplicateTypeConflict
    ? { key: "type", state: "attention", label: "Type", detail: `Typed ${entity.type} but a duplicate candidate has an incompatible type` }
    : { key: "type", state: "complete", label: "Type", detail: `Typed as ${entity.type}` });

  rows.push(entity.preferredNarrationName
    ? { key: "narration", state: "complete", label: "Narration", detail: `Narrated as "${entity.preferredNarrationName}"` }
    : { key: "narration", state: "optional", label: "Narration", detail: "Canonical name is narrated (no preferred name configured)" });

  rows.push(entity.localizedNaming
    ? { key: "localization", state: "complete", label: "Localization", detail: `Localized for ${entity.localizedNaming.locale}` }
    : { key: "localization", state: "optional", label: "Localization", detail: "No localized naming configured" });

  if (hasActivePronunciation(entity.pronunciation)) {
    rows.push(entity.pronunciation?.needsReview
      ? { key: "pronunciation", state: "attention", label: "Pronunciation", detail: "Active pronunciation is marked for review" }
      : { key: "pronunciation", state: "complete", label: "Pronunciation", detail: "Pronunciation configured" });
  } else if (context.pronunciationSuggestionPending) {
    rows.push({ key: "pronunciation", state: "optional", label: "Pronunciation", detail: "An AI suggestion is awaiting review" });
  } else {
    rows.push({ key: "pronunciation", state: "na", label: "Pronunciation", detail: "Default provider pronunciation (opt-in not configured)" });
  }

  const openFindings = context.continuityOpenCount ?? 0;
  rows.push(openFindings
    ? { key: "continuity", state: "attention", label: "Continuity", detail: `${openFindings} open continuity finding${openFindings === 1 ? "" : "s"}` }
    : { key: "continuity", state: "complete", label: "Continuity", detail: "No open continuity findings" });

  if (entity.visualProfilePolicy?.mode === "skip") {
    rows.push({ key: "visualProfile", state: "na", label: "Visual Profile", detail: "Skipped by policy" });
  } else if (!context.visualProfile) {
    rows.push({ key: "visualProfile", state: "optional", label: "Visual Profile", detail: "No Visual Profile yet" });
  } else if (context.visualProfile.needsReviewConflicts > 0) {
    rows.push({ key: "visualProfile", state: "attention", label: "Visual Profile", detail: `${context.visualProfile.needsReviewConflicts} conflict${context.visualProfile.needsReviewConflicts === 1 ? "" : "s"} need${context.visualProfile.needsReviewConflicts === 1 ? "s" : ""} review` });
  } else {
    rows.push({ key: "visualProfile", state: "complete", label: "Visual Profile", detail: `Visual Profile ${context.visualProfile.status}` });
  }

  const candidates = context.duplicateCandidates ?? 0;
  rows.push(candidates
    ? { key: "duplicates", state: "attention", label: "Duplicates", detail: `${candidates} possible duplicate${candidates === 1 ? "" : "s"}` }
    : { key: "duplicates", state: "complete", label: "Duplicates", detail: "No duplicate candidates" });

  return rows;
}

export function readinessNeedsAttention(rows: EntityReadinessRow[]): boolean {
  return rows.some((row) => row.state === "attention");
}
