import type { CacheIdentity } from './keys.js';
import { buildKeywordCacheKey, buildRelatedCacheKey } from './keys.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import type { KeywordCache, CachedKeywordEntry, CachedRelatedEntry } from './store.js';

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

export type RelatedCacheResolution =
  | { kind: 'hit_ok'; entry: CachedRelatedEntry }
  | { kind: 'hit_empty'; entry: CachedRelatedEntry }
  | { kind: 'retry_error'; entry: CachedRelatedEntry }
  | { kind: 'expired'; entry: CachedRelatedEntry }
  | { kind: 'miss' };

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
  relatedResolutions: Map<string, RelatedCacheResolution>;
};

export function planRunCache(
  normalizedKeywords: readonly string[],
  options: KeywordAccessOptions,
  cache: KeywordCache | null,
  now: number,
  related?: {
    enabled: boolean;
    expandableKeywords: ReadonlySet<string>;
  },
): RunCachePlan {
  const resolutions = new Map<string, CacheResolution>();
  const relatedResolutions = new Map<string, RelatedCacheResolution>();
  let needsBrowser = false;
  for (const normalizedKeyword of normalizedKeywords) {
    const resolution = resolveKeywordAccess(normalizedKeyword, options, cache, now);
    resolutions.set(normalizedKeyword, resolution);
    if (resolution.kind !== 'hit') needsBrowser = true;

    if (!related?.enabled || !related.expandableKeywords.has(normalizedKeyword)) continue;
    const relatedResolution = resolveRelatedAccess(
      normalizedKeyword,
      options.identity,
      cache,
      now,
    );
    relatedResolutions.set(normalizedKeyword, relatedResolution);
    if (relatedResolution.kind === 'miss' || relatedResolution.kind === 'expired' || relatedResolution.kind === 'retry_error') {
      needsBrowser = true;
      continue;
    }
    if (relatedResolution.kind === 'hit_ok') {
      for (const row of relatedResolution.entry.rows) {
        const candidate = normalizeKeyword(row.relatedKeyword);
        if (resolutions.has(candidate)) continue;
        const candidateResolution = resolveKeywordAccess(candidate, options, cache, now);
        resolutions.set(candidate, candidateResolution);
        if (candidateResolution.kind !== 'hit') needsBrowser = true;
      }
    }
  }
  return { needsBrowser, resolutions, relatedResolutions };
}

export function resolveRelatedAccess(
  normalizedKeyword: string,
  identity: CacheIdentity,
  cache: KeywordCache | null,
  now: number,
): RelatedCacheResolution {
  const entry = cache?.getRelated?.(buildRelatedCacheKey(normalizedKeyword, identity)) ?? null;
  if (entry === null) return { kind: 'miss' };
  if (Date.parse(entry.expiresAt) <= now) return { kind: 'expired', entry };
  if (entry.status === 'ok') return { kind: 'hit_ok', entry };
  if (entry.status === 'empty') return { kind: 'hit_empty', entry };
  // Errors are evidence, not a successful lookup result. Expansion retries
  // them on the next run rather than silently suppressing candidates.
  return { kind: 'retry_error', entry };
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
