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

const checksSchema = z.object({
  completeness: qaStatusSchema,
  names: qaStatusSchema,
  numbers: qaStatusSchema,
  terminology: qaStatusSchema,
  dialogue: qaStatusSchema,
  storyConsistency: qaStatusSchema,
  narrationFidelity: qaStatusSchema,
});

export const qaResultSchema = z.object({
  status: qaStatusSchema,
  score: z.number().min(0).max(1),
  issues: z.array(qaIssueSchema),
  checks: checksSchema,
});

export type QaStatus = z.infer<typeof qaStatusSchema>;
export type QaCategory = z.infer<typeof qaCategorySchema>;
export type QaResult = z.infer<typeof qaResultSchema>;

const severityRank: Record<QaStatus, number> = { pass: 0, warn: 1, fail: 2 };

/** Never trust a model's top-level status when a check or issue is more severe. */
export function normalizeQaResult(value: unknown): QaResult {
  const parsed = qaResultSchema.parse(value);
  const statuses: QaStatus[] = [
    parsed.status,
    ...Object.values(parsed.checks),
    ...parsed.issues.map((issue) => issue.severity),
  ];
  const status = statuses.reduce<QaStatus>((worst, current) => severityRank[current] > severityRank[worst] ? current : worst, "pass");
  return { ...parsed, status };
}
