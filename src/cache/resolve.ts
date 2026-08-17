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

// Decides how a pending keyword is served. Forced refresh bypasses the cache
// entirely; an entry is a hit only while not past its stored expiry (expired
// counts as a miss but the row is left for opportunistic cleanup).
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
