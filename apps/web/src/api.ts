export type ErrorDiagnostic = { id:string;timestamp:string;summary:string;category:"transient"|"rate_limit"|"configuration"|"content_qa"|"permanent";retryable:boolean;recommendedAction:string;chapter?:number;stage?:string;provider?:string;code?:string;technicalDetails?:string;issues?:Array<{category:string;severity:string;message:string;evidence?:string}> };
export type ApiValidationIssue = { path: string; message: string; code?: string };
export class ApiError extends Error { constructor(message: string, public readonly diagnostic?: ErrorDiagnostic, public readonly validation?: ApiValidationIssue[]) { super(formatApiError(message, diagnostic, validation)); this.name = "ApiError"; } }
export function formatDiagnostic(diagnostic: ErrorDiagnostic) { return `${diagnostic.summary}\nNext: ${diagnostic.recommendedAction}\nReference: ${diagnostic.id}`; }
export function formatApiError(message: string, diagnostic?: ErrorDiagnostic, validation?: ApiValidationIssue[]) {
  const fields = validation?.length ? `Please correct:\n${validation.map((issue) => `• ${issue.path}: ${issue.message}`).join("\n")}` : undefined;
  return [message, fields, diagnostic ? formatDiagnostic(diagnostic) : undefined].filter(Boolean).join("\n");
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const binary = options?.body instanceof ArrayBuffer || (typeof Blob !== "undefined" && options?.body instanceof Blob);
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...options, headers: { ...(binary ? {} : { "content-type": "application/json" }), ...options?.headers } }); }
  catch (cause) { throw new ApiError("Cannot reach the local Story Studio service. Confirm `npm run web` is running, then try again.", undefined, undefined); }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(typeof value.error === "string" ? value.error : `Request failed (${response.status})`, value.diagnostic, parseValidationIssues(value.validation));
  return value as T;
}

function parseValidationIssues(value: unknown): ApiValidationIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues = value.filter((item): item is ApiValidationIssue => Boolean(item) && typeof item === "object" && typeof (item as ApiValidationIssue).path === "string" && typeof (item as ApiValidationIssue).message === "string").slice(0, 25);
  return issues.length ? issues : undefined;
}

export function post<T>(path: string, body: unknown) { return api<T>(path, { method: "POST", body: JSON.stringify(body) }); }
export function put<T>(path: string, body: unknown) { return api<T>(path, { method: "PUT", body: JSON.stringify(body) }); }
export function del<T>(path: string) { return api<T>(path, { method: "DELETE", body: JSON.stringify({}) }); }

