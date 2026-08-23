import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDomainAgeModule, renderDomainAgeCsv, renderDomainAgeJson, DOMAIN_AGE_CSV_HEADERS } from './domainAge.js';
import type { CacheStore, CachedDomainAgeEntry, DomainAgeTtlSettings } from '../cache/store.js';
import type { RdapClient, RdapRegistrationResult } from '../rdap/types.js';
import type { FirstSeenClient, FirstSeenResult } from '../firstseen/types.js';
import type { RunStore } from '../db/store.js';
import type { EnrichmentItemRecord } from '../enrichment/types.js';
import { ResearchError } from '../shared/errors.js';
import type { DomainAgeRecord } from './domainAge.js';

const TTL: DomainAgeTtlSettings = {
  rdapOkMs: 180 * 24 * 60 * 60 * 1000,
  rdapNotFoundMs: 30 * 24 * 60 * 60 * 1000,
  rdapUnsupportedMs: 30 * 24 * 60 * 60 * 1000,
  rdapErrorMs: 60 * 60 * 1000,
  firstSeenOkMs: 30 * 24 * 60 * 60 * 1000,
  firstSeenErrorMs: 60 * 60 * 1000,
  firstSeenUnavailableMs: 24 * 60 * 60 * 1000,
};

const NOW_ISO = '2026-01-01T00:00:00.000Z';
const FUTURE = '2026-08-23T00:00:00.000Z'; // well past now
const PAST = '2025-01-01T00:00:00.000Z'; // expired

type PutCall = { domain: string; entry: Omit<CachedDomainAgeEntry, 'domain' | 'storedAt' | 'expiresAt'> };
type StoreCall = {
  enrichmentId: string;
  itemId: string;
  module: string;
  status: string;
  source: string;
  cacheStatus: string;
  payload: string | null;
};

function fullCached(domain: string, overrides: Partial<CachedDomainAgeEntry> = {}): CachedDomainAgeEntry {
  return {
    domain,
    registrationDate: '2010-05-03T04:00:00Z',
    registrationStatus: 'ok',
    registrationRule: 'earliest eventDate among eventAction in {registration, add, create}',
    registrationIsRedacted: false,
    registrationFetchedAt: NOW_ISO,
    registrationExpiresAt: FUTURE,
    registrationError: null,
    registrationRequestCount: 1,
    registrationHttpStatus: 200,
    firstSeenDate: '2001-04-09T13:50:45Z',
    firstSeenStatus: 'ok',
    firstSeenSource: 'wayback',
    firstSeenFetchedAt: NOW_ISO,
    firstSeenExpiresAt: FUTURE,
    firstSeenError: null,
    firstSeenRequestCount: 1,
    firstSeenHttpStatus: 200,
    error: null,
    storedAt: NOW_ISO,
    expiresAt: FUTURE,
    ...overrides,
  };
}

function mockStore(completed?: Map<string, DomainAgeRecord>): { store: RunStore; calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const seed = completed ?? new Map<string, DomainAgeRecord>();
  const store = {
    upsertEnrichmentItem(item: {
      enrichmentId: string;
      itemId: string;
      module: string;
      status: string;
      source: string;
      cacheStatus?: string;
      error?: string | null;
      fetchedAt?: string | null;
      payload?: string | null;
    }): void {
      calls.push({
        enrichmentId: item.enrichmentId,
        itemId: item.itemId,
        module: item.module,
        status: item.status,
        source: item.source,
        cacheStatus: item.cacheStatus ?? 'none',
        payload: item.payload ?? null,
      });
    },
    loadEnrichmentItems(_runId: string): EnrichmentItemRecord[] {
      return [...seed.entries()].map(
        ([itemId, payload]): EnrichmentItemRecord => ({
          enrichmentId: _runId,
          itemId,
          module: 'domain_age',
          status: 'completed',
          source: 'checkpoint',
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          requestCount: 0,
          fetchedAt: payload.fetchedAt,
          cacheStatus: 'hit',
          error: payload.error,
          payload: JSON.stringify(payload),
        }),
      );
    },
  };
  return { store: store as unknown as RunStore, calls };
}

