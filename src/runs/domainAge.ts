// Domain-age enrichment module: resolves registration date (RDAP) and first-seen
// date (configurable provider) for the set of domains observed across a run's
// shortlisted SERPs, with per-source TTL caching, per-domain checkpointing, and
// per-source partial refresh.
//
// Design contract (from review):
//  - Bounded, shortlist-only domain set (5-30 targets). `provenance` carries the
//    shortlisted keywords each domain was observed in so outputs stay traceable.
//  - registrationDate and firstSeenDate are separate facts from separate providers
//    and can never alias one another.
//  - The enrichment_items checkpoint (enrichment.sqlite) is the resume source of
//    truth, NOT the mutable TTL cache. A completed domain is never re-fetched on
//    resume. The TTL cache only governs cross-run network freshness.
//  - Registration and first-seen carry independent fetchedAt/expiresAt/error so a
//    short first-seen TTL never forces a refetch of a valid 180-day registration
//    fact; only the expired source is refreshed (partial refresh).
//  - Checkpoint failures are not swallowed: a DB error propagates so the domain is
//    never reported as truthfully completed.
//
// This mirrors the isolation shape of applyDomainRatings (src/runs/engine.ts): a
// self-contained function driven by injected clients/cache/store so it is fully
// mock-testable and surviveable across Ctrl+C/restart via checkpoints.
import type { CacheStore, CachedDomainAgeEntry, DomainAgeTtlSettings } from '../cache/store.js';
import { ttlMsForFirstSeenStatus, ttlMsForRdapStatus, FIRST_SEEN_QUERY_VERSION } from '../cache/store.js';
import type { RunStore } from '../db/store.js';
import { ResearchError } from '../shared/errors.js';
import type { ResearchConfig } from '../config/config.js';
import { registrableDomain } from '../domains/normalize.js';
import { RDAP_PARSER_VERSION } from '../rdap/types.js';
import type {
  RdapClient,
  RdapClientConfig,
  RdapRegistrationResult,
  RdapRegistrationStatus,
  RdapEventCandidate,
} from '../rdap/types.js';
import type {
  FirstSeenClient,
  FirstSeenClientConfig,
  FirstSeenResult,
  FirstSeenStatus,
} from '../firstseen/types.js';
import type { EnrichmentCacheStatus, EnrichmentItemRecord } from '../enrichment/types.js';

// The canonical, assembled fact for one domain. registration* and firstSeen* are
// deliberately separate fields sourced from different providers; they can never
// alias one another and are reported with full provenance.
export type DomainAgeRecord = {
  domain: string;
  registrationDate: string | null;
  registrationStatus: RdapRegistrationStatus;
  registrationRule: string;
  registrationIsRedacted: boolean;
  registrationFetchedAt: string | null;
  registrationSource: string;
  // Raw RDAP event candidates for auditability (source: parsed RDAP events).
  registrationEvents: Array<{ eventAction: string; eventDate: string | null }>;
  firstSeenDate: string | null;
  firstSeenStatus: FirstSeenStatus;
  firstSeenSource: string | null;
  firstSeenFetchedAt: string | null;
  // Keyword provenance: which shortlisted keywords observed this domain.
  sourceKeywords: string[];
  // Rank-level provenance: positions at which the domain was observed per keyword.
  sourceRanks: Array<{ keyword: string; position: number }>;
  // Domain age in days from registration date to observedAt (null if no registration date).
  domainAgeDays: number | null;
  // When this record was observed/fetched.
  observedAt: string;
  cacheHit: boolean;
  cacheStatus: 'hit' | 'miss' | 'expired' | 'partial' | 'none';
  // True when this domain was omitted from enrichment due to the domain cap.
  omitted: boolean;
  omitReason: string | null;
  fetchedAt: string;
  // Per-source error details.
  registrationError: string | null;
  firstSeenError: string | null;
  firstSeenSourceReason: string | null;
  // Per-source HTTP status and request count.
  registrationHttpStatus: number | null;
  registrationRequestCount: number;
  firstSeenHttpStatus: number | null;
  firstSeenRequestCount: number;
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
  provenance?: Map<string, string[]>;
  ranks?: Map<string, Array<{ keyword: string; position: number }>>;
  omitted?: Array<{ domain: string; sourceKeywords: string[]; sourceRanks: Array<{ keyword: string; position: number }> }>;
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
  resume?: boolean;
};

