import { HttpCacheEntry, WebBinaryResponse, WebHttpClientOptions } from "./types.js";

export class WebHttpError extends Error {
  constructor(message: string, readonly status?: number, options?: ErrorOptions) { super(message, options); this.name = "WebHttpError"; }
}

export class WebHttpClient {
  private readonly fetcher: typeof fetch; private readonly timeoutMs: number; private readonly delayMs: number;
  private readonly maxBytes: number; private readonly retries: number; private readonly maxRedirects: number;
  private readonly hosts?: Set<string>; private readonly cache?: WebHttpClientOptions["cache"];
  private readonly cacheTtlMs: number; private readonly sleep: (ms: number) => Promise<void>; private readonly maintainCookies: boolean;
  private readonly defaultHeaders: Record<string, string>; private readonly cookies = new Map<string, Map<string, string>>(); private lastRequestAt = 0;
  private readonly solveBrowserChallenge: boolean; private readonly cookieStore?: WebHttpClientOptions["cookieStore"];
  private readonly loadedHosts = new Set<string>();

  constructor(options: WebHttpClientOptions = {}) {
    this.fetcher = options.fetcher ?? fetch; this.timeoutMs = options.timeoutMs ?? 30_000;
    this.delayMs = options.requestDelayMs ?? 500; this.maxBytes = options.maxResponseBytes ?? 5_000_000;
    this.retries = options.maxRetries ?? 2; this.maxRedirects = options.maxRedirects ?? 5;
    this.hosts = options.allowedHosts ? new Set(options.allowedHosts.map((host) => host.toLowerCase())) : undefined;
    this.cache = options.cache; this.cacheTtlMs = options.cacheTtlMs ?? 300_000;
    this.maintainCookies = options.maintainCookies ?? false; this.defaultHeaders = { ...options.defaultHeaders };
    this.solveBrowserChallenge = options.solveBrowserChallenge ?? false; this.cookieStore = options.cookieStore;
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


  async getBinary(input: string, options: { maxBytes?: number } = {}): Promise<WebBinaryResponse> {
    const limit = options.maxBytes ?? this.maxBytes;
    for (let challengeAttempts = 0; ; challengeAttempts++) {
      let url = this.validateUrl(input); let result: WebBinaryResponse | undefined;
      for (let redirects = 0; redirects <= this.maxRedirects; redirects++) {
        await this.rateLimit(); let response: Response;
        try { response = await this.fetcher(url, { method: "GET", redirect: "manual", headers: { Accept: "text/plain,application/zip,application/octet-stream;q=0.9,*/*;q=0.5", "User-Agent": "AI-Story-Studio/0.1", ...this.defaultHeaders, ...await this.cookieHeaders(url) }, signal: AbortSignal.timeout(this.timeoutMs) }); }
        catch (error) { throw new WebHttpError(`Web download failed for ${url.href}`, undefined, { cause: error }); }
        this.captureCookies(url, response);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location"); if (!location) throw new WebHttpError(`Redirect from ${url.href} has no Location header`, response.status);
          if (redirects === this.maxRedirects) throw new WebHttpError(`Too many redirects while downloading ${input}`, response.status);
          url = this.validateUrl(new URL(location, url).href); continue;
        }
        if (!response.ok) { await discard(response); throw new WebHttpError(`Web download failed (${response.status}) for ${url.href}`, response.status); }
        const contentLength = Number(response.headers.get("content-length")); if (Number.isFinite(contentLength) && contentLength > limit) throw new WebHttpError(`Web download exceeds ${limit} bytes: ${url.href}`, response.status);
        result = { bytes: await readLimitedBytes(response, limit), contentType: response.headers.get("content-type") ?? undefined, url: url.href };
        break;
      }
      if (!result) throw new WebHttpError(`Too many redirects while downloading ${input}`);
      if (result.bytes.length && result.bytes.length <= CHALLENGE_PROBE_BYTES) {
        const probe = new TextDecoder().decode(result.bytes);
        if (await this.challengeSolved(new URL(result.url), probe, challengeAttempts)) continue;
      }
      return result;
    }
  }