function mockCache(seed: CachedDomainAgeEntry[] = []): {
  cache: CacheStore;
  puts: PutCall[];
  get: (domain: string) => CachedDomainAgeEntry | null;
} {
  const map = new Map<string, CachedDomainAgeEntry>();
  for (const e of seed) map.set(e.domain, e);
  const puts: PutCall[] = [];
  const cache = {
    getDomainAge(domain: string): CachedDomainAgeEntry | null {
      return map.get(domain) ?? null;
    },
    putDomainAge(
      domain: string,
      entry: Omit<CachedDomainAgeEntry, 'domain' | 'storedAt' | 'expiresAt'>,
    ): void {
      const regExp = entry.registrationExpiresAt ? Date.parse(entry.registrationExpiresAt) : Number.POSITIVE_INFINITY;
      const fsExp = entry.firstSeenExpiresAt ? Date.parse(entry.firstSeenExpiresAt) : Number.POSITIVE_INFINITY;
      const rowExp = Math.min(regExp, fsExp);
      map.set(domain, {
        ...entry,
        domain,
        storedAt: entry.registrationFetchedAt ?? NOW_ISO,
        expiresAt: Number.isFinite(rowExp) ? new Date(rowExp).toISOString() : '',
      });
      puts.push({ domain, entry });
    },
  };
  return { cache: cache as unknown as CacheStore, puts, get: (d) => map.get(d) ?? null };
}

function rdapEntry(domain: string, result: Partial<RdapRegistrationResult> = {}): RdapRegistrationResult {
  return {
    domain,
    registrationDate: '2010-05-03T04:00:00Z',
    status: 'ok',
    error: null,
    source: 'rdap',
    rule: 'earliest eventDate among eventAction in {registration, add, create}',
    events: [],
    isRedacted: false,
    fetchedAt: NOW_ISO,
    requestCount: 1,
    httpStatus: 200,
    ...result,
  };
}

function fsEntry(domain: string, result: Partial<FirstSeenResult> = {}): FirstSeenResult {
  return {
    domain,
    firstSeenDate: '2001-04-09T13:50:45Z',
    status: 'ok',
    error: null,
    source: 'wayback',
    sourceReason: null,
    fetchedAt: NOW_ISO,
    requestCount: 1,
    httpStatus: 200,
    ...result,
  };
}

async function runOne(opts: {
  domains: string[];
  cache?: CacheStore;
  rdap?: RdapClient | null;
  firstSeen?: FirstSeenClient | null;
  store?: RunStore | null;
  completed?: Map<string, DomainAgeRecord>;
  resume?: boolean;
  forceRefresh?: boolean;
  signal?: { cancelled: boolean };
  provenance?: Map<string, string[]>;
  now?: () => number;
}): Promise<{ results: Map<string, DomainAgeRecord>; rdapCalls: { v: number }; fsCalls: { v: number } }> {
  const rdapCalls = { v: 0 };
  const fsCalls = { v: 0 };
  // Respect an explicit `null` (provider disabled) — do not fall back via `??`,
  // which would treat null as "use default".
  const rdap: RdapClient | null = opts.rdap !== undefined
    ? opts.rdap
    : ((d) => { rdapCalls.v += 1; return Promise.resolve(rdapEntry(d)); });
  const firstSeen: FirstSeenClient | null = opts.firstSeen !== undefined
    ? opts.firstSeen
    : ((d) => { fsCalls.v += 1; return Promise.resolve(fsEntry(d)); });
  const cache = opts.cache ?? mockCache().cache;
  const storeInfo = opts.store ? { store: opts.store } : mockStore(opts.completed);
  const results = await runDomainAgeModule({
    domains: opts.domains,
    cache,
    rdap,
    firstSeen,
    ttl: TTL,
    forceRefresh: opts.forceRefresh ?? false,
    store: storeInfo.store,
    runId: 'run-1',
    logger: () => {},
    now: opts.now ?? (() => Date.parse(NOW_ISO)),
    onProgress: () => {},
    resume: opts.resume ?? false,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.provenance ? { provenance: opts.provenance } : {}),
  });
  return { results, rdapCalls, fsCalls };
}

