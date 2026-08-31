import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupHistoricalDomains,
  parseHistoricalDomainFixture,
  renderHistoricalSpikeCsv,
  runHistoricalSourceSpike,
  type HistoricalSpikeDeps,
} from './spike.js';
import type { CommonCrawlCollection, CommonCrawlDomainResult } from './commonCrawl.js';
import type { FirstSeenResult } from '../../firstseen/types.js';

const HEADER = 'domain,dataset,source_run_id,source_enrichment_id,registration_date,registration_status,source_keywords,source_ranks,observed_at\n';

function row(values: string[]): string {
  return values.map((value) => value.includes(',') ? `"${value}"` : value).join(',') + '\n';
}

function ccCollection(id = 'CC-MAIN-2026-34'): CommonCrawlCollection {
  return {
    id,
    name: id,
    cdxApi: `https://index.commoncrawl.org/${id}-index`,
    from: '2026-08-01T00:00:00Z',
    to: '2026-08-15T00:00:00Z',
  };
}

function ccResult(domain: string, date: string | null, status: CommonCrawlDomainResult['status'] = date ? 'ok' : 'not_found'): CommonCrawlDomainResult {
  return {
    domain,
    status,
    earliestSampledCaptureAt: date,
    earliestSampledCaptureUrl: date ? `https://${domain}/` : null,
    earliestSampledCaptureHttpStatus: date ? '200' : null,
    earliestMatchedCollectionId: date ? 'CC-MAIN-2026-34' : null,
    earliestMatchedCollectionFrom: date ? '2026-08-01T00:00:00Z' : null,
    earliestMatchedCollectionTo: date ? '2026-08-15T00:00:00Z' : null,
    historyCompleteForSelectedCollections: status === 'ok' || status === 'not_found',
    selectedCollectionCount: 1,
    checkedCollectionCount: 1,
    requestCount: 1,
    requestLatenciesMs: [25],
    attempts: [],
    source: 'common_crawl',
    sourceReason: null,
  };
}

function wayback(domain: string, date: string | null, status: FirstSeenResult['status'] = date ? 'ok' : 'not_found'): FirstSeenResult {
  return {
    domain,
    firstSeenDate: date,
    status,
    error: null,
    source: 'wayback',
    sourceReason: null,
    fetchedAt: '2026-08-31T00:00:00Z',
    requestCount: 1,
    httpStatus: 200,
  };
}

function deps(
  commonCrawlLookup: (domain: string) => CommonCrawlDomainResult,
  waybackLookup: (domain: string) => FirstSeenResult,
): HistoricalSpikeDeps {
  let clock = Date.parse('2026-08-31T00:00:00Z');
  return {
    commonCrawl: {
      loadCollections: async () => [ccCollection()],
      lookupDomain: async (domain) => commonCrawlLookup(domain),
    },
    wayback: async (domain) => waybackLookup(domain),
    now: () => {
      clock += 10;
      return clock;
    },
  };
}

test('fixture parser preserves persisted research provenance and groups duplicate domains', () => {
  const content = HEADER
    + row(['example.com', 'dataset-a', 'run-a', 'enrich-a', '2020-01-01T00:00:00Z', 'ok', 'alpha,beta', 'alpha:1|beta:2', '2026-08-30T00:00:00Z'])
    + row(['example.com', 'dataset-b', 'run-b', 'enrich-b', '2020-01-01T00:00:00Z', 'ok', 'gamma', 'gamma:3', '2026-08-31T00:00:00Z']);

  const parsed = parseHistoricalDomainFixture(content);
  assert.equal(parsed.length, 2);
  const grouped = groupHistoricalDomains(parsed);
  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0]?.datasets, ['dataset-a', 'dataset-b']);
  assert.deepEqual(grouped[0]?.sourceKeywords, ['alpha', 'beta', 'gamma']);
});

test('fixture parser rejects missing provenance and malformed domains', () => {
  const content = HEADER
    + row(['https://example.com/path', 'dataset-a', 'run-a', 'enrich-a', '', 'unsupported', 'alpha', 'alpha:1', '2026-08-30T00:00:00Z']);
  assert.throws(() => parseHistoricalDomainFixture(content), /hostname-only domain/);

  const missing = 'domain,dataset\nexample.com,a\n';
  assert.throws(() => parseHistoricalDomainFixture(missing), /missing required column/);
});

