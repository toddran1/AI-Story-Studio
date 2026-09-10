import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getAudioDashboard, getChapter, getChapterPage, getOutputsLibrary, getQaDashboard, getScenesDashboard, getStoryBibleView, getStoryDashboard, getStoryOverview, getVideoDashboard, listStories, updateStorySettings, chapterFilterSchema } from "./catalog.js";
import { JobConflictError } from "./job-manager.js";
import { StudioOperations } from "./operations.js";
import { exportPaths, previewPaths, sceneImagePath, storyPaths, videoExportPaths, voicePreviewPaths } from "../../src/storage/paths.js";
import { SceneManifest, sceneManifestSchema } from "../../src/scenes/types.js";
import { readJsonIfExists } from "../../src/storage/story-files.js";
import { BatchValidationError, ConfigurationError, ProviderError, StorageError } from "../../src/pipeline/errors.js";
import { WebHttpError } from "../../src/source/web/http-client.js";
import { logger } from "../../src/utils/logger.js";
import { loadLatestProduction } from "../../src/production/manifest.js";

const MAX_BODY_BYTES = 50_000_000;
const MAX_JSON_BYTES = 1_000_000;
class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }
const sourceInspectJsonSchema = z.object({
  url: z.url(), type: z.enum(["web", "fanqie"]).optional(), from: z.number().int().positive().optional(),
  to: z.number().int().positive().optional(), chapter: z.number().int().positive().optional(),
  splitChapters: z.boolean().optional(), allowGaps: z.boolean().optional(),
}).strict();

