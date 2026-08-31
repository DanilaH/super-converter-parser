import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommonCrawlHistoricalPresenceClient } from './commonCrawl.js';
import { DEFAULT_HISTORICAL_PRESENCE_CONFIG } from './types.js';

function collection(id: string, from: string): Record<string, unknown> {
  return {
    id,
    name: id,
    'cdx-api': `https://index.commoncrawl.org/${id}-index`,
    from,
    to: from,
  };
}

test('later capture after an earlier collection error remains ok but incomplete', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/collinfo.json')) {
      return new Response(JSON.stringify([
        collection('CC-MAIN-2008-01', '2008-01-01T00:00:00'),
        collection('CC-MAIN-2014-01', '2014-01-01T00:00:00'),
      ]), { status: 200 });
    }
    if (url.includes('CC-MAIN-2008-01-index')) {
      return new Response('temporary upstream failure', { status: 500 });
    }
    return new Response(`${JSON.stringify({
      timestamp: '20140309112233',
      url: 'https://example.com/',
      status: '200',
    })}\n`, { status: 200 });
  };

  const client = createCommonCrawlHistoricalPresenceClient({
    ...DEFAULT_HISTORICAL_PRESENCE_CONFIG,
    maxAttempts: 1,
    fetchImpl,
    minDelayMs: 0,
    now: () => Date.parse('2026-08-31T00:00:00Z'),
    sleep: async () => undefined,
  });

  const result = await client.lookup('example.com');
  assert.equal(result.status, 'ok');
  assert.equal(result.earliestSampledCaptureAt, '2014-03-09T11:22:33Z');
  assert.equal(result.historyCompleteForSelectedCollections, false);
  assert.match(result.sourceReason ?? '', /earlier selected collection failed/i);
});
