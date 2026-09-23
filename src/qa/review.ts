import { readFile } from "node:fs/promises";
import { chapterSchema } from "../domain/chapter.js";
import { QaCategory, QaFinding, QaState, qaStateSchema, QaStatus } from "../domain/qa.js";
import { Story } from "../domain/story.js";
import { StoryBible } from "../domain/story-bible.js";
import { LLMProvider } from "../llm/provider.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { storyPaths } from "../storage/paths.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { fingerprint } from "../utils/hash.js";
import {
  anchorFromIssue, computeFindingId, deriveIssues, extractNameRelation, FindingAnchor, findingFingerprint,
  migrateQaState, normalizeExcerptKey, normalizeQaText, openFindings, qaCounts, recomputeQaSummary,
} from "./findings.js";
import { computeQaDependencyFingerprint, computeQaDependencyFingerprints, qaDependencySnapshot, loadQaDeterministicDependencies, loadStoredQaDependencies, resolveStoredQaContext } from "./freshness.js";
import { QA_PROMPT_VERSION } from "./prompts.js";
import { validateChapterQuality } from "./validator.js";
import { runDeterministicQaChecks, type AcceptedContinuity } from "./deterministic.js";
import { exceptionsPromptSection, filterExceptedFindings, listQaExceptions } from "./exceptions.js";
import { loadStoryBibleWithCanonicalOverlay } from "../story-bible/canonical.js";
import { authorizedNarrationNames } from "../narration/naming-preferences.js";
import { persistQaStateWithMetadata } from "./persistence.js";
import type { QaDependencySnapshot } from "../domain/qa.js";

export type FreshQaDetection = {
  category: QaCategory;
  severity: "warn" | "fail";
  message: string;
  evidence: string;
  suggestedFix?: string;
  origin?: "llm" | "deterministic";
  safeToFix?: boolean;
  confidence?: number;
  /** Pre-resolved entity anchors (deterministic checks); merged into the computed anchor. */
  entityIds?: string[];
  /** Auto-anchoring found multiple possible identities; a single-ID exception cannot safely choose one. */
  entityMatchAmbiguous?: boolean;
  /** Deterministic rule identity (rule kind + matched token); part of the finding identity. */
  ruleKey?: string;
  /** Continuity findings this detection relates to; recorded in provenance. */
  continuityIds?: string[];
};

/** Anchor provider/deterministic detections before entity-scoped exception filtering. */
export function prepareQaDetections(detections: FreshQaDetection[], options: {
  canonicalEntities?: StoryBible["canonicalEntities"];
  effectiveNamingEntities?: StoryBible["canonicalEntities"];
  translation: string;
  narration: string;
}): FreshQaDetection[] {
  const paragraphs = combinedQaParagraphs(options.translation, options.narration).map((item) => item.text);
  return detections.map((detection) => {
    const entities = detection.category === "names" && options.effectiveNamingEntities?.length
      ? options.effectiveNamingEntities : options.canonicalEntities;
    const anchor = anchorFromIssue(detection, { canonicalEntities: entities, paragraphs });
    const anchoredIds = anchor.entityIds ?? [];
    return { ...detection, entityIds: [...new Set([...(detection.entityIds ?? []), ...anchoredIds])],
      ...(detection.entityIds?.length ? {} : anchoredIds.length > 1 ? { entityMatchAmbiguous: true } : {}) };
  });
}

export type ReconcileOutcome = { verified: number; respected: number; reopened: number; newFindings: number; obsoleted: number };

const tokenSet = (key?: string) => new Set((key ?? "").split(" ").filter(Boolean));

/** Containment overlap of excerpt token sets; 0 when either side has no excerpt. */
export function excerptOverlap(a?: string, b?: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (!sa.size || !sb.size) return 0;
  let intersection = 0;
  for (const token of sa) if (sb.has(token)) intersection++;
  return intersection / Math.min(sa.size, sb.size);
}

function previousAnchor(finding: QaFinding): FindingAnchor {
  return {
    entityIds: finding.provenance?.entityIds,
    excerptKey: finding.provenance?.excerptKey,
    messageKey: normalizeQaText(finding.message),
    paragraphBucket: undefined,
    relation: finding.provenance?.relation ?? extractNameRelation(finding),
  };
}

/**
 * Reattachment requires more than a bare shared entity: a shared entity plus
 * strong excerpt overlap or the same wrong>right name relation, or strong
 * excerpt overlap alone.
 */
function anchorsSimilar(previous: QaFinding, anchor: FindingAnchor): boolean {
  const prior = previousAnchor(previous);
  if (excerptOverlap(prior.excerptKey, anchor.excerptKey) >= 0.6) return true;
  const sharedEntity = Boolean(prior.entityIds?.length && anchor.entityIds?.length && prior.entityIds.some((id) => anchor.entityIds!.includes(id)));
  return sharedEntity && Boolean(prior.relation && anchor.relation && prior.relation === anchor.relation);
}

