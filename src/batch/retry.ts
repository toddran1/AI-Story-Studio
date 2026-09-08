import { ConfigurationError } from "../pipeline/errors.js";
import { RetryConfig } from "./types.js";

export type RetryHooks = {
  sleep?: (ms: number) => Promise<void>; random?: () => number;
  onAttempt?: (attempt: number) => Promise<void> | void; shouldStop?: () => boolean;
};

export async function withRetry<T>(operation: () => Promise<T>, config: RetryConfig, hooks: RetryHooks = {}): Promise<T> {
  const sleep = hooks.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = hooks.random ?? Math.random;
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    if (lastError !== undefined && hooks.shouldStop?.()) throw lastError;
    await hooks.onAttempt?.(attempt);
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (attempt >= config.maxAttempts || hooks.shouldStop?.() || !isTransientError(error)) throw error;
      const retryAfterMs = findRetryAfterMs(error);
      const exponential = Math.min(config.maxDelayMs, config.initialDelayMs * 2 ** (attempt - 1));
      const delay = retryAfterMs ?? Math.round(exponential * (0.75 + random() * 0.5));
      await sleep(Math.min(config.maxDelayMs, Math.max(0, delay)));
    }
  }
  throw lastError;
}

export function isTransientError(error: unknown): boolean {
  for (const item of errorChain(error)) {
    if (item instanceof ConfigurationError || item?.name === "ZodError") return false;
    const status = numeric(item?.status ?? item?.statusCode);
    if (status === 408 || status === 409 || status === 425 || status === 429 || (status !== undefined && status >= 500)) return true;
    if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) return false;
    const code = String(item?.code ?? "").toUpperCase();
    if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) return true;
    const message = String(item?.message ?? item ?? "").toLowerCase();
    if (/\b(408|429|5\d\d)\b|rate.?limit|timed?\s*out|temporar|network|connection reset|unavailable|overloaded/.test(message)) return true;
    if (/api.?key|unauthori[sz]ed|forbidden|unsupported model|invalid configuration|schema|json/.test(message)) return false;
  }
  return false;
}

function errorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = []; let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    if (typeof current === "object") { chain.push(current as Record<string, unknown>); current = (current as { cause?: unknown }).cause; }
    else { chain.push({ message: String(current) }); break; }
  }
  return chain;
}
function numeric(value: unknown): number | undefined { const result = Number(value); return Number.isFinite(result) ? result : undefined; }
function findRetryAfterMs(error: unknown): number | undefined {
  for (const item of errorChain(error)) {
    const headers = item.headers as { get?: (name: string) => string | null } | Record<string, string> | undefined;
    const raw = typeof (headers as { get?: unknown } | undefined)?.get === "function"
      ? (headers as { get: (name: string) => string | null }).get("retry-after")
      : (headers as Record<string, string> | undefined)?.["retry-after"];
    if (!raw) continue;
    const seconds = Number(raw); if (Number.isFinite(seconds)) return seconds * 1000;
    const date = Date.parse(raw); if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}
