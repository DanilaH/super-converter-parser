import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommonCrawlQuery,
  createCommonCrawlHistoryClient,
  parseCommonCrawlCaptureLines,
  parseCommonCrawlCollections,
  selectCommonCrawlCollections,
  type CommonCrawlClientConfig,
  type CommonCrawlCollection,
} from './commonCrawl.js';

function config(fetchImpl: typeof fetch): CommonCrawlClientConfig {
  return {
    timeoutMs: 1_000,
    minDelayMs: 0,
    maxAttempts: 2,
    baseDelayMs: 0,
    maxDelayMs: 1,
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
  };
}

function response(body: string, status = 200, headers?: Record<string, string>): Response {
  const init: ResponseInit = { status };
  if (headers) init.headers = headers;
  return new Response(body, init);
}

function collection(id: string, from: string, to: string): CommonCrawlCollection {
  return {
    id,
    name: id,
    cdxApi: `https://index.commoncrawl.org/${id}-index`,
    from,
    to,
  };
}

test('parses and chronologically sorts Common Crawl collection metadata', () => {
  const parsed = parseCommonCrawlCollections([
    {
      id: 'CC-MAIN-2026-34',
      name: 'August 2026 Index',
      'cdx-api': 'https://index.commoncrawl.org/CC-MAIN-2026-34-index',
      from: '2026-08-07T10:18:45Z',
      to: '2026-08-20T01:52:41Z',
    },
    {
      id: 'CC-MAIN-2025-05',
      name: 'January 2025 Index',
      'cdx-api': 'https://index.commoncrawl.org/CC-MAIN-2025-05-index',
      from: '2025-01-12T19:43:58Z',
      to: '2025-01-26T16:54:02Z',
    },
  ]);

  assert.deepEqual(parsed.map((item) => item.id), ['CC-MAIN-2025-05', 'CC-MAIN-2026-34']);
});

test('rejects collection metadata that redirects the CDX endpoint off Common Crawl', () => {
  assert.throws(() => parseCommonCrawlCollections([
    {
      id: 'CC-MAIN-2026-34',
      'cdx-api': 'https://evil.example/cdx',
    },
  ]), /Refusing non-Common-Crawl/);
});

test('annual selection keeps one old anchor per year plus recent crawls', () => {
  const collections = [
    collection('CC-MAIN-2023-05', '2023-01-01T00:00:00Z', '2023-01-15T00:00:00Z'),
    collection('CC-MAIN-2023-40', '2023-10-01T00:00:00Z', '2023-10-15T00:00:00Z'),
    collection('CC-MAIN-2024-05', '2024-01-01T00:00:00Z', '2024-01-15T00:00:00Z'),
    collection('CC-MAIN-2025-05', '2025-01-01T00:00:00Z', '2025-01-15T00:00:00Z'),
    collection('CC-MAIN-2025-30', '2025-07-01T00:00:00Z', '2025-07-15T00:00:00Z'),
    collection('CC-MAIN-2026-04', '2026-01-01T00:00:00Z', '2026-01-15T00:00:00Z'),
    collection('CC-MAIN-2026-34', '2026-08-01T00:00:00Z', '2026-08-15T00:00:00Z'),
  ];
  const selected = selectCommonCrawlCollections(collections, 'annual', {
    nowMs: Date.parse('2026-08-31T00:00:00Z'),
    recentMonths: 18,
  });

  assert.deepEqual(selected.map((item) => item.id), [
    'CC-MAIN-2023-05',
    'CC-MAIN-2024-05',
    'CC-MAIN-2025-05',
    'CC-MAIN-2025-30',
    'CC-MAIN-2026-04',
    'CC-MAIN-2026-34',
  ]);
});

test('query is domain-scoped, 200-only, and deliberately one-record existence evidence', () => {
  const query = buildCommonCrawlQuery(
    'https://index.commoncrawl.org/CC-MAIN-2026-34-index',
    'example.com',
  );
  const url = new URL(query);
  assert.equal(url.searchParams.get('url'), 'example.com');
  assert.equal(url.searchParams.get('output'), 'json');
  assert.equal(url.searchParams.get('matchType'), 'domain');
  assert.equal(url.searchParams.get('filter'), 'status:200');
  assert.equal(url.searchParams.get('fl'), 'timestamp,url,status,urlkey');
  assert.equal(url.searchParams.get('limit'), '1');
});

