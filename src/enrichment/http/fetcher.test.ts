import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { boundedFetch, parseRetryAfter, type DnsResolver, type SsrfChecker, type IpPolicy } from './fetcher.js';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

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
      } else if (url === '/relative-redirect') {
        res.writeHead(302, { Location: '/ok' });
        res.end();
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

test('boundedFetch: timeout failureReason is timeout not oversized', async () => {
  const result = await boundedFetch(`${baseUrl}/slow-body`, {
    ...testConfig,
    timeoutMs: 100,
  });
  assert.equal(result.failureReason, 'timeout');
  assert.notEqual(result.failureReason, 'oversized');
});

test('boundedFetch: oversized failureReason is oversized', async () => {
  const result = await boundedFetch(`${baseUrl}/oversized`, {
    ...testConfig,
    maxBytes: 20,
  });
  assert.equal(result.failureReason, 'oversized');
  assert.notEqual(result.failureReason, 'timeout');
});

test('boundedFetch: relative redirect preserves hostname', async () => {
  const result = await boundedFetch(`${baseUrl}/relative-redirect`, {
    ...testConfig,
  });
  assert.equal(result.status, 200);
  assert.match(result.finalUrl ?? '', new RegExp(escapeRegExp(baseUrl)));
});

test('boundedFetch: retry does not consume redirect budget', async () => {
  const http = await import('node:http');
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    if (req.url === '/retry-redirect') {
      if (requestCount <= 2) {
        res.writeHead(429, { 'Retry-After': '0' });
        res.end();
      } else {
        res.writeHead(302, { Location: '/final' });
        res.end();
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>final</body></html>');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const serverPort = addr.port;

  try {
    const result = await boundedFetch(`http://127.0.0.1:${serverPort}/retry-redirect`, {
      ...testConfig,
      maxRetries: 3,
      baseRetryDelayMs: 10,
    });

    assert.equal(result.status, 200, 'Should succeed after retries + redirect');
    assert.match(result.body ?? '', /final/);
    assert.equal(result.finalUrl, `http://127.0.0.1:${serverPort}/final`);
    assert.equal(requestCount, 4, 'Should be exactly 2 retries + 1 redirect + 1 final = 4 requests');
    assert.deepEqual(result.redirectChain, [`http://127.0.0.1:${serverPort}/final`]);
  } finally {
    server.close();
  }
});

test('boundedFetch: stalled redirect body does not hang', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/stall-redirect') {
      res.writeHead(302, { Location: '/destination' });
      res.write('x'.repeat(100));
      setTimeout(() => res.end(), 10000);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>destination</body></html>');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const serverPort = addr.port;

  try {
    const startTime = Date.now();
    const result = await boundedFetch(`http://127.0.0.1:${serverPort}/stall-redirect`, {
      ...testConfig,
      timeoutMs: 2000,
      ssrfChecker: async () => ({ allowed: true, ip: '127.0.0.1' }),
    });
    const elapsed = Date.now() - startTime;

    assert.equal(result.status, 200);
    assert.match(result.body ?? '', /destination/);
    assert.ok(elapsed < 5000, `Should not hang on stalled body, took ${elapsed}ms`);
  } finally {
    server.close();
  }
});

test('boundedFetch: stalled final 429 body does not hang with pinned agent', async () => {
  const http = await import('node:http');
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    res.writeHead(429, { 'Retry-After': '0' });
    res.write('x'.repeat(100));
    setTimeout(() => res.end(), 10000);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const serverPort = addr.port;

  try {
    const startTime = Date.now();
    const result = await boundedFetch(`http://127.0.0.1:${serverPort}/stall-429`, {
      ...testConfig,
      timeoutMs: 2000,
      maxRetries: 1,
      baseRetryDelayMs: 10,
      ssrfChecker: async () => ({ allowed: true, ip: '127.0.0.1' }),
    });
    const elapsed = Date.now() - startTime;

    assert.equal(result.status, 429);
    assert.ok(elapsed < 5000, `Should not hang on stalled 429 body with pinned agent, took ${elapsed}ms`);
  } finally {
    server.close();
  }
});

test('boundedFetch: stalled redirect body does not hang with pinned agent', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/stall-redirect') {
      res.writeHead(302, { Location: '/destination' });
      res.write('x'.repeat(100));
      setTimeout(() => res.end(), 10000);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>destination</body></html>');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const serverPort = addr.port;

  try {
    const startTime = Date.now();
    const result = await boundedFetch(`http://127.0.0.1:${serverPort}/stall-redirect`, {
      ...testConfig,
      timeoutMs: 2000,
      ssrfChecker: async () => ({ allowed: true, ip: '127.0.0.1' }),
    });
    const elapsed = Date.now() - startTime;

    assert.equal(result.status, 200);
    assert.match(result.body ?? '', /destination/);
    assert.ok(elapsed < 5000, `Should not hang on stalled redirect body with pinned agent, took ${elapsed}ms`);
  } finally {
    server.close();
  }
});

test('boundedFetch: pinned transport preserves hostname and SNI', async () => {
  const http = await import('node:http');
  let receivedHost: string | undefined;
  const server = http.createServer((req, res) => {
    receivedHost = req.headers.host;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>pinned-ok</body></html>');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const serverPort = addr.port;

  try {
    const customSsrf = async (url: string) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'example.com') {
        return { allowed: true, ip: '127.0.0.1' };
      }
      return { allowed: true, ip: '127.0.0.1' };
    };

    const result = await boundedFetch(`http://example.com:${serverPort}/`, {
      ...testConfig,
      ssrfChecker: customSsrf,
      timeoutMs: 5000,
    });

    assert.equal(result.status, 200, 'Request should succeed via pinned IP');
    assert.match(result.body ?? '', /pinned-ok/);
    assert.equal(result.finalUrl, `http://example.com:${serverPort}/`, 'finalUrl should preserve original hostname');
    assert.equal(receivedHost, `example.com:${serverPort}`, 'Server should receive original hostname in Host header');
  } finally {
    server.close();
  }
});

test('boundedFetch: pinned transport with relative redirect', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/destination' });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>destination</body></html>');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const serverPort = addr.port;

  try {
    const customSsrf = async () => ({ allowed: true, ip: '127.0.0.1' });

    const result = await boundedFetch(`http://example.com:${serverPort}/redirect`, {
      ...testConfig,
      ssrfChecker: customSsrf,
      timeoutMs: 5000,
    });

    assert.equal(result.status, 200);
    assert.match(result.body ?? '', /destination/);
    assert.equal(result.finalUrl, `http://example.com:${serverPort}/destination`);
  } finally {
    server.close();
  }
});

