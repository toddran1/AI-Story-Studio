export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, headers: { ...(options?.body instanceof ArrayBuffer ? {} : { "content-type": "application/json" }), ...options?.headers } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value as T;
}

export function post<T>(path: string, body: unknown) { return api<T>(path, { method: "POST", body: JSON.stringify(body) }); }
export function put<T>(path: string, body: unknown) { return api<T>(path, { method: "PUT", body: JSON.stringify(body) }); }

export type StoryConfig = {
  slug: string; title: string; author?: string; sourceLanguage: string; outputLanguage: string; source: { type: string; url?: string };
  context: { recentChapterSummaries: number };
  pipeline: { translation: Model; narration: Model; qa: Model; storyBible: Model; tts: { provider: "fish"; model: string; referenceId?: string; speed: number; format: "mp3"; sampleRate: number; bitrate: number; normalize: boolean; maxCharsPerRequest: number } };
};
export type Model = { provider: "openai" | "gemini"; model: string };
export type StoryCard = { slug: string; title: string; author?: string; sourceType: string; sourceUrl?: string; sourceLanguage: string; outputLanguage: string; importedChapters: number; processedChapters: number; latestProcessedChapter?: number; qa: Counts; progress: number };
export type Counts = { pass: number; warn: number; fail: number };
export type ChapterRow = { chapter: number; originalTitle?: string; translation: string; narration: string; qa?: "pass" | "warn" | "fail"; qaScore?: number; tts: string; audioAvailable: boolean };
export type QaResult = { status: "pass" | "warn" | "fail"; score: number; issues: Array<{ category: string; severity: "warn" | "fail"; message: string; evidence: string }>; checks: Record<string, "pass" | "warn" | "fail"> };
export type Job = { id: string; type: string; story: string; status: "queued" | "running" | "completed" | "failed" | "paused"; progress?: any; result?: any; error?: string };