/** True when the finding's anchored entities/excerpt no longer appear in the current content. */
export function anchorAbsentFromContent(finding: QaFinding, content: string, entities: StoryBible["canonicalEntities"]): boolean {
  const normalized = normalizeQaText(content);
  if (!normalized) return false;
  const entityIds = finding.provenance?.entityIds ?? [];
  if (entityIds.length) {
    const names = entities.filter((entity) => entityIds.includes(entity.id))
      .flatMap((entity) => [entity.canonicalName, entity.originalName, ...entity.aliases, entity.preferredNarrationName ?? ""])
      .map((name) => normalizeQaText(name)).filter(Boolean);
    if (names.length && !names.some((name) => normalized.includes(name))) return true;
  }
  const excerptKey = finding.provenance?.excerptKey;
  if (excerptKey) {
    // Presence must mean a contiguous phrase survived, not scattered stopwords:
    // after a genuine rewrite, shared words like "su ming" or "chapter" remain
    // everywhere, but no 4-token run of the old excerpt does.
    const tokens = excerptKey.split(" ").filter(Boolean);
    if (tokens.length) {
      const window = Math.min(4, tokens.length);
      let present = false;
      for (let index = 0; index + window <= tokens.length; index++) {
        if (normalized.includes(tokens.slice(index, index + window).join(" "))) { present = true; break; }
      }
      if (!present) return true;
    }
  }
  return false;
}

/** For naming findings: the wrong term the issue names is no longer present in the current text. */
function wrongTermAbsent(finding: QaFinding, content: string): boolean {
  if (finding.category !== "names") return false;
  const relation = finding.provenance?.relation ?? extractNameRelation(finding);
  const wrong = relation?.split(">")[0] ?? "";
  if (wrong.length < 2) return false;
  const normalized = normalizeQaText(content);
  return normalized.length > 0 && !normalized.includes(wrong);
}

/** An old naming objection can be retired only when its disputed term and
 * identity both resolve uniquely to an explicit current Story Bible rule. */
