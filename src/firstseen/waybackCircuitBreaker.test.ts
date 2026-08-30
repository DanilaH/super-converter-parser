import test from 'node:test';
import assert from 'node:assert/strict';
import { createWaybackClient } from './wayback.js';
import type { FirstSeenClientConfig } from './types.js';

function baseConfig(fetchImpl: typeof fetch): FirstSeenClientConfig {
  return {
    provider: 'wayback',
    endpoint: 'https://web.archive.org/cdx/search/cdx',
    apiKey: null,
    timeoutMs: 5_000,
    minDelayMs: 0,
    maxAttempts: 3,
    baseDelayMs: 0,
    maxDelayMs: 1,
    fetchImpl,
    sleep: () => Promise.resolve(),
    random: () => 0,
  };
}

function cdxResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

test('opens provider circuit when the configured network retry budget is exhausted', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw new TypeError('network unreachable');
  }) as unknown as typeof fetch;
  const config = baseConfig(fetchImpl);
  config.maxAttempts = 3;
  const client = createWaybackClient(config);

  const failed = await client('first.example');
  assert.equal(failed.status, 'error');
  assert.equal(failed.requestCount, config.maxAttempts);
  assert.match(failed.error ?? '', /circuit opened/);
  assert.equal(calls, config.maxAttempts);

  const skipped = await client('second.example');
  assert.equal(skipped.status, 'unavailable');
  assert.equal(skipped.requestCount, 0);
  assert.equal(skipped.httpStatus, null);
  assert.match(skipped.sourceReason ?? '', /circuit open.*network failures/);
  assert.equal(calls, config.maxAttempts);
});

test('successful HTTP response resets the consecutive network-failure streak', async () => {
  let calls = 0;
  const outcomes: Array<'network' | 'ok'> = [
    'network',
    'network',
    'ok',
    'network',
    'network',
    'ok',
  ];
  const fetchImpl = (async () => {
    calls += 1;
    const outcome = outcomes.shift();
    if (outcome === 'network') throw new TypeError('network unreachable');
    return cdxResponse([['timestamp'], ['20100101000000']]);
  }) as unknown as typeof fetch;
  const config = baseConfig(fetchImpl);
  config.maxAttempts = 3;
  const client = createWaybackClient(config);

  assert.equal((await client('one.example')).status, 'ok');
  assert.equal((await client('two.example')).status, 'ok');
  assert.equal(calls, 6);
});

test('HTTP 403 and 451 open the provider circuit immediately', async () => {
  for (const blockedStatus of [403, 451]) {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return cdxResponse({}, blockedStatus);
    }) as unknown as typeof fetch;
    const client = createWaybackClient(baseConfig(fetchImpl));

    const blocked = await client(`blocked-${blockedStatus}.example`);
    assert.equal(blocked.status, 'error');
    assert.equal(blocked.httpStatus, blockedStatus);
    assert.equal(calls, 1);

    const skipped = await client(`skipped-${blockedStatus}.example`);
    assert.equal(skipped.status, 'unavailable');
    assert.equal(skipped.requestCount, 0);
    assert.match(skipped.sourceReason ?? '', new RegExp(`HTTP ${blockedStatus}`));
    assert.equal(calls, 1);
  }
});

test('ordinary HTTP provider errors do not open the circuit', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return calls === 1
      ? cdxResponse({}, 500)
      : cdxResponse([['timestamp'], ['20120101000000']]);
  }) as unknown as typeof fetch;
  const client = createWaybackClient(baseConfig(fetchImpl));

  const serverError = await client('server-error.example');
  assert.equal(serverError.status, 'error');
  assert.equal(serverError.httpStatus, 500);

  const next = await client('healthy.example');
  assert.equal(next.status, 'ok');
  assert.equal(next.firstSeenDate, '2012-01-01T00:00:00Z');
  assert.equal(calls, 2);
});

test('HTTP 429 retry behavior does not open the provider circuit', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls <= 2) {
      return new Response('{}', {
        status: 429,
        headers: { 'Retry-After': '0' },
      });
    }
    return cdxResponse([['timestamp'], ['20150101000000']]);
  }) as unknown as typeof fetch;
  const config = baseConfig(fetchImpl);
  config.maxAttempts = 2;
  const client = createWaybackClient(config);

  const rateLimited = await client('rate-limited.example');
  assert.equal(rateLimited.status, 'error');
  assert.equal(rateLimited.httpStatus, 429);

  const next = await client('healthy.example');
  assert.equal(next.status, 'ok');
  assert.equal(next.firstSeenDate, '2015-01-01T00:00:00Z');
  assert.equal(calls, 3);
});
