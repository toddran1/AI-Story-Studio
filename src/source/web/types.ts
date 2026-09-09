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
  sleep?: (ms: number) => Promise<void>;
};
