import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDomainAgeModule, renderDomainAgeCsv, renderDomainAgeJson, DOMAIN_AGE_CSV_HEADERS } from './domainAge.js';
import type { CacheStore, CachedDomainAgeEntry, DomainAgeTtlSettings } from '../cache/store.js';
import type { RdapClient, RdapRegistrationResult } from '../rdap/types.js';
import type { FirstSeenClient, FirstSeenResult } from '../firstseen/types.js';
import type { RunStore } from '../db/store.js';
import { ResearchError } from '../shared/errors.js';

const TTL: DomainAgeTtlSettings = {
  rdapOkMs: 180 * 24 * 60 * 60 * 1000,
  rdapNotFoundMs: 30 * 24 * 60 * 60 * 1000,
  rdapUnsupportedMs: 30 * 24 * 60 * 60 * 1000,
  rdapErrorMs: 60 * 60 * 1000,
  firstSeenOkMs: 30 * 24 * 60 * 60 * 1000,
  firstSeenErrorMs: 60 * 60 * 1000,
  firstSeenUnavailableMs: 24 * 60 * 60 * 1000,
};

type StoreCall = {
  enrichmentId: string;
  itemId: string;
  module: string;
  status: string;
  source: string;
  cacheStatus: string;
};

function mockStore(): { store: RunStore; calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const store = {
    upsertEnrichmentItem(item: {
      enrichmentId: string;
      itemId: string;
      module: string;
      status: string;
      source: string;
      cacheStatus?: string;
    }): void {
      calls.push({
        enrichmentId: item.enrichmentId,
        itemId: item.itemId,
        module: item.module,
        status: item.status,
        source: item.source,
        cacheStatus: item.cacheStatus ?? 'none',
      });
    },
  };
  return { store: store as unknown as RunStore, calls };
}

type PutCall = { domain: string; entry: CachedDomainAgeEntry; ttlMs: number };
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
    putDomainAge(domain: string, entry: CachedDomainAgeEntry, _storedAt: string, ttlMs: number): void {
      const full: CachedDomainAgeEntry = {
        domain,
        registrationDate: entry.registrationDate,
        registrationStatus: entry.registrationStatus,
        registrationRule: entry.registrationRule,
        registrationIsRedacted: entry.registrationIsRedacted,
        firstSeenDate: entry.firstSeenDate,
        firstSeenStatus: entry.firstSeenStatus,
        firstSeenSource: entry.firstSeenSource,
        error: entry.error,
        storedAt: _storedAt,
        expiresAt: new Date(Date.parse(_storedAt) + ttlMs).toISOString(),
      };
      map.set(domain, full);
      puts.push({ domain, entry, ttlMs });
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
    fetchedAt: '2026-01-01T00:00:00.000Z',
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
    fetchedAt: '2026-01-01T00:00:00.000Z',
    requestCount: 1,
    httpStatus: 200,
    ...result,
  };
}

const FRESH_EXPERIMENT = '2026-08-23T00:00:00.000Z'; // > now below

test('fresh fetch resolves registration and first-seen and caches the result', async () => {
  let rdapCalls = 0;
  let fsCalls = 0;
  const rdap: RdapClient = (_d) => {
    rdapCalls += 1;
    return Promise.resolve(rdapEntry(_d));
  };
  const firstSeen: FirstSeenClient = (_d) => {
    fsCalls += 1;
    return Promise.resolve(fsEntry(_d));
  };
  const { cache, puts } = mockCache();
  const { store, calls } = mockStore();
  const progress: any[] = [];

  const results = await runDomainAgeModule({
    domains: ['example.com'],
    cache,
    rdap,
    firstSeen,
    ttl: TTL,
    forceRefresh: false,
    store,
    runId: 'run-1',
    logger: () => {},
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    onProgress: (p) => progress.push(p),
  });

  const record = results.get('example.com');
  assert.ok(record);
  assert.equal(record.registrationDate, '2010-05-03T04:00:00Z');
  assert.equal(record.firstSeenDate, '2001-04-09T13:50:45Z');
  assert.equal(record.cacheHit, false);
  assert.equal(record.error, null);
  assert.equal(rdapCalls, 1);
  assert.equal(fsCalls, 1);
  // Cached with the min TTL (firstSeen ok = 30d, registration ok = 180d -> 30d).
  assert.equal(puts.length, 1);
  assert.equal(puts[0]!.ttlMs, TTL.firstSeenOkMs);
  // Checkpoint recorded as completed/hit-less.
  const ck = calls.find((c) => c.itemId === 'example.com' && c.status === 'completed');
  assert.equal(ck?.module, 'domain_age');
  assert.equal(ck?.cacheStatus, 'miss');
  assert.deepEqual(progress[0], {
    stage: 'domain_age',
    completed: 1,
    total: 1,
    errors: 0,
    cacheHits: 0,
  });
});

