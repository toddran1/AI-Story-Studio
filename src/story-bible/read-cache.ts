import { stat } from "node:fs/promises";
import { fingerprint } from "../utils/hash.js";

/**
 * Generic per-story read cache. A cached value is valid only while the
 * caller-supplied fingerprint (derived from the input artifacts) is unchanged,
 * so correctness never depends on TTLs or explicit invalidation — both exist
 * only as conveniences. Concurrent readers share one in-flight build per key.
 */

type CacheEntry = { fingerprint: string; value: unknown };

const entries = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();
const buildCounts = new Map<string, number>();
const hitCounts = new Map<string, number>();

const keyFor = (namespace: string, root: string, slug: string) => `${namespace}\0${root}\0${slug}`;

export async function cachedStoryRead<T>(
  namespace: string,
  root: string,
  slug: string,
  computeFingerprint: () => Promise<string>,
  build: () => Promise<T>,
): Promise<{ value: T; cacheHit: boolean }> {
  const key = keyFor(namespace, root, slug);
  const stamp = await computeFingerprint();
  const cached = entries.get(key);
  if (cached && cached.fingerprint === stamp) {
    hitCounts.set(key, (hitCounts.get(key) ?? 0) + 1);
    return { value: cached.value as T, cacheHit: true };
  }
  const pending = inFlight.get(key);
  if (pending) {
    hitCounts.set(key, (hitCounts.get(key) ?? 0) + 1);
    return { value: (await pending) as T, cacheHit: true };
  }
  buildCounts.set(key, (buildCounts.get(key) ?? 0) + 1);
  const promise = build();
  inFlight.set(key, promise);
  try {
    const value = await promise;
    entries.set(key, { fingerprint: stamp, value });
    return { value, cacheHit: false };
  } finally {
    inFlight.delete(key);
  }
}

export function invalidateStoryReadCache(root: string, slug: string, namespace?: string): void {
  const suffix = `\0${root}\0${slug}`;
  for (const key of [...entries.keys()]) {
    if (key.endsWith(suffix) && (!namespace || key.startsWith(`${namespace}\0`))) entries.delete(key);
  }
}

/** mtime+size stamp: "-" for missing files so artifact deletion invalidates. */
export async function fileStamp(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "-";
    throw error;
  }
}

export async function filesStampFingerprint(paths: string[]): Promise<string> {
  return fingerprint(await Promise.all(paths.map(fileStamp)));
}

/** Test/diagnostic visibility into build sharing; not used by production logic. */
export function storyReadCacheStats() {
  return { builds: Object.fromEntries(buildCounts), hits: Object.fromEntries(hitCounts) };
}

export function resetStoryReadCaches(): void {
  entries.clear();
  inFlight.clear();
  buildCounts.clear();
  hitCounts.clear();
}
