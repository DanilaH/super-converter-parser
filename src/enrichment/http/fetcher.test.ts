import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { boundedFetch, parseRetryAfter } from './fetcher.js';

let server: Server;
let baseUrl: string;

const allowAllSsrf = async () => ({ allowed: true });

const blockPrivateSsrf = async (url: string) => {
  if (url.includes('192.168.1.1') || url.includes('10.') || url.includes('127.0.0.1')) {
    return { allowed: false, reason: 'Blocked IP' };
  }
  return { allowed: true };
};

before(() => {
  return new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      const url = req.url ?? '/';

      if (url === '/ok') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>Test</title></head><body>Hello</body></html>');
      } else if (url === '/plain') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Plain text content');
      } else if (url === '/empty') {
        res.writeHead(204);
        res.end();
      } else if (url === '/redirect-once') {
        res.writeHead(301, { Location: '/ok' });
        res.end();
      } else if (url === '/redirect-chain') {
        res.writeHead(302, { Location: '/redirect-once' });
        res.end();
      } else if (url === '/redirect-loop') {
        res.writeHead(302, { Location: '/redirect-loop' });
        res.end();
      } else if (url === '/redirect-to-private') {
        res.writeHead(302, { Location: 'http://192.168.1.1/admin' });
        res.end();
      } else if (url === '/no-location-redirect') {
        res.writeHead(302);
        res.end();
      } else if (url === '/oversized') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const bigBody = 'x'.repeat(100);
        res.end(bigBody);
      } else if (url === '/rate-limited') {
        res.writeHead(429, { 'Retry-After': '30' });
        res.end('Rate limited');
      } else if (url === '/slow') {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html>slow</html>');
        }, 200);
      } else if (url === '/slow-body') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write('<html>partial');
        setTimeout(() => {
          res.end('</html>');
        }, 500);
      } else if (url === '/not-found') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body>Not found</body></html>');
      } else if (url === '/server-error') {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<html><body>Error</body></html>');
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(() => {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

const testConfig = { minDomainDelayMs: 0, maxDomainDelayMs: 0, ssrfChecker: allowAllSsrf };

test('boundedFetch: fetches HTML successfully', async () => {
  const result = await boundedFetch(`${baseUrl}/ok`, testConfig);

  assert.equal(result.status, 200);
  assert.equal(result.error, null);
  assert.equal(result.aborted, false);
  assert.equal(result.bodyError, false);
  assert.match(result.body ?? '', /<title>Test<\/title>/);
  assert.ok(result.contentType?.includes('text/html'));
  assert.equal(result.finalUrl, `${baseUrl}/ok`);
  assert.equal(result.redirectChain.length, 0);
});

test('boundedFetch: follows single redirect', async () => {
  const result = await boundedFetch(`${baseUrl}/redirect-once`, testConfig);

  assert.equal(result.status, 200);
  assert.equal(result.finalUrl, `${baseUrl}/ok`);
  assert.equal(result.redirectChain.length, 1);
  assert.match(result.body ?? '', /Hello/);
});

test('boundedFetch: follows redirect chain', async () => {
  const result = await boundedFetch(`${baseUrl}/redirect-chain`, testConfig);

  assert.equal(result.status, 200);
  assert.equal(result.finalUrl, `${baseUrl}/ok`);
  assert.equal(result.redirectChain.length, 2);
});

test('boundedFetch: rejects redirect to private IP', async () => {
  const result = await boundedFetch(`${baseUrl}/redirect-to-private`, {
    ...testConfig,
    ssrfChecker: blockPrivateSsrf,
  });

  assert.match(result.error!, /SSRF blocked/);
  assert.equal(result.body, null);
});

test('boundedFetch: handles redirect without Location', async () => {
  const result = await boundedFetch(`${baseUrl}/no-location-redirect`, testConfig);

  assert.equal(result.status, 302);
  assert.match(result.error!, /without Location/);
});

test('boundedFetch: detects rate limiting with Retry-After', async () => {
  const result = await boundedFetch(`${baseUrl}/rate-limited`, testConfig);

  assert.equal(result.status, 429);
  assert.match(result.error!, /Rate limited/);
  assert.equal(result.retryAfter, '30');
});

test('boundedFetch: aborts oversized body and sets bodyError', async () => {
  const result = await boundedFetch(`${baseUrl}/oversized`, {
    ...testConfig,
    maxBytes: 50,
  });

  assert.equal(result.aborted, true);
  assert.equal(result.bodyError, true);
  assert.equal(result.body, null);
  assert.match(result.error!, /exceeded/);
});

test('boundedFetch: handles timeout', async () => {
  const result = await boundedFetch(`${baseUrl}/slow`, {
    ...testConfig,
    timeoutMs: 50,
  });

  assert.equal(result.status, 0);
  assert.ok(result.error);
});

test('boundedFetch: fetches plain text', async () => {
  const result = await boundedFetch(`${baseUrl}/plain`, testConfig);

  assert.equal(result.status, 200);
  assert.match(result.body ?? '', /Plain text/);
  assert.ok(result.contentType?.includes('text/plain'));
});

test('boundedFetch: returns body with 404 status', async () => {
  const result = await boundedFetch(`${baseUrl}/not-found`, testConfig);

  assert.equal(result.status, 404);
  assert.ok(result.body);
  assert.equal(result.bodyError, false);
});

test('boundedFetch: returns body with 500 status', async () => {
  const result = await boundedFetch(`${baseUrl}/server-error`, testConfig);

  assert.equal(result.status, 500);
  assert.ok(result.body);
  assert.equal(result.bodyError, false);
});

test('parseRetryAfter: parses seconds', () => {
  assert.equal(parseRetryAfter('30'), 30000);
  assert.equal(parseRetryAfter('0'), 0);
});

test('parseRetryAfter: parses HTTP-date', () => {
  const future = new Date(Date.now() + 60000);
  const result = parseRetryAfter(future.toUTCString());
  assert.ok(result !== null);
  assert.ok(result >= 59000 && result <= 61000);
});

test('parseRetryAfter: returns null for invalid', () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('invalid'), null);
});

test('boundedFetch: timeout covers body read (stalled body after headers)', async () => {
  const startTime = Date.now();
  const result = await boundedFetch(`${baseUrl}/slow-body`, {
    ...testConfig,
    timeoutMs: 100,
  });
  const elapsed = Date.now() - startTime;

  assert.ok(result.aborted, 'Should be aborted due to timeout');
  assert.ok(result.bodyError, 'Should have body error');
  assert.equal(result.body, null, 'Body should be null');
  assert.ok(elapsed < 500, `Timeout should fire quickly, took ${elapsed}ms`);
  assert.match(result.error ?? '', /abort/i);
});

test('slow-body endpoint test', async () => {
  const result = await boundedFetch(`${baseUrl}/slow-body`, {
    ...testConfig,
    timeoutMs: 2000,
  });
  console.log('SLOW BODY FULL: status=', result.status, 'body=', result.body?.slice(0, 50));
  assert.equal(result.status, 200);
});
