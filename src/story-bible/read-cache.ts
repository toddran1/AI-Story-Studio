import { stat } from "node:fs/promises";
import { fingerprint } from "../utils/hash.js";
import { logger } from "../utils/logger.js";

/**
 * Generic per-story read cache. A cached value is valid only while the
 * caller-supplied fingerprint (derived from the input artifacts) is unchanged,
 * so correctness never depends on TTLs or explicit invalidation — both exist
 * only as conveniences. Concurrent readers share one in-flight build per key.
 *
 * Every key also carries a monotonically increasing generation. Invalidation
 * bumps the generation AND drops the stored entry, which closes the
 * invalidation-vs-inflight race: a build that was already running when
 * invalidation landed finishes for its original caller but is never stored,
 * and a later reader never joins it.
 */

type CacheEntry = { fingerprint: string; generation: number; sequence: number; value: unknown };
type PendingBuild = { fingerprint: string; generation: number; sequence: number; promise: Promise<unknown> };

const entries = new Map<string, CacheEntry>();
const inFlight = new Map<string, PendingBuild>();
const generations = new Map<string, number>();
const buildSequences = new Map<string, number>();
const buildCounts = new Map<string, number>();
const hitCounts = new Map<string, number>();

const keyFor = (namespace: string, root: string, slug: string) => `${namespace}\0${root}\0${slug}`;
const generationFor = (key: string) => generations.get(key) ?? 0;

export async function cachedStoryRead<T>(
  namespace: string,
  root: string,
  slug: string,
  computeFingerprint: () => Promise<string>,
  build: () => Promise<T>,
): Promise<{ value: T; cacheHit: boolean }> {
  const key = keyFor(namespace, root, slug);
  const stamp = await computeFingerprint();
  const generation = generationFor(key);
  const cached = entries.get(key);
  if (cached && cached.fingerprint === stamp && cached.generation === generation) {
    hitCounts.set(key, (hitCounts.get(key) ?? 0) + 1);
    return { value: cached.value as T, cacheHit: true };
  }
  const pending = inFlight.get(key);
  if (pending && pending.fingerprint === stamp && pending.generation === generation) {
    hitCounts.set(key, (hitCounts.get(key) ?? 0) + 1);
    return { value: (await pending.promise) as T, cacheHit: true };
  }
  buildCounts.set(key, (buildCounts.get(key) ?? 0) + 1);
  const sequence = (buildSequences.get(key) ?? 0) + 1;
  buildSequences.set(key, sequence);
  const entry: PendingBuild = { fingerprint: stamp, generation, sequence, promise: build() };
  inFlight.set(key, entry);
  try {
    const value = (await entry.promise) as T;
    const current = entries.get(key);
    if (generationFor(key) === entry.generation && (!current || current.sequence <= entry.sequence)) {
      entries.set(key, { fingerprint: entry.fingerprint, generation: entry.generation, sequence: entry.sequence, value });
    } else {
      // Invalidated while this build was running: the caller still gets its
      // value, but it must never poison the cache for the new generation.
      logger.debug({ event: "story_bible.cache_build_discarded", namespace, story: slug, generation: entry.generation });
    }
    return { value, cacheHit: false };
  } finally {
    // A newer build may already own this slot; never remove another build's entry.
    if (inFlight.get(key) === entry) inFlight.delete(key);
  }
}

export function invalidateStoryReadCache(root: string, slug: string, namespace?: string): void {
  const suffix = `\0${root}\0${slug}`;
  const keys = new Set([...entries.keys(), ...inFlight.keys(), ...generations.keys(), ...buildSequences.keys()]);
  for (const key of keys) {
    if (!key.endsWith(suffix)) continue;
    if (namespace && !key.startsWith(`${namespace}\0`)) continue;
    entries.delete(key);
    generations.set(key, generationFor(key) + 1);
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
  generations.clear();
  buildSequences.clear();
  buildCounts.clear();
  hitCounts.clear();
}