function authorizedNamingObjection(finding: Pick<QaFinding, "category" | "message" | "evidence" | "provenance">, entities: StoryBible["canonicalEntities"]): { entity: string; used: string } | undefined {
  if (finding.category !== "names" || !entities.length) return undefined;
  const relation = finding.provenance?.relation ?? extractNameRelation(finding);
  const [wrong, right] = relation?.split(">") ?? [];
  const identityNames = (entity: StoryBible["canonicalEntities"][number]) => [entity.canonicalName, entity.originalName, ...entity.aliases].map(normalizeQaText);
  const anchors = finding.provenance?.entityIds ?? [];
  const candidates = entities.filter((entity) => anchors.length ? anchors.includes(entity.id) : right && identityNames(entity).includes(right));
  if (candidates.length !== 1) return undefined;
  const entity = candidates[0]!;
  if (right && !identityNames(entity).includes(right)) return undefined;
  const sourceName = right ? [entity.canonicalName, entity.originalName, ...entity.aliases].find((name) => normalizeQaText(name) === right) : undefined;
  const allowed = authorizedNarrationNames(entity, sourceName);
  const quoted = [...`${finding.message}\n${finding.evidence}`.matchAll(/["“]([^"”]{2,300})["”]/g)].map((match) => normalizeQaText(match[1]!));
  const disputed = wrong || (/(?:unauthori[sz]ed|improperly|incorrectly|wrong(?:ly)?|renam)/i.test(`${finding.message} ${finding.evidence}`)
    ? allowed.map(normalizeQaText).find((name) => quoted.includes(name)) : undefined);
  if (!disputed || !allowed.some((name) => normalizeQaText(name) === disputed)) return undefined;
  // A name shared with another identity cannot prove which entity the finding concerns.
  if (entities.some((other) => other.id !== entity.id && [...identityNames(other), ...authorizedNarrationNames(other).map(normalizeQaText)].includes(disputed))) return undefined;
  return { entity: entity.canonicalName, used: allowed.find((name) => normalizeQaText(name) === disputed)! };
}

/** True when the content a recheck actually evaluated plausibly covers the finding's anchored region. */
function anchorCoveredByEvaluation(finding: QaFinding, evaluatedContent: string, entities: StoryBible["canonicalEntities"]): boolean {
  const normalized = normalizeQaText(evaluatedContent);
  if (!normalized) return false;
  const entityIds = finding.provenance?.entityIds ?? [];
  const names = entities.filter((entity) => entityIds.includes(entity.id))
    .flatMap((entity) => [entity.canonicalName, entity.originalName, ...entity.aliases, entity.preferredNarrationName ?? ""])
    .map((name) => normalizeQaText(name)).filter(Boolean);
  if (names.some((name) => normalized.includes(name))) return true;
  const excerptKey = finding.provenance?.excerptKey;
  if (excerptKey) {
    const tokens = excerptKey.split(" ").filter(Boolean);
    const window = Math.min(4, tokens.length);
    for (let index = 0; index + window <= tokens.length; index++) {
      if (normalized.includes(tokens.slice(index, index + window).join(" "))) return true;
    }
  }
  return false;
}

/**
 * Merge fresh detections into the previous state. Match by computed finding id
 * first, then by same-category anchor similarity (shared entity plus excerpt
 * overlap or shared wrong-term relation, or strong excerpt overlap alone) so
 * LLM-reworded detections reconcile. When a dependency fingerprint is supplied
 * (a verification pass ran), every touched finding is stamped with it, and an
 * unmatched open finding is retired to obsolete only when the dependencies
 * changed since its last verification, the evaluated content covered its
 * anchored region, and its anchor (or wrong term) is gone from current content.
 */
export function reconcileQaState(
  previous: QaState | undefined,
  freshDetections: FreshQaDetection[],
  options: {
    now?: string;
    chapter?: number;
    canonicalEntities?: StoryBible["canonicalEntities"];
    effectiveNamingEntities?: StoryBible["canonicalEntities"];
    paragraphs?: string[];
    content?: string;
    /** QA dependency fingerprint this reconciliation verifies against. */
    dependencyFingerprint?: string;
    /** Content the verification actually evaluated (subset for changed-only rechecks). */
    evaluatedContent?: string;
  } = {},
): { findings: QaFinding[]; outcome: ReconcileOutcome } {
  const now = options.now ?? new Date().toISOString();
  const chapter = options.chapter ?? previous?.findings.find((finding) => finding.provenance?.chapter)?.provenance?.chapter ?? 0;
  const entities = options.canonicalEntities ?? [];
  const namingEntities = options.effectiveNamingEntities ?? [];
  const outcome: ReconcileOutcome = { verified: 0, respected: 0, reopened: 0, newFindings: 0, obsoleted: 0 };
  const findings = (previous?.findings ?? []).map((finding) => ({ ...finding }));
  const unmatched = new Map(findings.map((finding) => [finding.id, finding]));
  const stampVerification = (finding: QaFinding) => {
    if (options.dependencyFingerprint) finding.verifiedAgainstFingerprint = options.dependencyFingerprint;
  };

  const applyMatch = (prior: QaFinding, detection: FreshQaDetection) => {
    unmatched.delete(prior.id);
    prior.lastVerifiedAt = now;
    stampVerification(prior);
    if (prior.status === "open") {
      prior.message = detection.message;
      prior.evidence = detection.evidence;
      prior.suggestedFix = detection.suggestedFix ?? prior.suggestedFix;
      prior.fingerprint = findingFingerprint({ ...detection, category: prior.category, severity: detection.severity });
      prior.severity = detection.severity;
    } else if (prior.status === "fixed_manual" || prior.status === "fixed_ai") {
      // Regression: the fixed problem returned. Reopen but keep the resolution history.
      prior.status = "open";
      prior.reopenedAt = now;
      prior.message = detection.message;
      prior.evidence = detection.evidence;
      prior.severity = detection.severity;
      prior.fingerprint = findingFingerprint({ ...detection, category: prior.category, severity: detection.severity });
      outcome.reopened++;
    } else if (prior.status === "dismissed") {
      // Same anchored problem re-reported: the dismissal is respected.
      outcome.respected++;
    } else {
      prior.status = "open";
      prior.reopenedAt = now;
      outcome.reopened++;
    }
  };

  for (const detection of freshDetections) {
    const anchor = anchorFromIssue(detection, { canonicalEntities: detection.category === "names" && namingEntities.length ? namingEntities : entities, paragraphs: options.paragraphs });
    if (detection.entityIds?.length) anchor.entityIds = [...new Set([...(anchor.entityIds ?? []), ...detection.entityIds])];
    if (detection.ruleKey) anchor.ruleKey = detection.ruleKey;
    const id = computeFindingId(detection.category, chapter, anchor);
    const exact = unmatched.get(id);
    if (exact) { applyMatch(exact, detection); continue; }
    const similar = [...unmatched.values()].find((candidate) => candidate.category === detection.category && anchorsSimilar(candidate, anchor));
    if (similar) { applyMatch(similar, detection); continue; }
    findings.push({
      id,
      category: detection.category,
      severity: detection.severity,
      message: detection.message,
      evidence: detection.evidence,
      suggestedFix: detection.suggestedFix,
      status: "open",
      fingerprint: findingFingerprint(detection),
      firstDetectedAt: now,
      lastVerifiedAt: now,
      ...(options.dependencyFingerprint ? { verifiedAgainstFingerprint: options.dependencyFingerprint } : {}),
      provenance: {
        ...(chapter > 0 ? { chapter } : {}),
        ...(anchor.entityIds?.length ? { entityIds: anchor.entityIds } : {}),
        ...(anchor.excerptKey ? { excerptKey: anchor.excerptKey } : {}),
        ...(anchor.relation ? { relation: anchor.relation } : {}),
        ...(detection.continuityIds?.length ? { continuityIds: detection.continuityIds } : {}),
        ...(detection.ruleKey ? { ruleKey: detection.ruleKey } : {}),
      },
      origin: detection.origin ?? "llm",
      ...(detection.safeToFix !== undefined ? { safeToFix: detection.safeToFix } : {}),
      ...(detection.confidence !== undefined ? { confidence: detection.confidence } : {}),
    });
    outcome.newFindings++;
  }

  for (const prior of unmatched.values()) {
    if (prior.status === "open") {
      // Evidence-based retirement: dependencies changed since this finding was
      // last verified, the verification covered its anchored region, the
      // finding was not re-detected, and its anchor (or wrong term) is gone
      // from the current content. Legacy callers without a dependency
      // fingerprint keep the previous content-absence behavior.
      const dependenciesChanged = options.dependencyFingerprint === undefined || prior.verifiedAgainstFingerprint !== options.dependencyFingerprint;
      const covered = options.evaluatedContent === undefined || options.evaluatedContent === options.content
        || anchorCoveredByEvaluation(prior, options.evaluatedContent, entities);
      const anchorGone = options.content !== undefined
        && (anchorAbsentFromContent(prior, options.content, entities) || wrongTermAbsent(prior, options.content));
      // Deterministic rules re-evaluate the checked content on every recheck, so
      // a covered recheck that did not re-fire the rule is proof of absence even
      // when the anchor text remains (e.g. the rule itself was removed).
      const verifiedAbsent = anchorGone || prior.origin === "deterministic";
      const authorized = covered ? authorizedNamingObjection(prior, namingEntities) : undefined;
      if ((dependenciesChanged && covered && verifiedAbsent) || authorized) {
        prior.status = "obsolete";
        prior.resolution = {
          action: "obsolete", resolvedAt: now,
          ...(authorized ? { reason: `Obsolete because the current Story Bible explicitly authorizes “${authorized.used}” as the narration name for ${authorized.entity}.` }
            : options.dependencyFingerprint ? { reason: "Verified absent after the QA dependency fingerprint changed" } : {}),
        };
        prior.lastVerifiedAt = now;
        stampVerification(prior);
        outcome.obsoleted++;
        continue;
      }
      // Otherwise an open finding stays open: the LLM declining to re-report a
      // warn/fail is not proof the problem was fixed.
      stampVerification(prior);
    } else if (prior.status === "fixed_manual" || prior.status === "fixed_ai") {
      prior.lastVerifiedAt = now;
      stampVerification(prior);
      outcome.verified++;
    } else if (prior.status === "dismissed") {
      prior.lastVerifiedAt = now;
      stampVerification(prior);
      outcome.respected++;
    }
  }
  return { findings, outcome };
}

/** Bounded plain-text rendering of previous findings for the recheck prompt. */
export function compactFindingsContext(
  previous: Pick<QaState, "findings">,
  options: { maxFindings?: number; excerptLength?: number } = {},
): string {
  const max = options.maxFindings ?? 25;
  const excerptLength = options.excerptLength ?? 160;
  const order = (finding: QaFinding) => finding.status === "open" ? 0 : finding.status === "dismissed" ? 2 : finding.status === "obsolete" ? 3 : 1;
  const sorted = [...previous.findings].sort((a, b) => order(a) - order(b));
  const shown = sorted.slice(0, max);
  const truncate = (text: string) => text.length > excerptLength ? `${text.slice(0, excerptLength)}…` : text;
  const lines = shown.map((finding) => {
    const decision = finding.status === "open"
      ? "open"
      : `${finding.status} (${finding.resolution?.action ?? "resolved"}${finding.resolution?.reason ? `: ${finding.resolution.reason}` : ""})`;
    return `- [${decision}] ${finding.category} (${finding.severity}): ${finding.message} Evidence: ${truncate(finding.evidence)}`;
  });
  if (sorted.length > shown.length) lines.push(`- … and ${sorted.length - shown.length} more previous findings not listed here.`);
  return lines.join("\n");
}

const splitParagraphs = (text: string) => text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);

/** Combined, labeled paragraph sequence: translation paragraphs (T1..Tn) then narration (N1..Nm). */
export function combinedQaParagraphs(translation: string, narration: string): { label: string; text: string }[] {
  return [
    ...splitParagraphs(translation).map((text, index) => ({ label: `T${index + 1}`, text })),
    ...splitParagraphs(narration).map((text, index) => ({ label: `N${index + 1}`, text })),
  ];
}

export function computeContentSpans(translation: string, narration: string): QaState["contentSpans"] {
  const paragraphs = combinedQaParagraphs(translation, narration).map((paragraph) => paragraph.text);
  return { paragraphFingerprints: paragraphs.map((text) => fingerprint(text)), textFingerprint: fingerprint(paragraphs) };
}

export type ChangedSpanSelection = {
  paragraphs: { label: string; text: string }[];
  changedCount: number;
  totalCount: number;
  ratio: number;
};

/** Positional fingerprint diff; insertion/removal shifts count as changes and push toward full fallback. */
export function selectChangedParagraphs(previousSpans: QaState["contentSpans"], translation: string, narration: string): ChangedSpanSelection | undefined {
  if (!previousSpans) return undefined;
  const current = combinedQaParagraphs(translation, narration);
  const previousFingerprints = previousSpans.paragraphFingerprints;
  const total = Math.max(previousFingerprints.length, current.length);
  if (!total) return undefined;
  const changed = new Set<number>();
  for (let index = 0; index < total; index++) {
    if (previousFingerprints[index] === undefined || !current[index] || previousFingerprints[index] !== fingerprint(current[index]!.text)) changed.add(index);
  }
  const selected = new Set<number>();
  for (const index of changed) for (const neighbor of [index - 1, index, index + 1]) if (current[neighbor]) selected.add(neighbor);
  return {
    paragraphs: [...selected].sort((a, b) => a - b).map((index) => current[index]!),
    changedCount: changed.size,
    totalCount: total,
    ratio: changed.size / total,
  };
}

/** Conservative overlap: shared entities, or high excerpt containment with the continuity explanation. */
function relatesToContinuity(detection: FreshQaDetection, anchor: FindingAnchor, accepted: AcceptedContinuity): boolean {
  if (anchor.entityIds?.length && accepted.entityIds.some((id) => anchor.entityIds!.includes(id))) return true;
  return excerptOverlap(normalizeExcerptKey(accepted.explanation, 24), normalizeExcerptKey(`${detection.message} ${detection.evidence}`, 24)) >= 0.6;
}

/** Reconcile fresh detections with prior state and produce the full persistable QA state. */
export function buildQaState(
  previous: QaState | undefined,
  detections: FreshQaDetection[],
  options: {
    chapter: number;
    canonicalEntities?: StoryBible["canonicalEntities"];
    effectiveNamingEntities?: StoryBible["canonicalEntities"];
    translation: string;
    narration: string;
    now?: string;
    baseScore?: { score?: number; originalScore?: number; status?: QaStatus; originalStatus?: QaStatus };
    mode?: "production" | "thorough";
    acceptedContinuity?: AcceptedContinuity[];
    dependencyFingerprint?: string;
    dependencySnapshot?: QaDependencySnapshot;
    evaluatedContent?: string;
  },
): { state: QaState; outcome: ReconcileOutcome } {
  const paragraphs = combinedQaParagraphs(options.translation, options.narration).map((paragraph) => paragraph.text);
  const acceptedContinuity = options.acceptedContinuity ?? [];
  const prepared: FreshQaDetection[] = [];
  for (const detection of detections) {
    if (detection.category === "names" && options.effectiveNamingEntities?.length && authorizedNamingObjection({ ...detection, provenance: detection.entityIds?.length ? { entityIds: detection.entityIds } : undefined }, options.effectiveNamingEntities)) continue;
    if (detection.category === "storyConsistency" && (detection.origin ?? "llm") === "llm" && acceptedContinuity.length) {
      const anchor = anchorFromIssue(detection, { canonicalEntities: options.canonicalEntities, paragraphs });
      const related = acceptedContinuity.filter((accepted) => relatesToContinuity(detection, anchor, accepted));
      if (related.length) {
        const id = computeFindingId(detection.category, options.chapter, anchor);
        const existed = previous?.findings.some((finding) => finding.id === id);
        // A finding that merely restates an intentional/accepted continuity
        // decision is suppressed; only genuinely pre-existing or unrelated
        // detections survive.
        if (!existed) continue;
        prepared.push({ ...detection, continuityIds: [...new Set([...(detection.continuityIds ?? []), ...related.map((item) => item.id)])] });
        continue;
      }
    }
    prepared.push(detection);
  }
  const { findings, outcome } = reconcileQaState(previous, prepared, {
    now: options.now,
    chapter: options.chapter,
    canonicalEntities: options.canonicalEntities,
    effectiveNamingEntities: options.effectiveNamingEntities,
    paragraphs,
    content: `${options.translation}\n\n${options.narration}`,
    dependencyFingerprint: options.dependencyFingerprint,
    evaluatedContent: options.evaluatedContent,
  });
  const base = {
    score: options.baseScore?.score ?? previous?.score,
    originalScore: previous?.originalScore ?? options.baseScore?.originalScore,
    status: options.baseScore?.status ?? previous?.status,
    originalStatus: previous?.originalStatus ?? options.baseScore?.originalStatus,
  };
  const summary = recomputeQaSummary(findings, base);
  const state = qaStateSchema.parse({
    status: summary.status,
    score: summary.score,
    originalScore: summary.originalScore,
    originalStatus: summary.originalStatus,
    checks: summary.checks,
    issues: deriveIssues(findings),
    findings,
    contentSpans: computeContentSpans(options.translation, options.narration),
    ...(options.dependencySnapshot ? { dependencySnapshot: options.dependencySnapshot } : {}),
    ...((options.mode ?? previous?.mode) ? { mode: options.mode ?? previous?.mode } : {}),
  });
  return { state, outcome };
}

/** Index-based resolution used by the legacy dismiss/manually-fixed flow; maps to finding IDs. */
export function resolveQaFindingsByIndex(
  value: unknown,
  issueIndexes: number[],
  disposition: "dismissed" | "manually_fixed",
  reviewedAt = new Date().toISOString(),
  chapter?: number,
): QaState {
  const state = migrateQaState(value, { chapter });
  const indexes = [...new Set(issueIndexes)];
  if (!indexes.length || indexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= state.issues.length)) {
    throw new Error("One or more selected QA findings no longer exist. Reload the chapter and select them again.");
  }
  if (indexes.some((index) => state.issues[index]!.review !== undefined)) {
    throw new Error("One or more selected QA findings have already been resolved. Reload the chapter and select active findings.");
  }
  const findings = state.findings.map((finding) => ({ ...finding }));
  const targetable = findings.filter((finding) => finding.status !== "obsolete");
  for (const index of indexes) {
    const finding = targetable[index]!;
    finding.status = disposition === "dismissed" ? "dismissed" : "fixed_manual";
    finding.resolution = { action: disposition === "dismissed" ? "dismiss" : "manual_fix", resolvedAt: reviewedAt };
  }
  const summary = recomputeQaSummary(findings, state);
  return qaStateSchema.parse({ ...state, ...summary, issues: deriveIssues(findings), findings });
}