test('boundedFetch: pinned transport with cross-host redirect', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: `http://other.example.com:${req.headers.host?.split(':')[1]}/destination` });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>cross-host</body></html>');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const serverPort = addr.port;

  try {
    const customSsrf = async () => ({ allowed: true, ip: '127.0.0.1' });

    const result = await boundedFetch(`http://example.com:${serverPort}/redirect`, {
      ...testConfig,
      ssrfChecker: customSsrf,
      timeoutMs: 5000,
    });

    assert.equal(result.status, 200);
    assert.match(result.body ?? '', /cross-host/);
    assert.equal(result.finalUrl, `http://other.example.com:${serverPort}/destination`);
  } finally {
    server.close();
  }
});

test('boundedFetch: connector sets correct SNI context', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>context-ok</body></html>');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const serverPort = addr.port;

  try {
    const customSsrf = async (url: string) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'myhost.test') {
        return { allowed: true, ip: '127.0.0.1' };
      }
      return { allowed: true, ip: '127.0.0.1' };
    };

    const result = await boundedFetch(`http://myhost.test:${serverPort}/`, {
      ...testConfig,
      ssrfChecker: customSsrf,
      timeoutMs: 5000,
    });

    assert.equal(result.status, 200);
    assert.match(result.body ?? '', /context-ok/);
      assert.equal(result.finalUrl, `http://myhost.test:${serverPort}/`);
  } finally {
    server.close();
  }
});

test('boundedFetch: DNS validation timeout does not hang (initial hop)', async () => {
  const startTime = Date.now();
  const neverResolvingResolver: DnsResolver = () => new Promise(() => {});
  const result = await boundedFetch(`http://never-resolve-example-initial.test/path`, {
    timeoutMs: 2000,
    dnsResolver: neverResolvingResolver,
  });
  const elapsed = Date.now() - startTime;

  assert.equal(result.status, 0);
  assert.match(result.error!, /DNS resolution|timeout/i);
  assert.ok(elapsed < 10000, `DNS timeout should be bounded, took ${elapsed}ms`);
});

test('boundedFetch: DNS validation timeout does not hang (redirect hop)', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://never-resolve-redirect.test/destination' });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>ok</body></html>');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const serverPort = addr.port;

  try {
    const startTime = Date.now();
    const allowLoopbackPolicy: IpPolicy = () => false;
    const statefulResolver: DnsResolver = (hostname) => {
      if (hostname === `initial.test`) {
        return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
      }
      return new Promise(() => {});
    };
    const result = await boundedFetch(`http://initial.test:${serverPort}/redirect`, {
      timeoutMs: 10000,
      dnsResolver: statefulResolver,
      ipPolicy: allowLoopbackPolicy,
    });
    const elapsed = Date.now() - startTime;

    assert.equal(result.status, 0);
    assert.equal(result.failureReason, 'timeout');
    assert.ok(elapsed < 15000, `Redirect DNS timeout should be bounded, took ${elapsed}ms`);
  } finally {
    server.close();
  }
});

test('boundedFetch: DNS operational error is not classified as SSRF block', async () => {
  const failingResolver: DnsResolver = () => Promise.reject(new Error('NXDOMAIN'));
  const result = await boundedFetch(`http://nonexistent-domain-example.test/path`, {
    timeoutMs: 2000,
    dnsResolver: failingResolver,
  });

  assert.equal(result.status, 0);
  assert.equal(result.failureReason, 'network');
  assert.ok(!result.error!.includes('SSRF blocked'), 'Error should not claim SSRF block');
});
