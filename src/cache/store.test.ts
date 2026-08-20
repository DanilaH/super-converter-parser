import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CacheStore,
  CACHE_SCHEMA_VERSION,
  EXPIRED_ENTRY_GRACE_MS,
  ttlMsForKeywordStatus,
  ttlMsForDomainStatus,
  ttlMsForRelatedStatus,
  type CacheTtlSettings,
  type CachedKeywordEntry,
  type CachedRelatedEntry,
} from './store.js';
import { buildKeywordCacheKey, buildRelatedCacheKey, keywordCacheIdentity, type CacheIdentity } from './keys.js';
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

test('putKeyword is atomic: a SERP insert failure preserves the previous keyword and SERP rows', async () => {
  // A real trigger-based fault injection: any INSERT into serp_cache aborts,
  // so the whole putKeyword transaction must roll back, leaving the previous
  // keyword row and its SERP rows exactly as they were.
  const directory = await mkdtemp(join(tmpdir(), 'cache-atomic-'));
  const path = join(directory, 'cache.sqlite');
  const now = Date.now();
  const liveEntry = entry({
    collectedAt: new Date(now - 60_000).toISOString(),
    storedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  const first = CacheStore.open(path);
  first.putKeyword(liveEntry);
  first.close();

  const raw = new Database(path);
  raw.exec(`
    CREATE TRIGGER inject_serp_failure
    BEFORE INSERT ON serp_cache
    BEGIN
      SELECT RAISE(ABORT, 'injected serp insert failure');
    END;
  `);
  raw.close();

  const store = CacheStore.open(path);
  const key = buildKeywordCacheKey('compare lists', IDENTITY);
  const before = store.getKeyword(key) as CachedKeywordEntry;
  assert.equal(before?.serpRows.length, 3);

  assert.throws(
    () =>
      store.putKeyword({
        ...liveEntry,
        serpRows: serpRows(1),
        expiresAt: new Date(now + 120_000).toISOString(),
      }),
    (error: unknown) => error instanceof ResearchError && error.code === 'CACHE_DB_ERROR',
  );

  // The failed write changed nothing: the previous entry is fully intact.
  const after = store.getKeyword(key) as CachedKeywordEntry;
  assert.equal(after?.record.surfer?.volume, 49500);
  assert.deepEqual(
    after.serpRows.map((row) => row.position),
    [1, 2, 3],
  );
  assert.equal(after.expiresAt, liveEntry.expiresAt);
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
    relatedErrorMs: 60 * 60 * 1000,
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
  assert.equal(ttlMsForRelatedStatus('ok', ttl), 7 * 24 * 60 * 60 * 1000);
  assert.equal(ttlMsForRelatedStatus('empty', ttl), 7 * 24 * 60 * 60 * 1000);
  assert.equal(ttlMsForRelatedStatus('error', ttl), 60 * 60 * 1000);
});

test('related cache roundtrip preserves parent keyword, identity and TTL-derived expiry', () => {
  const store = CacheStore.openInMemory();
  const key = buildRelatedCacheKey('compare lists', IDENTITY);
  const storedAt = '2026-01-01T00:00:00.000Z';
  const ttlMs = 7 * 24 * 60 * 60 * 1000;
  store.putRelated(
    {
      cacheKey: key,
      normalizedKeyword: 'compare lists',
      identity: IDENTITY,
      status: 'ok',
      error: null,
      rows: [
        { relatedKeyword: 'compare lists online', overlap: 80, volume: 1200 },
        { relatedKeyword: 'compare two lists', overlap: 60, volume: 800 },
      ],
    },
    storedAt,
    ttlMs,
  );
  const loaded = store.getRelated(key) as CachedRelatedEntry;
  assert.equal(loaded?.rows.length, 2);
  assert.equal(loaded?.rows[0]?.relatedKeyword, 'compare lists online');
  assert.equal(loaded?.rows[1]?.overlap, 60);
  // The store derives the expiry from storedAt + ttlMs, never from the caller.
  assert.equal(loaded.expiresAt, '2026-01-08T00:00:00.000Z');
  assert.equal(loaded.normalizedKeyword, 'compare lists');
  assert.deepEqual(loaded.identity, IDENTITY);
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.error, null);
  assert.equal(store.getRelated('other'), null);
  store.close();
});

test('related entries are scoped by identity: a different market cannot read them', () => {
  const store = CacheStore.openInMemory();
  store.putRelated(
    {
      cacheKey: buildRelatedCacheKey('compare lists', IDENTITY),
      normalizedKeyword: 'compare lists',
      identity: IDENTITY,
      status: 'ok',
      error: null,
      rows: [{ relatedKeyword: 'x', overlap: null, volume: null }],
    },
    '2026-01-01T00:00:00.000Z',
    7 * 24 * 60 * 60 * 1000,
  );
  const otherIdentity = { ...IDENTITY, gl: 'de' };
  assert.equal(store.getRelated(buildRelatedCacheKey('compare lists', otherIdentity)), null);
  // Same identity, different parent keyword: also a miss.
  assert.equal(store.getRelated(buildRelatedCacheKey('other keyword', IDENTITY)), null);
  store.close();
});

test('related entries cache empty and error states distinctly from never-fetched', () => {
  const store = CacheStore.openInMemory();
  const storedAt = '2026-01-01T00:00:00.000Z';
  const ttlMs = 7 * 24 * 60 * 60 * 1000;

  // A genuinely empty expansion is cached, not treated as a miss.
  const emptyKey = buildRelatedCacheKey('no related', IDENTITY);
  store.putRelated(
    {
      cacheKey: emptyKey,
      normalizedKeyword: 'no related',
      identity: IDENTITY,
      status: 'empty',
      error: null,
      rows: [],
    },
    storedAt,
    ttlMs,
  );
  const empty = store.getRelated(emptyKey) as CachedRelatedEntry;
  assert.equal(empty?.status, 'empty');
  assert.deepEqual(empty?.rows, []);
  assert.equal(empty?.error, null);
  assert.equal(empty?.expiresAt, '2026-01-08T00:00:00.000Z');

  // A failed expansion is cached with its error for a short TTL.
  const errorKey = buildRelatedCacheKey('broken keyword', IDENTITY);
  store.putRelated(
    {
      cacheKey: errorKey,
      normalizedKeyword: 'broken keyword',
      identity: IDENTITY,
      status: 'error',
      error: 'SURFER_PARSE_ERROR: related sidebar not found',
      rows: [],
    },
    storedAt,
    60 * 60 * 1000,
  );
  const error = store.getRelated(errorKey) as CachedRelatedEntry;
  assert.equal(error?.status, 'error');
  assert.equal(error?.error, 'SURFER_PARSE_ERROR: related sidebar not found');
  assert.deepEqual(error?.rows, []);
  assert.equal(error?.expiresAt, '2026-01-01T01:00:00.000Z');

  // An error entry is replaced by a successful one in place.
  store.putRelated(
    {
      cacheKey: errorKey,
      normalizedKeyword: 'broken keyword',
      identity: IDENTITY,
      status: 'ok',
      error: null,
      rows: [{ relatedKeyword: 'fixed keyword', overlap: 50, volume: 400 }],
    },
    storedAt,
    ttlMs,
  );
  const fixed = store.getRelated(errorKey) as CachedRelatedEntry;
  assert.equal(fixed?.status, 'ok');
  assert.equal(fixed?.error, null);
  assert.equal(fixed?.rows.length, 1);
  assert.equal(fixed?.rows[0]?.relatedKeyword, 'fixed keyword');

  // A key that was never written is still a miss.
  assert.equal(store.getRelated('never-written'), null);
  store.close();
});

test('putRelated rejects invalid ok/empty/error combinations with CACHE_DB_ERROR', () => {
  const store = CacheStore.openInMemory();
  const key = buildRelatedCacheKey('compare lists', IDENTITY);
  const base = {
    cacheKey: key,
    normalizedKeyword: 'compare lists',
    identity: IDENTITY,
  };
  const invalid: Array<{
    label: string;
    status: 'ok' | 'empty' | 'error';
    error: string | null;
    rows: CachedRelatedEntry['rows'];
  }> = [
    { label: 'ok without rows', status: 'ok', error: null, rows: [] },
    { label: 'ok with an error message', status: 'ok', error: 'x', rows: [{ relatedKeyword: 'x', overlap: null, volume: null }] },
    { label: 'empty with rows', status: 'empty', error: null, rows: [{ relatedKeyword: 'x', overlap: null, volume: null }] },
    { label: 'empty with an error message', status: 'empty', error: 'x', rows: [] },
    { label: 'error without a message', status: 'error', error: null, rows: [] },
    { label: 'error with an empty message', status: 'error', error: '', rows: [] },
    { label: 'error with rows', status: 'error', error: 'x', rows: [{ relatedKeyword: 'x', overlap: null, volume: null }] },
  ];
  for (const item of invalid) {
    assert.throws(
      () => store.putRelated({ ...base, status: item.status, error: item.error, rows: item.rows }, '2026-01-01T00:00:00.000Z', 7 * 24 * 60 * 60 * 1000),
      (error: unknown) => error instanceof ResearchError && error.code === 'CACHE_DB_ERROR',
      item.label,
    );
  }
  // Nothing was persisted as a placeholder pretending to be a result.
  assert.equal(store.getRelated(key), null);
  store.close();
});

test('putRelated replaces an existing entry and derives a fresh expiry', () => {
  const store = CacheStore.openInMemory();
  const key = buildRelatedCacheKey('compare lists', IDENTITY);
  store.putRelated(
    {
      cacheKey: key,
      normalizedKeyword: 'compare lists',
      identity: IDENTITY,
      status: 'ok',
      error: null,
      rows: [{ relatedKeyword: 'old', overlap: 1, volume: 1 }],
    },
    '2026-01-01T00:00:00.000Z',
    7 * 24 * 60 * 60 * 1000,
  );
  const ttlMs = 7 * 24 * 60 * 60 * 1000;
  const storedAt = '2026-02-01T00:00:00.000Z';
  store.putRelated(
    {
      cacheKey: key,
      normalizedKeyword: 'compare lists',
      identity: IDENTITY,
      status: 'ok',
      error: null,
      rows: [{ relatedKeyword: 'new', overlap: 2, volume: 2 }],
    },
    storedAt,
    ttlMs,
  );
  const loaded = store.getRelated(key) as CachedRelatedEntry;
  assert.equal(loaded?.rows.length, 1);
  assert.equal(loaded?.rows[0]?.relatedKeyword, 'new');
  assert.equal(loaded.expiresAt, '2026-02-08T00:00:00.000Z');
  store.close();
});

test('a v1 cache database migrates to the current schema and is backed up first', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-migrate-v1-'));
  const path = join(directory, 'cache.sqlite');
  const v1 = new Database(path);
  v1.pragma('user_version = 1');
  v1.exec(`
    CREATE TABLE keyword_cache (
      cache_key TEXT PRIMARY KEY,
      keyword TEXT NOT NULL,
      normalized_keyword TEXT NOT NULL,
      identity TEXT NOT NULL,
      status TEXT NOT NULL,
      surfer TEXT,
      google TEXT,
      error TEXT,
      collected_at TEXT NOT NULL,
      stored_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE serp_cache (
      cache_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      keyword TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      hostname TEXT NOT NULL,
      result_type TEXT NOT NULL,
      PRIMARY KEY (cache_key, position)
    );
    CREATE TABLE related_cache (
      cache_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      related_keyword TEXT NOT NULL,
      overlap INTEGER,
      volume INTEGER,
      stored_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (cache_key, position)
    );
    CREATE TABLE domain_cache (
      domain TEXT PRIMARY KEY,
      dr REAL,
      status TEXT NOT NULL,
      error TEXT,
      stored_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  // A v1 keyword entry that must survive the migration.
  v1.prepare(
    `INSERT INTO keyword_cache
       (cache_key, keyword, normalized_keyword, identity, status, surfer, google, error, collected_at, stored_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  ).run(
    'k1',
    'compare lists',
    'compare lists',
    JSON.stringify(IDENTITY),
    'completed',
    JSON.stringify({ volume: 49500 }),
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    '2026-12-08T00:00:00.000Z',
  );
  v1.close();

  const migrated = CacheStore.open(path);
  assert.equal(migrated.version, CACHE_SCHEMA_VERSION);
  assert.equal(migrated.version, 3);
  // The pre-migration copy is preserved next to the original.
  const backupPath = `${path}.pre-v1.bak`;
  assert.ok(existsSync(backupPath));
  const backup = new Database(backupPath);
  assert.equal(backup.pragma('user_version', { simple: true }), 1);
  assert.equal((backup.prepare('SELECT COUNT(*) AS c FROM keyword_cache').get() as { c: number }).c, 1);
  backup.close();
  // Existing data survived the structural changes.
  assert.equal(migrated.getKeyword('k1')?.record.surfer?.volume, 49500);
  // v2/v3 columns exist and are writable through the new contract.
  migrated.putRelated(
    {
      cacheKey: buildRelatedCacheKey('compare lists', IDENTITY),
      normalizedKeyword: 'compare lists',
      identity: IDENTITY,
      status: 'empty',
      error: null,
      rows: [],
    },
    '2026-01-01T00:00:00.000Z',
    7 * 24 * 60 * 60 * 1000,
  );
  const related = migrated.getRelated(buildRelatedCacheKey('compare lists', IDENTITY));
  assert.equal(related?.status, 'empty');
  assert.equal(migrated.getRelated('other'), null);
  migrated.close();
});

test('a failed migration rolls back atomically and leaves the old version intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-migrate-rollback-'));
  const path = join(directory, 'cache.sqlite');
  const v1 = new Database(path);
  v1.pragma('user_version = 1');
  // v1 schema but related_cache already has a "keyword" column, so the v2
  // ALTER ADD COLUMN must fail; the transaction must roll back everything.
  v1.exec(`
    CREATE TABLE keyword_cache (
      cache_key TEXT PRIMARY KEY,
      keyword TEXT NOT NULL,
      normalized_keyword TEXT NOT NULL,
      identity TEXT NOT NULL,
      status TEXT NOT NULL,
      surfer TEXT,
      google TEXT,
      error TEXT,
      collected_at TEXT NOT NULL,
      stored_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE serp_cache (
      cache_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      keyword TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      hostname TEXT NOT NULL,
      result_type TEXT NOT NULL,
      PRIMARY KEY (cache_key, position)
    );
    CREATE TABLE related_cache (
      cache_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      related_keyword TEXT NOT NULL,
      overlap INTEGER,
      volume INTEGER,
      keyword TEXT NOT NULL,
      stored_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (cache_key, position)
    );
    CREATE TABLE domain_cache (
      domain TEXT PRIMARY KEY,
      dr REAL,
      status TEXT NOT NULL,
      error TEXT,
      stored_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  v1.prepare(
    `INSERT INTO keyword_cache
       (cache_key, keyword, normalized_keyword, identity, status, surfer, google, error, collected_at, stored_at, expires_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
  ).run('k1', 'x', 'x', '{}', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-08T00:00:00.000Z');
  // A legacy related row that must survive the failed migration.
  v1.prepare(
    `INSERT INTO related_cache (cache_key, position, related_keyword, overlap, volume, keyword, stored_at, expires_at)
     VALUES (?, 0, 'x', NULL, NULL, 'compare lists', ?, ?)`,
  ).run('related-legacy', '2026-01-01T00:00:00.000Z', '2026-01-08T00:00:00.000Z');
  v1.close();

  assert.throws(
    () => CacheStore.open(path),
    (error: unknown) => error instanceof ResearchError && error.code === 'CACHE_DB_ERROR',
  );

  // The failed migration left the file fully usable at v1 with its data.
  const raw = new Database(path);
  assert.equal(raw.pragma('user_version', { simple: true }), 1);
  assert.equal((raw.prepare('SELECT COUNT(*) AS c FROM keyword_cache').get() as { c: number }).c, 1);
  const columns = raw.prepare('PRAGMA table_info(related_cache)').all() as Array<{ name: string }>;
  assert.ok(!columns.some((column) => column.name === 'identity'));
  // The legacy related row is still readable under the v1 contract.
  assert.equal(
    (raw.prepare('SELECT COUNT(*) AS c FROM related_cache WHERE cache_key = ?').get('related-legacy') as { c: number }).c,
    1,
  );
  raw.close();
});

