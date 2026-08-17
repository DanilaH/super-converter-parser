import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CacheStore,
  CACHE_SCHEMA_VERSION,
  ttlMsForKeywordStatus,
  ttlMsForDomainStatus,
  type CacheTtlSettings,
  type CachedKeywordEntry,
} from './store.js';
import { buildKeywordCacheKey, keywordCacheIdentity, type CacheIdentity } from './keys.js';
import { loadConfig } from '../config/config.js';
import { ResearchError } from '../shared/errors.js';
import type { SerpResult } from '../google/serp.js';

const CONFIG = loadConfig({});
const IDENTITY: CacheIdentity = {
  market: 'US',
  hl: 'en',
  gl: 'us',
  topN: 10,
  surferParserVersion: '1.0.0',
  googleParserVersion: '1.2.0',
};

function serpRows(count: number): SerpResult[] {
  return Array.from({ length: count }, (_, index) => ({
    keyword: 'compare lists',
    position: index + 1,
    title: `title ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    hostname: 'example.com',
    resultType: 'organic' as const,
  }));
}

function entry(overrides: Partial<CachedKeywordEntry> = {}): CachedKeywordEntry {
  return {
    cacheKey: buildKeywordCacheKey('compare lists', IDENTITY),
    keyword: 'compare lists',
    normalizedKeyword: 'compare lists',
    identity: IDENTITY,
    record: {
      id: 'kw-0001',
      keyword: 'compare lists',
      normalizedKeyword: 'compare lists',
      sources: [{ type: 'seed', rowNumbers: [1] }],
      status: 'completed',
      surfer: { volume: 49500, cpc: 7.9, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' },
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://google.com/search?q=compare+lists',
        detectedLocation: null,
        geoWarning: false,
      },
      error: null,
    },
    serpRows: serpRows(3),
    collectedAt: '2026-01-01T00:00:00.000Z',
    storedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-08T00:00:00.000Z',
    ...overrides,
  };
}

test('fresh cache store is at the current schema version', () => {
  const store = CacheStore.openInMemory();
  assert.equal(store.version, CACHE_SCHEMA_VERSION);
  store.close();
});

test('putKeyword/getKeyword roundtrip preserves data and SERP rows in order', () => {
  const store = CacheStore.openInMemory();
  const item = entry();
  store.putKeyword(item);
  const loaded = store.getKeyword(item.cacheKey) as CachedKeywordEntry;
  assert.equal(loaded?.keyword, 'compare lists');
  assert.deepEqual(loaded.identity, IDENTITY);
  assert.equal(loaded.record.status, 'completed');
  assert.equal(loaded.record.surfer?.volume, 49500);
  assert.deepEqual(loaded.record.error, null);
  assert.equal(loaded.collectedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(loaded.expiresAt, '2026-01-08T00:00:00.000Z');
  assert.deepEqual(
    loaded.serpRows.map((row) => row.position),
    [1, 2, 3],
  );
  store.close();
});

test('putKeyword replaces an existing entry and its SERP rows', () => {
  const store = CacheStore.openInMemory();
  const item = entry();
  store.putKeyword(item);
  store.putKeyword({ ...item, serpRows: serpRows(1), expiresAt: '2026-01-09T00:00:00.000Z' });
  const loaded = store.getKeyword(item.cacheKey) as CachedKeywordEntry;
  assert.equal(loaded.serpRows.length, 1);
  assert.equal(loaded.expiresAt, '2026-01-09T00:00:00.000Z');
  store.close();
});

test('getKeyword returns null for unknown keys', () => {
  const store = CacheStore.openInMemory();
  assert.equal(store.getKeyword('nope'), null);
  store.close();
});

test('failed entries keep their error and short TTL mapping', () => {
  const ttl: CacheTtlSettings = {
    completedMs: 7 * 24 * 60 * 60 * 1000,
    partialMs: 6 * 60 * 60 * 1000,
    failedMs: 60 * 60 * 1000,
    relatedMs: 7 * 24 * 60 * 60 * 1000,
    domainOkMs: 30 * 24 * 60 * 60 * 1000,
    domainNotFoundMs: 30 * 24 * 60 * 60 * 1000,
    domainErrorMs: 60 * 60 * 1000,
  };
  assert.equal(ttlMsForKeywordStatus('completed', ttl), 7 * 24 * 60 * 60 * 1000);
  assert.equal(ttlMsForKeywordStatus('partial', ttl), 6 * 60 * 60 * 1000);
  assert.equal(ttlMsForKeywordStatus('failed', ttl), 60 * 60 * 1000);
  assert.equal(ttlMsForDomainStatus('ok', ttl), 30 * 24 * 60 * 60 * 1000);
  assert.equal(ttlMsForDomainStatus('not_found', ttl), 30 * 24 * 60 * 60 * 1000);
  assert.equal(ttlMsForDomainStatus('error', ttl), 60 * 60 * 1000);
});

test('related cache roundtrip', () => {
  const store = CacheStore.openInMemory();
  const key = 'related-key';
  store.putRelated({
    cacheKey: key,
    rows: [
      { relatedKeyword: 'compare lists online', overlap: 80, volume: 1200 },
      { relatedKeyword: 'compare two lists', overlap: 60, volume: 800 },
    ],
    storedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-08T00:00:00.000Z',
  });
  const loaded = store.getRelated(key);
  assert.equal(loaded?.rows.length, 2);
  assert.equal(loaded?.rows[0]?.relatedKeyword, 'compare lists online');
  assert.equal(store.getRelated('other'), null);
  store.close();
});

test('domain cache roundtrip with explicit TTL', () => {
  const store = CacheStore.openInMemory();
  store.putDomain(
    'example.com',
    { dr: 42.5, status: 'ok', error: null },
    '2026-01-01T00:00:00.000Z',
    30 * 24 * 60 * 60 * 1000,
  );
  const loaded = store.getDomain('example.com');
  assert.equal(loaded?.dr, 42.5);
  assert.equal(loaded?.status, 'ok');
  assert.equal(loaded?.expiresAt, '2026-01-31T00:00:00.000Z');
  store.putDomain(
    'broken.com',
    { dr: null, status: 'error', error: 'rate limited' },
    '2026-01-01T00:00:00.000Z',
    60 * 60 * 1000,
  );
  const failed = store.getDomain('broken.com');
  assert.equal(failed?.error, 'rate limited');
  assert.equal(failed?.expiresAt, '2026-01-01T01:00:00.000Z');
  store.close();
});

test('cleanup removes expired entries and orphaned SERP rows but keeps valid ones', () => {
  const store = CacheStore.openInMemory();
  store.putKeyword(entry({ cacheKey: 'valid', expiresAt: '2026-02-01T00:00:00.000Z' }));
  store.putKeyword(entry({ cacheKey: 'expired', expiresAt: '2020-01-01T00:00:00.000Z' }));
  store.putKeyword(entry({ cacheKey: 'expired2', expiresAt: '2020-01-01T00:00:00.000Z' }));
  store.putRelated({
    cacheKey: 'related-expired',
    rows: [{ relatedKeyword: 'x', overlap: null, volume: null }],
    storedAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2020-01-02T00:00:00.000Z',
  });
  store.putDomain('old.com', { dr: null, status: 'error', error: 'x' }, '2020-01-01T00:00:00.000Z', 1000);

  const deleted = store.cleanup(Date.parse('2026-01-01T00:00:00.000Z'));
  assert.ok(deleted >= 3);
  assert.ok(store.getKeyword('valid'));
  assert.equal(store.getKeyword('expired'), null);
  assert.equal(store.getKeyword('expired2'), null);
  assert.equal(store.getRelated('related-expired'), null);
  assert.equal(store.getDomain('old.com'), null);
  store.close();
});

test('open of a cache path inside an existing file raises CACHE_DB_ERROR', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-open-'));
  const file = join(directory, 'blocker');
  await writeFile(file, 'file', 'utf8');
  assert.throws(
    () => CacheStore.open(join(file, 'cache.sqlite')),
    (error: unknown) => error instanceof ResearchError && error.code === 'CACHE_DB_ERROR',
  );
});

test('open creates the parent directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-dir-'));
  const path = join(directory, 'nested', 'deep', 'cache.sqlite');
  const store = CacheStore.open(path);
  store.putKeyword(entry({ expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  store.close();
  const reopened = CacheStore.open(path);
  assert.equal(reopened.getKeyword(entry().cacheKey)?.keyword, 'compare lists');
  reopened.close();
});

test('open of a corrupt database raises CACHE_DB_ERROR', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-corrupt-'));
  const path = join(directory, 'cache.sqlite');
  await writeFile(path, 'this is not a sqlite database', 'utf8');
  assert.throws(
    () => CacheStore.open(path),
    (error: unknown) => error instanceof ResearchError && error.code === 'CACHE_DB_ERROR',
  );
});

test('TTL defaults match the documented cache semantics', () => {
  assert.equal(CONFIG.cache.ttl.completedMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(CONFIG.cache.ttl.partialMs, 6 * 60 * 60 * 1000);
  assert.equal(CONFIG.cache.ttl.failedMs, 60 * 60 * 1000);
  assert.equal(CONFIG.cache.ttl.domainOkMs, 30 * 24 * 60 * 60 * 1000);
});

test('keywordCacheIdentity comes from config and parser versions', () => {
  assert.deepEqual(keywordCacheIdentity(CONFIG), {
    market: 'US',
    hl: 'en',
    gl: 'us',
    topN: 10,
    surferParserVersion: '1.0.0',
    googleParserVersion: '1.2.0',
  });
});