test('cache hit avoids fetching and marks the record cached', async () => {
  let rdapCalls = 0;
  let fsCalls = 0;
  const rdap: RdapClient = () => {
    rdapCalls += 1;
    return Promise.resolve(rdapEntry('example.com'));
  };
  const firstSeen: FirstSeenClient = () => {
    fsCalls += 1;
    return Promise.resolve(fsEntry('example.com'));
  };
  const storedAt = '2026-01-01T00:00:00.000Z';
  const { cache, puts } = mockCache([
    {
      domain: 'example.com',
      registrationDate: '2005-01-01T00:00:00Z',
      registrationStatus: 'ok',
      registrationRule: 'earliest eventDate among eventAction in {registration, add, create}',
      registrationIsRedacted: false,
      firstSeenDate: '1999-12-31T23:59:59Z',
      firstSeenStatus: 'ok',
      firstSeenSource: 'wayback',
      error: null,
      storedAt,
      expiresAt: FRESH_EXPERIMENT,
    },
  ]);

  const results = await runDomainAgeModule({
    domains: ['example.com'],
    cache,
    rdap,
    firstSeen,
    ttl: TTL,
    forceRefresh: false,
    store: null,
    runId: 'run-1',
    logger: () => {},
    now: () => Date.parse(storedAt),
  });

  const record = results.get('example.com');
  assert.equal(record?.registrationDate, '2005-01-01T00:00:00Z');
  assert.equal(record?.firstSeenDate, '1999-12-31T23:59:59Z');
  assert.equal(record?.cacheHit, true);
  assert.equal(rdapCalls, 0);
  assert.equal(fsCalls, 0);
  assert.equal(puts.length, 0);
});

test('expired cache entry triggers a fresh fetch (cacheStatus expired)', async () => {
  let rdapCalls = 0;
  const rdap: RdapClient = () => {
    rdapCalls += 1;
    return Promise.resolve(rdapEntry('example.com'));
  };
  const storedAt = '2026-01-01T00:00:00.000Z';
  const { cache, puts } = mockCache([
    {
      domain: 'example.com',
      registrationDate: '2005-01-01T00:00:00Z',
      registrationStatus: 'ok',
      registrationRule: 'single',
      registrationIsRedacted: false,
      firstSeenDate: null,
      firstSeenStatus: 'unavailable',
      firstSeenSource: 'unconfigured',
      error: null,
      storedAt,
      expiresAt: '2026-01-01T00:00:00.000Z', // == now -> not fresh -> expired
    },
  ]);
  const { store, calls } = mockStore();

  await runDomainAgeModule({
    domains: ['example.com'],
    cache,
    rdap,
    firstSeen: null,
    ttl: TTL,
    forceRefresh: false,
    store,
    runId: 'run-1',
    logger: () => {},
    now: () => Date.parse(storedAt),
  });

  assert.equal(rdapCalls, 1);
  assert.equal(puts.length, 1);
  assert.equal(calls.find((c) => c.itemId === 'example.com' && c.status === 'completed')?.cacheStatus, 'expired');
});

test('forceRefresh bypasses the cache even when fresh', async () => {
  let rdapCalls = 0;
  const rdap: RdapClient = () => {
    rdapCalls += 1;
    return Promise.resolve(rdapEntry('example.com'));
  };
  const storedAt = '2026-01-01T00:00:00.000Z';
  const { cache } = mockCache([
    {
      domain: 'example.com',
      registrationDate: '2000-01-01T00:00:00Z',
      registrationStatus: 'ok',
      registrationRule: 'single',
      registrationIsRedacted: false,
      firstSeenDate: null,
      firstSeenStatus: 'unavailable',
      firstSeenSource: 'unconfigured',
      error: null,
      storedAt,
      expiresAt: FRESH_EXPERIMENT,
    },
  ]);

  await runDomainAgeModule({
    domains: ['example.com'],
    cache,
    rdap,
    firstSeen: null,
    ttl: TTL,
    forceRefresh: true,
    store: null,
    runId: 'run-1',
    logger: () => {},
    now: () => Date.parse(storedAt),
  });

  assert.equal(rdapCalls, 1);
});