export type QaFindingTransition = "manual_fix" | "ai_fix" | "dismiss" | "reopen";

/** Stable lifecycle conflicts that clients can reconcile by reloading QA state. */
export class QaFindingLifecycleConflictError extends Error {
  constructor(readonly code: "QA_FINDING_ALREADY_RESOLVED" | "QA_FINDING_ALREADY_OPEN", message: string) {
    super(message);
    this.name = "QaFindingLifecycleConflictError";
  }
}

/** Single-finding status transition with resolution history; recomputes the summary from open findings. */
export function transitionQaFinding(
  value: QaState,
  id: string,
  action: QaFindingTransition,
  options: { reason?: string; finalTextFingerprint?: string; now?: string } = {},
): QaState {
  const now = options.now ?? new Date().toISOString();
  const findings = value.findings.map((finding) => ({ ...finding }));
  const finding = findings.find((candidate) => candidate.id === id);
  if (!finding) throw new Error("QA finding was not found. Reload the chapter and try again.");
  if (action === "reopen") {
    if (finding.status === "open") throw new QaFindingLifecycleConflictError("QA_FINDING_ALREADY_OPEN", "QA finding is already open.");
    finding.status = "open";
    finding.reopenedAt = now;
  } else {
    if (finding.status !== "open") throw new QaFindingLifecycleConflictError("QA_FINDING_ALREADY_RESOLVED", "QA finding has already been resolved. Reload the chapter and select an open finding.");
    finding.status = action === "dismiss" ? "dismissed" : action === "manual_fix" ? "fixed_manual" : "fixed_ai";
    finding.resolution = {
      action,
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.finalTextFingerprint ? { finalTextFingerprint: options.finalTextFingerprint } : {}),
      resolvedAt: now,
    };
  }
  const summary = recomputeQaSummary(findings, value);
  return qaStateSchema.parse({ ...value, ...summary, issues: deriveIssues(findings), findings });
}