test('spike keeps registration, Common Crawl, and Wayback as independent evidence', async () => {
  const rows = parseHistoricalDomainFixture(
    HEADER + row(['example.com', 'dataset-a', 'run-a', 'enrich-a', '2020-01-01T00:00:00Z', 'ok', 'alpha', 'alpha:1', '2026-08-30T00:00:00Z']),
  );
  const result = await runHistoricalSourceSpike(
    {
      rows,
      collectionMode: 'latest',
      recentMonths: 18,
      maxCollections: 48,
      requestBudget: 100,
      allowLargeScan: false,
    },
    deps(
      (domain) => ccResult(domain, '2021-01-01T00:00:00Z'),
      (domain) => wayback(domain, '2019-01-01T00:00:00Z'),
    ),
  );

  const evidence = result.domains[0];
  assert.equal(evidence?.registrationDate, '2020-01-01T00:00:00Z');
  assert.equal(evidence?.commonCrawl.earliestSampledCaptureAt, '2021-01-01T00:00:00Z');
  assert.equal(evidence?.wayback.firstSeenDate, '2019-01-01T00:00:00Z');
  assert.equal(evidence?.commonCrawlBeforeRegistration, false);
  assert.equal(evidence?.waybackBeforeRegistration, true);
  assert.equal(result.comparison.waybackEarlier, 1);
  assert.equal(result.decisionGate.status, 'pending_human_review');
});

test('not_found and unavailable never become observed/negative evidence', async () => {
  const rows = parseHistoricalDomainFixture(
    HEADER + row(['example.com', 'dataset-a', 'run-a', 'enrich-a', '', 'unsupported', 'alpha', 'alpha:1', '2026-08-30T00:00:00Z']),
  );
  const result = await runHistoricalSourceSpike(
    {
      rows,
      collectionMode: 'latest',
      recentMonths: 18,
      maxCollections: 48,
      requestBudget: 100,
      allowLargeScan: false,
    },
    deps(
      (domain) => ccResult(domain, null, 'not_found'),
      (domain) => wayback(domain, null, 'unavailable'),
    ),
  );

  assert.equal(result.providerSummary.commonCrawl.ok, 0);
  assert.equal(result.providerSummary.commonCrawl.notFound, 1);
  assert.equal(result.providerSummary.wayback.ok, 0);
  assert.equal(result.providerSummary.wayback.unavailable, 1);
  assert.equal(result.comparison.neitherArchiveSourceObserved, 1);
  assert.equal(result.domains[0]?.commonCrawlBeforeRegistration, null);
  assert.equal(result.domains[0]?.waybackBeforeRegistration, null);

  const csv = renderHistoricalSpikeCsv(result);
  assert.match(csv, /example\.com/);
  assert.doesNotMatch(csv, /undefined|null/);
});

test('request budget fails before domain network work starts', async () => {
  const rows = parseHistoricalDomainFixture(
    HEADER + row(['example.com', 'dataset-a', 'run-a', 'enrich-a', '', 'unsupported', 'alpha', 'alpha:1', '2026-08-30T00:00:00Z']),
  );
  let lookups = 0;
  const localDeps: HistoricalSpikeDeps = {
    commonCrawl: {
      loadCollections: async () => [ccCollection('CC-MAIN-2025-05'), ccCollection('CC-MAIN-2026-34')],
      lookupDomain: async (domain) => {
        lookups += 1;
        return ccResult(domain, null);
      },
    },
    wayback: async (domain) => wayback(domain, null),
  };

  await assert.rejects(
    () => runHistoricalSourceSpike(
      {
        rows,
        collectionMode: 'all',
        recentMonths: 18,
        maxCollections: null,
        requestBudget: 1,
        allowLargeScan: false,
      },
      localDeps,
    ),
    /above request budget/,
  );
  assert.equal(lookups, 0);
});

test('Common Crawl collection-list failure degrades to unavailable while Wayback still runs', async () => {
  const rows = parseHistoricalDomainFixture(
    HEADER + row(['example.com', 'dataset-a', 'run-a', 'enrich-a', '2020-01-01T00:00:00Z', 'ok', 'alpha', 'alpha:1', '2026-08-30T00:00:00Z']),
  );
  let waybackCalls = 0;
  const result = await runHistoricalSourceSpike(
    {
      rows,
      collectionMode: 'annual',
      recentMonths: 18,
      maxCollections: 48,
      requestBudget: 100,
      allowLargeScan: false,
    },
    {
      commonCrawl: {
        loadCollections: async () => { throw new Error('blocked'); },
        lookupDomain: async (domain) => ccResult(domain, null),
      },
      wayback: async (domain) => {
        waybackCalls += 1;
        return wayback(domain, '2018-01-01T00:00:00Z');
      },
    },
  );

  assert.equal(result.commonCrawlScope.collectionListError, 'blocked');
  assert.equal(result.domains[0]?.commonCrawl.status, 'unavailable');
  assert.equal(result.domains[0]?.wayback.status, 'ok');
  assert.equal(waybackCalls, 1);
});
