import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBatchPlan } from "../src/batch/plan.js";

describe("dry-run planning", () => {
  it("plans discovery without invoking a processor/provider", async () => {
    const provider = vi.fn(); const root = await mkdtemp(join(tmpdir(), "batch-plan-"));
    const chapters = [{ chapter: 1, filename: "chapter-1.txt", path: "/input/chapter-1.txt" }];
    const plan = await createBatchPlan(root, "story", { chapters, invalidFiles: [], duplicateChapters: [], emptyFiles: [], missingChapters: [] }, chapters);
    expect(plan.wouldProcess).toBe(1); expect(provider).not.toHaveBeenCalled();
  });
});