export type QaRecheckMode = "full" | "changed";
export type QaRecheckSummary = ReturnType<typeof qaCounts> & Pick<ReconcileOutcome, "verified" | "respected" | "reopened" | "newFindings"> & {
  mode: QaRecheckMode;
  fellBackToFull: boolean;
  obsoleted: number;
  reason?: QaRecheckDecision["reason"];
  globalDependencyChanges?: string[];
};

export type QaRecheckInspection = {
  requestedMode: QaRecheckMode;
  mode: QaRecheckMode;
  fellBackToFull: boolean;
  changedCount: number;
  totalCount: number;
  selectedLabels: string[];
  previousFindings: number;
  exceptions: number;
  reason: QaRecheckDecision["reason"];
  globalDependencyChanges: string[];
  dependencyChanges: {
    textChanged: boolean; sourceChanged: boolean; namingChanged: boolean; pronunciationChanged: boolean;
    exceptionsChanged: boolean; acceptedContinuityChanged: boolean; qaConfigChanged: boolean;
    promptChanged: boolean; modeChanged: boolean; contextChanged: boolean; narrationSettingsChanged: boolean;
  };
};

export type QaRecheckDecision = {
  requestedMode: QaRecheckMode;
  effectiveMode: QaRecheckMode;
  reason: "requested_full" | "missing_prior_spans" | "missing_dependency_snapshot" | "zero_text_changes" | "large_text_change" | "global_dependency_changed" | "changed_text_only";
  changedCount: number;
  totalCount: number;
  selectedLabels: string[];
  globalDependencyChanges: string[];
  dependencyChanges: QaRecheckInspection["dependencyChanges"];
};