test('fresh fetch resolves registration and first-seen and caches per-source TTLs', async () => {
  const { cache, puts } = mockCache();
  const { results, rdapCalls, fsCalls } = await runOne({
    domains: ['example.com'],
    cache,
    provenance: new Map([['example.com', ['json diff']]]),
  });

  const record = results.get('example.com')!;
  assert.equal(record.registrationDate, '2010-05-03T04:00:00Z');
  assert.equal(record.firstSeenDate, '2001-04-09T13:50:45Z');
  assert.equal(record.cacheHit, false);
  assert.equal(record.error, null);
  assert.deepEqual(record.sourceKeywords, ['json diff']);
  assert.equal(rdapCalls.v, 1);
  assert.equal(fsCalls.v, 1);

  assert.equal(puts.length, 1);
  // Independent per-source expiries, not a single combined TTL.
  assert.equal(puts[0]!.entry.registrationExpiresAt, new Date(Date.parse(NOW_ISO) + TTL.rdapOkMs).toISOString());
  assert.equal(puts[0]!.entry.firstSeenExpiresAt, new Date(Date.parse(NOW_ISO) + TTL.firstSeenOkMs).toISOString());
  assert.equal(puts[0]!.entry.registrationRequestCount, 1);
  assert.equal(puts[0]!.entry.firstSeenRequestCount, 1);
});

test('cache hit avoids both providers and does not rewrite the cache', async () => {
  const cached = fullCached('example.com');
  const { cache, puts } = mockCache([cached]);
  const res = await runOne({ domains: ['example.com'], cache, now: () => Date.parse(NOW_ISO) });
  const rec = res.results.get('example.com')!;
  assert.equal(rec.cacheHit, true);
  assert.equal(res.rdapCalls.v, 0);
  assert.equal(res.fsCalls.v, 0);
  assert.equal(puts.length, 0);
});

test('expired registration only triggers partial refresh: registration refetched, first-seen (unavailable) reused', async () => {
  // first-seen is unavailable (no provider). registration cache is expired.
  const cached = fullCached('example.com', {
    registrationExpiresAt: PAST,
    firstSeenStatus: 'unavailable',
    firstSeenSource: 'unconfigured',
    firstSeenDate: null,
    firstSeenExpiresAt: null,
    firstSeenFetchedAt: null,
    error: 'registration event redacted or absent',
  });
  const { cache, puts } = mockCache([cached]);
  const res = await runOne({
    domains: ['example.com'],
    cache,
    firstSeen: null,
    now: () => Date.parse(NOW_ISO),
  });
  // Registration expired -> refetched; no first-seen provider -> no network call.
  assert.equal(res.rdapCalls.v, 1);
  assert.equal(res.fsCalls.v, 0);
  assert.equal(res.results.get('example.com')!.cacheHit, false);
  // Only the registration TTL is refreshed; first-seen stays unavailable.
  assert.equal(res.results.get('example.com')!.firstSeenStatus, 'unavailable');
  assert.equal(res.results.get('example.com')!.firstSeenDate, null);
  // Cache is rewritten (registration was refreshed).
  assert.equal(puts.length, 1);
});

test('partial refresh: fresh registration, expired first-seen -> only first-seen refetched', async () => {
  let fsCalls = 0;
  const fs: FirstSeenClient = () => { fsCalls += 1; return Promise.resolve(fsEntry('example.com')); };
  const cached = fullCached('example.com', {
    registrationExpiresAt: FUTURE, // fresh
    firstSeenExpiresAt: PAST, // expired
    firstSeenDate: '2001-04-09T13:50:45Z',
  });
  const { cache, puts } = mockCache([cached]);
  let rdapCalls = 0;
  const rdap: RdapClient = () => { rdapCalls += 1; return Promise.resolve(rdapEntry('example.com')); };
  const res = await runOne({ domains: ['example.com'], cache, rdap, firstSeen: fs, now: () => Date.parse(NOW_ISO) });
  // Registration fresh -> not refetched; first-seen expired -> refetched.
  assert.equal(rdapCalls, 0);
  assert.equal(fsCalls, 1);
  assert.equal(res.results.get('example.com')!.cacheHit, false);
  // Registration date preserved from cache (not re-fetched).
  assert.equal(res.results.get('example.com')!.registrationDate, '2010-05-03T04:00:00Z');
  assert.equal(puts.length, 1);
});