test('RDAP rate-limit (thrown) surfaces as a per-domain error, not a run crash', async () => {
  const rdap: RdapClient = () => {
    throw new ResearchError('RDAP_RATE_LIMIT', 'RDAP rate limited (429) after 3 attempts');
  };
  const { cache, puts } = mockCache();

  const results = await runDomainAgeModule({
    domains: ['example.com'],
    cache,
    rdap,
    firstSeen: null,
    ttl: TTL,
    forceRefresh: false,
    store: null,
    runId: 'run-1',
    logger: () => {},
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
  });

  const record = results.get('example.com')!;
  assert.equal(record.registrationStatus, 'error');
  assert.match(record.error ?? '', /RDAP_RATE_LIMIT/);
  // Errors cache with the short error TTL, not the ok TTL.
  assert.equal(puts[0]!.ttlMs, TTL.rdapErrorMs);
});

test('first-seen disabled yields unavailable with no provider calls', async () => {
  let fsCalls = 0;
  const results = await runDomainAgeModule({
    domains: ['example.com'],
    cache: mockCache().cache,
    rdap: () => Promise.resolve(rdapEntry('example.com')),
    firstSeen: null,
    ttl: TTL,
    forceRefresh: false,
    store: null,
    runId: 'run-1',
    logger: () => {},
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
  });
  void fsCalls;
  const record = results.get('example.com')!;
  assert.equal(record.firstSeenStatus, 'unavailable');
  assert.equal(record.firstSeenSource, 'unconfigured');
  assert.equal(record.firstSeenDate, null);
});

test('first-seen throw is recorded as a first-seen error', async () => {
  const results = await runDomainAgeModule({
    domains: ['example.com'],
    cache: mockCache().cache,
    rdap: () => Promise.resolve(rdapEntry('example.com')),
    firstSeen: () => Promise.reject(new ResearchError('FIRST_SEEN_ERROR', 'boom')),
    ttl: TTL,
    forceRefresh: false,
    store: null,
    runId: 'run-1',
    logger: () => {},
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
  });
  const record = results.get('example.com')!;
  assert.equal(record.firstSeenStatus, 'error');
  assert.match(record.error ?? '', /FIRST_SEEN_ERROR.*boom/);
});

test('resume: a cached domain is not re-fetched on the second run', async () => {
  let rdapCalls = 0;
  const rdap: RdapClient = () => {
    rdapCalls += 1;
    return Promise.resolve(rdapEntry('example.com'));
  };
  const storedAt = '2026-01-01T00:00:00.000Z';
  const { cache } = mockCache([
    {
      domain: 'example.com',
      registrationDate: '2010-05-03T04:00:00Z',
      registrationStatus: 'ok',
      registrationRule: 'earliest',
      registrationIsRedacted: false,
      firstSeenDate: '2001-04-09T13:50:45Z',
      firstSeenStatus: 'ok',
      firstSeenSource: 'wayback',
      error: null,
      storedAt,
      expiresAt: FRESH_EXPERIMENT,
    },
  ]);

  await runDomainAgeModule({
    domains: ['example.com'],
    cache,
    rdap,
    firstSeen: () => Promise.resolve(fsEntry('example.com')),
    ttl: TTL,
    forceRefresh: false,
    store: null,
    runId: 'run-2',
    logger: () => {},
    now: () => Date.parse(storedAt),
  });

  assert.equal(rdapCalls, 0);
});

test('deduplicates domains before fetching', async () => {
  let rdapCalls = 0;
  const rdap: RdapClient = () => {
    rdapCalls += 1;
    return Promise.resolve(rdapEntry('example.com'));
  };
  await runDomainAgeModule({
    domains: ['example.com', 'EXAMPLE.com', 'blog.example.com'],
    cache: mockCache().cache,
    rdap,
    firstSeen: null,
    ttl: TTL,
    forceRefresh: false,
    store: null,
    runId: 'run-1',
    logger: () => {},
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
  });
  assert.equal(rdapCalls, 1);
});