const GLOBAL_QA_DEPENDENCIES = ["source", "naming", "pronunciation", "exceptions", "acceptedContinuity", "context", "config", "narrationSettings", "prompt", "mode"] as const;

/** One decision function shared by the no-cost inspector and real provider execution. */
export function decideQaRecheckMode(input: {
  requestedMode: QaRecheckMode;
  previous: QaState | undefined;
  currentSnapshot: NonNullable<QaState["dependencySnapshot"]>;
  translation: string;
  narration: string;
}): QaRecheckDecision {
  const selection = selectChangedParagraphs(input.previous?.contentSpans, input.translation, input.narration);
  const changedCount = selection?.changedCount ?? 0;
  const totalCount = selection?.totalCount ?? 0;
  const selectedLabels = selection?.paragraphs.map((paragraph) => paragraph.label) ?? [];
  const prior = input.previous?.dependencySnapshot;
  const globalDependencyChanges = prior
    ? GLOBAL_QA_DEPENDENCIES.filter((key) => prior[key] !== input.currentSnapshot[key])
    : [...GLOBAL_QA_DEPENDENCIES];
  const dependencyChanges = {
    textChanged: !prior || prior.text !== input.currentSnapshot.text,
    sourceChanged: !prior || prior.source !== input.currentSnapshot.source,
    namingChanged: !prior || prior.naming !== input.currentSnapshot.naming,
    pronunciationChanged: !prior || prior.pronunciation !== input.currentSnapshot.pronunciation,
    exceptionsChanged: !prior || prior.exceptions !== input.currentSnapshot.exceptions,
    acceptedContinuityChanged: !prior || prior.acceptedContinuity !== input.currentSnapshot.acceptedContinuity,
    qaConfigChanged: !prior || prior.config !== input.currentSnapshot.config,
    promptChanged: !prior || prior.prompt !== input.currentSnapshot.prompt,
    modeChanged: !prior || prior.mode !== input.currentSnapshot.mode,
    contextChanged: !prior || prior.context !== input.currentSnapshot.context,
    narrationSettingsChanged: !prior || prior.narrationSettings !== input.currentSnapshot.narrationSettings,
  };
  let reason: QaRecheckDecision["reason"];
  let effectiveMode = input.requestedMode;
  if (input.requestedMode === "full") reason = "requested_full";
  else if (!input.previous?.contentSpans) { effectiveMode = "full"; reason = "missing_prior_spans"; }
  else if (!prior) { effectiveMode = "full"; reason = "missing_dependency_snapshot"; }
  else if (globalDependencyChanges.length) { effectiveMode = "full"; reason = "global_dependency_changed"; }
  else if (!selection) { effectiveMode = "full"; reason = "missing_prior_spans"; }
  else if (selection.changedCount === 0) { effectiveMode = "full"; reason = "zero_text_changes"; }
  else if (selection.ratio > 0.5) { effectiveMode = "full"; reason = "large_text_change"; }
  else reason = "changed_text_only";
  return { requestedMode: input.requestedMode, effectiveMode, reason, changedCount, totalCount, selectedLabels: effectiveMode === "changed" ? selectedLabels : [], globalDependencyChanges, dependencyChanges };
}

