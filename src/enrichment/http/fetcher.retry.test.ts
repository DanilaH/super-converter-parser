import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  boundedFetch,
  isRetryableHttpStatus,
  isRetryableNetworkFailure,
} from './fetcher.js';

const allowAllSsrf = async () => ({ allowed: true });
const retryConfig = {
  ssrfChecker: allowAllSsrf,
  minDomainDelayMs: 0,
  maxDomainDelayMs: 0,
  baseRetryDelayMs: 0,
  timeoutMs: 1000,
};

test('HTTP retry classifier is narrow and explicit', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableHttpStatus(status), true, `${status} should be retryable`);
  }
  for (const status of [200, 301, 400, 401, 403, 404, 422]) {
    assert.equal(isRetryableHttpStatus(status), false, `${status} should not be retryable`);
  }
});

test('network retry classifier retries transient codes but not permanent DNS failure', () => {
  const controller = new AbortController();
  assert.equal(isRetryableNetworkFailure({ cause: { code: 'ECONNRESET' } }, controller), true);
  assert.equal(isRetryableNetworkFailure({ cause: { code: 'EAI_AGAIN' } }, controller), true);
  assert.equal(isRetryableNetworkFailure({ cause: { code: 'UND_ERR_SOCKET' } }, controller), true);
  assert.equal(isRetryableNetworkFailure({ cause: { code: 'ENOTFOUND' } }, controller), false);
  assert.equal(isRetryableNetworkFailure(new Error('generic failure'), controller), false);
});

test('retryable HTTP responses do not consume redirect budget', async () => {
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount += 1;
    if (req.url === '/start') {
      if (requestCount <= 2) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('temporary upstream failure');
        return;
      }
      res.writeHead(302, { Location: '/final' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>ok</body></html>');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const startUrl = `http://127.0.0.1:${port}/start`;
  const finalUrl = `http://127.0.0.1:${port}/final`;

  try {
    const result = await boundedFetch(startUrl, {
      ...retryConfig,
      maxRetries: 2,
      maxRedirects: 1,
    });

    assert.equal(result.status, 200);
    assert.equal(result.finalUrl, finalUrl);
    assert.deepEqual(result.redirectChain, [finalUrl]);
    assert.equal(requestCount, 4);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('non-retryable 404 is returned after one request', async () => {
  let requestCount = 0;
  const server = createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('missing');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const result = await boundedFetch(`http://127.0.0.1:${port}/missing`, {
      ...retryConfig,
      maxRetries: 3,
    });

    assert.equal(result.status, 404);
    assert.equal(result.body, 'missing');
    assert.equal(requestCount, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('exhausted retryable HTTP response preserves factual terminal status and body', async () => {
  let requestCount = 0;
  const server = createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('still unavailable');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const result = await boundedFetch(`http://127.0.0.1:${port}/upstream`, {
      ...retryConfig,
      maxRetries: 1,
    });

    assert.equal(result.status, 502);
    assert.equal(result.body, 'still unavailable');
    assert.equal(result.failureReason, null);
    assert.equal(requestCount, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
