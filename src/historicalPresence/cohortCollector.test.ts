import test from 'node:test';
import assert from 'node:assert/strict';
import type { EntrantCohort } from '../enrichment/entrantCohort.js';
import { HistoricalPresenceCache } from './cache.js';
import { collectCohortHistoricalPresence } from './cohortCollector.js';
import type { HistoricalPresenceClient, HistoricalPresenceResult } from './types.js';

function domain(name: string, bestRank: number, occurrenceCount = 1) {
  return {
    registrableDomain: name,
    bestRank,
    occurrenceCount,
  } as EntrantCohort['domains'][number];
}

function cohort(clusterId: string, domains: EntrantCohort['domains']): EntrantCohort {
  return { clusterId, domains } as EntrantCohort;
}

function ok(domainName: string, date: string): HistoricalPresenceResult {
  return {
    domain: domainName,
    status: 'ok',
    earliestSampledCaptureAt: date,
    earliestSampledCaptureUrl: `https://${domainName}/`,
    earliestSampledCaptureHttpStatus: '200',
    earliestMatchedCollectionId: 'CC-MAIN-2014-10',
    earliestMatchedCollectionFrom: '2014-03-01T00:00:00Z',
    earliestMatchedCollectionTo: '2014-03-31T00:00:00Z',
    historyCompleteForSelectedCollections: true,
    selectedCollectionCount: 24,
    checkedCollectionCount: 7,
    source: 'common_crawl',
    sourceReason: 'bounded sampled web-presence',
    error: null,
    fetchedAt: '2026-08-31T00:00:00.000Z',
    requestCount: 7,
    httpStatus: 200,
  };
}

function client(calls: string[]): HistoricalPresenceClient {
  return {
    source: 'common_crawl',
    queryVersion: 1,
    lookup: async (domainName) => {
      calls.push(domainName);
      return ok(domainName, '2014-03-09T00:00:00Z');
    },
  };
}

test('collector applies deterministic cross-cluster priority and explicit cap omissions', async () => {
  const calls: string[] = [];
  const cache = HistoricalPresenceCache.openInMemory();
  try {
    const result = await collectCohortHistoricalPresence({
      cohorts: [
        cohort('cluster-2', [domain('shared.test', 4, 2), domain('only-b.test', 1, 1)]),
        cohort('cluster-1', [domain('shared.test', 2, 3), domain('only-a.test', 3, 4)]),
      ],
      client: client(calls),
      cache,
      domainCap: 2,
      now: () => Date.parse('2026-08-31T00:00:00Z'),
    });

    assert.deepEqual(calls, ['only-b.test', 'shared.test']);
    assert.equal(result.summary.uniqueDomainCount, 3);
    assert.equal(result.summary.checkedDomainCount, 2);
    assert.equal(result.summary.omittedDomainCount, 1);
    assert.equal(result.domains.find((row) => row.registrableDomain === 'only-a.test')?.omitReason, 'domain_cap');
    assert.equal(result.domains.find((row) => row.registrableDomain === 'shared.test')?.priority.clusterCount, 2);
    assert.equal(result.domains.find((row) => row.registrableDomain === 'shared.test')?.priority.bestRank, 2);
  } finally {
    cache.close();
  }
});

test('fresh provider/query-matched cache avoids network and preserves cached provenance', async () => {
  const cache = HistoricalPresenceCache.openInMemory();
  const calls: string[] = [];
  try {
    cache.put(ok('cached.test', '2010-01-01T00:00:00Z'), 1, '2026-08-31T00:00:00.000Z', 60_000);
    const result = await collectCohortHistoricalPresence({
      cohorts: [cohort('cluster-1', [domain('cached.test', 1)])],
      client: client(calls),
      cache,
      now: () => Date.parse('2026-08-31T00:00:30Z'),
    });
    assert.deepEqual(calls, []);
    assert.equal(result.domains[0]?.cacheStatus, 'hit');
    assert.equal(result.domains[0]?.result?.earliestSampledCaptureAt, '2010-01-01T00:00:00Z');
    assert.equal(result.summary.cacheHitCount, 1);
    assert.equal(result.summary.networkRequestCount, 0);
  } finally {
    cache.close();
  }
});

test('query-version mismatch and expired cache entries are refetched rather than silently reused', async () => {
  const cache = HistoricalPresenceCache.openInMemory();
  const calls: string[] = [];
  try {
    cache.put(ok('mismatch.test', '2010-01-01T00:00:00Z'), 99, '2026-08-31T00:00:00.000Z', 60_000);
    cache.put(ok('expired.test', '2011-01-01T00:00:00Z'), 1, '2026-08-30T00:00:00.000Z', 1000);
    const result = await collectCohortHistoricalPresence({
      cohorts: [cohort('cluster-1', [domain('mismatch.test', 1), domain('expired.test', 2)])],
      client: client(calls),
      cache,
      now: () => Date.parse('2026-08-31T00:00:30Z'),
    });
    assert.deepEqual(calls, ['mismatch.test', 'expired.test']);
    assert.equal(result.domains.find((row) => row.registrableDomain === 'mismatch.test')?.cacheStatus, 'identity_mismatch');
    assert.equal(result.domains.find((row) => row.registrableDomain === 'expired.test')?.cacheStatus, 'expired');
  } finally {
    cache.close();
  }
});

test('provider statuses remain distinct in collection summary', async () => {
  const cache = HistoricalPresenceCache.openInMemory();
  const statuses = new Map<string, HistoricalPresenceResult['status']>([
    ['ok.test', 'ok'],
    ['none.test', 'not_found'],
    ['down.test', 'unavailable'],
    ['err.test', 'error'],
  ]);
  const statusClient: HistoricalPresenceClient = {
    source: 'common_crawl',
    queryVersion: 1,
    lookup: async (domainName) => ({
      ...ok(domainName, '2014-01-01T00:00:00Z'),
      status: statuses.get(domainName) ?? 'error',
      earliestSampledCaptureAt: domainName === 'ok.test' ? '2014-01-01T00:00:00Z' : null,
      earliestSampledCaptureUrl: domainName === 'ok.test' ? `https://${domainName}/` : null,
      error: domainName === 'err.test' ? 'boom' : null,
    }),
  };
  try {
    const result = await collectCohortHistoricalPresence({
      cohorts: [cohort('cluster-1', [
        domain('ok.test', 1), domain('none.test', 2), domain('down.test', 3), domain('err.test', 4),
      ])],
      client: statusClient,
      cache,
      now: () => Date.parse('2026-08-31T00:00:00Z'),
    });
    assert.equal(result.summary.knownPresenceDomainCount, 1);
    assert.equal(result.summary.notFoundDomainCount, 1);
    assert.equal(result.summary.unavailableDomainCount, 1);
    assert.equal(result.summary.errorDomainCount, 1);
    assert.deepEqual(result.summary.statusCounts, { error: 1, not_found: 1, ok: 1, unavailable: 1 });
  } finally {
    cache.close();
  }
});
