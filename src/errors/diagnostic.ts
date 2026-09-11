import { randomUUID } from "node:crypto";
import { z } from "zod";
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
  code: z.string().min(1).optional(),
  technicalDetails: z.string().min(1).optional(),
  issues: z.array(z.object({ category: z.string(), severity: z.string(), message: z.string(), evidence: z.string().optional() })).optional(),
});
export type ErrorDiagnostic = z.infer<typeof errorDiagnosticSchema>;

export function createErrorDiagnostic(error: unknown, context: { chapter?: number; stage?: string; summary?: string } = {}): ErrorDiagnostic {
  const chain = errorChain(error); const classified = classifyQueueFailure(error); const quality = chain.find((value) => value instanceof QualityGateError) as QualityGateError | undefined;
  const details = [...new Set(chain.map((value) => safeText(value.message)).filter(Boolean))];
  const combined = details.join(" Caused by: "); const parsed = parsePipelineContext(combined);
  const chapter = context.chapter ?? parsed.chapter; const stage = context.stage ?? parsed.stage ?? (quality ? "qa" : undefined);
  const code = chain.map((value) => typeof value.code === "string" ? value.code : undefined).find(Boolean);
  const summary = safeText(context.summary ?? (quality
    ? `${chapter ? `Chapter ${chapter} ` : ""}failed quality review`
    : details[0] ?? "An unexpected error occurred"));
  return errorDiagnosticSchema.parse({
    id: `ERR-${randomUUID().slice(0, 8).toUpperCase()}`, timestamp: new Date().toISOString(), summary,
    category: classified.category, retryable: classified.retryable, recommendedAction: safeText(classified.recommendedAction),
    chapter, stage, provider: classified.provider ?? parsed.provider, code,
    technicalDetails: combined && combined !== summary ? combined : undefined,
    issues: quality?.result.issues.slice(0, 20).map((issue) => ({ category: issue.category, severity: issue.severity, message: safeText(issue.message), evidence: safeText(issue.evidence) })),
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
