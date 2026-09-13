export type HttpCacheEntry = {
  url: string;
  body: string;
  etag?: string;
  lastModified?: string;
  fetchedAt: string;
};

export interface HttpCache {
  get(url: string): Promise<HttpCacheEntry | undefined>;
  set(url: string, entry: HttpCacheEntry): Promise<void>;
}

export interface CookieStore {
  get(host: string): Promise<Record<string, string> | undefined>;
  set(host: string, cookies: Record<string, string>): Promise<void>;
}

export type WebHttpClientOptions = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  requestDelayMs?: number;
  maxResponseBytes?: number;
  maxRetries?: number;
  maxRedirects?: number;
  allowedHosts?: string[];
  cache?: HttpCache;
  cacheTtlMs?: number;
  maintainCookies?: boolean;
  cookieStore?: CookieStore;
  solveBrowserChallenge?: boolean;
  defaultHeaders?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
};

export type WebBinaryResponse = { bytes: Uint8Array; contentType?: string; url: string };
