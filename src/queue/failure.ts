import { ConfigurationError, QualityGateError } from "../pipeline/errors.js";
import { FailureCategory } from "./types.js";

export type ClassifiedFailure = { category: FailureCategory; retryable: boolean; retryAfterMs?: number; message: string; recommendedAction: string; provider?: string };

export function classifyQueueFailure(error: unknown): ClassifiedFailure {
  const values = errorChain(error); const message = values.map((value) => value.message).find(Boolean) ?? String(error);
  const status = values.map((value) => numeric(value.status ?? value.statusCode)).find((value) => value !== undefined);
  const retryAfterMs = values.map(retryAfter).find((value) => value !== undefined);
  const provider = providerFrom(message);
  if (values.some((value) => value instanceof QualityGateError) || /quality gate|qa fail|continuity|invalid narration|model response/i.test(message))
    return { category: "content_qa", retryable: false, message, recommendedAction: "Review the chapter output, correct the content, then retry the affected stage.", provider };
  if (status === 429 || /rate.?limit|too many requests|quota temporarily/i.test(message))
    return { category: "rate_limit", retryable: true, retryAfterMs, message, recommendedAction: "Wait for the provider cooldown; the chapter will retry automatically.", provider };
  if (status !== undefined && status >= 500 || /timeout|timed out|network|ECONN|EAI_AGAIN|socket hang up|temporar(?:y|ily) unavailable|fetch failed/i.test(message))
    return { category: "transient", retryable: true, retryAfterMs, message, recommendedAction: "No action is required unless retries are exhausted.", provider };
  if (values.some((value) => value instanceof ConfigurationError) || /api key|credential|invalid model|voice|reference id|ffmpeg.*(?:unavailable|not found)|ffprobe.*(?:unavailable|not found)|whisper.*(?:unavailable|not found)|alignment (?:model|engine|executable)/i.test(message))
    return { category: "configuration", retryable: false, message, recommendedAction: "Fix the story or environment configuration, then resume the job.", provider };
  return { category: "permanent", retryable: false, message, recommendedAction: "Inspect the source and project artifacts before retrying.", provider };
}

export function retryDelayMs(attempt: number, retryAfterMs?: number, random = Math.random) {
  const bounded = Math.min(15 * 60_000, 2_000 * 2 ** Math.max(0, attempt - 1));
  return Math.max(retryAfterMs ?? 0, Math.min(15 * 60_000, Math.round(bounded * (0.75 + random() * 0.5))));
}

function errorChain(error: unknown) { const result: Array<Error & Record<string, unknown>> = []; let value = error; for (let depth = 0; value && depth < 8; depth++) { if (value instanceof Error) result.push(value as Error & Record<string, unknown>); value = typeof value === "object" ? (value as { cause?: unknown }).cause : undefined; } return result; }
function numeric(value: unknown) { const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN; return Number.isInteger(number) ? number : undefined; }
function retryAfter(value: Error & Record<string, unknown>) { const headers = value.headers as Record<string, unknown> | undefined; const raw = headers?.["retry-after"] ?? headers?.["Retry-After"] ?? value.retryAfter; if (raw !== undefined) { const seconds = Number(raw); if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000); const date = Date.parse(String(raw)); if (Number.isFinite(date)) return Math.max(0, date - Date.now()); } const match=value.message.match(/(?:please\s+)?retry\s+in\s+([0-9]+(?:\.[0-9]+)?)\s*(ms|milliseconds?|s|seconds?)/i); if(!match)return undefined;const amount=Number(match[1]);return Math.max(0,Math.ceil(amount*(/^m/i.test(match[2]!)?1:1000))); }
function providerFrom(message: string) { if (/fish/i.test(message)) return "fish"; if (/gemini|google/i.test(message)) return "gemini"; if (/openai/i.test(message)) return "openai"; if (/image/i.test(message)) return "image"; return undefined; }
