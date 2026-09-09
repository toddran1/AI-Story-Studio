import { readFile } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getChapter, getChapterPage, getQaDashboard, getStoryBible, getStoryOverview, listStories, updateStorySettings, chapterFilterSchema } from "./catalog.js";
import { JobConflictError } from "./job-manager.js";
import { StudioOperations } from "./operations.js";
import { previewPaths, storyPaths } from "../../src/storage/paths.js";

const MAX_BODY_BYTES = 50_000_000;
const sourceInspectJsonSchema = z.object({
  url: z.url(), type: z.enum(["web", "fanqie"]).optional(), from: z.number().int().positive().optional(),
  to: z.number().int().positive().optional(), chapter: z.number().int().positive().optional(),
  splitChapters: z.boolean().optional(), allowGaps: z.boolean().optional(),
}).strict();

export function createApiHandler(operations: StudioOperations) {
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost"); if (!url.pathname.startsWith("/api/")) return false;
    try {
      if (request.method === "GET" && url.pathname === "/api/health") return send(response, 200, { status: "ready", binding: "localhost", credentials: { openai: "server-only", gemini: "server-only", fish: "server-only" } });
      if (request.method === "GET" && url.pathname === "/api/stories") return send(response, 200, { stories: await listStories(operations.root) });
      if (request.method === "GET" && url.pathname === "/api/jobs") return send(response, 200, { jobs: operations.jobs.list() });

      const jobMatch = /^\/api\/jobs\/([a-f0-9-]+)$/.exec(url.pathname);
      if (jobMatch && request.method === "GET") { const job = operations.jobs.get(jobMatch[1]!); if (!job) return send(response, 404, { error: "Job not found" }); return send(response, 200, job); }
      const pauseMatch = /^\/api\/jobs\/([a-f0-9-]+)\/pause$/.exec(url.pathname);
      if (pauseMatch && request.method === "POST") return operations.jobs.pause(pauseMatch[1]!) ? send(response, 202, { status: "pause_requested" }) : send(response, 409, { error: "Job is not running or cannot be paused" });
      const eventMatch = /^\/api\/jobs\/([a-f0-9-]+)\/events$/.exec(url.pathname);
      if (eventMatch && request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        const unsubscribe = operations.jobs.subscribe(eventMatch[1]!, (job) => { response.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`); if (["completed", "failed", "paused"].includes(job.status)) response.end(); });
        if (!unsubscribe) { response.end(); return true; } request.on("close", unsubscribe); return true;
      }

      const storyMatch = /^\/api\/stories\/([a-z0-9-]+)$/.exec(url.pathname);
      if (storyMatch && request.method === "GET") return send(response, 200, await getStoryOverview(operations.root, storyMatch[1]!));
      const chapterList = /^\/api\/stories\/([a-z0-9-]+)\/chapters$/.exec(url.pathname);
      if (chapterList && request.method === "GET") return send(response, 200, await getChapterPage(operations.root, chapterList[1]!, {
        page: integerParam(url.searchParams.get("page"), 1), pageSize: integerParam(url.searchParams.get("pageSize"), 50),
        filter: chapterFilterSchema.parse(url.searchParams.get("filter") ?? "all"), query: url.searchParams.get("q") ?? undefined,
      }));
      const chapterMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)$/.exec(url.pathname);
      if (chapterMatch && request.method === "GET") return send(response, 200, await getChapter(operations.root, chapterMatch[1]!, Number(chapterMatch[2])));
      const audioMatch = /^\/api\/stories\/([a-z0-9-]+)\/chapters\/(\d+)\/audio$/.exec(url.pathname);
      if (audioMatch && request.method === "GET") return sendFile(response, storyPaths(operations.root, audioMatch[1]!, Number(audioMatch[2])).audio, "audio/mpeg");
      const qaMatch = /^\/api\/stories\/([a-z0-9-]+)\/qa$/.exec(url.pathname);
      if (qaMatch && request.method === "GET") return send(response, 200, await getQaDashboard(operations.root, qaMatch[1]!));
      const bibleMatch = /^\/api\/stories\/([a-z0-9-]+)\/story-bible$/.exec(url.pathname);
      if (bibleMatch && request.method === "GET") return send(response, 200, await getStoryBible(operations.root, bibleMatch[1]!));
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
      const previewResult = /^\/api\/stories\/([a-z0-9-]+)\/previews\/([A-Za-z0-9T_-]+)$/.exec(url.pathname);
      if (previewResult && request.method === "GET") return send(response, 200, await operations.getPreview(previewResult[1]!, previewResult[2]!));
      const previewAudio = /^\/api\/stories\/([a-z0-9-]+)\/previews\/([A-Za-z0-9T_-]+)\/audio-([ab])$/.exec(url.pathname);
      if (previewAudio && request.method === "GET") { const paths = previewPaths(operations.root, previewAudio[1]!, previewAudio[2]!); return sendFile(response, previewAudio[3] === "a" ? paths.audioA : paths.audioB, "audio/mpeg"); }
      const profileMatch = /^\/api\/stories\/([a-z0-9-]+)\/profile$/.exec(url.pathname);
      if (profileMatch && request.method === "POST") { const input = z.object({ previewId: z.string(), choice: z.enum(["a", "b"]) }).parse(await jsonBody(request)); return send(response, 200, { story: await operations.selectPreview(profileMatch[1]!, input.previewId, input.choice) }); }
      const refreshMatch = /^\/api\/stories\/([a-z0-9-]+)\/source\/refresh$/.exec(url.pathname);
      if (refreshMatch && request.method === "POST") { const input = z.object({ importNew: z.boolean().default(false) }).parse(await jsonBody(request)); return send(response, 200, await operations.refreshRemote(refreshMatch[1]!, input.importNew)); }
      return send(response, 404, { error: "API route not found" });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof JobConflictError || /locked by PID|already has active job/.test(String(error)) ? 409 : /not found|does not exist/.test(String(error)) ? 404 : 400;
      return send(response, status, { error: error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error) });
    }
  };
}

function send(response: ServerResponse, status: number, value: unknown): true { const output = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(output), "cache-control": "no-store" }); response.end(output); return true; }
async function sendFile(response: ServerResponse, path: string, contentType: string): Promise<true> { try { const data = await readFile(path); response.writeHead(200, { "content-type": contentType, "content-length": data.length, "cache-control": "no-store" }); response.end(data); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return send(response, 404, { error: "File not found" }); throw error; } return true; }
async function body(request: IncomingMessage): Promise<Buffer> { const parts: Buffer[] = []; let size = 0; for await (const chunk of request) { const part = Buffer.from(chunk); size += part.length; if (size > MAX_BODY_BYTES) throw new Error("Request body exceeds 50 MB"); parts.push(part); } return Buffer.concat(parts); }
async function jsonBody(request: IncomingMessage): Promise<unknown> { const raw = await body(request); if (!raw.length) return {}; try { return JSON.parse(raw.toString("utf8")); } catch { throw new Error("Request body must be valid JSON"); } }
function integerParam(value: string | null, fallback: number) { if (value === null) return fallback; const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new Error("Pagination values must be positive integers"); return number; }
function optionalInteger(value: string | null) { if (value === null) return undefined; return integerParam(value, 1); }
function optionalString(value: string | null) { return value?.trim() || undefined; }