/** What a recheck WOULD do: effective mode, changed-span selection, context sizes. No provider call. */
export async function inspectQaRecheck(deps: {
  root: string;
  story: Story;
  chapter: number;
  mode?: QaRecheckMode;
}): Promise<QaRecheckInspection> {
  const { root, story, chapter } = deps;
  const paths = storyPaths(root, story.slug, chapter);
  const [qaRaw, translation, narration, exceptions, dependencies] = await Promise.all([
    readJsonIfExists(paths.qa), readFile(paths.english, "utf8"), readFile(paths.narration, "utf8"), listQaExceptions(root, story.slug), loadStoredQaDependencies(root, story, chapter),
  ]);
  const previous = qaRaw ? migrateQaState(qaRaw, { chapter }) : undefined;
  const requestedMode = deps.mode ?? "changed";
  const currentSnapshot = qaDependencySnapshot(computeQaDependencyFingerprints(dependencies!));
  const decision = decideQaRecheckMode({ requestedMode, previous, currentSnapshot, translation, narration });
  return {
    requestedMode, mode: decision.effectiveMode, fellBackToFull: requestedMode === "changed" && decision.effectiveMode === "full",
    changedCount: decision.changedCount, totalCount: decision.totalCount, selectedLabels: decision.selectedLabels,
    reason: decision.reason, globalDependencyChanges: decision.globalDependencyChanges, dependencyChanges: decision.dependencyChanges,
    previousFindings: previous?.findings.length ?? 0,
    exceptions: exceptions.length,
  };
}

/**
 * Stateful QA recheck: validates current chapter text against previous
 * findings, reconciles, and persists qa.json ONLY on success. A provider or
 * validation failure throws and leaves the prior qa.json byte-identical.
 */
