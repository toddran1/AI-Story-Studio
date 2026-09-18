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

const RENAME_RELATION = /\brenames?\s+["“]?(.+?)["”]?\s+(?:to|as|into)\s+["“]?(.+?)["”]?\s*(?:[.,;:!?)]|$)/i;
const CALLS_RELATION = /\bcalls?\s+["“]?(.+?)["”]?\s+by the name\s+["“]?(.+?)["”]?\s*(?:[.,;:!?)]|$)/i;
const SHOULD_BE_RELATION = /["“]([^"”]{1,80})["”]\s+should be\s+["“]?(.+?)["”]?\s*(?:[.,;:!?)]|$)/i;
const USES_FOR_RELATION = /\buses?\s+["“]([^"”]{1,80})["”]\s+for\s+["“]?(.+?)["”]?\s*(?:[.,;:(]|$)/i;
const CONTAINS_NEVER_RELATION = /contains\s+["“]([^"”]{1,80})["”]\s+but\s+never\s+["“]?(.+?)["”]?\s*(?:[.,;)]|$)/i;

/**
 * Stable semantic discriminator for naming-style issues: the normalized
 * "wrong>right" name pair, when the issue states one. Pure message rewording
 * that keeps the same wrong term keeps the same relation.
 */
export function extractNameRelation(issue: { message: string; evidence: string }): string | undefined {
  const attempts: [string, RegExp, 1 | 2][] = [
    [issue.message, RENAME_RELATION, 2],
    [issue.message, CALLS_RELATION, 2],
    [issue.message, SHOULD_BE_RELATION, 1],
    [issue.message, USES_FOR_RELATION, 1],
    [issue.evidence, CONTAINS_NEVER_RELATION, 1],
  ];
  for (const [text, pattern, wrongGroup] of attempts) {
    const match = pattern.exec(text);
    if (!match) continue;
    const wrong = normalizeQaText(match[wrongGroup] ?? "");
    const right = normalizeQaText(match[wrongGroup === 1 ? 2 : 1] ?? "");
    if (wrong.length >= 2) return right ? `${wrong}>${right}` : wrong;
  }
  return undefined;
}

export type FindingAnchor = {
  entityIds?: string[];
  excerptKey?: string;
  messageKey: string;
  paragraphBucket?: number;
  /** Normalized "wrong>right" name relation, when the issue states one. */
  relation?: string;
  /** Deterministic rule identity (rule kind + matched token). */
  ruleKey?: string;
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
    relation: extractNameRelation(issue),
  };
}

/**
 * Content-derived stable finding identity (v2). Message wording is deliberately
 * excluded so an LLM-reworded re-detection maps to the same finding. Entity
 * IDs anchor the issue when nameable, disambiguated by the wrong>right name
 * relation or the deterministic rule identity so two genuinely different naming
 * problems about the same entity get different ids; otherwise the normalized
 * excerpt key anchors the passage; the normalized message is the last resort.
 */
export function computeFindingId(category: QaCategory, chapter: number, anchor: FindingAnchor): string {
  const hasEntities = Boolean(anchor.entityIds?.length);
  const key = fingerprint({
    v: 2,
    category,
    chapter,
    entities: hasEntities ? [...anchor.entityIds!].sort() : undefined,
    relation: anchor.relation || undefined,
    rule: anchor.ruleKey || undefined,
    excerpt: hasEntities || anchor.relation ? undefined : anchor.excerptKey || undefined,
    message: hasEntities || anchor.relation || anchor.ruleKey || anchor.excerptKey ? undefined : anchor.messageKey,
  });
  return `qaf_${key.slice(0, 24)}`;
}

export function findingFingerprint(finding: { category: QaCategory; severity: "warn" | "fail"; message: string; evidence: string }): string {
  return fingerprint({ v: 1, category: finding.category, severity: finding.severity, message: finding.message, evidence: finding.evidence });
}

