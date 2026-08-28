import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRdapClient } from './client.js';
import type { RdapClientConfig } from './types.js';
import type { BootstrapFile } from './bootstrap.js';
import { ResearchError } from '../shared/errors.js';

type MockResponse = Response;

function resp(status: number, body: unknown, headers: Record<string, string> = {}): MockResponse {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

const COM_BOOTSTRAP: BootstrapFile = {
  version: '1.0',
  publication: '2024-01-01T00:00:00Z',
  description: 'test bootstrap',
  services: [[[ 'com', 'net' ], [ 'https://rdap.verisign.com/com/v1/' ]]],
};

function registrationBody(domain: string, regDate: string): unknown {
  return {
    objectClassName: 'domain',
    ldhName: domain,
    events: [
      { eventAction: 'registration', eventDate: regDate },
      { eventAction: 'last update of RDAP database', eventDate: '2024-01-01T00:00:00Z' },
    ],
  };
}

function rdapUrl(domain: string): string {
  return `https://rdap.verisign.com/com/v1/domain/${encodeURIComponent(domain)}`;
}

// A fake fetch serving the bootstrap + a per-domain responder.
function fakeFetch(
  bootstrap: BootstrapFile,
  route: (url: string) => MockResponse,
): (url: string, init?: RequestInit) => Promise<MockResponse> {
  return async (url: string) => {
    if (url.endsWith('dns.json')) return resp(200, bootstrap);
    return route(url);
  };
}

function baseConfig(fetchImpl: (url: string, init?: RequestInit) => Promise<any>): RdapClientConfig {
  return {
    bootstrapBase: 'https://data.iana.org/rdap/',
    bootstrapFile: 'dns.json',
    bootstrapTtlMs: 60_000,
    queryTimeoutMs: 5_000,
    perHostMinDelayMs: 0,
    maxAttempts: 4,
    baseDelayMs: 10,
    maxDelayMs: 1_000,
    random: () => 0.5,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  };
}

test('200 returns ok with parsed registration date', async () => {
  let seen = '';
  const config = baseConfig(
    fakeFetch(COM_BOOTSTRAP, (url) => {
      seen = url;
      return resp(200, registrationBody('example.com', '2010-05-03T04:00:00Z'));
    }),
  );
  const result = await createRdapClient(config)('example.com');

  assert.equal(result.status, 'ok');
  assert.equal(result.registrationDate, '2010-05-03T04:00:00Z');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.requestCount, 1);
  assert.equal(seen, rdapUrl('example.com'));
});

test('404 maps to not_found', async () => {
  const config = baseConfig(
    fakeFetch(COM_BOOTSTRAP, () => resp(404, { errorCode: 404, title: 'not found' })),
  );
  const result = await createRdapClient(config)('example.com');
  assert.equal(result.status, 'not_found');
  assert.equal(result.registrationDate, null);
  assert.equal(result.httpStatus, 404);
});

test('410 maps to unsupported', async () => {
  const config = baseConfig(
    fakeFetch(COM_BOOTSTRAP, () => resp(410, {})),
  );
  const result = await createRdapClient(config)('example.com');
  assert.equal(result.status, 'unsupported');
  assert.equal(result.httpStatus, 410);
});

test('429 then 200 succeeds after retry', async () => {
  let calls = 0;
  const config = baseConfig(
    fakeFetch(COM_BOOTSTRAP, () => {
      calls += 1;
      return calls === 1
        ? resp(429, {}, { 'Retry-After': '0' })
        : resp(200, registrationBody('example.com', '2001-01-01T00:00:00Z'));
    }),
  );
  config.maxAttempts = 3;
  config.baseDelayMs = 0;
  config.maxDelayMs = 1;
  const result = await createRdapClient(config)('example.com');
  assert.equal(result.status, 'ok');
  assert.equal(result.registrationDate, '2001-01-01T00:00:00Z');
  assert.equal(calls, 2);
  assert.equal(result.requestCount, 2);
});

