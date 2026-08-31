import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMON_CRAWL_USER_AGENT,
  createCommonCrawlHistoryClient,
  parseCommonCrawlCollections,
  type CommonCrawlClientConfig,
  type CommonCrawlCollection,
} from './commonCrawl.js';

function response(body: string, status = 200): Response {
  return new Response(body, { status });
}

function config(fetchImpl: typeof fetch): CommonCrawlClientConfig {
  return {
    timeoutMs: 1_000,
    minDelayMs: 0,
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 1,
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
  };
}

function collection(): CommonCrawlCollection {
  return {
    id: 'CC-MAIN-2026-34',
    name: 'CC-MAIN-2026-34',
    cdxApi: 'https://index.commoncrawl.org/CC-MAIN-2026-34-index',
    from: '2026-08-07T10:18:45Z',
    to: '2026-08-20T01:52:41Z',
  };
}

test('timezone-less collinfo timestamps are normalized as UTC', () => {
  const parsed = parseCommonCrawlCollections([{
    id: 'CC-MAIN-2026-34',
    name: 'August 2026 Index',
    'cdx-api': 'https://index.commoncrawl.org/CC-MAIN-2026-34-index',
    from: '2026-08-07T10:18:45',
    to: '2026-08-20T01:52:41',
  }]);

  assert.equal(parsed[0]?.from, '2026-08-07T10:18:45Z');
  assert.equal(parsed[0]?.to, '2026-08-20T01:52:41Z');
});

test('Common Crawl no-capture 404 is evidence-level not_found, not an error', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return response('{"message":"No Captures found for: example.invalid"}', 404);
  }) as typeof fetch;

  const result = await createCommonCrawlHistoryClient(config(fetchImpl))
    .lookupDomain('example.invalid', [collection()]);

  assert.equal(result.status, 'not_found');
  assert.equal(result.requestCount, 1);
  assert.equal(result.attempts[0]?.status, 'not_found');
  assert.equal(result.attempts[0]?.httpStatus, 404);
  assert.equal(calls, 1);
});

test('an unrelated HTTP 404 remains an error', async () => {
  const fetchImpl = (async () => response('route missing', 404)) as typeof fetch;
  const result = await createCommonCrawlHistoryClient(config(fetchImpl))
    .lookupDomain('example.com', [collection()]);

  assert.equal(result.status, 'error');
  assert.equal(result.attempts[0]?.httpStatus, 404);
});

test('requests use an explicit Common Crawl-friendly User-Agent', async () => {
  let observed: string | null = null;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    observed = new Headers(init?.headers).get('user-agent');
    return response('');
  }) as typeof fetch;

  await createCommonCrawlHistoryClient(config(fetchImpl))
    .lookupDomain('example.com', [collection()]);

  assert.equal(observed, COMMON_CRAWL_USER_AGENT);
});

test('archive response status remains inspectable separately from CDX HTTP status', async () => {
  const fetchImpl = (async () => response(
    '{"timestamp":"20260810000000","url":"http://example.com/","status":"301","urlkey":"com,example)/"}\n',
  )) as typeof fetch;

  const result = await createCommonCrawlHistoryClient(config(fetchImpl))
    .lookupDomain('example.com', [collection()]);

  assert.equal(result.status, 'ok');
  assert.equal(result.earliestSampledCaptureHttpStatus, '301');
  assert.equal(result.attempts[0]?.captureHttpStatus, '301');
  assert.equal(result.attempts[0]?.httpStatus, 200);
});