test('cache hit with cached checkpoint is used as-is (registration 180d not refetched by 24h first-seen TTL)', async () => {
  // The classic bug: a stale combined expiry must NOT force a registration refetch.
  const cached = fullCached('example.com', {
    registrationExpiresAt: FUTURE, // 180d, still fresh
    firstSeenStatus: 'unavailable',
    firstSeenExpiresAt: PAST, // was 24h, now past — but unavailable is stable, reused
  });
  const { cache } = mockCache([cached]);
  const res = await runOne({ domains: ['example.com'], cache, firstSeen: null, now: () => Date.parse(NOW_ISO) });
  assert.equal(res.rdapCalls.v, 0); // registration NOT refetched
  assert.equal(res.fsCalls.v, 0); // no provider
  assert.equal(res.results.get('example.com')!.cacheHit, true);
});

test('forceRefresh bypasses the cache even when fresh', async () => {
  let rdapCalls = 0;
  const rdap: RdapClient = () => { rdapCalls += 1; return Promise.resolve(rdapEntry('example.com')); };
  const cached = fullCached('example.com', {
    registrationExpiresAt: FUTURE,
    firstSeenExpiresAt: FUTURE,
    firstSeenDate: '2001-04-09T13:50:45Z',
  });
  const { cache } = mockCache([cached]);
  await runOne({ domains: ['example.com'], cache, rdap, forceRefresh: true, now: () => Date.parse(NOW_ISO) });
  assert.equal(rdapCalls, 1);
});

test('RDAP rate-limit (thrown) surfaces as a per-domain error, not a run crash', async () => {
  const rdap: RdapClient = () => {
    throw new ResearchError('RDAP_RATE_LIMIT', 'RDAP rate limited (429) after 3 attempts');
  };
  const { cache, puts } = mockCache();
  const res = await runOne({ domains: ['example.com'], cache, rdap, firstSeen: null });
  const record = res.results.get('example.com')!;
  assert.equal(record.registrationStatus, 'error');
  assert.match(record.error ?? '', /RDAP_RATE_LIMIT/);
  // Error TTL, not the ok TTL.
  assert.equal(puts[0]!.entry.registrationStatus, 'error');
  assert.equal(puts[0]!.entry.registrationRequestCount, 0);
});

test('first-seen disabled yields unavailable with no provider calls', async () => {
  const res = await runOne({
    domains: ['example.com'],
    cache: mockCache().cache,
    rdap: () => Promise.resolve(rdapEntry('example.com')),
    firstSeen: null,
  });
  const record = res.results.get('example.com')!;
  assert.equal(record.firstSeenStatus, 'unavailable');
  assert.equal(record.firstSeenSource, 'unconfigured');
  assert.equal(record.firstSeenDate, null);
  assert.equal(record.registrationDate, '2010-05-03T04:00:00Z');
  assert.equal(res.fsCalls.v, 0);
});

test('first-seen throw is recorded as a first-seen error, not a run crash', async () => {
  const res = await runOne({
    domains: ['example.com'],
    cache: mockCache().cache,
    rdap: () => Promise.resolve(rdapEntry('example.com')),
    firstSeen: () => Promise.reject(new ResearchError('FIRST_SEEN_ERROR', 'boom')),
  });
  const record = res.results.get('example.com')!;
  assert.equal(record.firstSeenStatus, 'error');
  assert.equal(record.registrationDate, '2010-05-03T04:00:00Z');
  assert.match(record.error ?? '', /FIRST_SEEN_ERROR.*boom/);
});

