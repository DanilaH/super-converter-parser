import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ResearchError } from '../shared/errors.js';
import type { CacheIdentity } from './keys.js';
import type { SerpResult } from '../google/serp.js';
import type { KeywordRecord, KeywordStatus } from '../runs/run.js';

export const CACHE_SCHEMA_VERSION = 3;

// Index i is applied when the database is at version i.
// Never edit an applied migration; append a new one.
const MIGRATIONS: string[] = [
  `
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
  `,
  // v2: related rows carry their parent keyword and identity so entries are
  // self-describing and verifiable against the key that produced them.
  `
  ALTER TABLE related_cache ADD COLUMN keyword TEXT NOT NULL DEFAULT '';
  ALTER TABLE related_cache ADD COLUMN identity TEXT NOT NULL DEFAULT '';
  `,
  // v3: related entries are explicitly cached as ok/empty/error so a failed
  // or genuinely empty expansion is distinguishable from "never fetched".
  // Existing ok rows keep their implied status via the default.
  `
  ALTER TABLE related_cache ADD COLUMN status TEXT NOT NULL DEFAULT 'ok';
  ALTER TABLE related_cache ADD COLUMN error TEXT;
  `,
];

export type CachedKeywordEntry = {
  cacheKey: string;
  keyword: string;
  normalizedKeyword: string;
  identity: CacheIdentity;
  record: KeywordRecord;
  serpRows: SerpResult[];
  collectedAt: string;
  storedAt: string;
  expiresAt: string;
};

export type CachedRelatedStatus = 'ok' | 'empty' | 'error';

export type CachedRelatedEntry = {
  cacheKey: string;
  // The parent keyword this list belongs to, and the identity that scopes it;
  // both are persisted so the entry is verifiable against its cache key.
  normalizedKeyword: string;
  identity: CacheIdentity;
  // 'ok' carries the rows; 'empty' means the expansion genuinely found no
  // related keywords (still cacheable); 'error' records a failed expansion.
  status: CachedRelatedStatus;
  error: string | null;
  rows: Array<{ relatedKeyword: string; overlap: number | null; volume: number | null }>;
  storedAt: string;
  expiresAt: string;
};

export type CachedDomainEntry = {
  domain: string;
  dr: number | null;
  status: 'ok' | 'not_found' | 'error';
  error: string | null;
  storedAt: string;
  expiresAt: string;
};

export type CacheTtlSettings = {
  completedMs: number;
  partialMs: number;
  failedMs: number;
  relatedMs: number;
  relatedErrorMs: number;
  domainOkMs: number;
  domainNotFoundMs: number;
  domainErrorMs: number;
};

export function ttlMsForKeywordStatus(status: KeywordStatus, ttl: CacheTtlSettings): number {
  switch (status) {
    case 'completed':
      return ttl.completedMs;
    case 'partial':
      return ttl.partialMs;
    case 'failed':
      return ttl.failedMs;
    default:
      throw new ResearchError(
        'CACHE_DB_ERROR',
        `No cache TTL for keyword status "${status}".`,
      );
  }
}

export function ttlMsForDomainStatus(
  status: CachedDomainEntry['status'],
  ttl: CacheTtlSettings,
): number {
  switch (status) {
    case 'ok':
      return ttl.domainOkMs;
    case 'not_found':
      return ttl.domainNotFoundMs;
    case 'error':
      return ttl.domainErrorMs;
  }
}

export function ttlMsForRelatedStatus(status: CachedRelatedStatus, ttl: CacheTtlSettings): number {
  switch (status) {
    case 'ok':
    case 'empty':
      return ttl.relatedMs;
    case 'error':
      return ttl.relatedErrorMs;
  }
}

type KeywordRow = {
  cache_key: string;
  keyword: string;
  normalized_keyword: string;
  identity: string;
  status: string;
  surfer: string | null;
  google: string | null;
  error: string | null;
  collected_at: string;
  stored_at: string;
  expires_at: string;
};

type SerpRow = {
  position: number;
  keyword: string;
  title: string;
  url: string;
  hostname: string;
  result_type: string;
};

// The narrow surface the engine depends on, so tests can substitute a fake
// without opening a real database.
export interface KeywordCache {
  getKeyword(cacheKey: string): CachedKeywordEntry | null;
  putKeyword(entry: CachedKeywordEntry): void;
}

export class CacheStore implements KeywordCache {
  private readonly db: Database.Database;
  private readonly path: string | null;

  private constructor(db: Database.Database, path: string | null) {
    this.db = db;
    this.path = path;
  }

