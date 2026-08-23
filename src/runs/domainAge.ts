// Domain-age enrichment module: resolves registration date (RDAP) and
// first-seen date (configurable provider) for the set of domains observed
// across a run's SERPs, with TTL caching, per-domain checkpointing, progress,
// and graceful per-domain error handling.
//
// This mirrors the isolation shape of applyDomainRatings (src/runs/engine.ts):
// a self-contained function driven by injected clients/cache/store so it is
// fully mock-testable and surviveable across Ctrl+C/restart via the cache
// (cache hits are never re-fetched) plus an enrichment_items checkpoint.
import { registrableDomain } from '../domains/normalize.js';
import type { CacheStore, CachedDomainAgeEntry, DomainAgeTtlSettings } from '../cache/store.js';
import type { RunStore } from '../db/store.js';
import { ResearchError } from '../shared/errors.js';
import type { RdapClient, RdapRegistrationResult, RdapRegistrationStatus } from '../rdap/types.js';
import type { FirstSeenClient, FirstSeenResult, FirstSeenStatus } from '../firstseen/types.js';
import { ttlMsForDomainAgeEntry } from '../cache/store.js';

// The canonical, assembled fact for one domain. registration* and firstSeen*
// are deliberately separate fields sourced from different providers; they can
// never alias one another and are reported with full provenance.
export type DomainAgeRecord = {
  domain: string;
  registrationDate: string | null;
  registrationStatus: RdapRegistrationStatus;
  registrationRule: string;
  registrationIsRedacted: boolean;
  registrationFetchedAt: string | null;
  firstSeenDate: string | null;
  firstSeenStatus: FirstSeenStatus;
  firstSeenSource: string | null;
  firstSeenFetchedAt: string | null;
  cacheHit: boolean;
  fetchedAt: string;
  error: string | null;
};

export type DomainAgeProgress = {
  stage: 'domain_age';
  completed: number;
  total: number;
  errors: number;
  cacheHits: number;
};

export type DomainAgeModuleOptions = {
  domains: string[];
  cache: CacheStore | null;
  rdap: RdapClient | null;
  firstSeen: FirstSeenClient | null;
  ttl: DomainAgeTtlSettings;
  forceRefresh: boolean;
  store: RunStore | null;
  runId: string;
  logger: (line: string) => void;
  signal?: { cancelled: boolean };
  onProgress?: (progress: DomainAgeProgress) => void;
  now: () => number;
};

export async function runDomainAgeModule(
  opts: DomainAgeModuleOptions,
): Promise<Map<string, DomainAgeRecord>> {
  const { cache, rdap, firstSeen, ttl, forceRefresh, store, runId, logger, signal, onProgress, now } =
    opts;

  // Deduplicate on the normalized registrable domain so a domain shared by
  // many keywords is resolved once (RDAP/first-seen are keyed by registrable
  // domain, per the geographic-accuracy scoping).
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of opts.domains) {
    const domain = registrableDomain(raw) ?? raw;
    if (!seen.has(domain)) {
      seen.add(domain);
      unique.push(domain);
    }
  }

  const results = new Map<string, DomainAgeRecord>();
  let cacheHits = 0;
  let errors = 0;
  let completed = 0;

  for (const domain of unique) {
    if (signal?.cancelled) {
      logger('Domain-age enrichment paused before completion.');
      break;
    }

    checkpoint(store, runId, domain, 'running', 'rdap', 'none', null);

    const cached = cache?.getDomainAge(domain) ?? null;
    const isFresh =
      cached !== null && !forceRefresh && Date.parse(cached.expiresAt) > now();

    let record: DomainAgeRecord;
    let cacheStatus: 'hit' | 'miss' | 'expired';
    if (isFresh) {
      cacheHits += 1;
      record = recordFromCache(cached!, now);
      cacheStatus = 'hit';
    } else {
      cacheStatus = cached === null ? 'miss' : 'expired';
      record = await freshDomainAge(domain, { rdap, firstSeen, now, logger });
      if (record.registrationStatus === 'error' || record.firstSeenStatus === 'error') {
        errors += 1;
      }
      // Persist to the TTL cache (cache.sqlite). Even error/unavailable facts are
      // cached so a transient failure is not retried every run until its TTL.
      // Cache hits are never re-written, mirroring applyDomainRatings.
      const ttlMs = ttlMsForDomainAgeEntry(record.registrationStatus, record.firstSeenStatus, ttl);
      cache?.putDomainAge(
        domain,
        {
          registrationDate: record.registrationDate,
          registrationStatus: record.registrationStatus,
          registrationRule: record.registrationRule,
          registrationIsRedacted: record.registrationIsRedacted,
          firstSeenDate: record.firstSeenDate,
          firstSeenStatus: record.firstSeenStatus,
          firstSeenSource: record.firstSeenSource ?? '',
          error: record.error,
        },
        new Date(now()).toISOString(),
        ttlMs,
      );
    }

    results.set(domain, record);
    completed += 1;

    checkpoint(
      store,
      runId,
      domain,
      'completed',
      'rdap',
      cacheStatus,
      record.error,
    );

    onProgress?.({ stage: 'domain_age', completed, total: unique.length, errors, cacheHits });
  }

  logger(`Domain-age enrichment complete: ${cacheHits} cached, ${unique.length - cacheHits} fetched, ${errors} error(s).`);
  return results;
}