export function createApiHandler(operations: StudioOperations) {
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost"); if (!url.pathname.startsWith("/api/")) return false;
    try {
      validateLocalRequest(request);
      if (request.method === "GET" && url.pathname === "/api/health") return send(response, 200, { status: "ready", binding: "localhost", credentials: { openai: "server-only", gemini: "server-only", fish: "server-only" } });
      if (request.method === "GET" && url.pathname === "/api/stories") return send(response, 200, { stories: await listStories(operations.root) });
      if (request.method === "GET" && url.pathname === "/api/jobs") return send(response, 200, { jobs: operations.jobs.list() });

      const jobMatch = /^\/api\/jobs\/([a-f0-9-]+)$/.exec(url.pathname);
      if (jobMatch && request.method === "GET") { const job = operations.jobs.get(jobMatch[1]!); if (!job) return send(response, 404, { error: "Job not found" }); return send(response, 200, job); }
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
          if (closed || response.destroyed) return; response.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
          if (["completed", "failed", "paused"].includes(job.status)) { cleanup(); response.end(); }
        }) ?? (() => undefined);
        response.on("close", cleanup); return true;
      }

      const storyMatch = /^\/api\/stories\/([a-z0-9-]+)$/.exec(url.pathname);
      if (storyMatch && request.method === "GET") return send(response, 200, await getStoryOverview(operations.root, storyMatch[1]!));
      const dashboardMatch = /^\/api\/stories\/([a-z0-9-]+)\/dashboard$/.exec(url.pathname);
      if (dashboardMatch && request.method === "GET") return send(response, 200, await getStoryDashboard(operations.root, dashboardMatch[1]!));
      const outputsMatch = /^\/api\/stories\/([a-z0-9-]+)\/outputs$/.exec(url.pathname);
      if (outputsMatch && request.method === "GET") return send(response, 200, await getOutputsLibrary(operations.root, outputsMatch[1]!));
      const chapterList = /^\/api\/stories\/([a-z0-9-]+)\/chapters$/.exec(url.pathname);
      if (chapterList && request.method === "GET") return send(response, 200, await getChapterPage(operations.root, chapterList[1]!, {
        page: integerParam(url.searchParams.get("page"), 1), pageSize: integerParam(url.searchParams.get("pageSize"), 50),
        filter: chapterFilterSchema.parse(url.searchParams.get("filter") ?? "all"), query: url.searchParams.get("q") ?? undefined,
      }));
      const chapterMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)$/.exec(url.pathname);
      if (chapterMatch && request.method === "GET") return send(response, 200, await getChapter(operations.root, chapterMatch[1]!, Number(chapterMatch[2])));
      const chapterTextMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/text$/.exec(url.pathname);
      if (chapterTextMatch && request.method === "PUT") return send(response, 200, await operations.editChapterText(chapterTextMatch[1]!, Number(chapterTextMatch[2]), await jsonBody(request)));
      const audioMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/audio$/.exec(url.pathname);
      if (audioMatch && request.method === "GET") {
        const chapter = await getChapter(operations.root, audioMatch[1]!, Number(audioMatch[2]));
        if (!chapter.audioAvailable) return send(response, 404, { error: "Current chapter audio was not found" });
        return sendFile(request, response, storyPaths(operations.root, audioMatch[1]!, Number(audioMatch[2])).audio, "audio/mpeg");
      }
      const subtitleFileMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/subtitles\.(srt|vtt)$/.exec(url.pathname);
      if (subtitleFileMatch && request.method === "GET") { const chapter = await getChapter(operations.root, subtitleFileMatch[1]!, Number(subtitleFileMatch[2])); if (!chapter.subtitles) return send(response, 404, { error: "Chapter subtitles were not found" }); const paths = storyPaths(operations.root, subtitleFileMatch[1]!, Number(subtitleFileMatch[2])); return sendFile(request, response, subtitleFileMatch[3] === "srt" ? paths.subtitlesSrt : paths.subtitlesVtt, subtitleFileMatch[3] === "srt" ? "application/x-subrip" : "text/vtt; charset=utf-8"); }
      const chapterVideoMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/video$/.exec(url.pathname);
      if (chapterVideoMatch && request.method === "GET") { const chapter = await getChapter(operations.root, chapterVideoMatch[1]!, Number(chapterVideoMatch[2])); if (!chapter.videoUrl) return send(response, 404, { error: "Chapter video was not found" }); return sendFile(request, response, storyPaths(operations.root, chapterVideoMatch[1]!, Number(chapterVideoMatch[2])).video, "video/mp4"); }
      const sceneImageMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/scenes\/(scene-\d{3})\.png$/.exec(url.pathname);
      if (sceneImageMatch && request.method === "GET") { const raw = await readJsonIfExists<SceneManifest>(storyPaths(operations.root, sceneImageMatch[1]!, Number(sceneImageMatch[2])).scenesManifest); const manifest = raw ? sceneManifestSchema.safeParse(raw) : undefined; const scene = manifest?.success ? manifest.data.scenes.find((item) => item.id === sceneImageMatch[3]) : undefined; if (!scene || scene.artwork.status !== "complete") return send(response, 404, { error: "Scene artwork was not found" }); return sendFile(request, response, sceneImagePath(operations.root, sceneImageMatch[1]!, Number(sceneImageMatch[2]), sceneImageMatch[3]!), "image/png"); }
      const qaMatch = /^\/api\/stories\/([a-z0-9-]+)\/qa$/.exec(url.pathname);
      if (qaMatch && request.method === "GET") return send(response, 200, await getQaDashboard(operations.root, qaMatch[1]!));
      const audioDashboardMatch = /^\/api\/stories\/([a-z0-9-]+)\/audio$/.exec(url.pathname);
      if (audioDashboardMatch && request.method === "GET") return send(response, 200, await getAudioDashboard(operations.root, audioDashboardMatch[1]!));
      const videoDashboardMatch = /^\/api\/stories\/([a-z0-9-]+)\/video$/.exec(url.pathname);
      if (videoDashboardMatch && request.method === "GET") return send(response, 200, await getVideoDashboard(operations.root, videoDashboardMatch[1]!));
      const scenesDashboardMatch = /^\/api\/stories\/([a-z0-9-]+)\/scenes$/.exec(url.pathname);
      if (scenesDashboardMatch && request.method === "GET") return send(response, 200, await getScenesDashboard(operations.root, scenesDashboardMatch[1]!, optionalInteger(url.searchParams.get("chapter"))));
      const productionMatch = /^\/api\/stories\/([a-z0-9-]+)\/production$/.exec(url.pathname);
      if (productionMatch && request.method === "GET") return send(response, 200, { latest: await loadLatestProduction(operations.root, productionMatch[1]!) });
      const productionPlanMatch = /^\/api\/stories\/([a-z0-9-]+)\/production\/plan$/.exec(url.pathname);
      if (productionPlanMatch && request.method === "POST") return send(response, 200, await operations.productionPlan(productionPlanMatch[1]!, await jsonBody(request)));
      const scenesEditMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/scenes$/.exec(url.pathname);
      if (scenesEditMatch && request.method === "PUT") { const input = z.object({ scenes: z.array(z.unknown()) }).strict().parse(await jsonBody(request)); return send(response, 200, { manifest: await operations.updateScenes(scenesEditMatch[1]!, Number(scenesEditMatch[2]), input.scenes) }); }
      const artworkReviewMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/scenes\/(scene-\d{3})\/review$/.exec(url.pathname);
      if (artworkReviewMatch && request.method === "POST") { const input = z.object({ review: z.enum(["unreviewed", "approved", "rejected", "needs-regeneration"]) }).strict().parse(await jsonBody(request)); return send(response, 200, { manifest: await operations.reviewArtwork(artworkReviewMatch[1]!, Number(artworkReviewMatch[2]), artworkReviewMatch[3]!, input.review) }); }
      const exportMatch = /^\/api\/stories\/([a-z0-9-]+)\/exports\/(\d+)-(\d+)\.(mp3|m4b)$/.exec(url.pathname);
      if (exportMatch && request.method === "GET") {
        const from = Number(exportMatch[2]); const to = Number(exportMatch[3]); const format = exportMatch[4] as "mp3" | "m4b";
        if (to < from) throw new HttpError("Invalid export range", 400);
        return sendFile(request, response, exportPaths(operations.root, exportMatch[1]!, from, to, format).output, format === "m4b" ? "audio/mp4" : "audio/mpeg");
      }
      const videoExportMatch = /^\/api\/stories\/([a-z0-9-]+)\/video-exports\/(\d+)-(\d+)\.mp4$/.exec(url.pathname);
      if (videoExportMatch && request.method === "GET") { const from = Number(videoExportMatch[2]); const to = Number(videoExportMatch[3]); if (to < from) throw new HttpError("Invalid video export range", 400); return sendFile(request, response, videoExportPaths(operations.root, videoExportMatch[1]!, from, to).output, "video/mp4"); }
      const bibleMatch = /^\/api\/stories\/([a-z0-9-]+)\/story-bible$/.exec(url.pathname);
      if (bibleMatch && request.method === "GET") return send(response, 200, await getStoryBibleView(operations.root, bibleMatch[1]!));
      if (bibleMatch && request.method === "POST") return send(response, 201, await operations.addBibleEntry(bibleMatch[1]!, await jsonBody(request)));
      const bibleEntryMatch = /^\/api\/stories\/([a-z0-9-]+)\/story-bible\/([a-f0-9-]+|auto-[a-f0-9]+)$/.exec(url.pathname);
      if (bibleEntryMatch && request.method === "PUT") return send(response, 200, await operations.updateBibleEntry(bibleEntryMatch[1]!, bibleEntryMatch[2]!, await jsonBody(request)));
      if (bibleEntryMatch && request.method === "DELETE") return send(response, 200, await operations.deleteBibleEntry(bibleEntryMatch[1]!, bibleEntryMatch[2]!));
      const settingsMatch = /^\/api\/stories\/([a-z0-9-]+)\/settings$/.exec(url.pathname);
      if (settingsMatch && request.method === "PUT") return send(response, 200, { story: await updateStorySettings(operations.root, settingsMatch[1]!, await jsonBody(request)) });

      const inspectMatch = /^\/api\/stories\/([a-z0-9-]+)\/source\/inspect$/.exec(url.pathname);
      if (inspectMatch && request.method === "POST") {
        const contentType = request.headers["content-type"] ?? "";
        if (contentType.includes("application/json")) return send(response, 200, await operations.inspectSource(sourceInspectJsonSchema.parse(await jsonBody(request))));
        const file = await body(request); const filename = request.headers["x-file-name"];
        return send(response, 200, await operations.inspectSource({ file, filename: typeof filename === "string" ? decodeURIComponent(filename) : undefined,
          type: optionalString(url.searchParams.get("type")) as never, chapter: optionalInteger(url.searchParams.get("chapter")), splitChapters: url.searchParams.get("split") === "true", allowGaps: url.searchParams.get("allowGaps") === "true" }));
      }
      const importMatch = /^\/api\/stories\/([a-z0-9-]+)\/source\/import$/.exec(url.pathname);
      if (importMatch && request.method === "POST") { const input = z.object({ inspectionId: z.string().uuid(), allowGaps: z.boolean().default(false) }).parse(await jsonBody(request)); return send(response, 200, await operations.importInspection(importMatch[1]!, input.inspectionId, input.allowGaps)); }
      const batchMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/batch$/.exec(url.pathname);
      if (batchMatch && request.method === "POST") return send(response, 202, operations.startBatch(batchMatch[1]!, await jsonBody(request)));
      const previewMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/preview$/.exec(url.pathname);
      if (previewMatch && request.method === "POST") return send(response, 202, operations.startPreview(previewMatch[1]!, await jsonBody(request)));
      const audioJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/audio$/.exec(url.pathname);
      if (audioJobMatch && request.method === "POST") return send(response, 202, operations.startAudio(audioJobMatch[1]!, await jsonBody(request)));
      const audiobookJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/audiobook$/.exec(url.pathname);
      if (audiobookJobMatch && request.method === "POST") return send(response, 202, operations.startAudiobook(audiobookJobMatch[1]!, await jsonBody(request)));
      const subtitleJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/subtitles$/.exec(url.pathname);
      if (subtitleJobMatch && request.method === "POST") return send(response, 202, operations.startSubtitles(subtitleJobMatch[1]!, await jsonBody(request)));
      const videoJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/video$/.exec(url.pathname);
      if (videoJobMatch && request.method === "POST") return send(response, 202, operations.startVideo(videoJobMatch[1]!, await jsonBody(request)));
      const videoExportJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/video-export$/.exec(url.pathname);
      if (videoExportJobMatch && request.method === "POST") return send(response, 202, operations.startVideoExport(videoExportJobMatch[1]!, await jsonBody(request)));
      const scenesJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/scenes$/.exec(url.pathname);
      if (scenesJobMatch && request.method === "POST") return send(response, 202, operations.startScenes(scenesJobMatch[1]!, await jsonBody(request)));
      const artworkJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/artwork$/.exec(url.pathname);
      if (artworkJobMatch && request.method === "POST") return send(response, 202, operations.startArtwork(artworkJobMatch[1]!, await jsonBody(request)));
      const productionJobMatch = /^\/api\/stories\/([a-z0-9-]+)\/jobs\/production$/.exec(url.pathname);
      if (productionJobMatch && request.method === "POST") return send(response, 202, operations.startProduction(productionJobMatch[1]!, await jsonBody(request)));
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
      if (status >= 500) logger.error({ event: "web.api.failed", method: request.method, path: url.pathname, status, error: error instanceof Error ? error.message : String(error) });
      return send(response, status, { error: error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error) });
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
async function jsonBody(request: IncomingMessage): Promise<unknown> { const raw = await body(request, MAX_JSON_BYTES); if (!raw.length) return {}; try { return JSON.parse(raw.toString("utf8")); } catch { throw new HttpError("Request body must be valid JSON", 400); } }
function integerParam(value: string | null, fallback: number) { if (value === null) return fallback; const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new Error("Pagination values must be positive integers"); return number; }
function optionalInteger(value: string | null) { if (value === null) return undefined; return integerParam(value, 1); }
function optionalString(value: string | null) { return value?.trim() || undefined; }

function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!header) return undefined; const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new HttpError("Invalid byte range", 416);
  const suffix = !match[1] ? Number(match[2]) : undefined; const start = suffix !== undefined ? Math.max(0, size - suffix) : Number(match[1]);
  const end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new HttpError("Requested byte range is not satisfiable", 416);
  return { start, end: Math.min(end, size - 1) };
}

function statusFor(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof z.ZodError) return 400;
  if (error instanceof JobConflictError || /locked by PID|already has active job/.test(String(error))) return 409;
  if (/not found|does not exist/.test(String(error))) return 404;
  if (error instanceof ConfigurationError || error instanceof BatchValidationError) return 422;
  if (error instanceof WebHttpError) return isTimeout(error) ? 504 : 502;
  if (error instanceof ProviderError) return isTimeout(error) ? 504 : 502;
  if (error instanceof StorageError) return 500;
  return 500;
}
function isTimeout(error: unknown) { for (let value: unknown = error, depth = 0; value && depth < 8; depth++, value = typeof value === "object" ? (value as { cause?: unknown }).cause : undefined) if (value instanceof Error && /timeout|timed out/i.test(`${value.name} ${value.message}`)) return true; return false; }