test('Retry-After cannot exceed configured maxDelayMs', async () => {
  let calls = 0;
  const slept: number[] = [];
  const config = baseConfig(
    fakeFetch(COM_BOOTSTRAP, () => {
      calls += 1;
      return calls === 1
        ? resp(429, {}, { 'Retry-After': '86400' })
        : resp(200, registrationBody('example.com', '2001-01-01T00:00:00Z'));
    }),
  );
  config.maxAttempts = 2;
  config.maxDelayMs = 250;
  config.sleep = (ms: number) => {
    slept.push(ms);
    return Promise.resolve();
  };

  const result = await createRdapClient(config)('example.com');
  assert.equal(result.status, 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(slept, [250]);
});

test('500 exhausts retries and returns RDAP_ERROR', async () => {
  let calls = 0;
  const config = baseConfig(
    fakeFetch(COM_BOOTSTRAP, () => {
      calls += 1;
      return resp(503, {});
    }),
  );
  config.maxAttempts = 2;
  config.baseDelayMs = 0;
  config.maxDelayMs = 1;
  const result = await createRdapClient(config)('example.com');
  assert.equal(result.status, 'error');
  assert.match(result.error ?? '', /RDAP_ERROR/);
  assert.equal(calls, 2);
});

test('429 exhausts retries and returns RDAP_RATE_LIMIT error', async () => {
  const config = baseConfig(
    fakeFetch(COM_BOOTSTRAP, () => resp(429, {}, { 'Retry-After': '0' })),
  );
  config.maxAttempts = 2;
  config.baseDelayMs = 0;
  config.maxDelayMs = 1;
  const result = await createRdapClient(config)('example.com');
  assert.equal(result.status, 'error');
  assert.match(result.error ?? '', /RDAP_RATE_LIMIT/);
});

test('network failure is an error, not unsupported', async () => {
  const failFetch = async (url: string): Promise<MockResponse> => {
    if (url.endsWith('dns.json')) return resp(200, COM_BOOTSTRAP);
    throw new Error('ECONNREFUSED');
  };
  const config = baseConfig(failFetch);
  config.maxAttempts = 1;
  const result = await createRdapClient(config)('example.com');
  assert.equal(result.status, 'error');
  assert.match(result.error ?? '', /network error/);
});

test('TLD absent from bootstrap is unsupported with zero domain requests', async () => {
  let domainCalls = 0;
  const config = baseConfig(
    fakeFetch(COM_BOOTSTRAP, () => {
      domainCalls += 1;
      return resp(200, registrationBody('a.com', '2010-01-01T00:00:00Z'));
    }),
  );
  const result = await createRdapClient(config)('example.org');
  assert.equal(result.status, 'unsupported');
  assert.equal(domainCalls, 0);
});

test('per-host rate limiting delays same-host queries', async () => {
  let wall = 1_000_000;
  const now = () => wall;
  const slept: number[] = [];
  const config = baseConfig(
    fakeFetch(COM_BOOTSTRAP, () => resp(200, registrationBody('a.com', '2010-01-01T00:00:00Z'))),
  );
  config.perHostMinDelayMs = 100;
  config.maxAttempts = 1;
  config.now = now;
  config.sleep = (ms: number) => {
    slept.push(ms);
    wall += ms; // mock clock advances by the sleep duration
    return Promise.resolve();
  };

  const client = createRdapClient(config);
  await client('a.com');
  // Only 30ms of mock time pass before the second query to the same host.
  wall += 30;
  await client('b.com');

  assert.equal(slept.length, 1, 'exactly one rate-limit sleep occurred');
  assert.equal(slept[0], 70, 'second query to same host waited the remaining 70ms gap');
});

test('registrable domain is used for the query path', async () => {
  let seenUrl = '';
  const config = baseConfig(
    fakeFetch(COM_BOOTSTRAP, (url) => {
      seenUrl = url;
      return resp(200, registrationBody('example.com', '2012-02-02T00:00:00Z'));
    }),
  );
  const result = await createRdapClient(config)('WWW.Example.CoM');
  assert.equal(seenUrl, rdapUrl('example.com'));
  assert.equal(result.registrationDate, '2012-02-02T00:00:00Z');
});
