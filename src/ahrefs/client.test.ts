import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAhrefsClient, type AhrefsClientConfig } from './client.js';

type FetchLike = (url: string) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }>;

function makeFetch(status: number, body: unknown, opts: { throwNetwork?: boolean } = {}): FetchLike {
  return async () => {
    if (opts.throwNetwork) throw new Error('network');
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
}

const baseOverrides: Partial<AhrefsClientConfig> = {
  endpoint: 'https://apiv2.ahrefs.com/',
  timeoutMs: 1000,
  minDelayMs: 1,
  maxDelayMs: 5,
};

function makeClient(overrides: Partial<AhrefsClientConfig> = {}): ReturnType<typeof createAhrefsClient> {
  return createAhrefsClient('key', { ...baseOverrides, ...overrides });
}

test('returns ok with dr for a successful response', async () => {
  const client = makeClient({ fetchImpl: makeFetch(200, { domain_rating: 42 }) as unknown as typeof fetch });
  const res = await client('example.com');
  assert.equal(res.status, 'ok');
  assert.equal(res.dr, 42);
  assert.equal(res.domain, 'example.com');
  assert.equal(res.error, null);
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
