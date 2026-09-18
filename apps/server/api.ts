import { randomUUID } from "node:crypto";
import { getStoryBible } from "./catalog.js";
import { loadStory } from "../../src/config/load-config.js";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getAudioDashboard, getCanonicalEntitiesPage, getCanonicalEntityDetail, getChapter, getChapterPage, getContinuityReview, getMinorReferencesPage, getOutputsLibrary, getQaDashboard, getScenesDashboard, getStoryBibleView, getStoryDashboard, getStoryOverview, getVideoDashboard, listStories, updateStorySettings, chapterFilterSchema } from "./catalog.js";
import { JobConflictError } from "./job-manager.js";
import { StudioOperations } from "./operations.js";
import { exportPaths, previewPaths, sceneImagePath, sceneVersionImagePath, storyPaths, videoExportPaths, visualProfileRefPath, voicePreviewPaths } from "../../src/storage/paths.js";
import { SceneManifest, sceneManifestSchema } from "../../src/scenes/types.js";
import { readJsonIfExists } from "../../src/storage/story-files.js";
import { BatchValidationError, ConfigurationError, ProviderError, SceneError, StorageError } from "../../src/pipeline/errors.js";
import { SummaryArtifactNotFoundError } from "../../src/summaries/visuals.js";
import { WebHttpError } from "../../src/source/web/http-client.js";
import { SourceOperationError } from "../../src/source/errors.js";
import { logger } from "../../src/utils/logger.js";
import { backupPath } from "../../src/studio/projects.js";
import { exists } from "../../src/storage/story-files.js";
import { durableJobStatusSchema } from "../../src/queue/types.js";
import { QueueConflictError, QueueNotFoundError } from "../../src/queue/repository.js";
import { productionForceSchema } from "../../src/production/types.js";
import { createErrorDiagnostic } from "../../src/errors/diagnostic.js";
import { findVisualReferenceFile, mimeForVisualReferenceExtension } from "../../src/visual-canon/assets.js";

const MAX_BODY_BYTES = 50_000_000;
const MAX_JSON_BYTES = 1_000_000;
class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }
const sourceInspectJsonSchema = z.object({
  url: z.url(), type: z.enum(["web", "fanqie"]).optional(), from: z.number().int().positive().optional(),
  to: z.number().int().positive().optional(), chapter: z.number().int().positive().optional(),
  splitChapters: z.boolean().optional(), allowGaps: z.boolean().optional(),
  acquisition: z.enum(["html", "bulk-download"]).optional(),
}).strict();
const directoryInspectSchema = z.object({ files: z.array(z.object({ name: z.string().min(1).max(255), text: z.string() }).strict()).min(1).max(2_000), allowGaps: z.boolean().optional() }).strict();