  async postForm(input: string, fields: Record<string, string>, options: { headers?: Record<string, string> } = {}): Promise<string> {
    const url = this.validateUrl(input);
    for (let challengeAttempts = 0; ; challengeAttempts++) {
      await this.rateLimit();
      const body = new URLSearchParams(fields).toString(); let response: Response;
      try {
        response = await this.fetcher(url, { method: "POST", redirect: "error", body, signal: AbortSignal.timeout(this.timeoutMs), headers: {
          Accept: "text/html,application/json;q=0.9,*/*;q=0.8", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent": "AI-Story-Studio/0.1", ...this.defaultHeaders, ...await this.cookieHeaders(url), ...options.headers,
        } });
      } catch (error) { throw new WebHttpError(`Web request failed for ${url.href}`, undefined, { cause: error }); }
      this.captureCookies(url, response);
      if (!response.ok) { await discard(response); throw new WebHttpError(`Web request failed (${response.status}) for ${url.href}`, response.status); }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > this.maxBytes) throw new WebHttpError(`Web response exceeds ${this.maxBytes} bytes: ${url.href}`, response.status);
      const text = await readLimitedText(response, this.maxBytes);
      if (await this.challengeSolved(url, text, challengeAttempts)) continue;
      return text;
    }
  }

  private async request(initial: URL, cached?: HttpCacheEntry, challengeAttempts = 0): Promise<string> {
    let url = initial;
    for (let redirects = 0; redirects <= this.maxRedirects; redirects++) {
      await this.rateLimit();
      let response: Response;
      try {
        const headers: Record<string, string> = { Accept: "text/html,application/xhtml+xml", "User-Agent": "AI-Story-Studio/0.1", ...this.defaultHeaders, ...await this.cookieHeaders(url) };
        if (url.href === initial.href && cached?.etag) headers["If-None-Match"] = cached.etag;
        if (url.href === initial.href && cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;
        response = await this.fetcher(url, { method: "GET", redirect: "manual", headers, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (error) { throw new WebHttpError(`Web request failed for ${url.href}`, undefined, { cause: error }); }
      this.captureCookies(url, response);
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
      if (await this.challengeSolved(url, body, challengeAttempts)) return this.request(initial, cached, challengeAttempts + 1);
      try {
        if (cacheable(body)) await this.cache?.set(initial.href, { url: initial.href, body, etag: response.headers.get("etag") ?? undefined,
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
    if (this.hosts && !hostAllowed(url.hostname.toLowerCase(), this.hosts)) throw new WebHttpError(`Web source host is not allowed: ${url.hostname}`);
    return url;
  }

  private async rateLimit() {
    const wait = this.lastRequestAt + this.delayMs - Date.now(); if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private async challengeSolved(url: URL, body: string, attempts: number): Promise<boolean> {
    if (!this.solveBrowserChallenge || !this.maintainCookies || attempts >= MAX_CHALLENGE_ATTEMPTS) return false;
    const token = jsChallengeToken(body); if (!token) return false;
    const retry = new URL(url.href); retry.search = `?challenge=${encodeURIComponent(token)}`;
    try { await this.request(this.validateUrl(retry.href), undefined, attempts + 1); return true; }
    catch { return false; }
  }

  private async cookieHeaders(url: URL): Promise<Record<string, string>> {
    if (!this.maintainCookies) return {}; const host = url.hostname.toLowerCase();
    if (this.cookieStore && !this.loadedHosts.has(host)) {
      this.loadedHosts.add(host);
      try {
        const stored = await this.cookieStore.get(host);
        if (stored && !this.cookies.has(host)) this.cookies.set(host, new Map(Object.entries(stored)));
      } catch { /* Cookie persistence is optional; continue with an empty jar. */ }
    }
    const values = this.cookies.get(host);
    return values?.size ? { Cookie: [...values].map(([name, value]) => `${name}=${value}`).join("; ") } : {};
  }

  private captureCookies(url: URL, response: Response) {
    if (!this.maintainCookies) return;
    const headers = response.headers as Headers & { getSetCookie?: () => string[] }; const values = headers.getSetCookie?.() ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : []);
    if (!values.length) return; const host = url.hostname.toLowerCase(); const jar = this.cookies.get(host) ?? new Map<string, string>();
    for (const header of values) { const pair = header.split(";", 1)[0]; const separator = pair?.indexOf("=") ?? -1; if (separator <= 0) continue; const name = pair!.slice(0, separator).trim(); const value = pair!.slice(separator + 1).trim(); if (/max-age\s*=\s*0/iu.test(header) || !value) jar.delete(name); else jar.set(name, value); }
    if (jar.size) this.cookies.set(host, jar); else this.cookies.delete(host);
    if (this.cookieStore) {
      const snapshot = Object.fromEntries(jar);
      void this.cookieStore.set(host, snapshot).catch(() => { /* Cookie persistence must not fail source requests. */ });
    }
  }
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const bytes = await readLimitedBytes(response, limit);
  if (!bytes.length) return "";
  const declared = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(response.headers.get("content-type") ?? "")?.[1]?.toLowerCase();
  const encoding = declared === "gb2312" || declared === "gbk" ? "gb18030" : declared ?? "utf-8";
  try { return new TextDecoder(encoding).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}
async function readLimitedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > limit) { await reader.cancel(); throw new WebHttpError(`Web response exceeds ${limit} bytes`, response.status); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
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
const MAX_CHALLENGE_ATTEMPTS = 2; const CHALLENGE_PROBE_BYTES = 65_536;
function jsChallengeToken(body: string) {
  if (!/location\.pathname\s*\+\s*["']\?challenge=["']/u.test(body)) return undefined;
  return /(?:let|var|const)\s+token\s*=\s*"([A-Za-z0-9+/=]{16,})"/u.exec(body)?.[1];
}
function cacheable(body: string) { return !/captcha|checking your browser|正在验证浏览器|正在進行安全驗證|安全验证|challenge\s*=/iu.test(body); }
function hostAllowed(host: string, allowed: Set<string>) { if (allowed.has(host)) return true; for (const value of allowed) if (value.startsWith("*.") && host.endsWith(value.slice(1)) && host.length > value.length - 1) return true; return false; }