test('no-alias regression: null first-seen is never backfilled from registration date', async () => {
  const results = await runDomainAgeModule({
    domains: ['example.com'],
    cache: mockCache().cache,
    rdap: () =>
      Promise.resolve(rdapEntry('example.com', { registrationDate: '2010-05-03T04:00:00Z' })),
    firstSeen: null,
    ttl: TTL,
    forceRefresh: false,
    store: null,
    runId: 'run-1',
    logger: () => {},
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
  });
  const r = results.get('example.com')!;
  assert.equal(r.registrationDate, '2010-05-03T04:00:00Z');
  assert.equal(r.firstSeenDate, null);
  assert.equal(r.firstSeenStatus, 'unavailable');
});

test('no-alias regression: null registration is never backfilled from first-seen', async () => {
  const results = await runDomainAgeModule({
    domains: ['example.com'],
    cache: mockCache().cache,
    rdap: () =>
      Promise.resolve(rdapEntry('example.com', { registrationDate: null, status: 'not_found' })),
    firstSeen: () =>
      Promise.resolve(fsEntry('example.com', { firstSeenDate: '2001-04-09T13:50:45Z' })),
    ttl: TTL,
    forceRefresh: false,
    store: null,
    runId: 'run-1',
    logger: () => {},
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
  });
  const r = results.get('example.com')!;
  assert.equal(r.registrationDate, null);
  assert.equal(r.firstSeenDate, '2001-04-09T13:50:45Z');
  assert.equal(r.registrationStatus, 'not_found');
});

test('cancellation stops early without re-throwing', async () => {
  let rdapCalls = 0;
  const rdap: RdapClient = () => {
    rdapCalls += 1;
    return Promise.resolve(rdapEntry('example.com'));
  };
  const signal = { cancelled: false };
  const results = await runDomainAgeModule({
    domains: ['example.com', 'other.com'],
    cache: mockCache().cache,
    rdap,
    firstSeen: null,
    ttl: TTL,
    forceRefresh: false,
    store: null,
    runId: 'run-1',
    logger: () => {},
    now: () => 0,
    signal,
  });
  // Cancel before the loop observes it would still complete the first item.
  signal.cancelled = true;
  // Run a fresh invocation that sees cancellation immediately.
  rdapCalls = 0;
  await runDomainAgeModule({
    domains: ['a.com', 'b.com'],
    cache: mockCache().cache,
    rdap,
    firstSeen: null,
    ttl: TTL,
    forceRefresh: false,
    store: null,
    runId: 'run-1',
    logger: () => {},
    now: () => 0,
    signal: { cancelled: true },
  });
  assert.equal(rdapCalls, 0);
  assert.equal(results.size, 2); // prior run completed both
  void results;
});

test('renderDomainAgeCsv writes the documented headers and quoted cells', () => {
  const records = [
    {
      domain: 'example.com',
      registrationDate: '2010-05-03T04:00:00Z',
      registrationStatus: 'ok',
      registrationRule: 'earliest',
      registrationIsRedacted: false,
      registrationFetchedAt: '2026-01-01T00:00:00.000Z',
      firstSeenDate: '2001-04-09T13:50:45Z',
      firstSeenStatus: 'ok',
      firstSeenSource: 'wayback',
      firstSeenFetchedAt: '2026-01-01T00:00:00.000Z',
      cacheHit: false,
      fetchedAt: '2026-01-01T00:00:00.000Z',
      error: null,
    } as const,
  ];
  const csv = renderDomainAgeCsv(records);
  const lines = csv.split('\r\n');
  assert.deepEqual(
    lines[0]!.split(','),
    DOMAIN_AGE_CSV_HEADERS.map((h) => `"${h}"`),
  );
  assert.equal(lines.length, 2);
  assert.match(lines[1] ?? '', /"example\.com"/);
  // cacheHit=false ("false") and registrationIsRedacted=false ("false").
  assert.equal((lines[1] ?? '').match(/"false"/g)?.length, 2);
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
      firstSeenDate: null,
      firstSeenStatus: 'unavailable',
      firstSeenSource: 'unconfigured',
      firstSeenFetchedAt: null,
      cacheHit: true,
      fetchedAt: '2026-01-01T00:00:00.000Z',
      error: null,
    } as const,
  ]);
  const parsed = JSON.parse(json);
  assert.equal(parsed[0]!.firstSeenStatus, 'unavailable');
  assert.equal(parsed[0]!.cacheHit, true);
});