export function createApiHandler(operations: StudioOperations) {
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost"); if (!url.pathname.startsWith("/api/")) return false;
    try {
      validateLocalRequest(request);
      if (request.method === "GET" && url.pathname === "/api/health") return send(response, 200, { status: "ready", binding: "localhost", credentials: { openai: "server-only", gemini: "server-only", kimi: "server-only", fish: "server-only" } });
      if (request.method === "GET" && url.pathname === "/api/stories") { const warnings: string[] = []; const stories = await listStories(operations.root, warnings); return send(response, 200, { stories, warnings }); }
      if (request.method === "GET" && url.pathname === "/api/novel/providers") return send(response, 200, { providers: operations.novelProviders() });
      if (request.method === "POST" && url.pathname === "/api/novel/search") return send(response, 200, await operations.searchNovelSources(await jsonBody(request)));
      const providerHealthMatch = /^\/api\/novel\/providers\/([a-z0-9-]+)\/health$/.exec(url.pathname);
      if (providerHealthMatch && request.method === "POST") return send(response, 200, await operations.diagnoseNovelProvider(providerHealthMatch[1]!));
      const providerStatusMatch = /^\/api\/novel\/providers\/([a-z0-9-]+)\/status$/.exec(url.pathname);
      if (providerStatusMatch && request.method === "PUT") return send(response, 200, operations.setNovelProviderEnabled(providerStatusMatch[1]!, await jsonBody(request)));
      if (request.method === "GET" && url.pathname === "/api/costs") return send(response, 200, await operations.appCostAnalytics(costFilters(url)));
      if (request.method === "POST" && url.pathname === "/api/stories") return send(response, 201, { story: await operations.createStory(await jsonBody(request)) });
      if (request.method === "POST" && url.pathname === "/api/stories/from-inspection") { const input = z.object({ inspectionId: z.string().uuid(), story: z.unknown() }).strict().parse(await jsonBody(request)); return send(response, 201, { story: await operations.createStoryWithInspection(input.story, input.inspectionId) }); }
      if (request.method === "GET" && url.pathname === "/api/settings") return send(response, 200, { settings: await operations.getGlobalSettings(), system: await operations.getSystemStatus() });
      if (request.method === "PUT" && url.pathname === "/api/settings") return send(response, 200, { settings: await operations.updateGlobalSettings(await jsonBody(request)) });
      if (request.method === "POST" && url.pathname === "/api/backups/restore") { const upload = await receiveUpload(request, operations.root, 4 * 1024 * 1024 * 1024); try { return send(response, 201, await operations.restoreBackup(upload)); } finally { await rm(upload, { force: true }); } }
      const backupDownload = /^\/api\/backups\/([a-f0-9-]{36})\.zip$/.exec(url.pathname);
      if (backupDownload && request.method === "GET") return sendFile(request, response, backupPath(operations.root, backupDownload[1]!), "application/zip");
      if (request.method === "GET" && url.pathname === "/api/jobs") return send(response, 200, { jobs: operations.jobs.list().map((job) => publicJob(job, operations.root)) });
      if (request.method === "GET" && url.pathname === "/api/queue/summary") return send(response, 200, await requireQueue(operations).repository.summary());
      if (request.method === "GET" && url.pathname === "/api/queue/jobs") return send(response, 200, await requireQueue(operations).repository.listJobs({ page: integerParam(url.searchParams.get("page"),1), pageSize: boundedPageSize(url.searchParams.get("pageSize")), status: url.searchParams.has("status") ? durableJobStatusSchema.parse(url.searchParams.get("status")) : undefined, story: optionalString(url.searchParams.get("story")) }));
      if (request.method === "GET" && url.pathname === "/api/queue/review") return send(response, 200, await requireQueue(operations).repository.listNeedsReview({ page: integerParam(url.searchParams.get("page"),1), pageSize: boundedPageSize(url.searchParams.get("pageSize")) }));
      const queueJobMatch = /^\/api\/queue\/jobs\/([a-f0-9-]+)$/.exec(url.pathname);
      if (queueJobMatch && request.method === "GET") { const repository=requireQueue(operations).repository;const job=await repository.getJob(queueJobMatch[1]!);if(!job)return send(response,404,{error:"Queue job not found"});const page=integerParam(url.searchParams.get("page"),1);const pageSize=boundedPageSize(url.searchParams.get("pageSize"));return send(response,200,{job,workItems:await repository.listWorkItems(job.id,{page,pageSize}),events:await repository.listRecentEvents(job.id,100)}); }
      const queueControlMatch = /^\/api\/queue\/jobs\/([a-f0-9-]+)\/(pause|resume|cancel)$/.exec(url.pathname);
      if(queueControlMatch&&request.method==="POST"){const repository=requireQueue(operations).repository;const action=queueControlMatch[2];const job=action==="pause"?await repository.requestPause(queueControlMatch[1]!):action==="resume"?await repository.resume(queueControlMatch[1]!):await repository.requestCancel(queueControlMatch[1]!);return send(response,202,{job});}
      const queueItemMatch=/^\/api\/queue\/items\/(\d+)\/(retry|resolve|skip)$/.exec(url.pathname);
      if(queueItemMatch&&request.method==="POST"){const repository=requireQueue(operations).repository;const action=queueItemMatch[2];const input=action==="retry"?z.object({stage:productionForceSchema.optional()}).strict().parse(await jsonBody(request)):{};if(action==="retry")await repository.retryItem(queueItemMatch[1]!,input.stage);else await repository.resolveItem(queueItemMatch[1]!,action==="skip");return send(response,202,{status:action});}
      const queueEventMatch=/^\/api\/queue\/jobs\/([a-f0-9-]+)\/events$/.exec(url.pathname);
      if(queueEventMatch&&request.method==="GET"){const repository=requireQueue(operations).repository;const initial=await repository.getJob(queueEventMatch[1]!);if(!initial)return send(response,404,{error:"Queue job not found"});response.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache",connection:"keep-alive","x-accel-buffering":"no"});let closed=false;let last=Number(request.headers["last-event-id"]??0);const push=async()=>{if(closed||response.destroyed)return;for(const item of await repository.listEvents(initial.id,last,100)){last=Number(item.id);response.write(`id: ${item.id}\nevent: queue\ndata: ${JSON.stringify(item)}\n\n`);}const job=await repository.getJob(initial.id);if(job)response.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);};await push();const timer=setInterval(()=>void push().catch(()=>undefined),1000);timer.unref();const cleanup=()=>{if(closed)return;closed=true;clearInterval(timer);};response.on("close",cleanup);return true;}

      const jobMatch = /^\/api\/jobs\/([a-f0-9-]+)$/.exec(url.pathname);
      if (jobMatch && request.method === "GET") { const job = operations.jobs.get(jobMatch[1]!); if (!job) return send(response, 404, { error: "Job not found" }); return send(response, 200, publicJob(job, operations.root)); }
      const retryMatch = /^\/api\/jobs\/([a-f0-9-]+)\/retry$/.exec(url.pathname);
      if (retryMatch && request.method === "POST") return send(response, 202, publicJob(await operations.retryJob(retryMatch[1]!), operations.root));
      const pauseMatch = /^\/api\/jobs\/([a-f0-9-]+)\/pause$/.exec(url.pathname);
      if (pauseMatch && request.method === "POST") return operations.jobs.pause(pauseMatch[1]!) ? send(response, 202, { status: "pause_requested" }) : send(response, 409, { error: "Job is not running or cannot be paused" });
      const eventMatch = /^\/api\/jobs\/([a-f0-9-]+)\/events$/.exec(url.pathname);
      if (eventMatch && request.method === "GET") {
        if (!operations.jobs.get(eventMatch[1]!)) return send(response, 404, { error: "Job not found" });
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        let closed = false; let unsubscribe: () => void = () => undefined;
        const heartbeat = setInterval(() => { if (!closed) response.write(": heartbeat\n\n"); }, 15_000); heartbeat.unref();
        const cleanup = () => { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe(); };
        unsubscribe = operations.jobs.subscribe(eventMatch[1]!, (job) => {
          if (closed || response.destroyed) return; response.write(`event: job\ndata: ${JSON.stringify(publicJob(job, operations.root))}\n\n`);
          if (["completed", "failed", "paused"].includes(job.status)) { cleanup(); response.end(); }
        }) ?? (() => undefined);
        response.on("close", cleanup); return true;
      }

      const storyMatch = /^\/api\/stories\/([a-z0-9-]+)$/.exec(url.pathname);
      if (storyMatch && request.method === "GET") return send(response, 200, await getStoryOverview(operations.root, storyMatch[1]!));
      if (storyMatch && request.method === "DELETE") return send(response, 200, await operations.deleteProject(storyMatch[1]!, await jsonBody(request)));
      const metadataMatch = /^\/api\/stories\/([a-z0-9-]+)\/metadata$/.exec(url.pathname);
      if (metadataMatch && request.method === "PUT") return send(response, 200, { story: await operations.updateMetadata(metadataMatch[1]!, await jsonBody(request)) });
      const coverMatch = /^\/api\/stories\/([a-z0-9-]+)\/cover$/.exec(url.pathname);
      if (coverMatch && request.method === "GET") { const root = storyPaths(operations.root, coverMatch[1]!, 1).story; for (const [name, type] of [["cover.jpg", "image/jpeg"], ["cover.jpeg", "image/jpeg"], ["cover.png", "image/png"]] as const) if (await exists(join(root, name))) return sendFile(request, response, join(root, name), type); return send(response, 404, { error: "Story cover was not found" }); }
      if (coverMatch && request.method === "PUT") { const filename = request.headers["x-file-name"]; if (typeof filename !== "string") throw new HttpError("Cover upload requires X-File-Name", 400); return send(response, 200, await operations.updateCover(coverMatch[1]!, decodeURIComponent(filename), await body(request, 15 * 1024 * 1024))); }
      const duplicateMatch = /^\/api\/stories\/([a-z0-9-]+)\/duplicate$/.exec(url.pathname);
      if (duplicateMatch && request.method === "POST") return send(response, 201, await operations.duplicateProject(duplicateMatch[1]!, await jsonBody(request)));
      const storyBackupMatch = /^\/api\/stories\/([a-z0-9-]+)\/backup$/.exec(url.pathname);
      if (storyBackupMatch && request.method === "POST") return send(response, 201, await operations.createBackup(storyBackupMatch[1]!, await jsonBody(request)));
      const storageMatch = /^\/api\/stories\/([a-z0-9-]+)\/storage$/.exec(url.pathname);
      if (storageMatch && request.method === "GET") return send(response, 200, { usage: await operations.storageUsage(storageMatch[1]!) });
      const cleanupMatch = /^\/api\/stories\/([a-z0-9-]+)\/storage\/cleanup$/.exec(url.pathname);
      if (cleanupMatch && request.method === "POST") return send(response, 200, await operations.cleanup(cleanupMatch[1]!, await jsonBody(request)));
      const activityMatch = /^\/api\/stories\/([a-z0-9-]+)\/activity$/.exec(url.pathname);
      if (activityMatch && request.method === "GET") return send(response, 200, { activity: await operations.recentActivity(activityMatch[1]!, optionalInteger(url.searchParams.get("limit"))) });
      const summariesMatch = /^\/api\/stories\/([a-z0-9-]+)\/summaries$/.exec(url.pathname);
      if (summariesMatch && request.method === "GET") return send(response, 200, { summaries: await operations.listSummaries(summariesMatch[1]!, { query: optionalString(url.searchParams.get("q")), type: optionalString(url.searchParams.get("type")), status: optionalString(url.searchParams.get("status")), sort: z.enum(["coverage", "created", "updated"]).default("updated").parse(url.searchParams.get("sort") ?? undefined) }) });
      if (summariesMatch && request.method === "POST") return send(response, 202, operations.startSummary(summariesMatch[1]!, await jsonBody(request)));
      const summaryMatch = /^\/api\/stories\/([a-z0-9-]+)\/summaries\/(sum_[a-f0-9-]{36})$/.exec(url.pathname);
      if (summaryMatch && request.method === "GET") return send(response, 200, { summary: await operations.getSummary(summaryMatch[1]!, summaryMatch[2]!) });
      if (summaryMatch && request.method === "PUT") return send(response, 200, { summary: await operations.updateSummary(summaryMatch[1]!, summaryMatch[2]!, await jsonBody(request)) });
      if (summaryMatch && request.method === "DELETE") { await jsonBody(request); return send(response, 200, await operations.deleteSummary(summaryMatch[1]!, summaryMatch[2]!)); }
      const summarySpeechMatch = /^\/api\/stories\/([a-z0-9-]+)\/summaries\/(sum_[a-f0-9-]{36})\/spoken-text$/.exec(url.pathname);
      if (summarySpeechMatch && request.method === "GET") return send(response, 200, await operations.summarySpeech(summarySpeechMatch[1]!, summarySpeechMatch[2]!));
      const summaryRegenerateMatch = /^\/api\/stories\/([a-z0-9-]+)\/summaries\/(sum_[a-f0-9-]{36})\/regenerate$/.exec(url.pathname);
      if (summaryRegenerateMatch && request.method === "POST") return send(response, 202, operations.regenerateSummary(summaryRegenerateMatch[1]!, summaryRegenerateMatch[2]!, await jsonBody(request)));
      const summaryMediaMatch = /^\/api\/stories\/([a-z0-9-]+)\/summaries\/(sum_[a-f0-9-]{36})\/(narration|audio|scenes|artwork|video|produce)$/.exec(url.pathname);
      if (summaryMediaMatch && request.method === "POST") return send(response, 202, await operations.startSummaryMedia(summaryMediaMatch[1]!, summaryMediaMatch[2]!, summaryMediaMatch[3]! as Parameters<StudioOperations["startSummaryMedia"]>[2], await jsonBody(request)));
      if (summaryMediaMatch && summaryMediaMatch[3] === "narration" && request.method === "PUT") return send(response, 200, { summary: await operations.editSummaryNarration(summaryMediaMatch[1]!, summaryMediaMatch[2]!, await jsonBody(request)) });
      if (summaryMediaMatch && summaryMediaMatch[3] === "scenes" && request.method === "PUT") return send(response, 200, { summary: await operations.editSummaryScenes(summaryMediaMatch[1]!, summaryMediaMatch[2]!, await jsonBody(request)) });
      const summarySceneRegenerateMatch = /^\/api\/stories\/([a-z0-9-]+)\/summaries\/(sum_[a-f0-9-]{36})\/scenes\/(scene-\d{3})\/regenerate$/.exec(url.pathname);
      if (summarySceneRegenerateMatch && request.method === "POST") { z.object({}).strict().parse(await jsonBody(request)); return send(response, 202, await operations.regenerateSummaryScene(summarySceneRegenerateMatch[1]!, summarySceneRegenerateMatch[2]!, summarySceneRegenerateMatch[3]!)); }
      const summaryImageMatch = /^\/api\/stories\/([a-z0-9-]+)\/summaries\/(sum_[a-f0-9-]{36})\/artwork\/(scene-\d{3})$/.exec(url.pathname);
      if (summaryImageMatch && request.method === "PUT") { const input = z.object({ review: z.enum(["unreviewed", "approved", "rejected", "needs-regeneration"]) }).strict().parse(await jsonBody(request)); return send(response, 200, { summary: await operations.reviewSummaryArtwork(summaryImageMatch[1]!, summaryImageMatch[2]!, summaryImageMatch[3]!, input.review) }); }
      if (summaryImageMatch && request.method === "GET") { const artifact = await operations.summaryVisuals().export(summaryImageMatch[1]!, summaryImageMatch[2]!, "artwork", summaryImageMatch[3]!); if (url.searchParams.get("download") === "1") response.setHeader("content-disposition", `attachment; filename="${artifact.name}"`); return sendFile(request, response, artifact.path, artifact.contentType); }
      const summaryExportMatch = /^\/api\/stories\/([a-z0-9-]+)\/summaries\/(sum_[a-f0-9-]{36})\/export\/(summary|narration|audio|video)$/.exec(url.pathname);
      if (summaryExportMatch && request.method === "GET") {
        const artifact = summaryExportMatch[3] === "video" ? await operations.summaryVisuals().export(summaryExportMatch[1]!, summaryExportMatch[2]!, "video") : await operations.summaryMedia().export(summaryExportMatch[1]!, summaryExportMatch[2]!, summaryExportMatch[3]!);
        if (url.searchParams.get("download") === "1") response.setHeader("content-disposition", `attachment; filename="${artifact.name}"`);
        return sendFile(request, response, artifact.path, artifact.contentType);
      }
      const dashboardMatch = /^\/api\/stories\/([a-z0-9-]+)\/dashboard$/.exec(url.pathname);
      if (dashboardMatch && request.method === "GET") return send(response, 200, await getStoryDashboard(operations.root, dashboardMatch[1]!));
      const outputsMatch = /^\/api\/stories\/([a-z0-9-]+)\/outputs$/.exec(url.pathname);
      if (outputsMatch && request.method === "GET") return send(response, 200, await getOutputsLibrary(operations.root, outputsMatch[1]!));
      const chapterList = /^\/api\/stories\/([a-z0-9-]+)\/chapters$/.exec(url.pathname);
      if (chapterList && request.method === "GET") return send(response, 200, await getChapterPage(operations.root, chapterList[1]!, {
        page: integerParam(url.searchParams.get("page"), 1), pageSize: integerParam(url.searchParams.get("pageSize"), 50),
        filter: chapterFilterSchema.parse(url.searchParams.get("filter") ?? "all"), query: url.searchParams.get("q") ?? undefined,
      }));
      const markCurrentPreviewMatch = /^\/api\/stories\/([a-z0-9-]+)\/stages\/mark-current\/preview$/.exec(url.pathname);
      if (markCurrentPreviewMatch && request.method === "POST") return send(response, 200, await operations.previewMarkStagesCurrent(markCurrentPreviewMatch[1]!, await jsonBody(request)));
      const markCurrentMatch = /^\/api\/stories\/([a-z0-9-]+)\/stages\/mark-current$/.exec(url.pathname);
      if (markCurrentMatch && request.method === "POST") return send(response, 200, await operations.markStagesCurrent(markCurrentMatch[1]!, await jsonBody(request)));
      const stagePlanMatch = /^\/api\/stories\/([a-z0-9-]+)\/stages\/plan$/.exec(url.pathname);
      if (stagePlanMatch && request.method === "POST") return send(response, 200, await operations.planStageExecution(stagePlanMatch[1]!, await jsonBody(request)));
      const stageRunMatch = /^\/api\/stories\/([a-z0-9-]+)\/stages\/run$/.exec(url.pathname);
      if (stageRunMatch && request.method === "POST") {
        const result = await operations.startStageExecution(stageRunMatch[1]!, await jsonBody(request));
        return send(response, "id" in result ? 202 : 200, result);
      }
      const chapterMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)$/.exec(url.pathname);
      if (chapterMatch && request.method === "GET") return send(response, 200, await getChapter(operations.root, chapterMatch[1]!, chapterParam(chapterMatch[2]!)));
      const chapterTextMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/text$/.exec(url.pathname);
      if (chapterTextMatch && request.method === "PUT") return send(response, 200, await operations.editChapterText(chapterTextMatch[1]!, chapterParam(chapterTextMatch[2]!), await jsonBody(request)));
      const chapterQaRepairMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/qa\/repair$/.exec(url.pathname);
      if (chapterQaRepairMatch && request.method === "POST") return send(response, 202, operations.startQaRepair(chapterQaRepairMatch[1]!, chapterParam(chapterQaRepairMatch[2]!), await jsonBody(request)));
      const chapterQaDismissMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/qa\/dismiss$/.exec(url.pathname);
      if (chapterQaDismissMatch && request.method === "PUT") return send(response, 200, await operations.dismissQaFindings(chapterQaDismissMatch[1]!, chapterParam(chapterQaDismissMatch[2]!), await jsonBody(request)));
      const chapterQaStateMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/qa$/.exec(url.pathname);
      if (chapterQaStateMatch && request.method === "GET") return send(response, 200, await operations.getChapterQa(chapterQaStateMatch[1]!, chapterParam(chapterQaStateMatch[2]!)));
      const qaSafeFixesMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/qa\/safe-fixes$/.exec(url.pathname);
      if (qaSafeFixesMatch && request.method === "POST") return send(response, 202, operations.startQaSafeFixes(qaSafeFixesMatch[1]!, chapterParam(qaSafeFixesMatch[2]!)));
      const qaFindingMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/qa\/findings\/(qaf_[a-f0-9]{24})\/(fix-ai|resolve-manual|dismiss|reopen)$/.exec(url.pathname);
      if (qaFindingMatch && request.method === "POST") {
        const slug = qaFindingMatch[1]!; const chapter = chapterParam(qaFindingMatch[2]!); const id = qaFindingMatch[3]!;
        const action = qaFindingMatch[4]!;
        if (action === "fix-ai") return send(response, 202, operations.startQaFindingFix(slug, chapter, id));
        if (action === "resolve-manual") return send(response, 200, await operations.resolveQaFindingManually(slug, chapter, id, await jsonBody(request)));
        if (action === "dismiss") return send(response, 200, await operations.dismissQaFinding(slug, chapter, id, await jsonBody(request)));
        return send(response, 200, await operations.reopenQaFinding(slug, chapter, id));
      }
      const audioMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/audio$/.exec(url.pathname);
      if (audioMatch && request.method === "GET") {
        const chapterNumber = chapterParam(audioMatch[2]!); const chapter = await getChapter(operations.root, audioMatch[1]!, chapterNumber);
        if (!chapter.audioAvailable) return send(response, 404, { error: "Chapter audio was not found" });
        const paths = storyPaths(operations.root, audioMatch[1]!, chapterNumber);
        const audioFile = (await exists(paths.audio)) ? paths.audio : paths.audioRaw;
        return sendFile(request, response, audioFile, "audio/mpeg");
      }
      const subtitleFileMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/subtitles\.(srt|vtt)$/.exec(url.pathname);
      if (subtitleFileMatch && request.method === "GET") { const chapterNumber = chapterParam(subtitleFileMatch[2]!); const chapter = await getChapter(operations.root, subtitleFileMatch[1]!, chapterNumber); if (!chapter.subtitles) return send(response, 404, { error: "Chapter subtitles were not found" }); const paths = storyPaths(operations.root, subtitleFileMatch[1]!, chapterNumber); return sendFile(request, response, subtitleFileMatch[3] === "srt" ? paths.subtitlesSrt : paths.subtitlesVtt, subtitleFileMatch[3] === "srt" ? "application/x-subrip" : "text/vtt; charset=utf-8"); }
      const subtitleEditMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/subtitles$/.exec(url.pathname);
      if (subtitleEditMatch && request.method === "PUT") return send(response, 200, await operations.editSubtitles(subtitleEditMatch[1]!, chapterParam(subtitleEditMatch[2]!), await jsonBody(request)));
      const subtitleResetMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/subtitles\/reset$/.exec(url.pathname);
      if (subtitleResetMatch && request.method === "POST") return send(response, 200, await operations.resetSubtitles(subtitleResetMatch[1]!, chapterParam(subtitleResetMatch[2]!)));
      const chapterVideoMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/video$/.exec(url.pathname);
      if (chapterVideoMatch && request.method === "GET") { const chapterNumber = chapterParam(chapterVideoMatch[2]!); const chapter = await getChapter(operations.root, chapterVideoMatch[1]!, chapterNumber); if (!chapter.videoUrl) return send(response, 404, { error: "Chapter video was not found" }); return sendFile(request, response, storyPaths(operations.root, chapterVideoMatch[1]!, chapterNumber).video, "video/mp4"); }
      const sceneImageMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/scenes\/(scene-\d{3})\.png$/.exec(url.pathname);
      if (sceneImageMatch && request.method === "GET") { const chapterNumber = chapterParam(sceneImageMatch[2]!); const raw = await readJsonIfExists<SceneManifest>(storyPaths(operations.root, sceneImageMatch[1]!, chapterNumber).scenesManifest); const manifest = raw ? sceneManifestSchema.safeParse(raw) : undefined; const scene = manifest?.success ? manifest.data.scenes.find((item) => item.id === sceneImageMatch[3]) : undefined; if (!scene || scene.artwork.status !== "complete") return send(response, 404, { error: "Scene artwork was not found" }); return sendFile(request, response, sceneImagePath(operations.root, sceneImageMatch[1]!, chapterNumber, sceneImageMatch[3]!), "image/png"); }
      const sceneVersionImageMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/scenes\/(scene-\d{3})\/versions\/(v\d+)\.png$/.exec(url.pathname);
      if (sceneVersionImageMatch && request.method === "GET") {
        const chapterNumber = chapterParam(sceneVersionImageMatch[2]!);
        const raw = await readJsonIfExists<SceneManifest>(storyPaths(operations.root, sceneVersionImageMatch[1]!, chapterNumber).scenesManifest);
        const manifest = raw ? sceneManifestSchema.safeParse(raw) : undefined;
        const scene = manifest?.success ? manifest.data.scenes.find((item) => item.id === sceneVersionImageMatch[3]) : undefined;
        const version = scene?.artwork.versions?.find((v) => v.id === sceneVersionImageMatch[4]);
        if (!scene || !version) return send(response, 404, { error: "Artwork version was not found" });
        const vPath = sceneVersionImagePath(operations.root, sceneVersionImageMatch[1]!, chapterNumber, scene.id, version.versionNumber);
        if (await exists(vPath)) {
          return sendFile(request, response, vPath, "image/png");
        }
        return sendFile(request, response, sceneImagePath(operations.root, sceneVersionImageMatch[1]!, chapterNumber, scene.id), "image/png");
      }
      const visualProfileRefImageMatch = /^\/api\/stories\/([a-z0-9-]+)\/visual-profiles\/(ent_[a-f0-9]{24})\/references\/([a-zA-Z0-9_-]+)(?:\.(png|jpg|jpeg|webp))?$/.exec(url.pathname);
      if (visualProfileRefImageMatch && request.method === "GET") {
        const storySlug = visualProfileRefImageMatch[1]!;
        const entityId = visualProfileRefImageMatch[2]!;
        const refId = visualProfileRefImageMatch[3]!;
        const requestedExt = visualProfileRefImageMatch[4];

        const match = await findVisualReferenceFile(
          operations.root,
          storySlug,
          entityId,
          refId,
          requestedExt,
        );

        if (!match) {
          return send(response, 404, { error: "Reference image not found" });
        }
        return sendFile(request, response, match.path, mimeForVisualReferenceExtension(match.ext));
      }
      const qaMatch = /^\/api\/stories\/([a-z0-9-]+)\/qa$/.exec(url.pathname);
      if (qaMatch && request.method === "GET") return send(response, 200, await getQaDashboard(operations.root, qaMatch[1]!));
      const qaExceptionsMatch = /^\/api\/stories\/([a-z0-9-]+)\/qa-exceptions$/.exec(url.pathname);
      if (qaExceptionsMatch && request.method === "GET") return send(response, 200, await operations.listQaExceptions(qaExceptionsMatch[1]!));
      if (qaExceptionsMatch && request.method === "POST") return send(response, 201, await operations.addQaException(qaExceptionsMatch[1]!, await jsonBody(request)));
      const qaExceptionMatch = /^\/api\/stories\/([a-z0-9-]+)\/qa-exceptions\/(qax_[a-f0-9]{24})$/.exec(url.pathname);
      if (qaExceptionMatch && request.method === "DELETE") return send(response, 200, await operations.removeQaException(qaExceptionMatch[1]!, qaExceptionMatch[2]!));
      const audioDashboardMatch = /^\/api\/stories\/([a-z0-9-]+)\/audio$/.exec(url.pathname);
      if (audioDashboardMatch && request.method === "GET") return send(response, 200, await getAudioDashboard(operations.root, audioDashboardMatch[1]!));
      const videoDashboardMatch = /^\/api\/stories\/([a-z0-9-]+)\/video$/.exec(url.pathname);
      if (videoDashboardMatch && request.method === "GET") return send(response, 200, await getVideoDashboard(operations.root, videoDashboardMatch[1]!));
      const scenesDashboardMatch = /^\/api\/stories\/([a-z0-9-]+)\/scenes$/.exec(url.pathname);
      if (scenesDashboardMatch && request.method === "GET") return send(response, 200, await getScenesDashboard(operations.root, scenesDashboardMatch[1]!, optionalInteger(url.searchParams.get("chapter"))));
      const visualProfilesMatch = /^\/api\/stories\/([a-z0-9-]+)\/visual-profiles$/.exec(url.pathname);
      if (visualProfilesMatch && request.method === "GET") {
        return send(response, 200, await operations.getVisualProfiles(visualProfilesMatch[1]!));
      }
      const visualProfileMatch = /^\/api\/stories\/([a-z0-9-]+)\/visual-profiles\/(ent_[a-f0-9]{24})$/.exec(url.pathname);
      if (visualProfileMatch && request.method === "GET") {
        const profile = await operations.getVisualProfile(visualProfileMatch[1]!, visualProfileMatch[2]!);
        if (!profile) return send(response, 404, { error: "Visual profile not found" });
        return send(response, 200, profile);
      }
      if (visualProfileMatch && request.method === "PUT") {
        return send(response, 200, await operations.updateVisualProfile(visualProfileMatch[1]!, visualProfileMatch[2]!, await jsonBody(request)));
      }
      if (visualProfileMatch && request.method === "DELETE") {
        return send(response, 200, await operations.deleteVisualProfile(visualProfileMatch[1]!, visualProfileMatch[2]!));
      }
      const visualProfileRefsMatch = /^\/api\/stories\/([a-z0-9-]+)\/visual-profiles\/(ent_[a-f0-9]{24})\/references$/.exec(url.pathname);
      if (visualProfileRefsMatch && request.method === "POST") {
        const contentType = request.headers["content-type"] ?? "";
        if (contentType.includes("application/json")) {
          const bodyData = (await jsonBody(request)) as any;
          const buffer = Buffer.from(bodyData.base64, "base64");
          const ext = bodyData.ext || "png";
          return send(response, 201, await operations.addVisualReferenceImage(visualProfileRefsMatch[1]!, visualProfileRefsMatch[2]!, buffer, ext, bodyData.viewType, bodyData.notes));
        } else {
          const filename = decodeURIComponent((request.headers["x-file-name"] as string) || "reference.png");
          const viewType = (request.headers["x-view-type"] as string) || "character_face";
          const notes = request.headers["x-notes"] ? decodeURIComponent(request.headers["x-notes"] as string) : undefined;
          const ext = filename.split(".").pop() || "png";
          const data = await body(request, 15 * 1024 * 1024);
          return send(response, 201, await operations.addVisualReferenceImage(visualProfileRefsMatch[1]!, visualProfileRefsMatch[2]!, Buffer.from(data), ext, viewType, notes));
        }
      }
      const visualProfileSingleRefMatch = /^\/api\/stories\/([a-z0-9-]+)\/visual-profiles\/(ent_[a-f0-9]{24})\/references\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (visualProfileSingleRefMatch && request.method === "DELETE") {
        return send(response, 200, await operations.deleteVisualReferenceImage(visualProfileSingleRefMatch[1]!, visualProfileSingleRefMatch[2]!, visualProfileSingleRefMatch[3]!));
      }
      const visualProfileStyleSheetMatch = /^\/api\/stories\/([a-z0-9-]+)\/visual-profiles\/(ent_[a-f0-9]{24})\/style-sheet$/.exec(url.pathname);
      if (visualProfileStyleSheetMatch && request.method === "POST") {
        const bodyData = (await jsonBody(request).catch(() => ({}))) as any;
        return send(response, 200, await operations.generateStyleSheet(visualProfileStyleSheetMatch[1]!, visualProfileStyleSheetMatch[2]!, bodyData));
      }
      const artDirectionMatch = /^\/api\/stories\/([a-z0-9-]+)\/art-direction$/.exec(url.pathname);
      if (artDirectionMatch && request.method === "GET") {
        return send(response, 200, await operations.getArtDirection(artDirectionMatch[1]!));
      }
      if (artDirectionMatch && request.method === "PUT") {
        return send(response, 200, await operations.updateArtDirection(artDirectionMatch[1]!, await jsonBody(request)));
      }
      const artDirectionPresetsMatch = /^\/api\/stories\/([a-z0-9-]+)\/art-direction\/presets$/.exec(url.pathname);
      if (artDirectionPresetsMatch && request.method === "POST") {
        return send(response, 201, await operations.createArtDirectionPreset(artDirectionPresetsMatch[1]!, await jsonBody(request)));
      }
      const artDirectionPresetDuplicateMatch = /^\/api\/stories\/([a-z0-9-]+)\/art-direction\/presets\/(preset_[A-Za-z0-9_-]+)\/duplicate$/.exec(url.pathname);
      if (artDirectionPresetDuplicateMatch && request.method === "POST") {
        const bodyData = (await jsonBody(request).catch(() => ({}))) as any;
        return send(response, 200, await operations.duplicateArtDirectionPreset(artDirectionPresetDuplicateMatch[1]!, artDirectionPresetDuplicateMatch[2]!, bodyData?.name));
      }
      const artDirectionPresetDefaultMatch = /^\/api\/stories\/([a-z0-9-]+)\/art-direction\/presets\/(preset_[A-Za-z0-9_-]+)\/default$/.exec(url.pathname);
      if (artDirectionPresetDefaultMatch && request.method === "POST") {
        return send(response, 200, await operations.setDefaultArtDirectionPreset(artDirectionPresetDefaultMatch[1]!, artDirectionPresetDefaultMatch[2]!));
      }
      const artDirectionPresetMatch = /^\/api\/stories\/([a-z0-9-]+)\/art-direction\/presets\/(preset_[A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (artDirectionPresetMatch && request.method === "PUT") {
        return send(response, 200, await operations.updateArtDirectionPreset(artDirectionPresetMatch[1]!, artDirectionPresetMatch[2]!, await jsonBody(request)));
      }
      if (artDirectionPresetMatch && request.method === "DELETE") {
        return send(response, 200, await operations.deleteArtDirectionPreset(artDirectionPresetMatch[1]!, artDirectionPresetMatch[2]!));
      }
      const productionMatch = /^\/api\/stories\/([a-z0-9-]+)\/production$/.exec(url.pathname);
      if (productionMatch && request.method === "GET") return send(response, 200, { latest: (await getStoryDashboard(operations.root, productionMatch[1]!)).latestProduction });
      const costsMatch = /^\/api\/stories\/([a-z0-9-]+)\/costs$/.exec(url.pathname);
      if (costsMatch && request.method === "GET") return send(response, 200, await operations.costAnalytics(costsMatch[1]!, costFilters(url)));
      const costRecordsMatch = /^\/api\/stories\/([a-z0-9-]+)\/costs\/records$/.exec(url.pathname);
      if (costRecordsMatch && request.method === "GET") return send(response, 200, await operations.costRecords(costRecordsMatch[1]!, { ...costFilters(url), page: integerParam(url.searchParams.get("page"), 1), pageSize: boundedPageSize(url.searchParams.get("pageSize")) }));
      const costExportMatch = /^\/api\/stories\/([a-z0-9-]+)\/costs\/export$/.exec(url.pathname);
      if (costExportMatch && request.method === "GET") { const format=z.enum(["json","csv"]).parse(url.searchParams.get("format")??"json");const items:unknown[]=[];let page=1,pages=1;do{const result=await operations.costRecords(costExportMatch[1]!,{...costFilters(url),page,pageSize:200});items.push(...result.items);pages=result.pages;page++;}while(page<=pages);if(format==="json")return send(response,200,{records:items});const rows=items as Array<Record<string,unknown>>;const columns=["attemptedAt","story","chapter","stage","provider","model","operation","success","inputTokens","cachedInputTokens","outputTokens","inputUtf8Bytes","imageCount","costUsd","costStatus","requestId"];const csv=[columns.join(","),...rows.map(row=>columns.map(key=>csvCell(row[key])).join(","))].join("\n");response.writeHead(200,{"content-type":"text/csv; charset=utf-8","content-disposition":`attachment; filename="${costExportMatch[1]}-provider-costs.csv"`});response.end(csv);return true; }
      const productionPlanMatch = /^\/api\/stories\/([a-z0-9-]+)\/production\/plan$/.exec(url.pathname);
      if (productionPlanMatch && request.method === "POST") return send(response, 200, await operations.productionPlan(productionPlanMatch[1]!, await jsonBody(request)));
      const scenesEditMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/scenes$/.exec(url.pathname);
      if (scenesEditMatch && request.method === "PUT") { const input = z.object({ scenes: z.array(z.unknown()) }).strict().parse(await jsonBody(request)); return send(response, 200, { manifest: await operations.updateScenes(scenesEditMatch[1]!, chapterParam(scenesEditMatch[2]!), input.scenes) }); }
      const artworkReviewMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/scenes\/(scene-\d{3})\/review$/.exec(url.pathname);
      if (artworkReviewMatch && request.method === "POST") { const input = z.object({ review: z.enum(["unreviewed", "approved", "rejected", "needs-regeneration"]) }).strict().parse(await jsonBody(request)); return send(response, 200, { manifest: await operations.reviewArtwork(artworkReviewMatch[1]!, chapterParam(artworkReviewMatch[2]!), artworkReviewMatch[3]!, input.review) }); }
      const artworkVersionReviewMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/scenes\/(scene-\d{3})\/versions\/(v\d+)\/review$/.exec(url.pathname);
      if (artworkVersionReviewMatch && request.method === "POST") {
        const bodyData = (await jsonBody(request).catch(() => ({}))) as any;
        const review = bodyData?.review ?? "approved";
        return send(response, 200, {
          manifest: await operations.reviewArtworkVersion(
            artworkVersionReviewMatch[1]!,
            chapterParam(artworkVersionReviewMatch[2]!),
            artworkVersionReviewMatch[3]!,
            artworkVersionReviewMatch[4]!,
            review
          ),
        });
      }
      const exportMatch = /^\/api\/stories\/([a-z0-9-]+)\/exports\/(\d+)-(\d+)\.(mp3|m4b)$/.exec(url.pathname);
      if (exportMatch && request.method === "GET") {
        const from = chapterParam(exportMatch[2]!); const to = chapterParam(exportMatch[3]!); const format = exportMatch[4] as "mp3" | "m4b";
        if (to < from) throw new HttpError("Invalid export range", 400);
        return sendFile(request, response, exportPaths(operations.root, exportMatch[1]!, from, to, format).output, format === "m4b" ? "audio/mp4" : "audio/mpeg");
      }
      const videoExportMatch = /^\/api\/stories\/([a-z0-9-]+)\/video-exports\/(\d+)-(\d+)\.mp4$/.exec(url.pathname);
      if (videoExportMatch && request.method === "GET") { const from = chapterParam(videoExportMatch[2]!); const to = chapterParam(videoExportMatch[3]!); if (to < from) throw new HttpError("Invalid video export range", 400); return sendFile(request, response, videoExportPaths(operations.root, videoExportMatch[1]!, from, to).output, "video/mp4"); }
      const bibleMatch = /^\/api\/stories\/([a-z0-9-]+)\/story-bible$/.exec(url.pathname);
      if (bibleMatch && request.method === "GET") return send(response, 200, await getStoryBibleView(operations.root, bibleMatch[1]!));
      if (bibleMatch && request.method === "POST") return send(response, 201, await operations.addBibleEntry(bibleMatch[1]!, await jsonBody(request)));
      const bibleEntitiesMatch = /^\/api\/stories\/([a-z0-9-]+)\/story-bible\/entities$/.exec(url.pathname);
      if (bibleEntitiesMatch && request.method === "GET") return send(response, 200, await getCanonicalEntitiesPage(operations.root, bibleEntitiesMatch[1]!, { page: integerParam(url.searchParams.get("page"), 1), pageSize: boundedPageSize(url.searchParams.get("pageSize")), type: entityTypeFilter(url.searchParams.get("type")), query: optionalString(url.searchParams.get("q")), sort: entitySortFilter(url.searchParams.get("sort")) }));
      const bibleEntityMatch = /^\/api\/stories\/([a-z0-9-]+)\/story-bible\/entities\/(ent_[a-f0-9]{24})$/.exec(url.pathname);
      if (bibleEntityMatch && request.method === "GET") return send(response, 200, await getCanonicalEntityDetail(operations.root, bibleEntityMatch[1]!, bibleEntityMatch[2]!));
      if (bibleEntityMatch && request.method === "PUT") return send(response, 200, await operations.updateCanonicalEntity(bibleEntityMatch[1]!, bibleEntityMatch[2]!, await jsonBody(request)));
      const localizationSuggestionsMatch = /^\/api\/stories\/([a-z0-9-]+)\/story-bible\/entities\/(ent_[a-f0-9]{24})\/localization-suggestions$/.exec(url.pathname);
      const pronunciationMatch = /^\/api\/stories\/([a-z0-9-]+)\/pronunciation(?:\/(ent_[a-f0-9]{24})(?:\/(test|enrich))?)?$/.exec(url.pathname);
      if (pronunciationMatch) {
        const slug = pronunciationMatch[1]!, id = pronunciationMatch[2];
        if (request.method === "GET") {
          const entities = (await getStoryBible(operations.root, slug)).canonicalEntities;
          await loadStory(storyPaths(operations.root, slug, 1).storyConfig);
          if (id && !entities.some(entity => entity.id === id)) return send(response, 404, { error: "Canonical entity was not found" });
          return send(response, 200, id ? entities.find(entity => entity.id === id) : { entities });
        }
        if (request.method === "PUT" && id) return send(response, 200, await operations.updateCanonicalEntity(slug, id, { pronunciation: await jsonBody(request) }));
        if (request.method === "POST") return send(response, 202, pronunciationMatch[3] === "test" && id ? operations.startPronunciationTest(slug, id) : operations.startPronunciationEnrichment(slug, id ? { entityId: id } : await jsonBody(request)));
      }
      if (localizationSuggestionsMatch && request.method === "POST") return send(response, 202, operations.startLocalizationSuggestions(localizationSuggestionsMatch[1]!, localizationSuggestionsMatch[2]!, await jsonBody(request)));
      const bibleAnalysisMatch = /^\/api\/stories\/([a-z0-9-]+)\/story-bible\/analysis$/.exec(url.pathname);
      if (bibleAnalysisMatch && request.method === "GET") return send(response, 200, await operations.analyzeStoryBible(bibleAnalysisMatch[1]!));
      const bibleCleanupMatch = /^\/api\/stories\/([a-z0-9-]+)\/story-bible\/cleanup\/apply$/.exec(url.pathname);
      if (bibleCleanupMatch && request.method === "POST") return send(response, 200, await operations.applyCleanupRecommendations(bibleCleanupMatch[1]!, await jsonBody(request)));
      const bibleDemoteMatch = /^\/api\/stories\/([a-z0-9-]+)\/story-bible\/entities\/(ent_[a-f0-9]{24})\/demote$/.exec(url.pathname);
      if (bibleDemoteMatch && request.method === "POST") return send(response, 200, await operations.demoteCanonicalEntity(bibleDemoteMatch[1]!, bibleDemoteMatch[2]!, await jsonBody(request)));
      const bibleRefsMatch = /^\/api\/stories\/([a-z0-9-]+)\/story-bible\/references$/.exec(url.pathname);
      if (bibleRefsMatch && request.method === "GET") return send(response, 200, await getMinorReferencesPage(operations.root, bibleRefsMatch[1]!, { page: integerParam(url.searchParams.get("page"), 1), pageSize: boundedPageSize(url.searchParams.get("pageSize")), parentEntityId: optionalString(url.searchParams.get("parent")), type: optionalString(url.searchParams.get("type")), query: optionalString(url.searchParams.get("q")) }));
      const bibleRefPromoteMatch = /^\/api\/stories\/([a-z0-9-]+)\/story-bible\/references\/([a-z0-9-_]+)\/promote$/.exec(url.pathname);
      if (bibleRefPromoteMatch && request.method === "POST") return send(response, 200, await operations.promoteMinorReference(bibleRefPromoteMatch[1]!, bibleRefPromoteMatch[2]!, await jsonBody(request)));
      const bibleRefMatch = /^\/api\/stories\/([a-z0-9-]+)\/story-bible\/references\/([a-z0-9-_]+)$/.exec(url.pathname);
      if (bibleRefMatch && request.method === "PUT") return send(response, 200, await operations.updateMinorReference(bibleRefMatch[1]!, bibleRefMatch[2]!, await jsonBody(request)));
      const bibleMergeMatch = /^\/api\/stories\/([a-z0-9-]+)\/story-bible\/merges$/.exec(url.pathname);
      if (bibleMergeMatch && request.method === "POST") return send(response, 201, await operations.mergeCanonicalEntities(bibleMergeMatch[1]!, await jsonBody(request)));
      const bibleMergeUndoMatch = /^\/api\/stories\/([a-z0-9-]+)\/story-bible\/merges\/([a-f0-9-]{36})\/undo$/.exec(url.pathname);
      if (bibleMergeUndoMatch && request.method === "POST") return send(response, 200, await operations.undoCanonicalMerge(bibleMergeUndoMatch[1]!, bibleMergeUndoMatch[2]!));
      const continuityMatch = /^\/api\/stories\/([a-z0-9-]+)\/continuity$/.exec(url.pathname);
      if (continuityMatch && request.method === "GET") return send(response, 200, await getContinuityReview(operations.root, continuityMatch[1]!, continuityStatusFilter(url.searchParams.get("status"))));
      const continuityFindingMatch = /^\/api\/stories\/([a-z0-9-]+)\/continuity\/(ctf_[a-f0-9]{24})$/.exec(url.pathname);
      if (continuityFindingMatch && request.method === "PUT") return send(response, 200, await operations.resolveContinuity(continuityFindingMatch[1]!, continuityFindingMatch[2]!, await jsonBody(request)));
      const bibleEntryMatch = /^\/api\/stories\/([a-z0-9-]+)\/story-bible\/([a-f0-9-]+|auto-[a-f0-9]+)$/.exec(url.pathname);
      if (bibleEntryMatch && request.method === "PUT") return send(response, 200, await operations.updateBibleEntry(bibleEntryMatch[1]!, bibleEntryMatch[2]!, await jsonBody(request)));
      if (bibleEntryMatch && request.method === "DELETE") return send(response, 200, await operations.deleteBibleEntry(bibleEntryMatch[1]!, bibleEntryMatch[2]!));
      const settingsMatch = /^\/api\/stories\/([a-z0-9-]+)\/settings$/.exec(url.pathname);
      if (settingsMatch && request.method === "PUT") return send(response, 200, { story: await updateStorySettings(operations.root, settingsMatch[1]!, await jsonBody(request)) });
      if (settingsMatch && request.method === "PUT") {
        await updateStorySettings(operations.root, settingsMatch[1]!, await jsonBody(request));
        const overview = await getStoryOverview(operations.root, settingsMatch[1]!);
        return send(response, 200, { story: overview.story, effectiveRouting: overview.effectiveRouting });
      }
      const novelSourcesMatch = /^\/api\/stories\/([a-z0-9-]+)\/sources$/.exec(url.pathname);
      if (novelSourcesMatch && request.method === "PUT") return send(response, 200, { story: await operations.updateNovelSourcePriorities(novelSourcesMatch[1]!, await jsonBody(request)) });
      const metadataTranslationJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/metadata-translation$/.exec(url.pathname);
      if (metadataTranslationJobMatch && request.method === "POST") return send(response, 202, operations.startMetadataTranslation(metadataTranslationJobMatch[1]!));

      const inspectMatch = /^\/api\/stories\/([a-z0-9-]+)\/source\/inspect$/.exec(url.pathname);
      if (inspectMatch && request.method === "POST") {
        const updateContext = inspectMatch[1] === "new" ? undefined : { story: inspectMatch[1]!, additive: true };
        const contentType = request.headers["content-type"] ?? "";
        if (contentType.includes("application/json")) { const raw = await jsonBody(request, 50_000_000); const parsedDirectory = directoryInspectSchema.safeParse(raw); return send(response, 200, await operations.inspectSource(parsedDirectory.success ? parsedDirectory.data : sourceInspectJsonSchema.parse(raw), updateContext)); }
        const file = await body(request); const filename = request.headers["x-file-name"];
        return send(response, 200, await operations.inspectSource({ file, filename: typeof filename === "string" ? decodeURIComponent(filename) : undefined,
          type: optionalString(url.searchParams.get("type")) as never, chapter: optionalInteger(url.searchParams.get("chapter")), splitChapters: url.searchParams.get("split") === "true", allowGaps: url.searchParams.get("allowGaps") === "true" }, updateContext));
      }
      const importMatch = /^\/api\/stories\/([a-z0-9-]+)\/source\/import$/.exec(url.pathname);
      if (importMatch && request.method === "POST") { const input = z.object({ inspectionId: z.string().uuid(), allowGaps: z.boolean().default(false), overwriteExisting: z.boolean().default(false) }).parse(await jsonBody(request)); return send(response, 200, await operations.importInspection(importMatch[1]!, input.inspectionId, input.allowGaps, input.overwriteExisting)); }
      const batchMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/batch$/.exec(url.pathname);
      if (batchMatch && request.method === "POST") return send(response, 202, operations.startBatch(batchMatch[1]!, await jsonBody(request)));
      const qaRecheckMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/qa\/recheck$/.exec(url.pathname);
      if (qaRecheckMatch && request.method === "POST") return send(response, 202, operations.startQaRecheck(qaRecheckMatch[1]!, chapterParam(qaRecheckMatch[2]!), await jsonBody(request)));
      const previewMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/preview$/.exec(url.pathname);
      if (previewMatch && request.method === "POST") return send(response, 202, operations.startPreview(previewMatch[1]!, await jsonBody(request)));
      const audioJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/audio$/.exec(url.pathname);
      if (audioJobMatch && request.method === "POST") return send(response, 202, operations.startAudio(audioJobMatch[1]!, await jsonBody(request)));
      const audiobookJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/audiobook$/.exec(url.pathname);
      if (audiobookJobMatch && request.method === "POST") return send(response, 202, operations.startAudiobook(audiobookJobMatch[1]!, await jsonBody(request)));
      const subtitleJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/subtitles$/.exec(url.pathname);
      if (subtitleJobMatch && request.method === "POST") return send(response, 202, operations.startSubtitles(subtitleJobMatch[1]!, await jsonBody(request)));
      const alignmentJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/alignment$/.exec(url.pathname);
      if (alignmentJobMatch && request.method === "POST") return send(response, 202, operations.startAlignment(alignmentJobMatch[1]!, await jsonBody(request)));
      const videoJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/video$/.exec(url.pathname);
      if (videoJobMatch && request.method === "POST") return send(response, 202, operations.startVideo(videoJobMatch[1]!, await jsonBody(request)));
      const videoExportJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/video-export$/.exec(url.pathname);
      if (videoExportJobMatch && request.method === "POST") return send(response, 202, operations.startVideoExport(videoExportJobMatch[1]!, await jsonBody(request)));
      const scenesJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/scenes$/.exec(url.pathname);
      if (scenesJobMatch && request.method === "POST") return send(response, 202, operations.startScenes(scenesJobMatch[1]!, await jsonBody(request)));
      const artworkJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/artwork$/.exec(url.pathname);
      if (artworkJobMatch && request.method === "POST") return send(response, 202, operations.startArtwork(artworkJobMatch[1]!, await jsonBody(request)));
      const productionJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/production$/.exec(url.pathname);
      if (productionJobMatch && request.method === "POST") return send(response, 202, await operations.submitProduction(productionJobMatch[1]!, await jsonBody(request)));
      const voicePreviewJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/voice-preview$/.exec(url.pathname);
      if (voicePreviewJobMatch && request.method === "POST") return send(response, 202, operations.startVoicePreview(voicePreviewJobMatch[1]!, await jsonBody(request)));
      const voicePreviewMatch = /^\/api\/stories\/([a-z0-9-]+)\/voice-previews\/([a-f0-9-]{36})\.mp3$/.exec(url.pathname);
      if (voicePreviewMatch && request.method === "GET") { const paths = voicePreviewPaths(operations.root, voicePreviewMatch[1]!, voicePreviewMatch[2]!); if (!(await readJsonIfExists(paths.manifest))) return send(response, 404, { error: "Voice preview was not found" }); return sendFile(request, response, paths.audio, "audio/mpeg"); }
      const previewResult = /^\/api\/stories\/([a-z0-9-]+)\/previews\/([A-Za-z0-9T_-]+)$/.exec(url.pathname);
      if (previewResult && request.method === "GET") return send(response, 200, await operations.getPreview(previewResult[1]!, previewResult[2]!));
      const previewAudio = /^\/api\/stories\/([a-z0-9-]+)\/previews\/([A-Za-z0-9T_-]+)\/audio-([ab])$/.exec(url.pathname);
      if (previewAudio && request.method === "GET") { const paths = previewPaths(operations.root, previewAudio[1]!, previewAudio[2]!); return sendFile(request, response, previewAudio[3] === "a" ? paths.audioA : paths.audioB, "audio/mpeg"); }
      const profileMatch = /^\/api\/stories\/([a-z0-9-]+)\/profile$/.exec(url.pathname);
      if (profileMatch && request.method === "POST") { const input = z.object({ previewId: z.string(), choice: z.enum(["a", "b"]) }).parse(await jsonBody(request)); return send(response, 200, { story: await operations.selectPreview(profileMatch[1]!, input.previewId, input.choice) }); }
      const refreshMatch = /^\/api\/stories\/([a-z0-9-]+)\/source\/refresh$/.exec(url.pathname);
      if (refreshMatch && request.method === "POST") { const input = z.object({ importNew: z.boolean().default(false) }).parse(await jsonBody(request)); return send(response, 200, await operations.refreshRemote(refreshMatch[1]!, input.importNew)); }
      return send(response, 404, { error: "API route not found" });
    } catch (error) {
      const status = statusFor(error);
      const displayError = error instanceof z.ZodError ? new Error(z.prettifyError(error), { cause: error }) : error;
      const diagnostic = createErrorDiagnostic(displayError);
      if (status >= 500) logger.error({ event: "web.api.failed", diagnosticId: diagnostic.id, category: diagnostic.category, method: request.method, path: url.pathname, status, error: error instanceof Error ? error.message : String(error) });
      return send(response, status, { error: diagnostic.summary, diagnostic: publicJob(diagnostic, operations.root), validation: validationIssues(error) });
    }
  };
}

export function validateLocalRequest(request: Pick<IncomingMessage, "method" | "headers">) {
  const rawHost = request.headers.host; const host = Array.isArray(rawHost) ? rawHost[0] : rawHost;
  if (host) {
    let hostname: string; try { hostname = new URL(`http://${host}`).hostname.toLowerCase(); } catch { throw new HttpError("Invalid Host header", 403); }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) throw new HttpError("Story Studio only accepts localhost requests", 403);
  }
  const fetchSite = request.headers["sec-fetch-site"]; if (fetchSite === "cross-site") throw new HttpError("Cross-site requests are not allowed", 403);
  const rawOrigin = request.headers.origin; const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (origin) {
    let originHost: string; try { originHost = new URL(origin).host.toLowerCase(); } catch { throw new HttpError("Invalid Origin header", 403); }
    if (!host || originHost !== host.toLowerCase()) throw new HttpError("Cross-origin requests are not allowed", 403);
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "")) {
    const rawType = request.headers["content-type"]; const type = (Array.isArray(rawType) ? rawType[0] : rawType)?.split(";", 1)[0]?.trim().toLowerCase();
    if (type !== "application/json" && type !== "application/octet-stream") throw new HttpError("Mutation requests require application/json or application/octet-stream", 415);
  }
}

