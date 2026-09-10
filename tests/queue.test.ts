import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ConfigurationError, QualityGateError } from "../src/pipeline/errors.js";
import { qaResultSchema } from "../src/domain/qa.js";
import { classifyQueueFailure, retryDelayMs } from "../src/queue/failure.js";
import { queueSubmissionSchema } from "../src/queue/types.js";

describe("durable queue policy", () => {
  it("classifies retryable, configuration, QA, and permanent failures", () => {
    expect(classifyQueueFailure(Object.assign(new Error("OpenAI rate limit"), { status: 429, headers: { "retry-after": "12" } }))).toMatchObject({ category: "rate_limit", retryable: true, retryAfterMs: 12_000, provider: "openai" });
    expect(classifyQueueFailure(Object.assign(new Error("service unavailable"), { status: 503 }))).toMatchObject({ category: "transient", retryable: true });
    expect(classifyQueueFailure(new ConfigurationError("FFmpeg unavailable"))).toMatchObject({ category: "configuration", retryable: false });
    expect(classifyQueueFailure(new QualityGateError("QA failed", failedQa()))).toMatchObject({ category: "content_qa", retryable: false });
    expect(classifyQueueFailure(new Error("Corrupt source chapter"))).toMatchObject({ category: "permanent", retryable: false });
  });
  it("uses bounded jitter and honors Retry-After", () => {
    expect(retryDelayMs(1, undefined, () => 0)).toBe(1500);
    expect(retryDelayMs(20, undefined, () => 1)).toBe(900_000);
    expect(retryDelayMs(1, 30_000, () => 0)).toBe(30_000);
  });
  it("validates queue ranges and rejects accidental dry runs", () => {
    expect(queueSubmissionSchema.parse({ from: 1, to: 1600, profile: "audiobook" })).toMatchObject({ refresh: false });
    expect(() => queueSubmissionSchema.parse({ from: 4, to: 3 })).toThrow(/Range end/);
    expect(() => queueSubmissionSchema.parse({ from: 1, to: 2, dryRun: true })).toThrow();
  });
  it("defines transactional locking, chronology, leases, foreign keys, and pagination indexes", async () => {
    const [migration, repository] = await Promise.all([readFile("migrations/001_durable_production_queue.sql", "utf8"), readFile("src/queue/repository.ts", "utf8")]);
    expect(migration).toContain("REFERENCES production_jobs(id) ON DELETE CASCADE");
    expect(migration).toContain("production_jobs_one_active_story");
    expect(migration).toContain("production_work_claim");
    expect(repository).toContain("FOR UPDATE OF wi SKIP LOCKED");
    expect(repository).toContain("earlier.ordinal<wi.ordinal");
    expect(repository).toContain("lease_expires_at");
  });
});

function failedQa() { return qaResultSchema.parse({ status: "fail", score: .2, issues: [{ category: "completeness", severity: "fail", message: "Missing passage", evidence: "Ending absent" }], checks: { completeness: "fail", names: "pass", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" } }); }