test('checkpoint resume reuses persisted payload and makes no fresh calls', async () => {
  const payload: DomainAgeRecord = {
    domain: 'example.com',
    registrationDate: '2010-05-03T04:00:00Z',
    registrationStatus: 'ok',
    registrationRule: 'earliest eventDate among eventAction in {registration, add, create}',
    registrationIsRedacted: false,
    registrationFetchedAt: '2026-06-01T00:00:00.000Z',
    registrationEvents: [],
    firstSeenDate: '2001-04-09T13:50:45Z',
    firstSeenStatus: 'ok',
    firstSeenSource: 'wayback',
    firstSeenFetchedAt: '2026-06-01T00:00:00.000Z',
    sourceKeywords: ['json diff'],
    domainAgeDays: 5680,
    observedAt: '2026-06-01T00:00:00.000Z',
    cacheHit: false,
    cacheStatus: 'miss',
    fetchedAt: '2026-06-01T00:00:00.000Z',
    registrationError: null,
    firstSeenError: null,
    firstSeenSourceReason: null,
    registrationHttpStatus: 200,
    registrationRequestCount: 1,
    firstSeenHttpStatus: 200,
    firstSeenRequestCount: 1,
    error: null,
  };
  const completed = new Map<string, DomainAgeRecord>([['example.com', payload]]);
  let rdapCalls = 0;
  const rdap: RdapClient = (d) => { rdapCalls += 1; return Promise.resolve(rdapEntry(d)); };
  const { store, calls } = mockStore(completed);
  // Cache is stale, but the checkpoint (not the cache) is the source of truth on resume.
  const { cache } = mockCache([fullCached('example.com', { registrationExpiresAt: PAST, firstSeenExpiresAt: PAST })]);
  const res = await runOne({
    domains: ['example.com'],
    cache,
    rdap,
    resume: true,
    completed,
    store,
    provenance: new Map([['example.com', ['json diff']]]),
  });
  assert.equal(rdapCalls, 0);
  assert.equal(res.results.get('example.com')?.registrationDate, '2010-05-03T04:00:00Z');
  assert.deepEqual(res.results.get('example.com')?.sourceKeywords, ['json diff']);
  assert.equal(calls.find((c) => c.itemId === 'example.com' && c.status === 'completed')?.source, 'checkpoint');
  // Every persisted checkpoint carries a payload (no truthy-but-empty completion).
  assert.equal(calls.every((c) => c.payload !== null), true);
});

test('a pre-cancelled signal stops with no fetches', async () => {
  let rdapCalls = 0;
  const rdap: RdapClient = (d) => { rdapCalls += 1; return Promise.resolve(rdapEntry(d)); };
  let fsCalls = 0;
  const fsClient: FirstSeenClient = (d) => { fsCalls += 1; return Promise.resolve(fsEntry(d)); };
  const res = await runOne({
    domains: ['a.com', 'b.com'],
    cache: mockCache().cache,
    rdap,
    firstSeen: fsClient,
    signal: { cancelled: true },
  });
  assert.equal(rdapCalls, 0);
  assert.equal(fsCalls, 0);
  assert.equal(res.results.size, 0);
});

test('deduplicates domains before fetching', async () => {
  const cached = fullCached('example.com');
  const { cache } = mockCache([cached]);
  const res = await runOne({ domains: ['example.com', 'EXAMPLE.com', 'blog.example.com'], cache });
  assert.equal(res.rdapCalls.v, 0); // all dedupe to example.com, cache hit
});

test('no-alias regression: null first-seen is never backfilled from registration date', async () => {
  const res = await runOne({
    domains: ['example.com'],
    cache: mockCache().cache,
    rdap: () => Promise.resolve(rdapEntry('example.com', { registrationDate: '2010-05-03T04:00:00Z' })),
    firstSeen: null,
  });
  const r = res.results.get('example.com')!;
  assert.equal(r.registrationDate, '2010-05-03T04:00:00Z');
  assert.equal(r.firstSeenDate, null);
  assert.equal(r.firstSeenStatus, 'unavailable');
});

test('no-alias regression: null registration is never backfilled from first-seen', async () => {
  const res = await runOne({
    domains: ['example.com'],
    cache: mockCache().cache,
    rdap: () => Promise.resolve(rdapEntry('example.com', { registrationDate: null, status: 'not_found' })),
    firstSeen: () => Promise.resolve(fsEntry('example.com', { firstSeenDate: '2001-04-09T13:50:45Z' })),
  });
  const r = res.results.get('example.com')!;
  assert.equal(r.registrationDate, null);
  assert.equal(r.firstSeenDate, '2001-04-09T13:50:45Z');
  assert.equal(r.registrationStatus, 'not_found');
});

