import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAhrefsClient, backoffMs, type AhrefsClientConfig } from './client.js';

type FetchInit = { signal?: AbortSignal; headers?: Record<string, string> };
type FetchLike = (url: string, init?: FetchInit) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }>;

function makeFetch(status: number, body: unknown, opts: { throwNetwork?: boolean } = {}): FetchLike {
  return async () => {
    if (opts.throwNetwork) throw new Error('network');
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
}

const baseOverrides: Partial<AhrefsClientConfig> = {
  endpoint: 'https://api.ahrefs.com/v3/public/domain-rating-free',
  timeoutMs: 1000,
  minDelayMs: 1,
  maxDelayMs: 5,
};

function makeClient(overrides: Partial<AhrefsClientConfig> = {}): ReturnType<typeof createAhrefsClient> {
  return createAhrefsClient('key', { ...baseOverrides, ...overrides });
}

test('returns ok with dr for a successful nested response', async () => {
  const client = makeClient({
    fetchImpl: makeFetch(200, { domain_rating: { domain_rating: 42 } }) as unknown as typeof fetch,
  });
  const res = await client('example.com');
  assert.equal(res.status, 'ok');
  assert.equal(res.dr, 42);
  assert.equal(res.domain, 'example.com');
  assert.equal(res.error, null);
});

test('falls back to a flat dr field when present', async () => {
  const client = makeClient({
    fetchImpl: makeFetch(200, { dr: 7 }) as unknown as typeof fetch,
  });
  const res = await client('example.com');
  assert.equal(res.status, 'ok');
  assert.equal(res.dr, 7);
});

test('sends a bearer token when an api key is set', async () => {
  let captured: FetchInit | undefined;
  const fetchImpl: FetchLike = async (_url, init) => {
    captured = init;
    return { status: 200, ok: true, json: async () => ({ domain_rating: { domain_rating: 1 } }) };
  };
  const client = makeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
  await client('example.com');
  assert.equal(captured?.headers?.Authorization, 'Bearer key');
  assert.equal(captured?.headers?.Accept, 'application/json');
});

test('omits the authorization header without an api key', async () => {
  let captured: FetchInit | undefined;
  const fetchImpl: FetchLike = async (_url, init) => {
    captured = init;
    return { status: 200, ok: true, json: async () => ({ domain_rating: { domain_rating: 1 } }) };
  };
  const client = createAhrefsClient('', { ...baseOverrides, fetchImpl: fetchImpl as unknown as typeof fetch });
  await client('example.com');
  assert.equal(captured?.headers?.Authorization, undefined);
});

test('maps 404 to not_found with null dr', async () => {
  const client = makeClient({ fetchImpl: makeFetch(404, {}) as unknown as typeof fetch });
  const res = await client('nope.com');
  assert.equal(res.status, 'not_found');
  assert.equal(res.dr, null);
  assert.equal(res.error, null);
});

test('maps other non-ok statuses to error', async () => {
  const client = makeClient({ fetchImpl: makeFetch(400, {}) as unknown as typeof fetch });
  const res = await client('x.com');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'status 400');
});

test('retries then throws AHREFS_RATE_LIMIT on persistent 429', async () => {
  const client = makeClient({ fetchImpl: makeFetch(429, {}) as unknown as typeof fetch });
  await assert.rejects(
    () => client('x.com'),
    (err) => (err as Error).message.toLowerCase().includes('rate limit'),
  );
});

test('network failure yields error status after retries', async () => {
  const client = makeClient({ fetchImpl: makeFetch(200, {}, { throwNetwork: true }) as unknown as typeof fetch });
  const res = await client('x.com');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'network');
});

test('response body read remains covered by the request timeout', async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    calls += 1;
    const signal = init?.signal;
    return {
      status: 200,
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        if (!signal) {
          reject(new Error('missing abort signal'));
          return;
        }
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    };
  };
  const client = makeClient({
    timeoutMs: 5,
    minDelayMs: 0,
    maxDelayMs: 0,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  const result = await client('stalled-body.example');
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'network');
  assert.equal(calls, 4, 'stalled body is aborted and bounded retries are exhausted');
});

test('backoff with jitter never exceeds maxDelayMs', () => {
  const min = 1000;
  const max = 5000;
  // Worst case for the cap: base fully grown to max and jitter at its max.
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    assert.ok(
      backoffMs(attempt, min, max, () => 1) <= max,
      `attempt ${attempt} (jitter=max) must not exceed maxDelayMs`,
    );
    assert.ok(
      backoffMs(attempt, min, max, () => 0) >= Math.min(max, min * Math.pow(2, attempt - 1)),
      `attempt ${attempt} (jitter=0) must keep the exponential base`,
    );
  }
});

test('backoff base doubles and is capped at maxDelayMs', () => {
  const min = 1000;
  const max = 5000;
  assert.equal(backoffMs(1, min, max, () => 0), 1000);
  assert.equal(backoffMs(2, min, max, () => 0), 2000);
  assert.equal(backoffMs(3, min, max, () => 0), 4000);
  // 4th attempt would be 8000 but is capped at maxDelayMs before jitter.
  assert.equal(backoffMs(4, min, max, () => 0), 5000);
});
