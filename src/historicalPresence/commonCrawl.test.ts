import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommonCrawlQuery,
  createCommonCrawlHistoricalPresenceClient,
  parseCommonCrawlCaptureLines,
  parseCommonCrawlCollections,
  selectCommonCrawlCollections,
} from './commonCrawl.js';
import { DEFAULT_HISTORICAL_PRESENCE_CONFIG } from './types.js';

function collection(id: string, from: string, to = from): Record<string, unknown> {
  return {
    id,
    name: id,
    'cdx-api': `https://index.commoncrawl.org/${id}-index`,
    from,
    to,
  };
}

test('annual selection keeps oldest crawl per year and stays bounded', () => {
  const parsed = parseCommonCrawlCollections([
    collection('CC-MAIN-2024-10', '2024-01-10T00:00:00'),
    collection('CC-MAIN-2024-22', '2024-05-10T00:00:00'),
    collection('CC-MAIN-2025-05', '2025-01-10T00:00:00'),
    collection('CC-MAIN-2025-30', '2025-07-10T00:00:00'),
    collection('CC-MAIN-2026-05', '2026-01-10T00:00:00'),
    collection('CC-MAIN-2026-30', '2026-07-10T00:00:00'),
  ]);
  const selected = selectCommonCrawlCollections(parsed, 'annual', {
    nowMs: Date.parse('2026-08-31T00:00:00Z'),
    recentMonths: 18,
    maxCollections: 5,
  });
  assert.deepEqual(selected.map((item) => item.id), [
    'CC-MAIN-2024-10',
    'CC-MAIN-2025-05',
    'CC-MAIN-2025-30',
    'CC-MAIN-2026-05',
    'CC-MAIN-2026-30',
  ]);
});

test('query is domain-scoped and limit=1 rather than pretending exact first capture', () => {
  const query = new URL(buildCommonCrawlQuery('https://index.commoncrawl.org/CC-MAIN-2026-30-index', 'example.com'));
  assert.equal(query.searchParams.get('url'), 'example.com');
  assert.equal(query.searchParams.get('matchType'), 'domain');
  assert.equal(query.searchParams.get('limit'), '1');
  assert.equal(query.searchParams.get('output'), 'json');
});

test('capture parser preserves archived page status separately from provider status', () => {
  const capture = parseCommonCrawlCaptureLines(JSON.stringify({
    urlkey: 'com,example)/',
    timestamp: '20140309112233',
    url: 'https://example.com/',
    status: '403',
  }));
  assert.equal(capture?.timestamp, '2014-03-09T11:22:33Z');
  assert.equal(capture?.status, '403');
});

test('404 No Captures is not_found and not a provider error', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/collinfo.json')) {
      return new Response(JSON.stringify([
        collection('CC-MAIN-2026-30', '2026-07-10T00:00:00'),
      ]), { status: 200 });
    }
    return new Response('No Captures found for: example.invalid', { status: 404 });
  };
  const client = createCommonCrawlHistoricalPresenceClient({
    ...DEFAULT_HISTORICAL_PRESENCE_CONFIG,
    collectionMode: 'latest',
    fetchImpl,
    minDelayMs: 0,
    now: () => Date.parse('2026-08-31T00:00:00Z'),
    sleep: async () => undefined,
  });
  const result = await client.lookup('example.invalid');
  assert.equal(result.status, 'not_found');
  assert.equal(result.error, null);
  assert.equal(result.historyCompleteForSelectedCollections, true);
  assert.equal(result.checkedCollectionCount, 1);
  assert.match(result.sourceReason ?? '', /not proof/i);
  assert.equal(calls.length, 2);
});

test('annual traversal returns bounded sampled presence and stops after earliest selected match', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/collinfo.json')) {
      return new Response(JSON.stringify([
        collection('CC-MAIN-2008-01', '2008-01-01T00:00:00'),
        collection('CC-MAIN-2014-01', '2014-01-01T00:00:00'),
        collection('CC-MAIN-2026-01', '2026-01-01T00:00:00'),
      ]), { status: 200 });
    }
    if (url.includes('CC-MAIN-2008-01-index')) {
      return new Response('No Captures found for: example.com', { status: 404 });
    }
    if (url.includes('CC-MAIN-2014-01-index')) {
      return new Response(`${JSON.stringify({ timestamp: '20140309112233', url: 'https://example.com/', status: '403' })}\n`, { status: 200 });
    }
    throw new Error(`Unexpected request after sampled match: ${url}`);
  };
  const client = createCommonCrawlHistoricalPresenceClient({
    ...DEFAULT_HISTORICAL_PRESENCE_CONFIG,
    fetchImpl,
    minDelayMs: 0,
    now: () => Date.parse('2026-08-31T00:00:00Z'),
    sleep: async () => undefined,
  });
  const result = await client.lookup('example.com');
  assert.equal(result.status, 'ok');
  assert.equal(result.earliestSampledCaptureAt, '2014-03-09T11:22:33Z');
  assert.equal(result.earliestSampledCaptureHttpStatus, '403');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.checkedCollectionCount, 2);
  assert.equal(result.selectedCollectionCount, 3);
  assert.equal(result.historyCompleteForSelectedCollections, true);
  assert.match(result.sourceReason ?? '', /bounded sampled web-presence/i);
});

test('provider 403 opens circuit and later domains are unavailable without network calls', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls += 1;
    const url = String(input);
    if (url.endsWith('/collinfo.json')) {
      return new Response(JSON.stringify([
        collection('CC-MAIN-2026-30', '2026-07-10T00:00:00'),
      ]), { status: 200 });
    }
    return new Response('blocked', { status: 403 });
  };
  const client = createCommonCrawlHistoricalPresenceClient({
    ...DEFAULT_HISTORICAL_PRESENCE_CONFIG,
    collectionMode: 'latest',
    fetchImpl,
    minDelayMs: 0,
    now: () => Date.parse('2026-08-31T00:00:00Z'),
    sleep: async () => undefined,
  });
  const first = await client.lookup('one.example');
  const afterFirst = calls;
  const second = await client.lookup('two.example');
  assert.equal(first.status, 'unavailable');
  assert.equal(second.status, 'unavailable');
  assert.match(second.sourceReason ?? '', /circuit open/i);
  assert.equal(calls, afterFirst);
});