function send(response: ServerResponse, status: number, value: unknown): true { const output = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(output), "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(output); return true; }
async function sendFile(request: IncomingMessage, response: ServerResponse, path: string, contentType: string): Promise<true> {
  let info; try { info = await stat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return send(response, 404, { error: "File not found" }); throw error; }
  const range = parseRange(request.headers.range, info.size); const status = range ? 206 : 200; const start = range?.start ?? 0; const end = range?.end ?? info.size - 1;
  response.writeHead(status, { "content-type": contentType, "content-length": Math.max(0, end - start + 1), "cache-control": "no-store", "accept-ranges": "bytes",
    "x-content-type-options": "nosniff", ...(range ? { "content-range": `bytes ${start}-${end}/${info.size}` } : {}) });
  const stream = createReadStream(path, { start, end }); stream.on("error", (error) => response.destroy(error)); stream.pipe(response); return true;
}
async function body(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> { const parts: Buffer[] = []; let size = 0; for await (const chunk of request) { const part = Buffer.from(chunk); size += part.length; if (size > limit) throw new HttpError(`Request body exceeds ${Math.floor(limit / 1_000_000)} MB`, 413); parts.push(part); } return Buffer.concat(parts); }
async function jsonBody(request: IncomingMessage, limit = MAX_JSON_BYTES): Promise<unknown> { const raw = await body(request, limit); if (!raw.length) return {}; try { return JSON.parse(raw.toString("utf8")); } catch { throw new HttpError("Request body must be valid JSON", 400); } }
export function integerParam(value: string | null, fallback: number) { if (value === null) return fallback; const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new HttpError("Pagination values must be positive integers", 400); return number; }
export function chapterParam(value: string) { const chapter = Number(value); if (!Number.isSafeInteger(chapter) || chapter < 1) throw new HttpError("Chapter must be a positive integer", 400); return chapter; }
function optionalInteger(value: string | null) { if (value === null) return undefined; return integerParam(value, 1); }
export function entityTypeFilter(value: string | null) { return value === null ? undefined : z.enum(["all", "character", "location", "organization", "ability", "item", "concept"]).parse(value); }
export function entitySortFilter(value: string | null) { return value === null ? undefined : z.enum(["last", "first", "name"]).parse(value); }
export function continuityStatusFilter(value: string | null) { return value === null ? undefined : z.enum(["all", "open", "accepted_new", "kept_existing", "intentional", "corrected", "merged", "dismissed"]).parse(value); }
function csvCell(value:unknown){const text=value===undefined||value===null?"":String(value);return /[",\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;}
function costFilters(url: URL) { return { chapterFrom: optionalInteger(url.searchParams.get("chapterFrom")), chapterTo: optionalInteger(url.searchParams.get("chapterTo")), productionRunId: optionalString(url.searchParams.get("run")), queueJobId: optionalString(url.searchParams.get("job")), stage: optionalString(url.searchParams.get("stage")), provider: optionalString(url.searchParams.get("provider")), model: optionalString(url.searchParams.get("model")), fromDate: optionalString(url.searchParams.get("fromDate")), toDate: optionalString(url.searchParams.get("toDate")) }; }
function optionalString(value: string | null) { return value?.trim() || undefined; }
function boundedPageSize(value:string|null){const size=integerParam(value,50);if(size>200)throw new HttpError("Page size cannot exceed 200",400);return size;}
function requireQueue(operations:StudioOperations){if(!operations.queue)throw new HttpError("Durable production queue is not configured. Set DATABASE_URL, run `npm run db:migrate`, and restart the studio.",503);return operations.queue;}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!header) return undefined; const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new HttpError("Invalid byte range", 416);
  const suffix = !match[1] ? Number(match[2]) : undefined; const start = suffix !== undefined ? Math.max(0, size - suffix) : Number(match[1]);
  const end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new HttpError("Requested byte range is not satisfiable", 416);
  return { start, end: Math.min(end, size - 1) };
}

export function statusFor(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof SourceOperationError) return error.status;
  if (error instanceof z.ZodError) return 400;
  if (error instanceof JobConflictError || /locked by PID|already has active job/.test(String(error))) return 409;
  if (error instanceof QueueConflictError) return 409;
  if (error instanceof QueueNotFoundError) return 404;
  if (error instanceof SummaryArtifactNotFoundError) return 404;
  if (error instanceof SceneError) return 400;
  if (/already exists/.test(String(error))) return 409;
  if (/Confirmation|Unsafe backup|invalid ZIP|Backup must|Cover must|Select between|Select a |Chapter folder|Only HTTPS|exceeds the .* limit|Duplicate chapter|Entity merge|Merge must|requires a manual Story Bible correction|does not contain a canonical status|Story context maxCharacters/.test(String(error))) return 400;
  if (/not found|does not exist/.test(String(error)) || errorCodeInChain(error, "ENOENT")) return 404;
  if (error instanceof ConfigurationError || error instanceof BatchValidationError) return 422;
  if (error instanceof WebHttpError) return isTimeout(error) ? 504 : 502;
  if (error instanceof ProviderError) return isTimeout(error) ? 504 : 502;
  if (error instanceof StorageError) return 500;
  return 500;
}

function errorCodeInChain(error: unknown, code: string) { let current: unknown = error; const seen = new Set<unknown>(); while (current && typeof current === "object" && !seen.has(current)) { seen.add(current); if ((current as { code?: unknown }).code === code) return true; current = (current as { cause?: unknown }).cause; } return false; }

/** A deliberately small, value-free validation contract for every editable API route. */
export function validationIssues(error: unknown): Array<{ path: string; message: string; code: string }> | undefined {
  const validation = findZodError(error);
  if (!validation) return undefined;
  return validation.issues.slice(0, 25).map((issue) => ({
    path: issue.path.map(String).join(".") || "form",
    message: issue.message.replace(/[\r\n]+/g, " ").slice(0, 300),
    code: issue.code,
  }));
}

function findZodError(error: unknown): z.ZodError | undefined {
  let current = error;
  for (let depth = 0; current && depth < 8; depth++) {
    if (current instanceof z.ZodError) return current;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}
function isTimeout(error: unknown) { for (let value: unknown = error, depth = 0; value && depth < 8; depth++, value = typeof value === "object" ? (value as { cause?: unknown }).cause : undefined) if (value instanceof Error && /timeout|timed out/i.test(`${value.name} ${value.message}`)) return true; return false; }

async function receiveUpload(request: IncomingMessage, root: string, limit: number) {
  const directory = join(root, ".ai-story-studio", "restore-uploads"); const path = join(directory, `${randomUUID()}.zip`); await mkdir(directory, { recursive: true }); const file = await open(path, "wx"); let size = 0; let complete = false;
  try { for await (const chunk of request) { const data = Buffer.from(chunk); size += data.length; if (size > limit) throw new HttpError("Backup upload exceeds the 4 GB limit", 413); await file.write(data); } if (!size) throw new HttpError("Backup upload is empty", 400); complete = true; return path; }
  finally { await file.close(); if (!complete) await rm(path, { force: true }); }
}

export function publicJob<T>(job: T, root: string): T { return redactLocalPaths(job, root) as T; }
function redactLocalPaths(value: unknown, root: string): unknown {
  if (typeof value === "string") { if (value.startsWith("/api/")) return value; if (isAbsolute(value)) return undefined; return value.includes(root) ? value.replaceAll(root, "[project]") : value; }
  if (Array.isArray(value)) return value.map((item) => redactLocalPaths(item, root)).filter((item) => item !== undefined);
  if (value && typeof value === "object") { const result: Record<string, unknown> = {}; for (const [key, item] of Object.entries(value)) { const safe = redactLocalPaths(item, root); if (safe !== undefined) result[key] = safe; } return result; }
  return value;
}
