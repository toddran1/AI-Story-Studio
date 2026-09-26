import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isQaIssueActive } from "../domain/qa.js";
import { QualityGateError } from "../pipeline/errors.js";
import { classifyQueueFailure } from "../queue/failure.js";
import { failureCategorySchema } from "../queue/types.js";

export const errorDiagnosticSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string(),
  summary: z.string().min(1),
  category: failureCategorySchema,
  retryable: z.boolean(),
  recommendedAction: z.string().min(1),
  chapter: z.number().int().positive().optional(),
  stage: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  technicalDetails: z.string().min(1).optional(),
  issues: z.array(z.object({ category: z.string(), severity: z.string(), message: z.string(), evidence: z.string().optional() })).optional(),
  /** QA dependency fingerprint in effect when a quality gate failed; used to tell historical failures from current ones. */
  qaDependencyFingerprint: z.string().min(1).optional(),
});
export type ErrorDiagnostic = z.infer<typeof errorDiagnosticSchema>;

/**
 * A QA failure diagnostic is historical once the chapter's current QA
 * dependency fingerprint differs from the one recorded at failure time.
 * Undefined when the comparison cannot be made (no provenance either side).
 */
export type QaDiagnosticComparison = "current" | "historical" | "unknown_legacy";

/**
 * Compares a QA diagnostic failure fingerprint against the chapter's current QA dependency fingerprint.
 * Distinguishes current failures, historical failures, and legacy failures where tracking was absent.
 */
export function compareQaDiagnosticFingerprint(
  diagnostic: Pick<ErrorDiagnostic, "qaDependencyFingerprint">,
  currentFingerprint?: string,
): QaDiagnosticComparison {
  if (!diagnostic.qaDependencyFingerprint || !currentFingerprint) return "unknown_legacy";
  return diagnostic.qaDependencyFingerprint === currentFingerprint ? "current" : "historical";
}

export function diagnosticIsHistorical(diagnostic: Pick<ErrorDiagnostic, "qaDependencyFingerprint">, currentFingerprint?: string): boolean | undefined {
  if (!diagnostic.qaDependencyFingerprint || !currentFingerprint) return undefined;
  return diagnostic.qaDependencyFingerprint !== currentFingerprint;
}

export function createErrorDiagnostic(error: unknown, context: { chapter?: number; stage?: string; summary?: string } = {}): ErrorDiagnostic {
  const chain = errorChain(error); const classified = classifyQueueFailure(error); const quality = chain.find((value) => value instanceof QualityGateError) as QualityGateError | undefined;
  const details = [...new Set(chain.map((value) => safeText(value.message)).filter(Boolean))];
  const combined = details.join(" Caused by: "); const parsed = parsePipelineContext(combined);
  const chapter = context.chapter ?? parsed.chapter; const stage = context.stage ?? parsed.stage ?? (quality ? "qa" : undefined);
  const code = chain.map((value) => typeof value.code === "string" ? value.code : undefined).find(Boolean);
  const model = chain.map((value) => typeof value.model === "string" ? value.model : undefined).find(Boolean);
  const provider = classified.provider ?? chain.map((value) => typeof value.provider === "string" ? value.provider : undefined).find(Boolean) ?? parsed.provider;
  const summary = safeText(context.summary ?? (quality
    ? `${chapter ? `Chapter ${chapter} ` : ""}failed quality review`
    : details[0] ?? "An unexpected error occurred"));
  // Only active open findings gate a chapter; resolved/reviewed history must
  // never appear in a failure diagnostic even on legacy results.
  const activeIssues = quality?.result.issues.filter(isQaIssueActive).slice(0, 20);
  return errorDiagnosticSchema.parse({
    id: `ERR-${randomUUID().slice(0, 8).toUpperCase()}`, timestamp: new Date().toISOString(), summary,
    category: classified.category, retryable: classified.retryable, recommendedAction: safeText(classified.recommendedAction),
    chapter, stage, provider, model, code,
    technicalDetails: combined && combined !== summary ? combined : undefined,
    issues: activeIssues?.length ? activeIssues.map((issue) => ({ category: issue.category, severity: issue.severity, message: safeText(issue.message), evidence: safeText(issue.evidence) })) : undefined,
    qaDependencyFingerprint: quality?.dependencyFingerprint,
  });
}

function errorChain(error: unknown) {
  const result: Array<Error & Record<string, unknown>> = []; let value = error;
  for (let depth = 0; value && depth < 8; depth++) {
    if (value instanceof Error) result.push(value as Error & Record<string, unknown>);
    else if (depth === 0) result.push(new Error(String(value)) as Error & Record<string, unknown>);
    value = typeof value === "object" ? (value as { cause?: unknown }).cause : undefined;
  }
  return result;
}

function parsePipelineContext(message: string) {
  const chapter = /Chapter(?:=|\s+)(\d+)/i.exec(message)?.[1];
  const stage = /Stage=([^\s:]+)/i.exec(message)?.[1]; const provider = /Provider=([^\s:]+)/i.exec(message)?.[1];
  return { chapter: chapter ? Number(chapter) : undefined, stage, provider };
}

function safeText(value: string) {
  return value
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(sk-(?:proj-)?)[A-Za-z0-9_-]{8,}/g, "$1[redacted]")
    .replace(/\b(api[_ -]?key|password|token)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1[redacted]@")
    .slice(0, 4_000);
}

export function safeErrorMessage(error: unknown, max = 300): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const oneLine = raw.replace(/[\r\n\t]+/g, " ").trim();
  return safeText(oneLine).slice(0, max);
}

export function safeProviderDetail(detail: unknown, max = 300): string {
  if (detail === undefined || detail === null) return "";
  const raw = typeof detail === "string" ? detail : (detail instanceof Error ? detail.message : String(detail));
  const oneLine = raw.replace(/[\r\n\t]+/g, " ").trim();
  return safeText(oneLine).slice(0, max);
}

export function sanitizeFishProviderDetail(
  raw: unknown,
  currentChunkText?: string,
  max = 300,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  let text = safeProviderDetail(raw, max * 2);
  if (!text) return undefined;

  if (currentChunkText && currentChunkText.trim()) {
    const normChunk = currentChunkText.replace(/[\r\n\t]+/g, " ").trim();
    if (normChunk.length > 0) {
      if (text.includes(normChunk)) {
        text = text.replaceAll(normChunk, "[REDACTED]");
      } else if (normChunk.length >= 15) {
        for (let len = Math.min(normChunk.length, 60); len >= 15; len -= 5) {
          for (let i = 0; i <= normChunk.length - len; i += 5) {
            const sub = normChunk.slice(i, i + len);
            if (text.includes(sub)) {
              text = text.replaceAll(sub, "[REDACTED]");
            }
          }
        }
      }
      const words = normChunk.split(/[\s_\W]+/).filter((w) => w.length >= 8);
      for (const word of words) {
        if (text.includes(word)) {
          text = text.replaceAll(word, "[REDACTED]");
        }
      }
    }
  }

  text = text.replace(/(\[REDACTED\](?:\s|:\s*)?)+/g, "[REDACTED]").trim();
  if (!text || text === "[REDACTED]" || text.replace(/\[REDACTED\]/g, "").trim().length === 0) {
    return undefined;
  }
  return text.slice(0, max);
}