export type StoryConfig = {
  slug: string; title: string; author?: string; description: string; tags: string[]; notes: string; defaultProductionProfile: "audio" | "audiobook" | "story-video" | "everything"; sourceLanguage: string; outputLanguage: string; source: { type: string; url?: string };
  context: { recentChapterSummaries: number };
  audio: AudioSettings;
  subtitles: SubtitleSettings; video: VideoSettings; scenes: SceneSettings; artwork: ArtworkSettings;
  pipeline: { translation: Model; narration: Model; qa: Model; storyBible: Model; scenePlanner: Model; tts: FishTtsConfig };
  productionProfiles: Record<string, { outputs: Array<"audio" | "audiobook" | "video">; artwork: boolean; repairQa: boolean; audiobookFormat: "mp3" | "m4b" }>;
};
export type AudioSettings = { loudnessTarget: number; truePeak: number; segmentGapSeconds: number; chapterGapSeconds: number; format: "mp3"; bitrate: "64k" | "96k" | "128k" | "160k" | "192k" | "256k" | "320k"; sampleRate: 32000 | 44100 | 48000 };
export type SubtitleSettings = { maxCharactersPerLine: number; maxLines: number; minimumDurationSeconds: number; maximumDurationSeconds: number };
export type VideoSettings = { width: number; height: number; fps: 24 | 25 | 30 | 60; codec: "libx264"; quality: number; subtitleMode: "none" | "burn" | "soft" | "both"; subtitleStyle: "default" | "large" | "minimal"; backgroundMode: "cover" | "gradient" | "kenBurns"; introDurationSeconds: number };
export type SceneSettings = { targetDurationSeconds: number; minimumDurationSeconds: number; maximumDurationSeconds: number; maximumScenesPerChapter: number };
export type ArtworkSettings = { provider: "openai"; model: string; stylePrompt: string; aspectRatio: "16:9"; quality: "low" | "medium" | "high"; size: "1536x1024" | "1024x1024" | "1024x1536"; outputFormat: "png" };
export type SceneArtwork = { status: "pending" | "running" | "complete" | "failed"; review: "unreviewed" | "approved" | "rejected" | "needs-regeneration"; provider?: string; model?: string; fingerprint?: string; imageFingerprint?: string; generatedAt?: string; error?: string };
export type Scene = { id: string; summary: string; startSeconds: number; endSeconds: number; characters: string[]; location?: string; visualPrompt: string; importance: "transition" | "standard" | "major"; artwork: SceneArtwork; imageUrl?: string };
export type SceneManifest = { version: 1; chapter: number; durationSeconds: number; planningFingerprint: string; manualRevision: number; manuallyEdited: boolean; updatedAt: string; scenes: Scene[] };
export type ScenesDashboard = { settings: SceneSettings; artwork: ArtworkSettings; planner: Model; selectedChapter?: number; chapters: Array<{ chapter: number; title?: string; durationSeconds?: number; sceneStatus: string; artworkStatus: string }>; counts: { chapters: number; planned: number; artworkReady: number }; manifest?: SceneManifest };
export type AudioDashboard = { settings: AudioSettings; chapters: Array<{ chapter: number; title?: string; status: string; durationSeconds?: number; audioAvailable: boolean }>; counts: { total: number; mastered: number }; totalDurationSeconds: number; exports: Array<{ fingerprint: string; from: number; to: number; format: "mp3" | "m4b"; createdAt: string; durationSeconds: number; downloadUrl: string }> };
export type VideoDashboard = { settings: VideoSettings; subtitleSettings: SubtitleSettings; background: { coverAvailable: boolean; coverName?: string; effectiveMode: string }; counts: { total: number; mastered: number; subtitles: number; videos: number }; chapters: Array<{ chapter: number; title?: string; durationSeconds?: number; subtitleStatus: string; videoStatus: string; videoAvailable: boolean }>; exports: Array<{ fingerprint: string; from: number; to: number; createdAt: string; durationSeconds: number; downloadUrl: string }> };
export type Model = { provider: "openai" | "gemini"; model: string };
export type FishTtsConfig = { provider: "fish"; model: string; referenceId?: string; speed: number; format: "mp3"; sampleRate: number; bitrate: number; normalize: boolean; maxCharsPerRequest: number };
export type StoryCard = { slug: string; title: string; author?: string; description: string; tags: string[]; sourceType: string; sourceUrl?: string; sourceLanguage: string; outputLanguage: string; importedChapters: number; processedChapters: number; latestProcessedChapter?: number; qa: Counts; progress: number; coverUrl?: string; updatedAt: string; recentActivity?: { type: string; message: string; at: string }; projectBytes: number; hasAudiobook: boolean; hasVideo: boolean };
export type Counts = { pass: number; warn: number; fail: number };
export type ChapterRow = { chapter: number; originalTitle?: string; translation: string; narration: string; qa?: "pass" | "warn" | "fail"; qaScore?: number; tts: string; audioMastering: string; alignment: string; subtitles: string; durationSeconds?: number; audioAvailable: boolean };
export type QaResult = { status: "pass" | "warn" | "fail"; score: number; issues: Array<{ category: string; severity: "warn" | "fail"; message: string; evidence: string }>; checks: Record<string, "pass" | "warn" | "fail"> };
export type Job = { id: string; type: string; story: string; status: "queued" | "running" | "completed" | "failed" | "paused"; progress?: any; result?: any; error?: string; diagnostic?: ErrorDiagnostic };
export type ProductionPlan = { story: string; from: number; to: number; chapters: number[]; requiredChapters: number[]; chapterRequirements: Record<string,string[]>; outputs: string[]; artwork: boolean; stages: string[]; counts: Record<string, { required: number; reusable: number }>; estimates: { llmOperations: number; ttsOperations: number; imageOperations: number; imagesPendingPlanning: number }; finalOutputs: string[]; costEstimate?: {classification:string;estimatedUsd?:number;lowUsd?:number;highUsd?:number;confidence:string;assumptions:string[];unknownStages:string[];breakdown:Array<{stage:string;required:number;estimatedUsd?:number;basis:string}>} };
export type CostAnalytics = {summary:{totalCostUsd:number;requests:number;successful:number;failed:number;retries:number;inputTokens:number;cachedInputTokens:number;outputTokens:number;inputUtf8Bytes:number;images:number;unpricedRequests:number};dimensions:Array<{stage:string;provider:string;model:string;requests:number;costUsd:number;inputTokens:number;outputTokens:number;inputUtf8Bytes:number;images:number;failures:number}>;chapters:Array<{chapter?:number;requests:number;costUsd:number;unpriced:number}>};
export type QueueJob = { id:string;story:string;from:number;to:number;profile?:string;status:string;pauseRequested:boolean;cancelRequested:boolean;currentChapter?:number;currentStage?:string;totalItems:number;completedItems:number;warningItems:number;reviewItems:number;failedItems:number;errorSummary?:string;createdAt:string;startedAt?:string;updatedAt:string;completedAt?:string };
export type QueueWorkItem = { id:string;jobId:string;story:string;chapter:number;ordinal:number;status:string;currentStage?:string;attemptCount:number;maxAttempts:number;lastError?:string;errorCategory?:string;nextRetryAt?:string;lastAttemptAt?:string;reused:boolean;qaStatus?:string };
export type QueueEvent = { id:string;jobId:string;workItemId?:string;type:string;message:string;data:Record<string,unknown>;createdAt:string };
export type QueuePage<T> = {items:T[];page:number;pageSize:number;total:number;pages:number};
export type ProductionManifest = { id: string; status: string; selection: { from: number; to: number }; options: { outputs: string[]; artwork: boolean; repairQa: boolean; refresh: boolean; audiobookFormat: string; force?: string; profile?: string; dryRun: boolean }; current: { chapter?: number; stage?: string }; chapters: Record<string, { chapter: number; status: string; qa?: string; warning?: string; operations: Record<string, { status: string; reused: boolean; startedAt?: string; completedAt?: string; error?: string }> }>; failures: Array<{ chapter?: number; stage: string; message: string }>; summary: { chapters: number; completed: number; needsReview: number; failed: number; reusedStages: number; newStages: number; qaWarnings: number; qaFailures: number; exports: Record<string, string>; elapsedMs: number } };
export type StoryDashboard = { story: StoryConfig; counts: Counts & { chapters: number; complete: number; minChapter?: number; maxChapter?: number }; source?: { type: string; origin: unknown; importedAt: string; chapterCount: number }; progress: { processed: number; audio: number; artwork: number; video: number }; latestProduction?: ProductionManifest; currentProfile?: string; estimatedRemainingStages: number };
export type OutputItem = { id: string; group: "chapterAudio" | "audiobooks" | "chapterVideos" | "combinedVideos" | "subtitles" | "artwork"; chapter?: number; from?: number; to?: number; format: string; createdAt: string; bytes: number; durationSeconds?: number; url: string };
