import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnrichmentCache, makeCacheKey, DEFAULT_CACHE_TTL } from './cache.js';

test('EnrichmentCache: returns null for missing key', () => {
  const cache = EnrichmentCache.openInMemory();
  assert.equal(cache.get('missing'), null);
  cache.close();
});

test('EnrichmentCache: stores and retrieves entries', () => {
  const cache = EnrichmentCache.openInMemory();
  const key = makeCacheKey('https://example.com', '1.0.0', 'default');

  cache.set(key, 'https://example.com', '1.0.0', '{"title": "Test"}', 'ok');
  const entry = cache.get(key);

  assert.ok(entry);
  assert.equal(entry!.url, 'https://example.com');
  assert.equal(entry!.status, 'ok');
  assert.equal(entry!.data, '{"title": "Test"}');
  cache.close();
});

test('EnrichmentCache: isFresh returns true for valid entry', () => {
  const cache = EnrichmentCache.openInMemory();
  const key = makeCacheKey('https://example.com', '1.0.0', 'default');

  cache.set(key, 'https://example.com', '1.0.0', '{}', 'ok');
  const entry = cache.get(key);

  assert.equal(cache.isFresh(entry!), true);
  cache.close();
});

test('EnrichmentCache: isFresh returns false for expired entry', () => {
  const shortTtl = { ...DEFAULT_CACHE_TTL, successMs: 1 };
  const cache = EnrichmentCache.openInMemory(shortTtl);
  const key = makeCacheKey('https://example.com', '1.0.0', 'default');

  cache.set(key, 'https://example.com', '1.0.0', '{}', 'ok');

  return new Promise((resolve) => {
    setTimeout(() => {
      const entry = cache.get(key);
      assert.equal(cache.isFresh(entry!), false);
      cache.close();
      resolve();
    }, 10);
  });
});

test('EnrichmentCache: different statuses have different TTLs', () => {
  const cache = EnrichmentCache.openInMemory();
  const keyOk = makeCacheKey('https://example.com/ok', '1.0.0', 'default');
  const keyError = makeCacheKey('https://example.com/error', '1.0.0', 'default');

  cache.set(keyOk, 'https://example.com/ok', '1.0.0', '{}', 'ok');
  cache.set(keyError, 'https://example.com/error', '1.0.0', '{}', 'error');

  const okEntry = cache.get(keyOk)!;
  const errorEntry = cache.get(keyError)!;

  const okExpiry = new Date(okEntry.expiresAt).getTime();
  const errorExpiry = new Date(errorEntry.expiresAt).getTime();

  assert.ok(okExpiry > errorExpiry, 'Success TTL should be longer than error TTL');
  cache.close();
});

test('EnrichmentCache: delete removes entry', () => {
  const cache = EnrichmentCache.openInMemory();
  const key = makeCacheKey('https://example.com', '1.0.0', 'default');

  cache.set(key, 'https://example.com', '1.0.0', '{}', 'ok');
  assert.ok(cache.get(key));

  cache.delete(key);
  assert.equal(cache.get(key), null);
  cache.close();
});

test('EnrichmentCache: clear removes all entries', () => {
  const cache = EnrichmentCache.openInMemory();

  cache.set(makeCacheKey('https://a.com', '1.0.0', 'default'), 'https://a.com', '1.0.0', '{}', 'ok');
  cache.set(makeCacheKey('https://b.com', '1.0.0', 'default'), 'https://b.com', '1.0.0', '{}', 'ok');

  cache.clear();
  assert.equal(cache.get(makeCacheKey('https://a.com', '1.0.0', 'default')), null);
  assert.equal(cache.get(makeCacheKey('https://b.com', '1.0.0', 'default')), null);
  cache.close();
});

test('EnrichmentCache: cleanup removes expired entries', () => {
  const shortTtl = { ...DEFAULT_CACHE_TTL, successMs: 1 };
  const cache = EnrichmentCache.openInMemory(shortTtl);
  const key = makeCacheKey('https://example.com', '1.0.0', 'default');

  cache.set(key, 'https://example.com', '1.0.0', '{}', 'ok');

  return new Promise((resolve) => {
    setTimeout(() => {
      const removed = cache.cleanup();
      assert.equal(removed, 1);
      assert.equal(cache.get(key), null);
      cache.close();
      resolve();
    }, 10);
  });
});

test('EnrichmentCache: upsert updates existing entry', () => {
  const cache = EnrichmentCache.openInMemory();
  const key = makeCacheKey('https://example.com', '1.0.0', 'default');

  cache.set(key, 'https://example.com', '1.0.0', '{"v": 1}', 'ok');
  cache.set(key, 'https://example.com', '1.0.0', '{"v": 2}', 'ok');

  const entry = cache.get(key);
  assert.equal(entry!.data, '{"v": 2}');
  cache.close();
});

test('makeCacheKey: normalizes URL trailing slash', () => {
  const key1 = makeCacheKey('https://example.com/', '1.0.0', 'default');
  const key2 = makeCacheKey('https://example.com', '1.0.0', 'default');
  assert.equal(key1, key2);
});

test('makeCacheKey: different versions produce different keys', () => {
  const key1 = makeCacheKey('https://example.com', '1.0.0', 'default');
  const key2 = makeCacheKey('https://example.com', '2.0.0', 'default');
  assert.notEqual(key1, key2);
});