test('CDX parser preserves a real capture and rejects malformed evidence', () => {
  const capture = parseCommonCrawlCaptureLines(
    '{"timestamp":"20251014220259","url":"https://example.com/a","status":"200","urlkey":"com,example)/a"}\n',
  );
  assert.deepEqual(capture, {
    timestamp: '2025-10-14T22:02:59Z',
    url: 'https://example.com/a',
    status: '200',
    urlKey: 'com,example)/a',
  });
  assert.equal(parseCommonCrawlCaptureLines('\n'), null);
  assert.throws(() => parseCommonCrawlCaptureLines('{bad json}\n'), /Malformed/);
});

test('domain lookup walks selected crawls oldest-first and stops on first sampled presence', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url.includes('2024-05')) return response('');
    if (url.includes('2025-05')) {
      return response('{"timestamp":"20250113000000","url":"https://example.com/","status":"200","urlkey":"com,example)/"}\n');
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const client = createCommonCrawlHistoryClient(config(fetchImpl));
  const result = await client.lookupDomain('example.com', [
    collection('CC-MAIN-2024-05', '2024-01-01T00:00:00Z', '2024-01-15T00:00:00Z'),
    collection('CC-MAIN-2025-05', '2025-01-01T00:00:00Z', '2025-01-15T00:00:00Z'),
    collection('CC-MAIN-2026-05', '2026-01-01T00:00:00Z', '2026-01-15T00:00:00Z'),
  ]);

  assert.equal(result.status, 'ok');
  assert.equal(result.earliestMatchedCollectionId, 'CC-MAIN-2025-05');
  assert.equal(result.earliestSampledCaptureAt, '2025-01-13T00:00:00Z');
  assert.equal(result.checkedCollectionCount, 2);
  assert.equal(result.historyCompleteForSelectedCollections, true);
  assert.equal(seen.length, 2);
});

test('an earlier collection error keeps later presence but marks earliest-history qualification incomplete', async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('2024-05')) return response('oops', 500);
    return response('{"timestamp":"20250113000000","url":"https://example.com/","status":"200"}\n');
  }) as typeof fetch;
  const cfg = config(fetchImpl);
  cfg.maxAttempts = 1;
  const client = createCommonCrawlHistoryClient(cfg);
  const result = await client.lookupDomain('example.com', [
    collection('CC-MAIN-2024-05', '2024-01-01T00:00:00Z', '2024-01-15T00:00:00Z'),
    collection('CC-MAIN-2025-05', '2025-01-01T00:00:00Z', '2025-01-15T00:00:00Z'),
  ]);

  assert.equal(result.status, 'ok');
  assert.equal(result.historyCompleteForSelectedCollections, false);
  assert.match(result.sourceReason ?? '', /earlier selected collection failed/);
});

test('HTTP access block opens the provider circuit and later domains fail closed as unavailable', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return response('blocked', 403);
  }) as typeof fetch;
  const client = createCommonCrawlHistoryClient(config(fetchImpl));
  const collections = [
    collection('CC-MAIN-2026-34', '2026-08-01T00:00:00Z', '2026-08-15T00:00:00Z'),
  ];

  const first = await client.lookupDomain('one.example', collections);
  const second = await client.lookupDomain('two.example', collections);
  assert.equal(first.status, 'unavailable');
  assert.equal(second.status, 'unavailable');
  assert.equal(second.requestCount, 0);
  assert.equal(calls, 1);
});

test('429 respects bounded Retry-After then succeeds', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fetchImpl = (async () => {
    calls += 1;
    return calls === 1
      ? response('rate limited', 429, { 'Retry-After': '999' })
      : response('{"timestamp":"20260810000000","url":"https://example.com/","status":"200"}\n');
  }) as typeof fetch;
  const cfg = config(fetchImpl);
  cfg.maxDelayMs = 250;
  cfg.sleep = async (ms) => { sleeps.push(ms); };
  const client = createCommonCrawlHistoryClient(cfg);
  const result = await client.lookupDomain('example.com', [
    collection('CC-MAIN-2026-34', '2026-08-01T00:00:00Z', '2026-08-15T00:00:00Z'),
  ]);

  assert.equal(result.status, 'ok');
  assert.equal(result.requestCount, 2);
  assert.deepEqual(sleeps, [250]);
});
