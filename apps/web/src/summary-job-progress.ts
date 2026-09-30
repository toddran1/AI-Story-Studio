import type { SummaryJobOperation } from "../../../src/summaries/types.js";
import type { Job } from "./api.js";
import { pretty } from "./format.js";

export type SummaryJobProgressView = {
  title: string;
  stageLabel: string;
  detail: string;
  completed?: number;
  total?: number;
  percent?: number;
};

export const SUMMARY_OPERATION_TITLES: Record<SummaryJobOperation, string> = {
  generate: "Generating summary",
  regenerate: "Regenerating summary",
  narration: "Generating summary narration",
  audio: "Generating summary audio",
  scenes: "Planning summary scenes",
  artwork: "Generating summary artwork",
  video: "Rendering summary video",
  produce: "Producing summary media",
  reupscale: "Re-upscaling summary artwork",
  music_export: "Exporting summary music",
};

export const SUMMARY_PHASE_LABELS: Record<string, string> = {
  preparing: "Preparing",
  extracting: "Extracting events",
  analyzing: "Analyzing storyline",
  drafting: "Drafting recap",
  summarizing: "Summarizing batches",
  combining: "Combining summaries",
  finalizing: "Finalizing recap",
  narration: "Narration",
  pronunciation: "Pronunciation",
  tts: "Speech synthesis",
  quality_check: "Quality verification",
  retry: "TTS retry",
  mastering: "Audio mastering",
  planning: "Scene planning",
  artwork: "Artwork generation",
  upscaling: "Artwork upscaling",
  scenes: "Scene planning",
  audio: "Audio generation",
  video: "Video rendering",
  rendering: "Video rendering",
  exporting: "Exporting audio",
  complete: "Complete",
};

export function isSummaryRelatedJob(job: Job): boolean {
  return job.type === "summary" || job.type === "summaryMusicExport";
}

export function summaryJobProgressView(job: Job): SummaryJobProgressView | undefined {
  if (job.type !== "summary" && job.type !== "summaryMusicExport") {
    return undefined;
  }

  const rawProgress = (job.progress && typeof job.progress === "object" ? job.progress : undefined) as Record<string, unknown> | undefined;
  const rawPayload = (job.payload && typeof job.payload === "object" ? job.payload : undefined) as Record<string, unknown> | undefined;

  let operation: SummaryJobOperation | undefined =
    (rawProgress?.operation as SummaryJobOperation | undefined) ??
    (rawPayload?.operation as SummaryJobOperation | undefined);

  const progressType = typeof rawProgress?.type === "string" ? rawProgress.type : "";

  if (!operation) {
    if (job.type === "summaryMusicExport") {
      operation = "music_export";
    } else if (progressType.startsWith("summary.reupscale.")) {
      operation = "reupscale";
    } else if (progressType.startsWith("summary.artwork.")) {
      operation = "artwork";
    }
  }

  const baseTitle = operation && SUMMARY_OPERATION_TITLES[operation]
    ? SUMMARY_OPERATION_TITLES[operation]
    : "Building story recap";

  if (progressType.startsWith("summary.artwork.") || progressType.startsWith("summary.reupscale.")) {
    const isReupscale = progressType.startsWith("summary.reupscale.");
    const isCompleted = progressType.endsWith("completed");
    const sceneRaw = typeof rawProgress?.scene === "string" ? rawProgress.scene : undefined;
    const sceneMatch = sceneRaw?.match(/^scene-(\d+)$/i);
    const sceneLabel = sceneMatch ? `Scene ${sceneMatch[1]}` : sceneRaw;
    const index = typeof rawProgress?.index === "number" ? rawProgress.index : undefined;
    const total = typeof rawProgress?.total === "number" && rawProgress.total > 0 ? rawProgress.total : undefined;

    let completed: number | undefined;
    let percent: number | undefined;
    if (index !== undefined && total !== undefined) {
      completed = Math.max(0, index - (isCompleted ? 0 : 1));
      percent = Math.min(100, Math.max(0, Math.round((completed / total) * 100)));
    }

    const countLabel = index !== undefined && total !== undefined
      ? `${isReupscale ? "Upscaling" : "Artwork"} ${index} of ${total}`
      : undefined;

    const detailParts = [sceneLabel, countLabel, isCompleted ? "complete" : "in progress"].filter(Boolean);
    const detail = detailParts.length > 0 ? detailParts.join(" · ") : (isReupscale ? "Upscaling artwork" : "Generating artwork");
    const stageLabel = isReupscale ? "Artwork upscaling" : "Artwork generation";

    return {
      title: baseTitle,
      stageLabel,
      detail,
      completed,
      total,
      percent,
    };
  }

  const phase = typeof rawProgress?.phase === "string" ? rawProgress.phase : undefined;
  const stageLabel = phase && SUMMARY_PHASE_LABELS[phase]
    ? SUMMARY_PHASE_LABELS[phase]
    : phase
      ? pretty(phase)
      : operation
        ? pretty(operation)
        : "Working";

  let completed: number | undefined = typeof rawProgress?.completed === "number" ? rawProgress.completed : undefined;
  let total: number | undefined = typeof rawProgress?.total === "number" && rawProgress.total > 0 ? rawProgress.total : undefined;
  let percent: number | undefined;

  if (completed !== undefined && total !== undefined) {
    percent = Math.min(100, Math.max(0, Math.round((completed / total) * 100)));
  } else if (job.status === "completed" || phase === "complete") {
    percent = 100;
  }

  let detail = typeof rawProgress?.detail === "string" && rawProgress.detail.trim().length > 0
    ? rawProgress.detail.trim()
    : "";

  if (!detail) {
    if (completed !== undefined && total !== undefined) {
      detail = `${stageLabel} · ${completed} of ${total}`;
    } else if (phase === "complete" || job.status === "completed") {
      detail = `${baseTitle} complete`;
    } else if (job.status === "failed") {
      detail = job.error || "Operation failed";
    } else {
      detail = `${stageLabel} in progress`;
    }
  }

  return {
    title: baseTitle,
    stageLabel,
    detail,
    completed,
    total,
    percent,
  };
}
