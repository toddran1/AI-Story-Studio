import { QaCategory, QaFinding, QaState, QaStatus, qaStateSchema } from "../domain/qa.js";
import { StoryBible } from "../domain/story-bible.js";
import { fingerprint } from "../utils/hash.js";

const severityRank: Record<QaStatus, number> = { pass: 0, warn: 1, fail: 2 };

/** Lowercase, strip punctuation, collapse whitespace. Keeps CJK characters. */
export function normalizeQaText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}

/** Bounded content key: first tokens of normalized text, stable across rewording of the surrounding prose. */
export function normalizeExcerptKey(text: string, maxTokens = 12): string {
  return normalizeQaText(text).split(" ").filter(Boolean).slice(0, maxTokens).join(" ");
}

const QUOTED_SPAN = /["“]([^"”]{3,600})["”]/g;

function quotedSpans(text: string): string[] {
  const spans: string[] = [];
  for (const match of text.matchAll(QUOTED_SPAN)) spans.push(match[1]!);
  return spans;
}

/** Canonical entity IDs whose identity names appear in the issue's message or evidence. */
export function matchEntityIds(text: string, entities: StoryBible["canonicalEntities"]): string[] {
  const haystack = normalizeQaText(text);
  if (!haystack) return [];
  const matched: string[] = [];
  for (const entity of entities) {
    const names = [entity.canonicalName, entity.originalName, ...entity.aliases, entity.preferredNarrationName ?? ""];
    if (names.some((name) => { const needle = normalizeQaText(name); return needle.length > 0 && haystack.includes(needle); })) matched.push(entity.id);
  }
  return matched;
}

export type FindingAnchor = {
  entityIds?: string[];
  excerptKey?: string;
  messageKey: string;
  paragraphBucket?: number;
};

export function anchorFromIssue(
  issue: { message: string; evidence: string },
  options: { canonicalEntities?: StoryBible["canonicalEntities"]; paragraphs?: string[] } = {},
): FindingAnchor {
  const combined = `${issue.message}\n${issue.evidence}`;
  const entityIds = options.canonicalEntities?.length ? matchEntityIds(combined, options.canonicalEntities) : [];
  const spans = quotedSpans(issue.evidence);
  const excerptKey = normalizeExcerptKey(spans[0] ?? issue.evidence);
  let paragraphBucket: number | undefined;
  if (options.paragraphs?.length && excerptKey) {
    const index = options.paragraphs.findIndex((paragraph) => normalizeQaText(paragraph).includes(excerptKey));
    if (index >= 0) paragraphBucket = index;
  }
  return {
    entityIds: entityIds?.length ? entityIds : undefined,
    excerptKey: excerptKey || undefined,
    messageKey: normalizeExcerptKey(issue.message),
    paragraphBucket,
  };
}

/**
 * Content-derived stable finding identity. Message wording is deliberately
 * excluded so an LLM-reworded re-detection maps to the same finding. Entity
 * IDs anchor the issue when nameable (stable across passage-level text edits);
 * otherwise the normalized excerpt key anchors the passage (so the same
 * category of issue at a different passage gets a different id); the
 * normalized message is the last-resort fallback.
 */
export function computeFindingId(category: QaCategory, chapter: number, anchor: FindingAnchor): string {
  const key = fingerprint({
    v: 1,
    category,
    chapter,
    entities: anchor.entityIds?.length ? [...anchor.entityIds].sort() : undefined,
    excerpt: anchor.entityIds?.length ? undefined : anchor.excerptKey || undefined,
    message: anchor.entityIds?.length || anchor.excerptKey ? undefined : anchor.messageKey,
  });
  return `qaf_${key.slice(0, 24)}`;
}

export function findingFingerprint(finding: { category: QaCategory; severity: "warn" | "fail"; message: string; evidence: string }): string {
  return fingerprint({ v: 1, category: finding.category, severity: finding.severity, message: finding.message, evidence: finding.evidence });
}

/** Issues[] is a compatibility projection of findings: everything except obsolete, with review dispositions. */
export function deriveIssues(findings: QaFinding[]): QaState["issues"] {
  return findings.filter((finding) => finding.status !== "obsolete").map((finding) => ({
    category: finding.category,
    severity: finding.severity,
    message: finding.message,
    evidence: finding.evidence,
    ...(finding.status === "dismissed"
      ? { review: { disposition: "dismissed" as const, reviewedAt: finding.resolution?.resolvedAt ?? "1970-01-01T00:00:00.000Z" } }
      : finding.status === "fixed_manual" || finding.status === "fixed_ai"
        ? { review: { disposition: "manually_fixed" as const, reviewedAt: finding.resolution?.resolvedAt ?? "1970-01-01T00:00:00.000Z" } }
        : {}),
  }));
}

/**
 * Backward-compatible parse of any qa.json: legacy files (issues with optional
 * review dispositions) gain findings; new files re-derive issues from findings.
 */
export function migrateQaState(raw: unknown, options: { chapter?: number } = {}): QaState {
  const parsed = qaStateSchema.parse(raw);
  if (parsed.findings.length) return { ...parsed, issues: deriveIssues(parsed.findings) };
  if (!parsed.issues.length) return parsed;
  const chapter = options.chapter ?? 0;
  const findings: QaFinding[] = parsed.issues.map((issue) => {
    const anchor = anchorFromIssue(issue);
    const status: QaFinding["status"] = issue.review?.disposition === "dismissed" ? "dismissed" : issue.review?.disposition === "manually_fixed" ? "fixed_manual" : "open";
    return {
      id: computeFindingId(issue.category, chapter, anchor),
      category: issue.category,
      severity: issue.severity,
      message: issue.message,
      evidence: issue.evidence,
      status,
      ...(issue.review ? { resolution: { action: issue.review.disposition === "dismissed" ? "dismiss" as const : "manual_fix" as const, resolvedAt: issue.review.reviewedAt } } : {}),
      fingerprint: findingFingerprint(issue),
      provenance: chapter > 0 ? { chapter, excerptKey: anchor.excerptKey } : { excerptKey: anchor.excerptKey },
      origin: "llm",
    };
  });
  return { ...parsed, findings, issues: deriveIssues(findings) };
}

export const openFindings = (state: Pick<QaState, "findings">) => state.findings.filter((finding) => finding.status === "open");
export const resolvedFindings = (state: Pick<QaState, "findings">) => state.findings.filter((finding) => finding.status !== "open");

export function qaCounts(state: Pick<QaState, "findings">) {
  const open = openFindings(state);
  return {
    open: open.length,
    resolved: state.findings.length - open.length,
    safeFixesAvailable: open.filter((finding) => finding.safeToFix === true).length,
  };
}

/**
 * Recompute checks/status/score from OPEN findings only. Resolved findings
 * retain evidence but never gate the chapter, matching resolveQaIssues.
 */
export function recomputeQaSummary(
  findings: QaFinding[],
  base?: { score?: number; originalScore?: number },
): { status: QaStatus; score: number; originalScore: number; checks: QaState["checks"] } {
  const open = findings.filter((finding) => finding.status === "open");
  const checks = {} as QaState["checks"];
  const categories: QaCategory[] = ["completeness", "names", "numbers", "terminology", "dialogue", "storyConsistency", "narrationFidelity"];
  for (const category of categories) {
    checks[category] = open.filter((finding) => finding.category === category)
      .reduce<QaStatus>((worst, finding) => severityRank[finding.severity] > severityRank[worst] ? finding.severity : worst, "pass");
  }
  const status = Object.values(checks).reduce<QaStatus>((worst, current) => severityRank[current] > severityRank[worst] ? current : worst, "pass");
  const originalScore = base?.originalScore ?? base?.score ?? 1;
  const weight = (finding: QaFinding) => finding.severity === "fail" ? 2 : 1;
  const active = findings.filter((finding) => finding.status !== "obsolete");
  const totalWeight = active.reduce((sum, finding) => sum + weight(finding), 0);
  const activeWeight = open.reduce((sum, finding) => sum + weight(finding), 0);
  const score = totalWeight ? Math.min(1, Math.max(originalScore, 1 - (1 - originalScore) * activeWeight / totalWeight)) : originalScore;
  return { status, score, originalScore, checks };
}