  static open(path: string): CacheStore {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const db = new Database(path);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      const store = new CacheStore(db, path);
      store.migrate();
      store.cleanup(Date.now());
      return store;
    } catch (error) {
      // Internal failures already carry the specific CACHE_DB_ERROR message
      // (e.g. a refused future schema version); keep them as-is instead of
      // double-wrapping them into the generic open error.
      if (error instanceof ResearchError && error.code === 'CACHE_DB_ERROR') throw error;
      throw new ResearchError(
        'CACHE_DB_ERROR',
        `Failed to open cache store at "${path}".`,
        { cause: error },
      );
    }
  }

  static openInMemory(): CacheStore {
    const store = new CacheStore(new Database(':memory:'), null);
    store.migrate();
    return store;
  }

  // Structural changes are never applied silently: before the first migration
  // of an existing database a restorable copy is made next to the original,
  // every migration runs atomically (a failure leaves the old version fully
  // intact), and a database from a newer version is refused outright.
  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    if (current > MIGRATIONS.length) {
      throw new ResearchError(
        'CACHE_DB_ERROR',
        `Cache database is at schema version ${current}, newer than this build supports (${MIGRATIONS.length}). Refusing to open it.`,
      );
    }
    if (current === MIGRATIONS.length) return;

    if (this.path !== null && current > 0) {
      const backupPath = `${this.path}.pre-v${current}.bak`;
      if (!existsSync(backupPath)) {
        // VACUUM INTO snapshots the full WAL state synchronously; a plain
        // file copy could miss uncheckpointed WAL pages.
        try {
          this.db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
        } catch (error) {
          throw new ResearchError(
            'CACHE_DB_ERROR',
            `Failed to back up cache database to "${backupPath}" before migrating it.`,
            { cause: error },
          );
        }
      }
    }

    for (let version = current; version < MIGRATIONS.length; version += 1) {
      try {
        const apply = this.db.transaction(() => {
          this.db.exec(MIGRATIONS[version] as string);
          this.db.pragma(`user_version = ${version + 1}`);
        });
        apply();
      } catch (error) {
        throw new ResearchError(
          'CACHE_DB_ERROR',
          `Cache schema migration v${version + 1} failed; the database was left at v${current}.`,
          { cause: error },
        );
      }
    }
  }

  get version(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  close(): void {
    this.db.close();
  }

  // Any storage-level failure is reported as CACHE_DB_ERROR with the original
  // cause attached, never as a raw driver exception leaking into exit code 1.
  private wrap<T>(operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw new ResearchError(
        'CACHE_DB_ERROR',
        `Cache store "${operation}" failed.`,
        { cause: error },
      );
    }
  }

  // Removes expired rows (and orphaned SERP rows whose keyword entry is
  // gone). Called on open; the correctness of the cache never depends on it.
  cleanup(now: number): number {
    return this.wrap('cleanup', () => {
      const iso = new Date(now).toISOString();
      const expireWhere = 'expires_at <= ?';
      let deleted = 0;
      const purge = this.db.transaction(() => {
        const keywordResult = this.db.prepare(`DELETE FROM keyword_cache WHERE ${expireWhere}`).run(iso);
        deleted += keywordResult.changes;
        const orphanSerp = this.db
          .prepare(
            'DELETE FROM serp_cache WHERE cache_key NOT IN (SELECT cache_key FROM keyword_cache)',
          )
          .run();
        deleted += orphanSerp.changes;
        const relatedResult = this.db.prepare(`DELETE FROM related_cache WHERE ${expireWhere}`).run(iso);
        deleted += relatedResult.changes;
        const domainResult = this.db.prepare(`DELETE FROM domain_cache WHERE ${expireWhere}`).run(iso);
        deleted += domainResult.changes;
      });
      purge();
      return deleted;
    });
  }

  getKeyword(cacheKey: string): CachedKeywordEntry | null {
    return this.wrap('getKeyword', () => this.getKeywordUnwrapped(cacheKey));
  }

  private getKeywordUnwrapped(cacheKey: string): CachedKeywordEntry | null {
    const row = this.db.prepare('SELECT * FROM keyword_cache WHERE cache_key = ?').get(cacheKey) as
      | KeywordRow
      | undefined;
    if (!row) return null;
    const serpRows = this.db
      .prepare('SELECT * FROM serp_cache WHERE cache_key = ? ORDER BY position ASC')
      .all(cacheKey) as SerpRow[];
    const identity = JSON.parse(row.identity) as CacheIdentity;
    return {
      cacheKey: row.cache_key,
      keyword: row.keyword,
      normalizedKeyword: row.normalized_keyword,
      identity,
      record: {
        id: 'cached',
        keyword: row.keyword,
        normalizedKeyword: row.normalized_keyword,
        sources: [],
        status: row.status as KeywordRecord['status'],
        surfer: row.surfer === null ? null : JSON.parse(row.surfer),
        google: row.google === null ? null : JSON.parse(row.google),
        error: row.error === null ? null : JSON.parse(row.error),
      },
      serpRows: serpRows.map((item) => ({
        keyword: item.keyword,
        position: item.position,
        title: item.title,
        url: item.url,
        hostname: item.hostname,
        resultType: item.result_type as SerpResult['resultType'],
      })),
      collectedAt: row.collected_at,
      storedAt: row.stored_at,
      expiresAt: row.expires_at,
    };
  }

  putKeyword(entry: CachedKeywordEntry): void {
    this.wrap('putKeyword', () => {
      const insertRow = this.db.prepare(
        `INSERT OR REPLACE INTO keyword_cache
           (cache_key, keyword, normalized_keyword, identity, status, surfer, google, error, collected_at, stored_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const deleteRows = this.db.prepare('DELETE FROM serp_cache WHERE cache_key = ?');
      const insertSerp = this.db.prepare(
        `INSERT INTO serp_cache (cache_key, position, keyword, title, url, hostname, result_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const write = this.db.transaction(() => {
        insertRow.run(
          entry.cacheKey,
          entry.record.keyword,
          entry.record.normalizedKeyword,
          JSON.stringify(entry.identity),
          entry.record.status,
          entry.record.surfer === null ? null : JSON.stringify(entry.record.surfer),
          entry.record.google === null ? null : JSON.stringify(entry.record.google),
          entry.record.error === null ? null : JSON.stringify(entry.record.error),
          entry.collectedAt,
          entry.storedAt,
          entry.expiresAt,
        );
        deleteRows.run(entry.cacheKey);
        for (const row of entry.serpRows) {
          insertSerp.run(
            entry.cacheKey,
            row.position,
            row.keyword,
            row.title,
            row.url,
            row.hostname,
            row.resultType,
          );
        }
      });
      write();
    });
  }

  getRelated(cacheKey: string): CachedRelatedEntry | null {
    return this.wrap('getRelated', () => {
      const rows = this.db
        .prepare('SELECT * FROM related_cache WHERE cache_key = ? ORDER BY position ASC')
        .all(cacheKey) as Array<{
        related_keyword: string;
        overlap: number | null;
        volume: number | null;
        keyword: string;
        identity: string;
        status: string;
        error: string | null;
        stored_at: string;
        expires_at: string;
      }>;
      if (rows.length === 0) return null;
      const status = rows[0]?.status as CachedRelatedStatus;
      return {
        cacheKey,
        normalizedKeyword: rows[0]?.keyword as string,
        identity: JSON.parse(rows[0]?.identity as string) as CacheIdentity,
        status,
        error: rows[0]?.error ?? null,
        // Data rows exist only for 'ok' entries; 'empty'/'error' store a
        // single placeholder row carrying status and error.
        rows:
          status === 'ok'
            ? rows.map((row) => ({
                relatedKeyword: row.related_keyword,
                overlap: row.overlap,
                volume: row.volume,
              }))
            : [],
        storedAt: rows[0]?.stored_at as string,
        expiresAt: rows[0]?.expires_at as string,
      };
    });
  }

  // Mirrors putDomain: the caller supplies data, storedAt and a TTL; the store
  // derives the expiry so callers can never store mismatched timestamps. An
  // 'ok' entry stores one row per related keyword; 'empty' and 'error' store a
  // single placeholder row, so the state is cacheable and observable.
  putRelated(
    entry: Omit<CachedRelatedEntry, 'storedAt' | 'expiresAt'>,
    storedAt: string,
    ttlMs: number,
  ): void {
    this.wrap('putRelated', () => {
      const expiresAt = new Date(Date.parse(storedAt) + ttlMs).toISOString();
      const deleteRows = this.db.prepare('DELETE FROM related_cache WHERE cache_key = ?');
      const insertRow = this.db.prepare(
        `INSERT INTO related_cache
           (cache_key, position, related_keyword, overlap, volume, keyword, identity, status, error, stored_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const identity = JSON.stringify(entry.identity);
      const write = this.db.transaction(() => {
        deleteRows.run(entry.cacheKey);
        const dataRows =
          entry.status === 'ok' && entry.rows.length > 0
            ? entry.rows
            : [{ relatedKeyword: '', overlap: null, volume: null }];
        dataRows.forEach((row, index) => {
          insertRow.run(
            entry.cacheKey,
            index,
            row.relatedKeyword,
            row.overlap,
            row.volume,
            entry.normalizedKeyword,
            identity,
            entry.status,
            entry.error,
            storedAt,
            expiresAt,
          );
        });
      });
      write();
    });
  }

  getDomain(domain: string): CachedDomainEntry | null {
    return this.wrap('getDomain', () => {
      const row = this.db
        .prepare('SELECT * FROM domain_cache WHERE domain = ?')
        .get(domain) as
        | {
            domain: string;
            dr: number | null;
            status: string;
            error: string | null;
            stored_at: string;
            expires_at: string;
          }
        | undefined;
      if (!row) return null;
      return {
        domain: row.domain,
        dr: row.dr,
        status: row.status as CachedDomainEntry['status'],
        error: row.error,
        storedAt: row.stored_at,
        expiresAt: row.expires_at,
      };
    });
  }

  putDomain(
    domain: string,
    entry: Omit<CachedDomainEntry, 'domain' | 'storedAt' | 'expiresAt'>,
    storedAt: string,
    ttlMs: number,
  ): void {
    this.wrap('putDomain', () => {
      const expiresAt = new Date(Date.parse(storedAt) + ttlMs).toISOString();
      this.db
        .prepare(
          `INSERT OR REPLACE INTO domain_cache (domain, dr, status, error, stored_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(domain, entry.dr, entry.status, entry.error, storedAt, expiresAt);
    });
  }
}
