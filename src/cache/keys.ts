import { createHash } from 'node:crypto';
import type { ResearchConfig } from '../config/config.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';

// The identity fields that must match for a cached keyword entry to be
// reusable: the semantic research settings and both parser versions. TTLs
// and operational settings are deliberately not part of the identity.
export type CacheIdentity = {
  market: string;
  hl: string;
  gl: string;
  topN: number;
  surferParserVersion: string;
  googleParserVersion: string;
};

export function keywordCacheIdentity(config: ResearchConfig): CacheIdentity {
  return {
    market: config.research.market,
    hl: config.research.googleHl,
    gl: config.research.googleGl,
    topN: config.research.topN,
    surferParserVersion: SURFER_PARSER_VERSION,
    googleParserVersion: GOOGLE_PARSER_VERSION,
  };
}

function cacheKey(scope: string, parts: Record<string, string | number>): string {
  // Sort-insensitive: a fixed key order makes the hash deterministic.
  const canonical = JSON.stringify({ scope, ...parts });
  return createHash('sha256').update(canonical).digest('hex');
}

export function buildKeywordCacheKey(
  normalizedKeyword: string,
  identity: CacheIdentity,
): string {
  return cacheKey('keyword', { normalizedKeyword, ...identity });
}

// Related keywords are cached per parent keyword under the same identity that
// governs the parent's own entry, so a different market or parser version can
// never read another variant's related data.
export function buildRelatedCacheKey(
  normalizedKeyword: string,
  identity: CacheIdentity,
): string {
  return cacheKey('related', { normalizedKeyword, ...identity });
}

export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

export function buildDomainCacheKey(domain: string): string {
  return cacheKey('domain', { domain: normalizeDomain(domain) });
}
