import type { Job } from "./job-manager.js";
import type { QueueJob } from "../../src/queue/types.js";
export function queueActivity(job: QueueJob): Job {
  return {
    id: `queue-${job.id}`, type: "production", story: job.story,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    status: job.status === "completed_with_warnings" ? "completed" : job.status === "needs_review" ? "failed" : job.status,
    scope: { from: job.from, to: job.to }, payload: { queueJobId: job.id },
    cancelRequested: job.cancelRequested, pauseRequested: job.pauseRequested,
    progress: { chapter: job.currentChapter, stage: job.currentStage, completed: job.completedItems, total: job.totalItems },
    error: job.errorSummary,
  };
}