test('a pre-cancelled signal stops with no fetches', async () => {
  let rdapCalls = 0;
  const rdap: RdapClient = (d) => { rdapCalls += 1; return Promise.resolve(rdapEntry(d)); };
  let fsCalls = 0;
  const fsClient: FirstSeenClient = (d) => { fsCalls += 1; return Promise.resolve(fsEntry(d)); };
  const res = await runOne({
    domains: ['a.com', 'b.com'],
    cache: mockCache().cache,
    rdap,
    firstSeen: fsClient,
    signal: { cancelled: true },
  });
  assert.equal(rdapCalls, 0);
  assert.equal(fsCalls, 0);
  assert.equal(res.results.size, 0);
});

test('an empty run (no domains) completes without error', async () => {
  const res = await runOne({ domains: [], cache: mockCache().cache, firstSeen: null });
  assert.equal(res.results.size, 0);
});

test('renderDomainAgeCsv writes the documented headers and quoted cells', () => {
  const records: DomainAgeRecord[] = [
    {
      domain: 'example.com',
      registrationDate: '2010-05-03T04:00:00Z',
      registrationStatus: 'ok',
      registrationRule: 'earliest',
      registrationIsRedacted: false,
      registrationFetchedAt: '2026-01-01T00:00:00.000Z',
      registrationEvents: [{ eventAction: 'registration', eventDate: '2010-05-03T04:00:00Z' }],
      firstSeenDate: '2001-04-09T13:50:45Z',
      firstSeenStatus: 'ok',
      firstSeenSource: 'wayback',
      firstSeenFetchedAt: '2026-01-01T00:00:00.000Z',
      sourceKeywords: ['json diff', 'json compare'],
      domainAgeDays: 5680,
      observedAt: '2026-01-01T00:00:00.000Z',
      cacheHit: false,
      cacheStatus: 'miss',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      registrationError: null,
      firstSeenError: null,
      firstSeenSourceReason: null,
      registrationHttpStatus: 200,
      registrationRequestCount: 1,
      firstSeenHttpStatus: 200,
      firstSeenRequestCount: 1,
      error: null,
    },
  ];
  const csv = renderDomainAgeCsv(records);
  const lines = csv.split('\r\n');
  assert.deepEqual(
    lines[0]!.split(','),
    DOMAIN_AGE_CSV_HEADERS.map((h) => `"${h}"`),
  );
  assert.equal(lines.length, 2);
  assert.match(lines[1] ?? '', /"example\.com"/);
  // cacheHit=false ("false") and registrationIsRedacted=false ("false"), plus
  // provenance joined by commas.
  assert.equal((lines[1] ?? '').match(/"false"/g)?.length, 2);
  assert.match(lines[1] ?? '', /"json diff,json compare"/);
});

test('renderDomainAgeJson serializes the records', () => {
  const json = renderDomainAgeJson([
    {
      domain: 'example.com',
      registrationDate: '2010-05-03T04:00:00Z',
      registrationStatus: 'ok',
      registrationRule: 'earliest',
      registrationIsRedacted: false,
      registrationFetchedAt: '2026-01-01T00:00:00.000Z',
      registrationEvents: [],
      firstSeenDate: null,
      firstSeenStatus: 'unavailable',
      firstSeenSource: 'unconfigured',
      firstSeenFetchedAt: null,
      sourceKeywords: [],
      domainAgeDays: 5680,
      observedAt: '2026-01-01T00:00:00.000Z',
      cacheHit: true,
      cacheStatus: 'hit',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      registrationError: null,
      firstSeenError: null,
      firstSeenSourceReason: null,
      registrationHttpStatus: 200,
      registrationRequestCount: 1,
      firstSeenHttpStatus: null,
      firstSeenRequestCount: 0,
      error: null,
    },
  ]);
  const parsed = JSON.parse(json);
  assert.equal(parsed[0]!.firstSeenStatus, 'unavailable');
  assert.equal(parsed[0]!.cacheHit, true);
  assert.deepEqual(parsed[0]!.sourceKeywords, []);
});
