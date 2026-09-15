import { z } from "zod";

export const qaStatusSchema = z.enum(["pass", "warn", "fail"]);
export const qaCategorySchema = z.enum([
  "completeness", "names", "numbers", "terminology", "dialogue", "storyConsistency", "narrationFidelity",
]);

export const qaIssueSchema = z.object({
  category: qaCategorySchema,
  severity: qaStatusSchema.exclude(["pass"]),
  message: z.string().min(1),
  evidence: z.string().min(1),
});

const reviewedQaIssueSchema = qaIssueSchema.extend({
  review: z.object({
    disposition: z.literal("dismissed"),
    reviewedAt: z.string().datetime(),
  }).optional(),
});

const checksSchema = z.object({
  completeness: qaStatusSchema,
  names: qaStatusSchema,
  numbers: qaStatusSchema,
  terminology: qaStatusSchema,
  dialogue: qaStatusSchema,
  storyConsistency: qaStatusSchema,
  narrationFidelity: qaStatusSchema,
});

/** Provider-facing schema. Keep manual review fields out of strict structured output. */
export const generatedQaResultSchema = z.object({
  status: qaStatusSchema,
  score: z.number().min(0).max(1),
  issues: z.array(qaIssueSchema),
  checks: checksSchema,
});

/** Persisted QA can additionally retain explicit human review decisions. */
export const qaResultSchema = generatedQaResultSchema.extend({
  issues: z.array(reviewedQaIssueSchema),
});

export type QaStatus = z.infer<typeof qaStatusSchema>;
export type QaCategory = z.infer<typeof qaCategorySchema>;
export type QaResult = z.infer<typeof qaResultSchema>;

const severityRank: Record<QaStatus, number> = { pass: 0, warn: 1, fail: 2 };

/** Never trust a model's top-level status when a check or issue is more severe. */
export function normalizeQaResult(value: unknown): QaResult {
  const parsed = generatedQaResultSchema.parse(value);
  const statuses: QaStatus[] = [
    parsed.status,
    ...Object.values(parsed.checks),
    ...parsed.issues.map((issue) => issue.severity),
  ];
  const status = statuses.reduce<QaStatus>((worst, current) => severityRank[current] > severityRank[worst] ? current : worst, "pass");
  return { ...parsed, status };
}

export function activeQaIssues(result: QaResult) {
  return result.issues.filter(isQaIssueActive);
}

export function isQaIssueActive(issue: QaResult["issues"][number]) {
  return issue.review?.disposition !== "dismissed";
}

/** Preserve dismissed evidence while removing it from the active QA decision. */
export function dismissQaIssues(value: unknown, issueIndexes: number[], reviewedAt = new Date().toISOString()): QaResult {
  const parsed = qaResultSchema.parse(value);
  const indexes = [...new Set(issueIndexes)];
  if (!indexes.length || indexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= parsed.issues.length)) {
    throw new Error("One or more selected QA findings no longer exist. Reload the chapter and select them again.");
  }
  const selected = new Set(indexes);
  const affectedCategories = new Set(indexes.map((index) => parsed.issues[index]!.category));
  const issues = parsed.issues.map((issue, index) => selected.has(index)
    ? { ...issue, review: { disposition: "dismissed" as const, reviewedAt } }
    : issue);
  const checks = { ...parsed.checks };
  for (const category of affectedCategories) {
    const remaining = issues.filter((issue) => issue.category === category && issue.review?.disposition !== "dismissed");
    checks[category] = remaining.reduce<QaStatus>((worst, issue) => severityRank[issue.severity] > severityRank[worst] ? issue.severity : worst, "pass");
  }
  const status = Object.values(checks).reduce<QaStatus>((worst, current) => severityRank[current] > severityRank[worst] ? current : worst, "pass");
  return qaResultSchema.parse({ ...parsed, issues, checks, status });
}