async function freshDomainAge(
  domain: string,
  ctx: { rdap: RdapClient | null; firstSeen: FirstSeenClient | null; now: () => number; logger: (line: string) => void },
): Promise<DomainAgeRecord> {
  const fetchedAt = new Date().toISOString();
  let registrationError: string | null = null;
  let registration: RdapRegistrationResult;

  if (!ctx.rdap) {
    registration = {
      domain,
      registrationDate: null,
      status: 'error',
      error: 'RDAP client not configured',
      source: 'rdap',
      rule: 'unreachable',
      events: [],
      isRedacted: false,
      fetchedAt,
      requestCount: 0,
      httpStatus: null,
    };
    registrationError = 'RDAP client not configured';
  } else {
    try {
      registration = await ctx.rdap(domain);
    } catch (error) {
      const code = error instanceof ResearchError ? error.code : 'RDAP_ERROR';
      registration = {
        domain,
        registrationDate: null,
        status: 'error',
        error: `${code}: ${error instanceof Error ? error.message : String(error)}`,
        source: 'rdap',
        rule: 'unreachable',
        events: [],
        isRedacted: false,
        fetchedAt,
        requestCount: 0,
        httpStatus: null,
      };
      registrationError = registration.error;
    }
  }

  let firstSeen: FirstSeenResult | null = null;
  if (ctx.firstSeen) {
    try {
      firstSeen = await ctx.firstSeen(domain);
    } catch (error) {
      firstSeen = {
        domain,
        firstSeenDate: null,
        status: 'error',
        error: `${error instanceof ResearchError ? error.code : 'FIRST_SEEN_ERROR'}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        source: 'wayback',
        sourceReason: null,
        fetchedAt,
        requestCount: 0,
        httpStatus: null,
      };
    }
  }

  const record: DomainAgeRecord = {
    domain,
    registrationDate: registration.registrationDate,
    registrationStatus: registration.status,
    registrationRule: registration.rule,
    registrationIsRedacted: registration.isRedacted,
    registrationFetchedAt: registration.fetchedAt,
    firstSeenDate: firstSeen?.firstSeenDate ?? null,
    firstSeenStatus: firstSeen ? firstSeen.status : 'unavailable',
    firstSeenSource: firstSeen ? firstSeen.source : 'unconfigured',
    firstSeenFetchedAt: firstSeen ? firstSeen.fetchedAt : null,
    cacheHit: false,
    fetchedAt,
    error: firstSeen && firstSeen.status === 'error'
      ? firstSeen.error
      : registrationError,
  };
  return record;
}

function recordFromCache(cached: CachedDomainAgeEntry, now: () => number): DomainAgeRecord {
  return {
    domain: cached.domain,
    registrationDate: cached.registrationDate,
    registrationStatus: cached.registrationStatus,
    registrationRule: cached.registrationRule,
    registrationIsRedacted: cached.registrationIsRedacted,
    registrationFetchedAt: cached.storedAt,
    firstSeenDate: cached.firstSeenDate,
    firstSeenStatus: cached.firstSeenStatus,
    firstSeenSource: cached.firstSeenSource,
    firstSeenFetchedAt: cached.storedAt,
    cacheHit: true,
    fetchedAt: new Date(now()).toISOString(),
    error: cached.error,
  };
}

function checkpoint(
  store: RunStore | null,
  runId: string,
  domain: string,
  status: 'running' | 'completed' | 'error' | 'not_attempted',
  source: 'rdap' | 'cache',
  cacheStatus: 'none' | 'hit' | 'miss' | 'expired',
  error: string | null,
): void {
  if (!store) return;
  try {
    store.upsertEnrichmentItem({
      enrichmentId: runId,
      itemId: domain,
      module: 'domain_age',
      status,
      source,
      cacheStatus,
      fetchedAt: new Date().toISOString(),
      error,
    });
  } catch {
    // Checkpointing must never fail the enrichment; the TTL cache is the source
    // of truth for resume, and a checkpoint DB hiccup should not drop results.
  }
}

export const DOMAIN_AGE_CSV_HEADERS = [
  'domain',
  'registration_date',
  'registration_status',
  'registration_is_redacted',
  'registration_rule',
  'first_seen_date',
  'first_seen_status',
  'first_seen_source',
  'cache_hit',
  'fetched_at',
  'error',
];

export function renderDomainAgeCsv(records: DomainAgeRecord[]): string {
  const rows: string[][] = [DOMAIN_AGE_CSV_HEADERS];
  for (const r of records) {
    rows.push([
      r.domain,
      r.registrationDate ?? '',
      r.registrationStatus,
      r.registrationIsRedacted ? 'true' : 'false',
      r.registrationRule,
      r.firstSeenDate ?? '',
      r.firstSeenStatus,
      r.firstSeenSource ?? '',
      r.cacheHit ? 'true' : 'false',
      r.fetchedAt,
      r.error ?? '',
    ]);
  }
  return csv(rows);
}

export function renderDomainAgeJson(records: DomainAgeRecord[]): string {
  return JSON.stringify(records, null, 2);
}

function csv(rows: string[][]): string {
  return rows.map(csvRow).join('\r\n');
}

function csvRow(row: string[]): string {
  return row
    .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
    .join(',');
}