test('a v2 cache database migrates to v3 and invalidates legacy related rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-migrate-v2-'));
  const path = join(directory, 'cache.sqlite');
  const v2 = new Database(path);
  v2.pragma('user_version = 2');
  v2.exec(`
    CREATE TABLE keyword_cache (
      cache_key TEXT PRIMARY KEY,
      keyword TEXT NOT NULL,
      normalized_keyword TEXT NOT NULL,
      identity TEXT NOT NULL,
      status TEXT NOT NULL,
      surfer TEXT,
      google TEXT,
      error TEXT,
      collected_at TEXT NOT NULL,
      stored_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE serp_cache (
      cache_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      keyword TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      hostname TEXT NOT NULL,
      result_type TEXT NOT NULL,
      PRIMARY KEY (cache_key, position)
    );
    CREATE TABLE related_cache (
      cache_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      related_keyword TEXT NOT NULL,
      overlap INTEGER,
      volume INTEGER,
      stored_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (cache_key, position)
    );
    CREATE TABLE domain_cache (
      domain TEXT PRIMARY KEY,
      dr REAL,
      status TEXT NOT NULL,
      error TEXT,
      stored_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    ALTER TABLE related_cache ADD COLUMN keyword TEXT NOT NULL DEFAULT '';
    ALTER TABLE related_cache ADD COLUMN identity TEXT NOT NULL DEFAULT '';
  `);
  // A keyword entry that must survive the migration.
  v2.prepare(
    `INSERT INTO keyword_cache
       (cache_key, keyword, normalized_keyword, identity, status, surfer, google, error, collected_at, stored_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  ).run(
    'k1',
    'compare lists',
    'compare lists',
    JSON.stringify(IDENTITY),
    'completed',
    JSON.stringify({ volume: 49500 }),
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    '2026-12-08T00:00:00.000Z',
  );
  // A legacy v2 related entry whose true status is unknowable.
  v2.prepare(
    `INSERT INTO related_cache (cache_key, position, related_keyword, overlap, volume, keyword, identity, stored_at, expires_at)
     VALUES (?, 0, 'x', NULL, NULL, 'compare lists', ?, ?, ?)`,
  ).run(
    'related-legacy',
    JSON.stringify(IDENTITY),
    '2026-01-01T00:00:00.000Z',
    '2026-12-08T00:00:00.000Z',
  );
  v2.close();

  const migrated = CacheStore.open(path);
  assert.equal(migrated.version, 3);
  // Legacy rows were invalidated, never silently pretended to be 'ok'.
  assert.equal(migrated.getRelated('related-legacy'), null);
  // Everything else survived the structural changes.
  assert.equal(migrated.getKeyword('k1')?.record.surfer?.volume, 49500);
  migrated.close();
  const raw = new Database(path);
  assert.equal(
    (raw.prepare('SELECT COUNT(*) AS c FROM related_cache').get() as { c: number }).c,
    0,
  );
  raw.close();
  // The pre-migration copy predates the invalidation.
  const backupPath = `${path}.pre-v2.bak`;
  assert.ok(existsSync(backupPath));
  const backup = new Database(backupPath);
  assert.equal(backup.pragma('user_version', { simple: true }), 2);
  assert.equal(
    (backup.prepare('SELECT COUNT(*) AS c FROM related_cache').get() as { c: number }).c,
    1,
  );
  backup.close();
});

test('a failed v3 migration rolls back atomically and keeps the legacy related rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-migrate-v3-rollback-'));
  const path = join(directory, 'cache.sqlite');
  const v2 = new Database(path);
  v2.pragma('user_version = 2');
  v2.exec(`
    CREATE TABLE keyword_cache (
      cache_key TEXT PRIMARY KEY,
      keyword TEXT NOT NULL,
      normalized_keyword TEXT NOT NULL,
      identity TEXT NOT NULL,
      status TEXT NOT NULL,
      surfer TEXT,
      google TEXT,
      error TEXT,
      collected_at TEXT NOT NULL,
      stored_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE serp_cache (
      cache_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      keyword TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      hostname TEXT NOT NULL,
      result_type TEXT NOT NULL,
      PRIMARY KEY (cache_key, position)
    );
    CREATE TABLE related_cache (
      cache_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      related_keyword TEXT NOT NULL,
      overlap INTEGER,
      volume INTEGER,
      stored_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (cache_key, position)
    );
    CREATE TABLE domain_cache (
      domain TEXT PRIMARY KEY,
      dr REAL,
      status TEXT NOT NULL,
      error TEXT,
      stored_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    ALTER TABLE related_cache ADD COLUMN keyword TEXT NOT NULL DEFAULT '';
    ALTER TABLE related_cache ADD COLUMN identity TEXT NOT NULL DEFAULT '';
    ALTER TABLE related_cache ADD COLUMN status TEXT NOT NULL DEFAULT 'ok';
  `);
  // A legacy related row that must survive the failed migration.
  v2.prepare(
    `INSERT INTO related_cache (cache_key, position, related_keyword, overlap, volume, keyword, identity, stored_at, expires_at)
     VALUES (?, 0, 'x', NULL, NULL, 'compare lists', ?, ?, ?)`,
  ).run(
    'related-legacy',
    JSON.stringify(IDENTITY),
    '2026-01-01T00:00:00.000Z',
    '2026-12-08T00:00:00.000Z',
  );
  v2.close();

  assert.throws(
    () => CacheStore.open(path),
    (error: unknown) =>
      error instanceof ResearchError &&
      error.code === 'CACHE_DB_ERROR' &&
      error.message.includes('migration v3 failed'),
  );

  // The failed migration left the file fully usable at v2 with its data; the
  // second v3 ALTER never ran and the invalidation never happened.
  const raw = new Database(path);
  assert.equal(raw.pragma('user_version', { simple: true }), 2);
  assert.equal(
    (raw.prepare('SELECT COUNT(*) AS c FROM related_cache').get() as { c: number }).c,
    1,
  );
  const columns = raw.prepare('PRAGMA table_info(related_cache)').all() as Array<{ name: string }>;
  assert.ok(!columns.some((column) => column.name === 'error'));
  raw.close();
});

test('a cache database from a newer schema version is refused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-migrate-future-'));
  const path = join(directory, 'cache.sqlite');
  const newer = new Database(path);
  newer.pragma('user_version = 99');
  newer.close();
  assert.throws(
    () => CacheStore.open(path),
    (error: unknown) =>
      error instanceof ResearchError &&
      error.code === 'CACHE_DB_ERROR' &&
      error.message.includes('newer than this build supports'),
  );
});

test('store methods wrap driver failures as CACHE_DB_ERROR', () => {
  const store = CacheStore.openInMemory();
  store.close();
  assert.throws(
    () => store.getKeyword('x'),
    (error: unknown) => error instanceof ResearchError && error.code === 'CACHE_DB_ERROR',
  );
  assert.throws(
    () => store.getRelated('x'),
    (error: unknown) => error instanceof ResearchError && error.code === 'CACHE_DB_ERROR',
  );
  assert.throws(
    () => store.getDomain('x'),
    (error: unknown) => error instanceof ResearchError && error.code === 'CACHE_DB_ERROR',
  );
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
  store.putRelated(
    {
      cacheKey: 'related-expired',
      normalizedKeyword: 'compare lists',
      identity: IDENTITY,
      status: 'ok',
      error: null,
      rows: [{ relatedKeyword: 'x', overlap: null, volume: null }],
    },
    '2020-01-01T00:00:00.000Z',
    1000,
  );
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

test('recently expired entries survive a reopen so the next run classifies them as expired', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-grace-'));
  const path = join(directory, 'cache.sqlite');
  const now = Date.now();
  const store = CacheStore.open(path);
  // Live entry: served as a hit.
  store.putKeyword(entry({ cacheKey: 'live', expiresAt: new Date(now + 60_000).toISOString() }));
  // Expired moments ago (within the grace window): must survive open and be
  // classifiable as expired by the next run instead of a provenance-less miss.
  const expiredRecently = new Date(now - 60_000).toISOString();
  store.putKeyword(entry({ cacheKey: 'recently-expired', expiresAt: expiredRecently }));
  store.putRelated(
    {
      cacheKey: 'recently-expired-related',
      normalizedKeyword: 'compare lists',
      identity: IDENTITY,
      status: 'ok',
      error: null,
      rows: [{ relatedKeyword: 'x', overlap: null, volume: null }],
    },
    expiredRecently,
    1,
  );
  // Dead long ago (beyond the grace window): purged at open.
  store.putKeyword(entry({ cacheKey: 'ancient', expiresAt: '2020-01-01T00:00:00.000Z' }));
  store.close();

  const reopened = CacheStore.open(path);
  assert.equal(reopened.getKeyword('live')?.cacheKey, 'live');
  const expired = reopened.getKeyword('recently-expired') as CachedKeywordEntry;
  assert.equal(expired?.cacheKey, 'recently-expired');
  assert.ok(Date.parse(expired.expiresAt) <= Date.now());
  assert.equal(reopened.getRelated('recently-expired-related')?.status, 'ok');
  assert.equal(reopened.getKeyword('ancient'), null);
  reopened.close();
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
  assert.equal(EXPIRED_ENTRY_GRACE_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(CONFIG.cache.ttl.completedMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(CONFIG.cache.ttl.partialMs, 6 * 60 * 60 * 1000);
  assert.equal(CONFIG.cache.ttl.failedMs, 60 * 60 * 1000);
  assert.equal(CONFIG.cache.ttl.relatedMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(CONFIG.cache.ttl.relatedErrorMs, 60 * 60 * 1000);
  assert.equal(CONFIG.cache.ttl.domainOkMs, 30 * 24 * 60 * 60 * 1000);
  assert.equal(CONFIG.cache.ttl.domainErrorMs, 60 * 60 * 1000);
});

test('keywordCacheIdentity comes from config and parser versions', () => {
  assert.deepEqual(keywordCacheIdentity(CONFIG), {
    market: 'US',
    hl: 'en',
    gl: 'us',
    topN: 10,
    surferParserVersion: '2.0.0',
    googleParserVersion: '1.2.0',
  });
});
