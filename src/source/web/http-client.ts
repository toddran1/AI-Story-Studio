import { HttpCacheEntry, WebHttpClientOptions } from "./types.js";

export class WebHttpError extends Error {
  constructor(message: string, readonly status?: number, options?: ErrorOptions) { super(message, options); this.name = "WebHttpError"; }
}

export class WebHttpClient {
  private readonly fetcher: typeof fetch; private readonly timeoutMs: number; private readonly delayMs: number;
  private readonly maxBytes: number; private readonly retries: number; private readonly maxRedirects: number;
  private readonly hosts?: Set<string>; private readonly cache?: WebHttpClientOptions["cache"];
  private readonly cacheTtlMs: number; private readonly sleep: (ms: number) => Promise<void>; private lastRequestAt = 0;

  constructor(options: WebHttpClientOptions = {}) {
    this.fetcher = options.fetcher ?? fetch; this.timeoutMs = options.timeoutMs ?? 30_000;
    this.delayMs = options.requestDelayMs ?? 500; this.maxBytes = options.maxResponseBytes ?? 5_000_000;
    this.retries = options.maxRetries ?? 2; this.maxRedirects = options.maxRedirects ?? 5;
    this.hosts = options.allowedHosts ? new Set(options.allowedHosts.map((host) => host.toLowerCase())) : undefined;
    this.cache = options.cache; this.cacheTtlMs = options.cacheTtlMs ?? 300_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async getText(input: string, options: { refresh?: boolean } = {}): Promise<string> {
    const initial = this.validateUrl(input); let cached: HttpCacheEntry | undefined;
    try { cached = await this.cache?.get(initial.href); } catch { /* Cache reads are optional; continue with the network. */ }
    if (!options.refresh && cached && !cached.etag && !cached.lastModified && Date.now() - Date.parse(cached.fetchedAt) < this.cacheTtlMs) return cached.body;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try { return await this.request(initial, cached); }
      catch (error) {
        lastError = error;
        if (attempt >= this.retries || !isTransient(error)) throw error;
        await this.sleep(Math.min(5000, 500 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  private async request(initial: URL, cached?: HttpCacheEntry): Promise<string> {
    let url = initial;
    for (let redirects = 0; redirects <= this.maxRedirects; redirects++) {
      await this.rateLimit();
      let response: Response;
      try {
        const headers: Record<string, string> = { Accept: "text/html,application/xhtml+xml", "User-Agent": "AI-Story-Studio/0.1" };
        if (url.href === initial.href && cached?.etag) headers["If-None-Match"] = cached.etag;
        if (url.href === initial.href && cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;
        response = await this.fetcher(url, { method: "GET", redirect: "manual", headers, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (error) { throw new WebHttpError(`Web request failed for ${url.href}`, undefined, { cause: error }); }
      if (response.status === 304 && cached) return cached.body;
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location"); if (!location) throw new WebHttpError(`Redirect from ${url.href} has no Location header`, response.status);
        if (redirects === this.maxRedirects) throw new WebHttpError(`Too many redirects while fetching ${initial.href}`, response.status);
        url = this.validateUrl(new URL(location, url).href); continue;
      }
      if (!response.ok) { await discard(response); throw new WebHttpError(`Web request failed (${response.status}) for ${url.href}`, response.status); }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > this.maxBytes) throw new WebHttpError(`Web response exceeds ${this.maxBytes} bytes: ${url.href}`, response.status);
      const body = await readLimitedText(response, this.maxBytes);
      try {
        await this.cache?.set(initial.href, { url: initial.href, body, etag: response.headers.get("etag") ?? undefined,
          lastModified: response.headers.get("last-modified") ?? undefined, fetchedAt: new Date().toISOString() });
      } catch { /* A cache write must not turn a successful network response into a failed source request. */ }
      return body;
    }
    throw new WebHttpError(`Too many redirects while fetching ${initial.href}`);
  }

  private validateUrl(input: string): URL {
    let url: URL; try { url = new URL(input); } catch (error) { throw new WebHttpError(`Invalid web source URL: ${input}`, undefined, { cause: error }); }
    if (url.protocol !== "https:") throw new WebHttpError(`Only HTTPS web sources are allowed: ${input}`);
    if (url.username || url.password) throw new WebHttpError("Web source URLs cannot contain credentials");
    if (this.hosts && !this.hosts.has(url.hostname.toLowerCase())) throw new WebHttpError(`Web source host is not allowed: ${url.hostname}`);
    return url;
  }

  private async rateLimit() {
    const wait = this.lastRequestAt + this.delayMs - Date.now(); if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
  }
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > limit) { await reader.cancel(); throw new WebHttpError(`Web response exceeds ${limit} bytes`, response.status); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
async function discard(response: Response) { try { await response.body?.cancel(); } catch { /* Best effort connection cleanup. */ } }
function isTransient(error: unknown) {
  if (error instanceof WebHttpError && error.status !== undefined) return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  const cause = error instanceof Error ? error.cause : undefined; const candidate = cause instanceof Error ? cause : error instanceof Error ? error : undefined;
  const code = String((candidate as NodeJS.ErrnoException | undefined)?.code ?? "").toUpperCase();
  return candidate?.name === "TimeoutError" || candidate?.name === "AbortError" || candidate?.name === "TypeError"
    || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EAI_AGAIN"].includes(code)
    || /network|fetch|timeout/i.test(candidate?.message ?? String(error));
}
