import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFirstSeenClient, parseFirstSeenProvider } from './client.js';
import { parseWaybackTimestamp, buildWaybackQuery, createWaybackClient } from './wayback.js';
import type { FirstSeenClientConfig } from './types.js';
import { ResearchError } from '../shared/errors.js';

function baseConfig(fetchImpl: typeof fetch): FirstSeenClientConfig {
  return {
    provider: 'wayback',
    endpoint: '',
    apiKey: null,
    timeoutMs: 5_000,
    minDelayMs: 0,
    maxAttempts: 3,
    baseDelayMs: 0,
    maxDelayMs: 1,
    fetchImpl,
  };
}

function cdxResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  const initObj: ResponseInit = { status: init?.status ?? 200 };
  if (init?.headers) initObj.headers = init.headers;
  return new Response(body === null ? null : JSON.stringify(body), initObj);
}

test('parseWaybackTimestamp converts compact UTC timestamp to ISO', () => {
  assert.equal(parseWaybackTimestamp('20100409135045'), '2010-04-09T13:50:45Z');
  assert.equal(parseWaybackTimestamp('20010101000000'), '2001-01-01T00:00:00Z');
  // Shorter timestamps are right-padded (unknown fields -> 00).
  assert.equal(parseWaybackTimestamp('20100409'), '2010-04-09T00:00:00Z');
});

test('parseWaybackTimestamp rejects garbage', () => {
  assert.equal(parseWaybackTimestamp('abc'), null);
  assert.equal(parseWaybackTimestamp('1234567'), null);
});

test('buildWaybackQuery targets the CDX endpoint with first-seen params', () => {
  const url = buildWaybackQuery('', 'example.com');
  assert.equal(url.startsWith('https://web.archive.org/cdx/search/cdx/?'), true);
  const params = new URL(url).searchParams;
  assert.equal(params.get('url'), 'example.com');
  assert.equal(params.get('output'), 'json');
  assert.equal(params.get('limit'), '1');
  assert.equal(params.get('from'), '1990');
  // fl=timestamp so row[0] is the capture timestamp, not urlkey.
  assert.equal(params.get('fl'), 'timestamp');
});

test('match semantics: url=<registrable domain> is documented in the query', () => {
  const params = new URL(buildWaybackQuery('https://web.archive.org/cdx/search/cdx', 'example.com')).searchParams;
  assert.equal(params.get('url'), 'example.com');
});

test('returns firstSeenDate from the earliest CDX capture', async () => {
  const fetchImpl = (async () =>
    cdxResponse([['timestamp'], ['20100409135045']])) as unknown as typeof fetch;
  const client = createFirstSeenClient(baseConfig(fetchImpl))!;
  const result = await client('example.com');

  assert.equal(result.status, 'ok');
  assert.equal(result.firstSeenDate, '2010-04-09T13:50:45Z');
  assert.equal(result.source, 'wayback');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.requestCount, 1);
});

test('no snapshots -> ok with null date and a source reason', async () => {
  const fetchImpl = (async () => cdxResponse([['timestamp']])) as unknown as typeof fetch;
  const client = createFirstSeenClient(baseConfig(fetchImpl))!;
  const result = await client('example.com');

  assert.equal(result.status, 'ok');
  assert.equal(result.firstSeenDate, null);
  assert.match(result.sourceReason ?? '', /no archived snapshots/);
});

test('header missing timestamp column -> error', async () => {
  const fetchImpl = (async () => cdxResponse([['urlkey', 'original'], ['org_6/example.com/', 'http://example.com/']])) as unknown as typeof fetch;
  const client = createFirstSeenClient(baseConfig(fetchImpl))!;
  const result = await client('example.com');
  assert.equal(result.status, 'error');
  assert.match(result.error ?? '', /missing 'timestamp'/);
});

test('HTTP 404 -> error', async () => {
  const fetchImpl = (async () => cdxResponse({}, { status: 404 })) as unknown as typeof fetch;
  const client = createFirstSeenClient(baseConfig(fetchImpl))!;
  const result = await client('example.com');
  assert.equal(result.status, 'error');
  assert.equal(result.httpStatus, 404);
});

test('malformed body -> error', async () => {
  const fetchImpl = (async () => cdxResponse({ not: 'an array' })) as unknown as typeof fetch;
  const client = createFirstSeenClient(baseConfig(fetchImpl))!;
  const result = await client('example.com');
  assert.equal(result.status, 'error');
  assert.match(result.error ?? '', /malformed/);
});

test('429 then 200 succeeds after retry', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return calls === 1
      ? cdxResponse({}, { status: 429, headers: { 'Retry-After': '0' } })
      : cdxResponse([['timestamp'], ['20050101000000']]);
  }) as unknown as typeof fetch;
  const config = baseConfig(fetchImpl);
  config.maxAttempts = 3;
  const client = createFirstSeenClient(config)!;
  const result = await client('example.com');

  assert.equal(result.status, 'ok');
  assert.equal(result.firstSeenDate, '2005-01-01T00:00:00Z');
  assert.equal(calls, 2);
  assert.equal(result.requestCount, 2);
});

test('no provider configured -> factory returns null', () => {
  assert.equal(createFirstSeenClient({ ...baseConfig(fetch as unknown as typeof fetch), provider: '' }), null);
  assert.equal(createFirstSeenClient({ ...baseConfig(fetch as unknown as typeof fetch), provider: 'unconfigured' }), null);
});

test('unknown provider -> throw', () => {
  const config = baseConfig(fetch as unknown as typeof fetch);
  config.provider = 'nope';
  assert.throws(() => createFirstSeenClient(config), (e) => e instanceof ResearchError);
  assert.throws(() => parseFirstSeenProvider('nope'), (e) => e instanceof ResearchError);
  assert.equal(parseFirstSeenProvider(undefined), null);
  assert.equal(parseFirstSeenProvider(''), null);
  assert.equal(parseFirstSeenProvider('wayback'), 'wayback');
});