export const DOMAIN_AGE_CONFIG_VERSION = '1.0.0';

// Sanitized, typed snapshot of everything the domain_age module needs so a resumed
// run is reproducible from persisted state instead of reloaded from the current
// environment (which could mix semantics across runs). No secrets and no
// non-serializable callables (random/sleep/clock) are carried; those are injected
// by the caller at build time.
export type DomainAgeConfigSnapshot = {
  configVersion: string;
  rdap: Omit<RdapClientConfig, 'fetchImpl' | 'now' | 'sleep' | 'random'>;
  firstSeen: {
    provider: string;
    endpoint: string;
    timeoutMs: number;
    minDelayMs: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  ttl: DomainAgeTtlSettings;
  parserVersions: { rdap: string };
};

export function buildDomainAgeConfigSnapshot(config: ResearchConfig): DomainAgeConfigSnapshot {
  return {
    configVersion: DOMAIN_AGE_CONFIG_VERSION,
    rdap: {
      bootstrapBase: config.rdap.bootstrapBase,
      bootstrapFile: config.rdap.bootstrapFile,
      bootstrapTtlMs: config.rdap.bootstrapTtlMs,
      queryTimeoutMs: config.rdap.queryTimeoutMs,
      perHostMinDelayMs: config.rdap.perHostMinDelayMs,
      maxAttempts: config.rdap.maxAttempts,
      baseDelayMs: config.rdap.baseDelayMs,
      maxDelayMs: config.rdap.maxDelayMs,
    },
    firstSeen: {
      provider: config.firstSeen.provider,
      endpoint: config.firstSeen.endpoint,
      timeoutMs: config.firstSeen.timeoutMs,
      minDelayMs: config.firstSeen.minDelayMs,
      maxAttempts: config.firstSeen.maxAttempts,
      baseDelayMs: config.firstSeen.baseDelayMs,
      maxDelayMs: config.firstSeen.maxDelayMs,
    },
    ttl: config.cache.ttl.domainAge,
    parserVersions: { rdap: RDAP_PARSER_VERSION },
  };
}

export function snapshotToRdapClientConfig(
  snapshot: DomainAgeConfigSnapshot,
  extras: { random: () => number; fetchImpl?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> },
): RdapClientConfig {
  const cfg: RdapClientConfig = {
    bootstrapBase: snapshot.rdap.bootstrapBase,
    bootstrapFile: snapshot.rdap.bootstrapFile,
    bootstrapTtlMs: snapshot.rdap.bootstrapTtlMs,
    queryTimeoutMs: snapshot.rdap.queryTimeoutMs,
    perHostMinDelayMs: snapshot.rdap.perHostMinDelayMs,
    maxAttempts: snapshot.rdap.maxAttempts,
    baseDelayMs: snapshot.rdap.baseDelayMs,
    maxDelayMs: snapshot.rdap.maxDelayMs,
    random: extras.random,
  };
  if (extras.fetchImpl) cfg.fetchImpl = extras.fetchImpl;
  if (extras.now) cfg.now = extras.now;
  if (extras.sleep) cfg.sleep = extras.sleep;
  return cfg;
}

export function snapshotToFirstSeenClientConfig(
  snapshot: DomainAgeConfigSnapshot,
  extras: { fetchImpl?: typeof fetch },
): FirstSeenClientConfig {
  const cfg: FirstSeenClientConfig = {
    provider: snapshot.firstSeen.provider,
    endpoint: snapshot.firstSeen.endpoint,
    apiKey: null,
    timeoutMs: snapshot.firstSeen.timeoutMs,
    minDelayMs: snapshot.firstSeen.minDelayMs,
    maxAttempts: snapshot.firstSeen.maxAttempts,
    baseDelayMs: snapshot.firstSeen.baseDelayMs,
    maxDelayMs: snapshot.firstSeen.maxDelayMs,
  };
  if (extras.fetchImpl) cfg.fetchImpl = extras.fetchImpl;
  return cfg;
}

export function snapshotDomainAgeTtl(snapshot: DomainAgeConfigSnapshot): DomainAgeTtlSettings {
  return snapshot.ttl;
}

function isFresh(expiresAt: string | null | undefined, nowMs: number): boolean {
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  return !Number.isNaN(parsed) && parsed > nowMs;
}

export async function runDomainAgeModule(
  opts: DomainAgeModuleOptions,
): Promise<Map<string, DomainAgeRecord>> {
  const { cache, rdap, firstSeen, ttl, forceRefresh, store, runId, logger, signal, onProgress, now, provenance, ranks, omitted } =
    opts;
  const resume = opts.resume ?? false;
  const fsConfigured = !!firstSeen;

  // Deduplicate on the normalized registrable domain so a domain shared by many
  // keywords is resolved once (RDAP/first-seen are keyed by registrable domain).
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

  // Resume source of truth: completed checkpoints from a prior run for this
  // enrichment. They are never re-fetched; the TTL cache only governs freshness
  // for domains that still need processing.
  const completedItems = resume && store ? loadCompletedDomainAgeItems(store, runId) : new Map<string, EnrichmentItemRecord>();

  for (const domain of unique) {
    if (signal?.cancelled) {
      logger('Domain-age enrichment paused before completion.');
      break;
    }

    const prov = provenance?.get(domain) ?? [];
    const domainRanks = ranks?.get(domain) ?? [];

    const resumed = completedItems.get(domain);
    if (resumed && resumed.payload) {
      const record = JSON.parse(resumed.payload) as DomainAgeRecord;
      record.sourceKeywords = prov;
      record.sourceRanks = domainRanks;
      // Preserve the original cacheHit/cacheStatus from the checkpoint payload.
      // Do not overwrite to true — the original record may have been a fresh fetch.
      results.set(domain, record);
      completed += 1;
      checkpoint(store, runId, domain, 'completed', 'checkpoint', record.cacheStatus ?? 'hit', null, record);
      onProgress?.({ stage: 'domain_age', completed, total: unique.length, errors, cacheHits });
      continue;
    }

    checkpoint(store, runId, domain, 'running', 'rdap', 'none', null, null);

    const cached = cache?.getDomainAge(domain) ?? null;
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();

    // --- Registration (RDAP) ---
    let regResult: RdapRegistrationResult;
    let regFetched = false;
    if (cached && isFresh(cached.registrationExpiresAt, nowMs) && !forceRefresh) {
      regResult = registrationFromCache(cached);
    } else {
      regResult = await fetchRegistration(domain, rdap, nowIso);
      regFetched = true;
    }

    // --- First-seen (provider or stable unavailable) ---
    let fsResult: FirstSeenResult | null;
    let fsFetched = false;
    // Pre-compute freshness/version for the !fsConfigured path so we can also
    // use them for cache-hit accounting below.
    // Stable unavailable: only genuinely unconfigured (source='unconfigured')
    // with matching query version and no expiry. NOT source='expired' (written
    // by us after TTL expiry) — that must remain stale for correct accounting.
    const isStableUnconfigured = !fsConfigured
      && cached?.firstSeenStatus === 'unavailable'
      && cached?.firstSeenSource === 'unconfigured';
    const versionMatch = !fsConfigured && cached && cached.firstSeenQueryVersion === FIRST_SEEN_QUERY_VERSION;
    const fsFresh = !fsConfigured && cached && (isStableUnconfigured || isFresh(cached.firstSeenExpiresAt, nowMs));
    if (!fsConfigured) {
      // No provider configured: deterministic unavailable. Reuse a cached value only
      // if its query version matches the current contract AND the TTL is fresh
      // (or the fact is a stable unconfigured unavailable that never changes).
      // A stale-version fact (e.g. v1 exact match under v2 domain scope) or an
      // expired TTL must NOT be served as valid: provider disabled does not grant
      // the right to ignore TTL.
      if (cached && versionMatch && fsFresh) {
        fsResult = firstSeenFromCache(cached);
      } else if (cached && versionMatch && !fsFresh) {
        // Version matches but TTL expired: provider disabled, so refetch is impossible.
        // Report as expired (not a valid hit).
        fsResult = makeExpiredFirstSeen(domain, nowIso, cached.firstSeenStatus as FirstSeenStatus);
      } else if (cached && !versionMatch) {
        // Stale query contract: report as unavailable with a clear reason.
        fsResult = makeStaleQueryVersion(domain, nowIso, cached.firstSeenQueryVersion);
      } else {
        fsResult = makeUnavailable(domain, nowIso);
      }
    } else if (cached && isFresh(cached.firstSeenExpiresAt, nowMs) && !forceRefresh) {
      fsResult = firstSeenFromCache(cached);
    } else {
      fsResult = await fetchFirstSeen(domain, firstSeen as FirstSeenClient, nowIso);
      fsFetched = true;
    }

    // Stale = version mismatch OR (not stable-unconfigured AND TTL expired).
    // Stable unconfigured unavailable is exempt from TTL but NOT from version mismatch.
    const firstSeenStale = !fsConfigured && cached !== null
      && (!versionMatch || (!isStableUnconfigured && !fsFresh));

    const cacheHit = !regFetched && !fsFetched && cached !== null && !firstSeenStale;
    if (cacheHit) cacheHits += 1;

    let cacheStatus: 'hit' | 'miss' | 'expired' | 'partial' = 'miss';
    if (cached) {
      cacheStatus = regFetched && fsFetched
        ? 'expired'
        : regFetched || fsFetched || firstSeenStale
          ? 'partial'
          : 'hit';
    }

    const record = assembleRecord(domain, regResult, fsResult, prov, domainRanks, nowIso, cacheHit, cacheStatus, nowMs);

    // Cache: write the full per-source record with independent expiries so a
    // fresh fact is preserved when its sibling is refreshed.
    if (cached && cacheHit) {
      // Nothing changed; do not rewrite the cache row.
    } else {
      const entry = buildCachedEntry(cached, regResult, fsResult, regFetched, fsFetched, nowMs, nowIso, ttl);
      cache?.putDomainAge(domain, entry, nowIso);
    }

    const hasError = record.registrationStatus === 'error' || record.firstSeenStatus === 'error';
    if (hasError) errors += 1;

    results.set(domain, record);
    completed += 1;

    checkpoint(
      store,
      runId,
      domain,
      hasError ? 'error' : 'completed',
      cacheHit ? 'cache' : 'rdap',
      cacheStatus,
      record.error,
      record,
    );

    onProgress?.({ stage: 'domain_age', completed, total: unique.length, errors, cacheHits });
  }

  const freshCount = completed - cacheHits;
  logger(
    `Domain-age enrichment complete: ${cacheHits} cached, ${freshCount} fetched (${errors} with errors) of ${completed} total.`,
  );

  // Append omitted-domain records (status=domain_cap) so outputs stay complete.
  if (omitted) {
    const nowIso = new Date(now()).toISOString();
    for (const o of omitted) {
      results.set(o.domain, {
        domain: o.domain,
        registrationDate: null,
        registrationStatus: 'not_attempted',
        registrationRule: 'not_attempted',
        registrationIsRedacted: false,
        registrationFetchedAt: null,
        registrationSource: 'rdap',
        registrationEvents: [],
        firstSeenDate: null,
        firstSeenStatus: 'not_attempted',
        firstSeenSource: null,
        firstSeenFetchedAt: null,
        sourceKeywords: o.sourceKeywords,
        sourceRanks: o.sourceRanks,
        domainAgeDays: null,
        observedAt: nowIso,
        cacheHit: false,
        cacheStatus: 'none',
        omitted: true,
        omitReason: 'domain_cap',
        fetchedAt: nowIso,
        registrationError: null,
        firstSeenError: null,
        firstSeenSourceReason: null,
        registrationHttpStatus: null,
        registrationRequestCount: 0,
        firstSeenHttpStatus: null,
        firstSeenRequestCount: 0,
        error: null,
      });
    }
    logger(`Domain-age: ${omitted.length} domains omitted (domain cap).`);
  }

  return results;
}

function loadCompletedDomainAgeItems(store: RunStore, runId: string): Map<string, EnrichmentItemRecord> {
  const items = store.loadEnrichmentItems(runId);
  const out = new Map<string, EnrichmentItemRecord>();
  for (const item of items) {
    if (item.module === 'domain_age' && item.status === 'completed' && item.payload) {
      out.set(item.itemId, item);
    }
  }
  return out;
}

async function fetchRegistration(domain: string, rdap: RdapClient | null, fetchedAt: string): Promise<RdapRegistrationResult> {
  if (!rdap) {
    return {
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
  }
  try {
    return await rdap(domain);
  } catch (error) {
    const code = error instanceof ResearchError ? error.code : 'RDAP_ERROR';
    const httpStatus = error instanceof ResearchError ? error.httpStatus ?? null : null;
    return {
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
      httpStatus,
    };
  }
}

async function fetchFirstSeen(domain: string, firstSeen: FirstSeenClient, fetchedAt: string): Promise<FirstSeenResult> {
  try {
    return await firstSeen(domain);
  } catch (error) {
    const code = error instanceof ResearchError ? error.code : 'FIRST_SEEN_ERROR';
    const httpStatus = error instanceof ResearchError ? error.httpStatus ?? null : null;
    return {
      domain,
      firstSeenDate: null,
      status: 'error',
      error: `${code}: ${error instanceof Error ? error.message : String(error)}`,
      source: 'wayback',
      sourceReason: null,
      fetchedAt,
      requestCount: 0,
      httpStatus,
    };
  }
}

function makeUnavailable(domain: string, fetchedAt: string): FirstSeenResult {
  return {
    domain,
    firstSeenDate: null,
    status: 'unavailable',
    error: null,
    source: 'unconfigured',
    sourceReason: 'first-seen provider not configured',
    fetchedAt,
    requestCount: 0,
    httpStatus: null,
  };
}

function makeStaleQueryVersion(domain: string, fetchedAt: string, cachedVersion: number): FirstSeenResult {
  return {
    domain,
    firstSeenDate: null,
    status: 'unavailable',
    error: null,
    source: 'stale_query_version',
    sourceReason: `cached first-seen fact used query version ${cachedVersion}, current contract is ${FIRST_SEEN_QUERY_VERSION}; not served as valid`,
    fetchedAt,
    requestCount: 0,
    httpStatus: null,
  };
}

function makeExpiredFirstSeen(domain: string, fetchedAt: string, cachedStatus: FirstSeenStatus): FirstSeenResult {
  return {
    domain,
    firstSeenDate: null,
    status: 'unavailable',
    error: null,
    source: 'expired',
    sourceReason: `cached first-seen fact (status=${cachedStatus}) has expired TTL and provider is not configured; not served as valid`,
    fetchedAt,
    requestCount: 0,
    httpStatus: null,
  };
}

function registrationFromCache(cached: CachedDomainAgeEntry): RdapRegistrationResult {
  let events: RdapRegistrationResult['events'] = [];
  try {
    events = cached.registrationEvents ? JSON.parse(cached.registrationEvents) : [];
  } catch {
    events = [];
  }
  return {
    domain: cached.domain,
    registrationDate: cached.registrationDate,
    status: cached.registrationStatus,
    error: cached.registrationError ?? null,
    source: 'rdap',
    rule: cached.registrationRule,
    events,
    isRedacted: cached.registrationIsRedacted,
    fetchedAt: cached.registrationFetchedAt ?? cached.storedAt,
    requestCount: cached.registrationRequestCount,
    httpStatus: cached.registrationHttpStatus,
  };
}

function firstSeenFromCache(cached: CachedDomainAgeEntry): FirstSeenResult {
  return {
    domain: cached.domain,
    firstSeenDate: cached.firstSeenDate,
    status: cached.firstSeenStatus as FirstSeenStatus,
    error: cached.firstSeenError ?? null,
    source: cached.firstSeenSource,
    sourceReason: cached.firstSeenSourceReason,
    fetchedAt: cached.firstSeenFetchedAt ?? cached.storedAt,
    requestCount: cached.firstSeenRequestCount,
    httpStatus: cached.firstSeenHttpStatus,
  };
}

function assembleRecord(
  domain: string,
  reg: RdapRegistrationResult,
  fs: FirstSeenResult | null,
  prov: string[],
  domainRanks: Array<{ keyword: string; position: number }>,
  fetchedAt: string,
  cacheHit: boolean,
  cacheStatus: 'hit' | 'miss' | 'expired' | 'partial',
  nowMs: number,
): DomainAgeRecord {
  // firstSeen takes precedence for the combined error; registration is independent
  // and never aliases the first-seen date.
  const combinedError =
    fs && fs.status === 'error'
      ? fs.error
      : reg.status === 'error'
        ? reg.error
        : null;
  // Domain age in days from registration date to observedAt.
  let domainAgeDays: number | null = null;
  if (reg.registrationDate) {
    const regInstant = Date.parse(reg.registrationDate);
    if (!Number.isNaN(regInstant)) {
      domainAgeDays = Math.floor((nowMs - regInstant) / (24 * 60 * 60 * 1000));
    }
  }
  return {
    domain,
    registrationDate: reg.registrationDate,
    registrationStatus: reg.status,
    registrationRule: reg.rule,
    registrationIsRedacted: reg.isRedacted,
    registrationFetchedAt: reg.fetchedAt,
    registrationSource: reg.source,
    registrationEvents: reg.events.map((e) => ({ eventAction: e.eventAction, eventDate: e.eventDate })),
    firstSeenDate: fs ? fs.firstSeenDate : null,
    firstSeenStatus: fs ? fs.status : 'unavailable',
    firstSeenSource: fs ? fs.source : 'unconfigured',
    firstSeenFetchedAt: fs ? fs.fetchedAt : null,
    sourceKeywords: prov,
    sourceRanks: domainRanks,
    domainAgeDays,
    observedAt: fetchedAt,
    cacheHit,
    cacheStatus,
    omitted: false,
    omitReason: null,
    fetchedAt,
    registrationError: reg.status === 'error' ? reg.error : null,
    firstSeenError: fs && fs.status === 'error' ? fs.error : null,
    firstSeenSourceReason: fs ? fs.sourceReason : null,
    registrationHttpStatus: reg.httpStatus,
    registrationRequestCount: reg.requestCount,
    firstSeenHttpStatus: fs ? fs.httpStatus : null,
    firstSeenRequestCount: fs ? fs.requestCount : 0,
    error: combinedError,
  };
}

// Build the cache entry, preserving cached expiry/fetchedAt for any reused source
// so that refreshing one fact does not reset the sibling's TTL window.
function buildCachedEntry(
  cached: CachedDomainAgeEntry | null,
  reg: RdapRegistrationResult,
  fs: FirstSeenResult | null,
  regFetched: boolean,
  fsFetched: boolean,
  nowMs: number,
  nowIso: string,
  ttl: DomainAgeTtlSettings,
): Omit<CachedDomainAgeEntry, 'domain' | 'storedAt' | 'expiresAt'> {
  const regTtl = ttlMsForRdapStatus(reg.status, ttl);
  const regFetchedAt = regFetched ? reg.fetchedAt : cached?.registrationFetchedAt ?? nowIso;
  const regExpiresAt = regFetched
    ? new Date(nowMs + regTtl).toISOString()
    : cached?.registrationExpiresAt ?? new Date(nowMs + regTtl).toISOString();
  const regError = regFetched
    ? reg.status === 'error'
      ? reg.error
      : null
    : cached?.registrationError ?? null;

  const fsStatus = fs ? fs.status : 'unavailable';
  // 'unavailable' with no provider is stable: never set a self-renewing expiry
  // (avoids a 24h cycle that would otherwise re-derive a fact that can't change).
  const fsExpires = !fsFetched && cached?.firstSeenExpiresAt
    ? cached.firstSeenExpiresAt
    : fsStatus === 'unavailable'
      ? null
      : new Date(nowMs + ttlMsForFirstSeenStatus(fsStatus, ttl)).toISOString();
  const fsFetchedAt = fsFetched ? (fs ? fs.fetchedAt : nowIso) : cached?.firstSeenFetchedAt ?? nowIso;
  const fsError = fsFetched
    ? fs && fs.status === 'error'
      ? fs.error
      : null
    : cached?.firstSeenError ?? null;

  return {
    registrationDate: reg.registrationDate,
    registrationStatus: reg.status,
    registrationRule: reg.rule,
    registrationIsRedacted: reg.isRedacted,
    registrationFetchedAt: regFetchedAt,
    registrationExpiresAt: regExpiresAt,
    registrationError: regError,
    registrationRequestCount: regFetched ? reg.requestCount : cached?.registrationRequestCount ?? reg.requestCount,
    registrationHttpStatus: regFetched ? reg.httpStatus : cached?.registrationHttpStatus ?? reg.httpStatus,
    registrationEvents: JSON.stringify(reg.events),
    firstSeenDate: fs ? fs.firstSeenDate : null,
    firstSeenStatus: fsStatus,
    firstSeenSource: fs ? fs.source : cached?.firstSeenSource ?? 'unconfigured',
    firstSeenFetchedAt: fsFetchedAt,
    firstSeenExpiresAt: fsExpires,
    firstSeenError: fsError,
    firstSeenRequestCount: fsFetched ? (fs ? fs.requestCount : 0) : cached?.firstSeenRequestCount ?? 0,
    firstSeenHttpStatus: fsFetched ? (fs ? fs.httpStatus : null) : cached?.firstSeenHttpStatus ?? null,
    firstSeenQueryVersion: fsFetched ? FIRST_SEEN_QUERY_VERSION : cached?.firstSeenQueryVersion ?? FIRST_SEEN_QUERY_VERSION,
    firstSeenEvents: '',
    firstSeenSourceReason: fs ? fs.sourceReason : null,
    error: combinedError(reg, fs),
  };
}

function combinedError(reg: RdapRegistrationResult, fs: FirstSeenResult | null): string | null {
  if (fs && fs.status === 'error') return fs.error;
  if (reg.status === 'error') return reg.error;
  return null;
}

function checkpoint(
  store: RunStore | null,
  runId: string,
  domain: string,
  status: 'running' | 'completed' | 'error' | 'not_attempted',
  source: 'rdap' | 'cache' | 'checkpoint',
  cacheStatus: EnrichmentCacheStatus,
  error: string | null,
  record: DomainAgeRecord | null,
): void {
  if (!store) return;
  // Deliberately NOT swallowed: a checkpoint DB failure must be visible and must
  // not leave a domain reported as truthfully completed. The caller (loop) lets
  // it propagate; the in-memory record is still returned but the run fails.
  store.upsertEnrichmentItem({
    enrichmentId: runId,
    itemId: domain,
    module: 'domain_age',
    status,
    source,
    cacheStatus,
    error,
    fetchedAt: record?.fetchedAt ?? new Date().toISOString(),
    requestCount: (record?.registrationRequestCount ?? 0) + (record?.firstSeenRequestCount ?? 0),
    payload: record ? JSON.stringify(record) : null,
  });
}

export const DOMAIN_AGE_CSV_HEADERS = [
  'domain',
  'registration_date',
  'registration_status',
  'registration_source',
  'registration_is_redacted',
  'registration_rule',
  'registration_fetched_at',
  'registration_events',
  'registration_error',
  'registration_http_status',
  'registration_request_count',
  'first_seen_date',
  'first_seen_status',
  'first_seen_source',
  'first_seen_source_reason',
  'first_seen_fetched_at',
  'first_seen_error',
  'first_seen_http_status',
  'first_seen_request_count',
  'domain_age_days',
  'observed_at',
  'source_keywords',
  'source_ranks',
  'cache_hit',
  'cache_status',
  'fetched_at',
  'omitted',
  'omit_reason',
  'error',
];

export function renderDomainAgeCsv(records: DomainAgeRecord[]): string {
  const rows: string[][] = [DOMAIN_AGE_CSV_HEADERS];
  for (const r of records) {
    rows.push([
      r.domain,
      r.registrationDate ?? '',
      r.registrationStatus,
      r.registrationSource,
      r.registrationIsRedacted ? 'true' : 'false',
      r.registrationRule,
      r.registrationFetchedAt ?? '',
      (r.registrationEvents ?? []).map((e) => `${e.eventAction}=${e.eventDate ?? ''}`).join('|'),
      r.registrationError ?? '',
      r.registrationHttpStatus !== null && r.registrationHttpStatus !== undefined ? String(r.registrationHttpStatus) : '',
      String(r.registrationRequestCount),
      r.firstSeenDate ?? '',
      r.firstSeenStatus,
      r.firstSeenSource ?? '',
      r.firstSeenSourceReason ?? '',
      r.firstSeenFetchedAt ?? '',
      r.firstSeenError ?? '',
      r.firstSeenHttpStatus !== null && r.firstSeenHttpStatus !== undefined ? String(r.firstSeenHttpStatus) : '',
      String(r.firstSeenRequestCount),
      r.domainAgeDays !== null && r.domainAgeDays !== undefined ? String(r.domainAgeDays) : '',
      r.observedAt,
      (r.sourceKeywords ?? []).join(','),
      (r.sourceRanks ?? []).map((rank) => `${rank.keyword}:${rank.position}`).join('|'),
      r.cacheHit ? 'true' : 'false',
      r.cacheStatus,
      r.fetchedAt,
      r.omitted ? 'true' : 'false',
      r.omitReason ?? '',
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