export async function recheckChapterQa(deps: {
  root: string;
  story: Story;
  chapter: number;
  provider: LLMProvider;
  mode?: QaRecheckMode;
  now?: string;
}): Promise<{ state: QaState; summary: QaRecheckSummary }> {
  const { root, story, chapter, provider } = deps;
  const paths = storyPaths(root, story.slug, chapter);
  const [qaRaw, chapterRaw, source, translation, narration, qaContext] = await Promise.all([
    readJsonIfExists(paths.qa), readJsonIfExists(paths.chapterMeta), readFile(paths.original, "utf8"),
    readFile(paths.english, "utf8"), readFile(paths.narration, "utf8"), resolveStoredQaContext({ storyContext: paths.storyContext, chapter }),
  ]);
  if (!chapterRaw) throw new Error(`Chapter ${chapter} has no production metadata`);
  if (!translation.trim() || !narration.trim()) throw new Error(`Chapter ${chapter} needs a retained translation and narration before it can be rechecked`);
  const metadata = chapterSchema.parse(chapterRaw);
  const context = qaContext.parsed;
  const previous = qaRaw ? migrateQaState(qaRaw, { chapter }) : undefined;

  const [deterministic, exceptions, deterministicDeps] = await Promise.all([
    runDeterministicQaChecks({ root, story, chapter, source, translation, narration }),
    listQaExceptions(root, story.slug),
    loadQaDeterministicDependencies(root, story.slug),
  ]);
  const config = story.pipeline.qa;
  const effectiveNamingEntities = (await loadStoryBibleWithCanonicalOverlay(root, story.slug)).canonicalEntities;
  const currentDependencies = {
    source: fingerprint({ source, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage }),
    translation: fingerprint(translation), narration: fingerprint(narration), context: qaContext.raw,
    config, narrationSettings: { profanityMode: story.narrationSettings.profanityMode, includeChapterTitle: story.narrationSettings.includeChapterTitle },
    prompt: QA_PROMPT_VERSION, mode: story.qaMode, ...deterministicDeps,
  };
  const dependencyFingerprints = computeQaDependencyFingerprints(currentDependencies);
  const dependencySnapshot = qaDependencySnapshot(dependencyFingerprints);
  const requestedMode = deps.mode ?? "full";
  const decision = decideQaRecheckMode({ requestedMode, previous, currentSnapshot: dependencySnapshot, translation, narration });
  const mode = decision.effectiveMode;
  const selection = mode === "changed" ? selectChangedParagraphs(previous?.contentSpans, translation, narration) : undefined;
  const changedContent = selection?.paragraphs.map((paragraph) => `[${paragraph.label}] ${paragraph.text}`).join("\n\n");
  const previousFindingsContext = previous && previous.findings.length ? compactFindingsContext(previous) : undefined;
  const result = await validateChapterQuality(provider, config, {
    chapter, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
    source, translation, narration, context, authorizedNarrationEntities: effectiveNamingEntities.filter((entity) => entity.localizedNaming || entity.preferredNarrationName || entity.aliasNarrationRules.length),
    profanityMode: story.narrationSettings.profanityMode, includeChapterTitle: story.narrationSettings.includeChapterTitle !== false,
    previousFindingsContext,
    exceptionsContext: exceptionsPromptSection(exceptions),
    mode: story.qaMode,
    recheck: { mode, changedContent },
  });

  // The same authoritative dependency fingerprint the pipeline records, so a
  // recheck-produced stage compares current against a pipeline-produced one.
  const dependencyFingerprint = dependencyFingerprints.fingerprint;
  const fullContent = `${translation}\n\n${narration}`;
  const detections = filterExceptedFindings(prepareQaDetections([...deterministic.detections, ...result.value.issues], {
    canonicalEntities: context.canonicalEntities, effectiveNamingEntities, translation, narration,
  }), exceptions);
  const { state, outcome } = buildQaState(previous, detections, {
    chapter, canonicalEntities: context.canonicalEntities, effectiveNamingEntities, translation, narration, now: deps.now,
    baseScore: { score: result.value.score, originalScore: result.value.originalScore, status: result.value.status, originalStatus: result.value.originalStatus },
    mode: story.qaMode,
    acceptedContinuity: deterministic.acceptedContinuity,
    dependencyFingerprint,
    dependencySnapshot,
    evaluatedContent: mode === "full" ? fullContent : changedContent,
  });
  await persistQaStateWithMetadata(paths, state, metadata, (outputFingerprint, prior) => ({
    ...prior,
    quality: { status: state.status, score: state.score, issueCategories: [...new Set(openFindings(state).map((finding) => finding.category))] },
    stages: { ...prior.stages, qa: {
      status: "complete", fingerprint: dependencyFingerprint, outputFingerprint, provider: config.provider, model: config.model,
      promptVersion: QA_PROMPT_VERSION, completedAt: new Date().toISOString(), usage: result.usage,
    } },
    updatedAt: new Date().toISOString(),
  }));

  return {
    state,
    summary: {
      ...qaCounts(state),
      verified: outcome.verified,
      respected: outcome.respected,
      reopened: outcome.reopened,
      newFindings: outcome.newFindings,
      obsoleted: outcome.obsoleted,
      mode,
      fellBackToFull: requestedMode === "changed" && mode === "full",
      reason: decision.reason,
      globalDependencyChanges: decision.globalDependencyChanges,
    },
  };
}
