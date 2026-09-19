export type ErrorDiagnostic = { id:string;timestamp:string;summary:string;category:"transient"|"rate_limit"|"configuration"|"content_qa"|"permanent";retryable:boolean;recommendedAction:string;chapter?:number;stage?:string;provider?:string;model?:string;code?:string;technicalDetails?:string;issues?:Array<{category:string;severity:string;message:string;evidence?:string}>;qaDependencyFingerprint?:string };
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

export type ResolvedModelRouting = {
  provider: "openai" | "gemini" | "kimi";
  model: string;
  source: "override" | "studio_default" | "environment_fallback";
  stage: string;
  ready: boolean;
  reason?: string;
};

export type StoryConfig = {
  slug: string; title: string; author?: string; description: string; tags: string[]; notes: string; defaultProductionProfile: "audio" | "audiobook" | "story-video" | "everything"; sourceLanguage: string; outputLanguage: string; source: { type: string; url?: string };
  metadataTranslationSource?: { title: string; author?: string; description?: string; tags?: string[]; language: string }; metadataTranslatedAt?: string;
  sources: Array<{ provider: string; bookId: string; url: string; title?: string; author?: string; addedAt: string; lastInspectedAt?: string; priority: number; enabled: boolean }>;
  context: { recentChapterSummaries: number };
  qaMode: "production" | "thorough";
  narrationSettings: { profanityMode: "preserve" | "soften-strong"; bleepStrongProfanity: boolean; includeChapterTitle?: boolean };
  audio: AudioSettings;
  subtitles: SubtitleSettings; video: VideoSettings; scenes: SceneSettings; artwork: ArtworkSettings;
  pipeline: { translation: Model; narration: Model; qa: Model; storyBible: Model; scenePlanner: Model; tts: FishTtsConfig };
  pipelineOverrides?: Record<string, boolean>;
  productionProfiles: Record<string, { outputs: Array<"audio" | "audiobook" | "video">; artwork: boolean; repairQa: boolean; audiobookFormat: "mp3" | "m4b" }>;
};
export type AudioSettings = { loudnessTarget: number; truePeak: number; segmentGapSeconds: number; chapterGapSeconds: number; format: "mp3"; bitrate: "64k" | "96k" | "128k" | "160k" | "192k" | "256k" | "320k"; sampleRate: 32000 | 44100 | 48000 };
export type SubtitleSettings = { maxCharactersPerLine: number; maxLines: number; minimumDurationSeconds: number; maximumDurationSeconds: number };
export type VideoSettings = { width: number; height: number; fps: 24 | 25 | 30 | 60; codec: "libx264"; quality: number; subtitleMode: "none" | "burn" | "soft" | "both"; subtitleStyle: "default" | "large" | "minimal"; backgroundMode: "cover" | "gradient" | "kenBurns"; introDurationSeconds: number };
export type SceneSettings = { targetDurationSeconds: number; minimumDurationSeconds: number; maximumDurationSeconds: number; maximumScenesPerChapter: number };
export type ArtworkSettings = { provider: "openai" | "gemini"; model: string; stylePrompt: string; aspectRatio: "16:9" | "1:1" | "9:16"; quality: "low" | "medium" | "high"; size: "1536x1024" | "1024x1024" | "1024x1536"; outputFormat: "png" };
export type ArtworkRouting = { provider: string; model: string; availableProviders: Array<{ name: string; models: string[]; defaultModel: string }> };
// Mirrors the server IMAGE_PROVIDER_CATALOG; used where artworkRouting is unavailable (e.g. the settings page).
export const ARTWORK_PROVIDERS: ArtworkRouting["availableProviders"] = [
  { name: "openai", models: ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-1", "gpt-image-1-mini"], defaultModel: "gpt-image-2.5-flare" },
  { name: "gemini", models: ["gemini-3.1-flash-image"], defaultModel: "gemini-3.1-flash-image" },
];
export type VisualRole =
  | "front"
  | "three_quarter"
  | "side"
  | "back"
  | "full_body"
  | "face_portrait"
  | "expression_sheet"
  | "outfit_sheet"
  | "equipment_reference"
  | "environment_reference"
  | "general_reference";

export type VisualReferenceImage = {
  id: string;
  entityId: string;
  role: VisualRole;
  imagePath: string;
  createdAt: string;
  source: "generated" | "uploaded" | "style_sheet";
  approved: boolean;
  prompt?: string;
  provenance?: Record<string, unknown>;
  imageUrl?: string;
};

export type VisualEntityType =
  | "character"
  | "creature"
  | "location"
  | "item"
  | "weapon"
  | "object"
  | "faction"
  | "vehicle"
  | "other";

export type VisualProfileStatus = "draft" | "approved";

export type CharacterVisualDetails = {
  apparentAge?: string;
  gender?: string;
  height?: string;
  build?: string;
  skinTone?: string;
  faceShape?: string;
  eyeColor?: string;
  hairColor?: string;
  hairstyle?: string;
  facialHair?: string;
  distinguishingFeatures?: string;
  scars?: string;
  tattoos?: string;
  defaultOutfit?: string;
  shoes?: string;
  accessories?: string;
  weapons?: string;
  equipment?: string;
  additionalAppearanceNotes?: string;
};

export type LocationVisualDetails = {
  environmentDescription?: string;
  architecture?: string;
  terrain?: string;
  vegetation?: string;
  weatherTendencies?: string;
  lighting?: string;
  atmosphere?: string;
  colorPalette?: string;
  recurringLandmarks?: string;
  canonicalEnvironmentPrompt?: string;
};

export type CreatureVisualDetails = {
  species?: string;
  scale?: string;
  anatomy?: string;
  coloration?: string;
  eyes?: string;
  armorFur?: string;
  distinguishingFeatures?: string;
  sizeRelativeToHuman?: string;
  canonicalCreaturePrompt?: string;
};

export type ItemVisualDetails = {
  shape?: string;
  materials?: string;
  dimensions?: string;
  color?: string;
  ornamentation?: string;
  wearDamage?: string;
  magicalEffects?: string;
  canonicalObjectPrompt?: string;
};

export type VisualVariant = {
  id: string;
  name: string;
  description?: string;
  defaultOutfit?: string;
  visualPrompt?: string;
};

export type VisualEntityProfile = {
  id: string;
  entityId: string;
  visualType: VisualEntityType;
  status: VisualProfileStatus;
  appearance: string;
  visualPrompt: string;
  negativePrompt: string;
  notes: string;
  character?: CharacterVisualDetails;
  location?: LocationVisualDetails;
  creature?: CreatureVisualDetails;
  item?: ItemVisualDetails;
  variants: VisualVariant[];
  references: VisualReferenceImage[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
};

export type ArtStyleOption =
  | "Cinematic anime"
  | "Manhwa"
  | "Manga"
  | "Semi-realistic"
  | "Photorealistic"
  | "Illustration"
  | "Custom";

export type ArtDirectionPreset = {
  id: string;
  name: string;
  isDefault: boolean;
  artStyle: ArtStyleOption;
  customStylePrompt: string;
  visualTone: string;
  colorDirection: string;
  lightingDirection: string;
  cameraStyle: string;
  compositionTendencies: string;
  environmentStyle: string;
  characterRenderingGuidance: string;
  aspectRatio: "16:9" | "1:1" | "9:16" | "4:3" | "21:9";
  characterConsistencyStrength: number;
  environmentConsistencyStrength: number;
  globalNegativePrompt: string;
  additionalVisualInstructions: string;
  createdAt: string;
  updatedAt: string;
};

export type StoryArtDirection = {
  activePresetId: string;
  presets: ArtDirectionPreset[];
  updatedAt: string;
};

export type ShotType =
  | "extreme_wide"
  | "wide"
  | "medium_wide"
  | "medium"
  | "medium_close_up"
  | "close_up"
  | "extreme_close_up";

export type CameraAngle =
  | "eye_level"
  | "low_angle"
  | "high_angle"
  | "overhead"
  | "dutch_angle"
  | "pov"
  | "over_shoulder";

export type CompositionTendency =
  | "balanced"
  | "centered"
  | "rule_of_thirds"
  | "dynamic"
  | "symmetrical"
  | "environmental"
  | "character_focused";

export type SceneDirection = {
  shotType?: ShotType;
  cameraAngle?: CameraAngle;
  composition?: CompositionTendency;
  lighting?: string;
  timeEnvironment?: "dawn" | "day" | "sunset" | "dusk" | "night" | "interior" | "custom";
  characterExpressions?: Record<string, string>;
  useCharacterReferences?: boolean;
  useCreatureReferences?: boolean;
  useLocationReferences?: boolean;
  preserveWardrobeEquipment?: boolean;
  useStoryArtDirection?: boolean;
};

export type SceneOverrides = {
  wardrobeOverrides?: Record<string, string>;
  artDirectionPresetId?: string;
  customVisualPrompt?: string;
  customNegativePrompt?: string;
};

export type ArtworkVersion = {
  id: string;
  versionNumber: number;
  sceneId: string;
  imagePath: string;
  imageFingerprint: string;
  createdAt: string;
  provider: string;
  model: string;
  prompt: string;
  promptFingerprint: string;
  resolvedVisualProfileReferences?: Array<{
    entityId: string;
    name?: string;
    role?: string;
    referenceId?: string;
  }>;
  artDirectionFingerprint?: string;
  provenance?: { referencesUsed?: "images" | "text-only" | "none"; referenceImageCount?: number; availableReferenceCount?: number };
  settings?: {
    quality?: string;
    size?: string;
    aspectRatio?: string;
    outputFormat?: string;
  };
  review: "unreviewed" | "approved" | "rejected" | "needs-regeneration";
  imageUrl?: string;
};

export type SceneArtwork = {
  status: "pending" | "running" | "complete" | "failed";
  review: "unreviewed" | "approved" | "rejected" | "needs-regeneration";
  provider?: string;
  model?: string;
  fingerprint?: string;
  imageFingerprint?: string;
  generatedAt?: string;
  error?: string;
  versions?: ArtworkVersion[];
  approvedVersionId?: string;
};

export type Scene = {
  id: string;
  summary: string;
  startSeconds: number;
  endSeconds: number;
  characters: string[];
  location?: string;
  visualPrompt: string;
  importance: "transition" | "standard" | "major";
  artwork: SceneArtwork;
  imageUrl?: string;
  versionUrls?: Record<string, string>;
  entityIds?: string[];
  resolvedCharacters?: ResolvedSceneCharacter[];
  direction?: SceneDirection;
  overrides?: SceneOverrides;
};

export type ResolvedSceneCharacter = {
  name: string;
  entityId?: string;
  canonicalName?: string;
  profileStatus?: "draft" | "approved" | "missing";
  visualProfileId?: string;
  resolution: "exact_id" | "canonical_name" | "preferred_name" | "localized_name" | "original_name" | "alias" | "unresolved";
};

export type SceneManifest = { version: 1; chapter: number; durationSeconds: number; planningFingerprint: string; manualRevision: number; manuallyEdited: boolean; updatedAt: string; scenes: Scene[] };
export type ScenesDashboard = {
  settings: SceneSettings;
  artwork: ArtworkSettings;
  artworkRouting?: ArtworkRouting;
  planner: Model;
  scenePlannerRouting?: ResolvedModelRouting;
  selectedChapter?: number;
  chapters: Array<{ chapter: number; title?: string; durationSeconds?: number; sceneStatus: string; artworkStatus: string }>;
  counts: { chapters: number; planned: number; artworkReady: number };
  manifest?: SceneManifest;
  manifestStale?: boolean;
  visualProfiles?: VisualEntityProfile[];
  artDirection?: StoryArtDirection;
};
export type AudioDashboard = { settings: AudioSettings; chapters: Array<{ chapter: number; title?: string; status: string; durationSeconds?: number; audioAvailable: boolean; audioStale: boolean }>; counts: { total: number; mastered: number; current: number; stale: number }; totalDurationSeconds: number; exports: Array<{ fingerprint: string; from: number; to: number; format: "mp3" | "m4b"; createdAt: string; durationSeconds: number; downloadUrl: string }> };
export type VideoDashboard = { settings: VideoSettings; subtitleSettings: SubtitleSettings; background: { coverAvailable: boolean; coverName?: string; effectiveMode: string }; counts: { total: number; mastered: number; subtitles: number; videos: number }; chapters: Array<{ chapter: number; title?: string; durationSeconds?: number; subtitleStatus: string; videoStatus: string; videoAvailable: boolean; videoStale?: boolean }>; exports: Array<{ fingerprint: string; from: number; to: number; createdAt: string; durationSeconds: number; downloadUrl: string }> };
export type Model = { provider: "openai" | "gemini" | "kimi"; model: string };
export type FishTtsConfig = { provider: "fish"; model: string; referenceId?: string; secondaryReferenceId?: string; voiceMode: "narrator-only" | "same-voice-dialogue" | "narrator-dialogue"; deliveryIntensity: "none" | "restrained" | "expressive"; qualityGuard: boolean; providerQualityGuard: boolean; maxQualityRetries: number; speed: number; format: "mp3"; sampleRate: number; bitrate: number; normalize: boolean; maxCharsPerRequest: number };
export type StoryCard = { slug: string; title: string; author?: string; description: string; tags: string[]; sourceType: string; sourceUrl?: string; sourceLanguage: string; outputLanguage: string; importedChapters: number; processedChapters: number; latestProcessedChapter?: number; qa: Counts; progress: number; coverUrl?: string; updatedAt: string; recentActivity?: { type: string; message: string; at: string }; projectBytes: number; hasAudiobook: boolean; hasVideo: boolean };
export type Counts = { pass: number; warn: number; fail: number };
export type ChapterRow = { chapter: number; originalTitle?: string; translation: string; narration: string; qa?: "pass" | "warn" | "fail"; qaScore?: number; qaStale?: boolean; qaNeedsVerification?: number; tts: string; audioMastering: string; alignment: string; subtitles: string; durationSeconds?: number; audioAvailable: boolean; audioStale?: boolean; videoAvailable?: boolean; videoStale?: boolean };
export type QaResult = { status: "pass" | "warn" | "fail"; score: number; originalScore?: number; originalStatus?: "pass" | "warn" | "fail"; issues: Array<{ category: string; severity: "warn" | "fail"; message: string; evidence: string; review?: { disposition: "dismissed" | "manually_fixed"; reviewedAt: string } }>; checks: Record<string, "pass" | "warn" | "fail"> };
export type QaFindingStatus = "open" | "fixed_manual" | "fixed_ai" | "dismissed" | "obsolete";
export type QaFinding = {
  id: string; category: string; severity: "warn" | "fail"; message: string; evidence: string; suggestedFix?: string;
  status: QaFindingStatus; resolution?: { action: "manual_fix" | "ai_fix" | "dismiss" | "obsolete"; reason?: string; resolvedAt: string };
  reopenedAt?: string; firstDetectedAt?: string; lastVerifiedAt?: string; verifiedAgainstFingerprint?: string;
  provenance?: { chapter?: number; stage?: string; entityIds?: string[]; excerptKey?: string; continuityIds?: string[] };
  origin: "llm" | "deterministic"; safeToFix?: boolean; confidence?: number;
};
export type QaState = QaResult & { findings: QaFinding[]; mode?: "production" | "thorough" };
export type QaCounts = { open: number; resolved: number; safeFixesAvailable: number };
export type QaFindingStats = {
  current: { critical: number; warnings: number; open: number; score: number; status: "pass" | "warn" | "fail" };
  history: { fixedManual: number; fixedAi: number; dismissed: number; obsolete: number; total: number };
  needsVerification: number;
};
export type QaFreshness = "missing" | "current" | "needs_recheck" | "failed";
export type ChapterQaDetail = { chapter: number; state: QaState; counts: QaCounts; qaStale: boolean; stats?: QaFindingStats; freshness?: QaFreshness; currentFingerprint?: string };
export type QaRecheckSummary = QaCounts & { verified: number; respected: number; reopened: number; newFindings: number; obsoleted: number; mode: "changed" | "full"; fellBackToFull: boolean };
export type QaExceptionMatchKind = "terminology" | "entity" | "rule" | "other";
export type QaException = { id: string; category: string; matchKind: QaExceptionMatchKind; value: string; reason?: string; createdAt: string };
export type ChapterDetail = {
  original?: string; translation?: string; narration?: string;
  storyContext?: unknown; storyContextStale?: boolean;
  alignment?: { mode: string; engine: string; warning?: string; metrics?: { matchedWordPercentage: number; averageConfidence?: number; audioDurationSeconds: number } } | null; alignmentStale?: boolean;
  subtitleDocument?: { cues: Array<{ index: number; startSeconds: number; endSeconds: number; text: string }>; manual?: boolean; timingMode?: string } | null;
  subtitles?: string; subtitlesStale?: boolean; subtitlesUrl?: string;
  videoUrl?: string; videoStale?: boolean;
  audioUrl?: string; audioAvailable?: boolean; audioStale?: boolean;
  qa?: QaResult; qaStale?: boolean;
  [key: string]: any;
};
export type TtsDeliveryIntensity = "none" | "restrained" | "expressive";
export type TtsQualityIssueType = "unexpected_speech" | "missing_speech" | "repetition" | "truncated" | "suspected_gibberish" | "abnormal_duration" | "unexpected_silence" | "invalid_audio" | "transcription_failed";
export type TtsQualityIssue = { type: TtsQualityIssueType; severity: number; detail?: string };
export type TtsQualityAttempt = { attempt: number; settings: { deliveryIntensity: TtsDeliveryIntensity }; status: "pass" | "retry" | "needs_review" | "unverified"; score?: number; issues: TtsQualityIssue[]; requestId?: string };
export type TtsSegmentStatus = "verified" | "needs_review" | "unverified" | "manually_accepted";
export type TtsSegmentQuality = { index: number; expectedText: string; transcription?: string; score?: number; status: TtsSegmentStatus; issues: TtsQualityIssue[]; attempts: TtsQualityAttempt[]; finalAttempt: number; acceptedAt?: string; acceptedReason?: string };
export type TtsQualitySummaryStatus = "verified" | "needs_review" | "unverified" | "partial";
export type TtsQualityArtifact = { version: 1; chapter: number; createdAt: string; updatedAt: string; provider: string; model: string; referenceId?: string; voiceMode?: string; deliveryIntensity?: TtsDeliveryIntensity; status: TtsQualitySummaryStatus; verificationPolicy: { transcriber: string; maxRetries: number; thresholds: Record<string, number>; fingerprint: string }; segments: TtsSegmentQuality[] };
export type Job = { id: string; type: string; story: string; status: "queued" | "running" | "completed" | "failed" | "paused"; progress?: any; result?: any; error?: string; diagnostic?: ErrorDiagnostic };
export type StorySummary = import("../../../src/summaries/types.js").StorySummary;
export type ProductionPlan = { story: string; from: number; to: number; chapters: number[]; requiredChapters: number[]; chapterRequirements: Record<string,string[]>; outputs: string[]; artwork: boolean; stages: string[]; counts: Record<string, { required: number; reusable: number }>; estimates: { llmOperations: number; ttsOperations: number; imageOperations: number; imagesPendingPlanning: number }; finalOutputs: string[]; costEstimate?: {classification:string;estimatedUsd?:number;lowUsd?:number;highUsd?:number;confidence:string;assumptions:string[];unknownStages:string[];breakdown:Array<{stage:string;required:number;estimatedUsd?:number;basis:string}>} };
export type CostAnalytics = {summary:{totalCostUsd:number;requests:number;successful:number;failed:number;retries:number;inputTokens:number;cachedInputTokens:number;outputTokens:number;inputUtf8Bytes:number;images:number;unpricedRequests:number};dimensions:Array<{stage:string;provider:string;model:string;requests:number;costUsd:number;inputTokens:number;outputTokens:number;inputUtf8Bytes:number;images:number;failures:number}>;chapters:Array<{chapter?:number;requests:number;costUsd:number;unpriced:number}>};
export type QueueJob = { id:string;story:string;from:number;to:number;profile?:string;status:string;pauseRequested:boolean;cancelRequested:boolean;currentChapter?:number;currentStage?:string;totalItems:number;completedItems:number;warningItems:number;reviewItems:number;failedItems:number;errorSummary?:string;createdAt:string;startedAt?:string;updatedAt:string;completedAt?:string };
export type QueueWorkItem = { id:string;jobId:string;story:string;chapter:number;ordinal:number;status:string;currentStage?:string;attemptCount:number;maxAttempts:number;lastError?:string;errorCategory?:string;nextRetryAt?:string;lastAttemptAt?:string;reused:boolean;qaStatus?:string };
export type QueueEvent = { id:string;jobId:string;workItemId?:string;type:string;message:string;data:Record<string,unknown>;createdAt:string };
export type QueuePage<T> = {items:T[];page:number;pageSize:number;total:number;pages:number};
export type ProductionManifest = { id: string; status: string; selection: { from: number; to: number }; options: { outputs: string[]; artwork: boolean; repairQa: boolean; refresh: boolean; audiobookFormat: string; force?: string; profile?: string; dryRun: boolean }; current: { chapter?: number; stage?: string }; chapters: Record<string, { chapter: number; status: string; qa?: string; warning?: string; operations: Record<string, { status: string; reused: boolean; startedAt?: string; completedAt?: string; error?: string }> }>; failures: Array<{ chapter?: number; stage: string; message: string }>; summary: { chapters: number; completed: number; needsReview: number; failed: number; reusedStages: number; newStages: number; qaWarnings: number; qaFailures: number; exports: Record<string, string>; elapsedMs: number } };
export type StoryDashboard = { story: StoryConfig; counts: Counts & { chapters: number; complete: number; minChapter?: number; maxChapter?: number }; source?: { type: string; origin: unknown; importedAt: string; chapterCount: number }; progress: { processed: number; audio: number; artwork: number; video: number }; latestProduction?: ProductionManifest; currentProfile?: string; estimatedRemainingStages: number };
export type OutputItem = { id: string; group: "chapterAudio" | "audiobooks" | "chapterVideos" | "combinedVideos" | "subtitles" | "artwork"; chapter?: number; from?: number; to?: number; format: string; createdAt: string; bytes: number; durationSeconds?: number; url: string };

export async function getVisualProfiles(slug: string): Promise<VisualEntityProfile[]> {
  const res = await api<VisualEntityProfile[] | Record<string, VisualEntityProfile>>(`/stories/${encodeURIComponent(slug)}/visual-profiles`);
  return Array.isArray(res) ? res : Object.values(res ?? {});
}

export async function getVisualProfile(slug: string, entityId: string): Promise<VisualEntityProfile> {
  return api<VisualEntityProfile>(`/stories/${encodeURIComponent(slug)}/visual-profiles/${encodeURIComponent(entityId)}`);
}

export async function updateVisualProfile(slug: string, entityId: string, profile: Partial<VisualEntityProfile>): Promise<VisualEntityProfile> {
  return put<VisualEntityProfile>(`/stories/${encodeURIComponent(slug)}/visual-profiles/${encodeURIComponent(entityId)}`, { profile });
}

export async function deleteVisualProfile(slug: string, entityId: string): Promise<{ ok: boolean }> {
  return del<{ ok: boolean }>(`/stories/${encodeURIComponent(slug)}/visual-profiles/${encodeURIComponent(entityId)}`);
}

export async function uploadVisualReference(slug: string, entityId: string, payload: { filename: string; dataBase64: string; role?: string; label?: string; notes?: string }): Promise<VisualReferenceImage> {
  return post<VisualReferenceImage>(`/stories/${encodeURIComponent(slug)}/visual-profiles/${encodeURIComponent(entityId)}/references`, payload);
}

export async function generateStyleSheet(slug: string, entityId: string): Promise<{ styleSheetUrl: string; profile: VisualEntityProfile }> {
  return post<{ styleSheetUrl: string; profile: VisualEntityProfile }>(`/stories/${encodeURIComponent(slug)}/visual-profiles/${encodeURIComponent(entityId)}/style-sheet`, {});
}

export async function getArtDirection(slug: string): Promise<StoryArtDirection> {
  return api<StoryArtDirection>(`/stories/${encodeURIComponent(slug)}/art-direction`);
}

export async function updateArtDirection(slug: string, artDirection: StoryArtDirection): Promise<StoryArtDirection> {
  return put<StoryArtDirection>(`/stories/${encodeURIComponent(slug)}/art-direction`, { artDirection });
}

export async function createArtDirectionPreset(slug: string, preset: ArtDirectionPreset): Promise<StoryArtDirection> {
  return post<StoryArtDirection>(`/stories/${encodeURIComponent(slug)}/art-direction/presets`, { preset });
}

export async function updateArtDirectionPreset(slug: string, id: string, preset: Partial<ArtDirectionPreset>): Promise<StoryArtDirection> {
  return put<StoryArtDirection>(`/stories/${encodeURIComponent(slug)}/art-direction/presets/${encodeURIComponent(id)}`, { preset });
}

export async function deleteArtDirectionPreset(slug: string, id: string): Promise<StoryArtDirection> {
  return del<StoryArtDirection>(`/stories/${encodeURIComponent(slug)}/art-direction/presets/${encodeURIComponent(id)}`);
}

export async function duplicateArtDirectionPreset(slug: string, id: string): Promise<{ preset: ArtDirectionPreset; artDirection: StoryArtDirection }> {
  return post<{ preset: ArtDirectionPreset; artDirection: StoryArtDirection }>(`/stories/${encodeURIComponent(slug)}/art-direction/presets/${encodeURIComponent(id)}/duplicate`, {});
}

export async function setDefaultArtDirectionPreset(slug: string, id: string): Promise<StoryArtDirection> {
  return post<StoryArtDirection>(`/stories/${encodeURIComponent(slug)}/art-direction/presets/${encodeURIComponent(id)}/default`, {});
}

export async function getChapterTtsQuality(slug: string, chapter: number): Promise<{ quality: TtsQualityArtifact | null }> {
  return api<{ quality: TtsQualityArtifact | null }>(`/stories/${encodeURIComponent(slug)}/chapters/${chapter}/tts-quality`);
}

export async function verifyChapterTtsQuality(slug: string, chapter: number): Promise<Job> {
  return post<Job>(`/stories/${encodeURIComponent(slug)}/chapters/${chapter}/tts-quality/verify`, {});
}

export async function regenerateChapterTtsSegment(slug: string, chapter: number, segment: number): Promise<Job> {
  return post<Job>(`/stories/${encodeURIComponent(slug)}/chapters/${chapter}/audio-segments/${segment}/regenerate`, {});
}

export async function acceptChapterTtsSegment(slug: string, chapter: number, segment: number, reason?: string): Promise<{ quality: TtsQualityArtifact }> {
  return post<{ quality: TtsQualityArtifact }>(`/stories/${encodeURIComponent(slug)}/chapters/${chapter}/audio-segments/${segment}/accept`, { reason });
}

export function chapterTtsSegmentAudioUrl(slug: string, chapter: number, segment: number): string {
  return `/api/stories/${encodeURIComponent(slug)}/chapters/${chapter}/audio-segments/${segment}.mp3`;
}

export async function reviewArtworkVersion(slug: string, chapter: number, sceneId: string, versionId: string, review: string): Promise<SceneArtwork> {
  return post<SceneArtwork>(`/stories/${encodeURIComponent(slug)}/chapters/${chapter}/scenes/${encodeURIComponent(sceneId)}/versions/${encodeURIComponent(versionId)}/review`, { review });
}