/** Verification is separate from lifecycle: a finding is verified-current only against the fingerprint it was last evaluated with. */
export function findingVerification(finding: Pick<QaFinding, "verifiedAgainstFingerprint">, currentFingerprint: string): "current" | "needs_recheck" {
  return finding.verifiedAgainstFingerprint === currentFingerprint ? "current" : "needs_recheck";
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
 * Existing finding ids and fields are kept as-is; missing optional fields
 * (verifiedAgainstFingerprint, provenance.relation) are simply absent.
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
      provenance: {
        ...(chapter > 0 ? { chapter } : {}),
        ...(anchor.excerptKey ? { excerptKey: anchor.excerptKey } : {}),
        ...(anchor.relation ? { relation: anchor.relation } : {}),
      },
      origin: "llm",
    };
  });
  return { ...parsed, findings, issues: deriveIssues(findings) };
}

export const openFindings = (state: Pick<QaState, "findings">) => state.findings.filter((finding) => finding.status === "open");
export const resolvedFindings = (state: Pick<QaState, "findings">) => state.findings.filter((finding) => finding.status !== "open");

/** Findings that currently gate the chapter; diagnostics must use these, never resolved history. */
export const activeQaFindings = (state: Pick<QaState, "findings">) => openFindings(state);

/** Deterministic current score: severity-weighted deduction from a clean 1.0, based on open findings only. */
export function qaScoreFromOpenFindings(open: QaFinding[]): number {
  const deduction = open.reduce((sum, finding) => sum + (finding.severity === "fail" ? 0.3 : 0.1), 0);
  return Math.round(Math.max(0, 1 - deduction) * 1000) / 1000;
}

export type QaFindingStats = {
  current: { critical: number; warnings: number; open: number; score: number; status: QaStatus };
  history: { fixedManual: number; fixedAi: number; dismissed: number; obsolete: number; total: number };
  /** Non-obsolete findings whose verification predates the current dependency fingerprint. */
  needsVerification: number;
};

/** Single counting entry point: current gating state, resolution history, and staleness. */
export function qaFindingStats(state: Pick<QaState, "findings">, currentFingerprint?: string): QaFindingStats {
  const open = openFindings(state);
  const count = (status: QaFinding["status"]) => state.findings.filter((finding) => finding.status === status).length;
  return {
    current: {
      critical: open.filter((finding) => finding.severity === "fail").length,
      warnings: open.filter((finding) => finding.severity === "warn").length,
      open: open.length,
      score: qaScoreFromOpenFindings(open),
      status: open.reduce<QaStatus>((worst, finding) => severityRank[finding.severity] > severityRank[worst] ? finding.severity : worst, "pass"),
    },
    history: { fixedManual: count("fixed_manual"), fixedAi: count("fixed_ai"), dismissed: count("dismissed"), obsolete: count("obsolete"), total: state.findings.length },
    needsVerification: currentFingerprint
      ? state.findings.filter((finding) => finding.status !== "obsolete" && findingVerification(finding, currentFingerprint) === "needs_recheck").length
      : 0,
  };
}

export function qaCounts(state: Pick<QaState, "findings">) {
  const stats = qaFindingStats(state);
  return {
    open: stats.current.open,
    resolved: stats.history.total - stats.current.open,
    safeFixesAvailable: openFindings(state).filter((finding) => finding.safeToFix === true).length,
  };
}

/**
 * Recompute checks/status/score from OPEN findings only. Resolved findings
 * retain evidence but never gate the chapter; resolution history never enters
 * the current score, so two chapters with identical open findings score the
 * same regardless of how much history they carry.
 */
export function recomputeQaSummary(
  findings: QaFinding[],
  base?: { score?: number; originalScore?: number },
): { status: QaStatus; score: number; originalScore: number; checks: QaState["checks"] } {
  const stats = qaFindingStats({ findings });
  const checks = {} as QaState["checks"];
  const categories: QaCategory[] = ["completeness", "names", "numbers", "terminology", "dialogue", "storyConsistency", "narrationFidelity"];
  const open = findings.filter((finding) => finding.status === "open");
  for (const category of categories) {
    checks[category] = open.filter((finding) => finding.category === category)
      .reduce<QaStatus>((worst, finding) => severityRank[finding.severity] > severityRank[worst] ? finding.severity : worst, "pass");
  }
  const originalScore = base?.originalScore ?? base?.score ?? 1;
  return { status: stats.current.status, score: stats.current.score, originalScore, checks };
}
