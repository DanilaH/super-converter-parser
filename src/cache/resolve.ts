import type { CacheIdentity } from './keys.js';
import { buildKeywordCacheKey } from './keys.js';
import type { KeywordCache, CachedKeywordEntry } from './store.js';

export type CacheResolution =
  | { kind: 'forced' }
  | { kind: 'hit'; entry: CachedKeywordEntry }
  | { kind: 'expired' }
  | { kind: 'miss' };

export type KeywordAccessOptions = {
  identity: CacheIdentity;
  forceRefresh: boolean;
  refreshKeywords: ReadonlySet<string>;
};

// Refresh semantics that were active when a run was (inter)rupted are
// persisted in the run store. Merging them with whatever flags the operator
// supplies now keeps a forced-refresh run forced across pause/resume, while
// still letting a resume add new refresh keywords. The result is the single
// source of truth for both planning (needs browser?) and execution.
export function mergedCacheRefresh(
  provided: { forceRefresh: boolean; refreshKeywords: ReadonlySet<string> },
  persisted: { forceRefresh: boolean; refreshKeywords: readonly string[] },
): { forceRefresh: boolean; refreshKeywords: string[] } {
  return {
    forceRefresh: provided.forceRefresh || persisted.forceRefresh,
    refreshKeywords: Array.from(
      new Set([...persisted.refreshKeywords, ...provided.refreshKeywords]),
    ),
  };
}

export type RunCachePlan = {
  needsBrowser: boolean;
  // One resolution per pending keyword, decided exactly once per run and
  // reused by the engine, so the browser decision and execution can never
  // disagree about the same cache state (no read-then-use window).
  resolutions: Map<string, CacheResolution>;
};

export function planRunCache(
  normalizedKeywords: readonly string[],
  options: KeywordAccessOptions,
  cache: KeywordCache | null,
  now: number,
): RunCachePlan {
  const resolutions = new Map<string, CacheResolution>();
  let needsBrowser = false;
  for (const normalizedKeyword of normalizedKeywords) {
    const resolution = resolveKeywordAccess(normalizedKeyword, options, cache, now);
    resolutions.set(normalizedKeyword, resolution);
    if (resolution.kind !== 'hit') needsBrowser = true;
  }
  return { needsBrowser, resolutions };
}

// Decides how a pending keyword is served. Forced refresh bypasses the cache
// entirely; an entry is a hit only while not past its stored expiry. Expired
// entries are their own bucket (never double-counted as misses) and are
// reported with their own status; the row stays until a refresh overwrites it
// (open-time cleanup only purges rows that died longer ago than the grace
// window).
export function resolveKeywordAccess(
  normalizedKeyword: string,
  options: KeywordAccessOptions,
  cache: KeywordCache | null,
  now: number,
): CacheResolution {
  if (options.forceRefresh || options.refreshKeywords.has(normalizedKeyword)) {
    return { kind: 'forced' };
  }
  if (cache === null) return { kind: 'miss' };

  const entry = cache.getKeyword(buildKeywordCacheKey(normalizedKeyword, options.identity));
  if (entry === null) return { kind: 'miss' };
  return Date.parse(entry.expiresAt) > now ? { kind: 'hit', entry } : { kind: 'expired' };
}
