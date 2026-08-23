import Database from 'better-sqlite3';

export type EnrichmentCacheStatus = 'hit' | 'miss' | 'expired' | 'refreshed' | 'none';

export type CacheEntry = {
  key: string;
  url: string;
  extractorVersion: string;
  data: string;
  fetchedAt: string;
  expiresAt: string;
  status: 'ok' | 'not_found' | 'error';
};

export type CacheTtlConfig = {
  successMs: number;
  notFoundMs: number;
  errorMs: number;
};

export const DEFAULT_CACHE_TTL: CacheTtlConfig = {
  successMs: 7 * 24 * 60 * 60 * 1000,
  notFoundMs: 24 * 60 * 60 * 1000,
  errorMs: 60 * 60 * 1000,
};

export type EnrichmentCacheConfig = {
  dbPath: string;
  ttl: CacheTtlConfig;
};

export function makeCacheKey(url: string, extractorVersion: string, limitsHash: string): string {
  const normalizedUrl = url.endsWith('/') ? url.slice(0, -1) : url;
  return `${normalizedUrl}::${extractorVersion}::${limitsHash}`;
}

export class EnrichmentCache {
  private readonly db: Database.Database;
  private readonly ttl: CacheTtlConfig;

  private constructor(db: Database.Database, ttl: CacheTtlConfig) {
    this.db = db;
    this.ttl = ttl;
  }

  static open(config: EnrichmentCacheConfig): EnrichmentCache {
    const db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS enrichment_http_cache (
        cache_key TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        data TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cache_expires ON enrichment_http_cache(expires_at);
    `);
    return new EnrichmentCache(db, config.ttl);
  }

  static openInMemory(ttl: CacheTtlConfig = DEFAULT_CACHE_TTL): EnrichmentCache {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE enrichment_http_cache (
        cache_key TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        data TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);
    return new EnrichmentCache(db, ttl);
  }

  get(key: string): CacheEntry | null {
    const row = this.db.prepare(
      'SELECT cache_key, url, extractor_version, data, fetched_at, expires_at, status FROM enrichment_http_cache WHERE cache_key = ?',
    ).get(key) as {
      cache_key: string;
      url: string;
      extractor_version: string;
      data: string;
      fetched_at: string;
      expires_at: string;
      status: string;
    } | undefined;

    if (!row) return null;

    return {
      key: row.cache_key,
      url: row.url,
      extractorVersion: row.extractor_version,
      data: row.data,
      fetchedAt: row.fetched_at,
      expiresAt: row.expires_at,
      status: row.status as CacheEntry['status'],
    };
  }

  isFresh(entry: CacheEntry): boolean {
    const now = Date.now();
    const expires = new Date(entry.expiresAt).getTime();
    return expires > now;
  }

  set(key: string, url: string, extractorVersion: string, data: string, status: CacheEntry['status']): void {
    const now = new Date();
    let ttlMs: number;

    switch (status) {
      case 'ok':
        ttlMs = this.ttl.successMs;
        break;
      case 'not_found':
        ttlMs = this.ttl.notFoundMs;
        break;
      case 'error':
        ttlMs = this.ttl.errorMs;
        break;
    }

    const expiresAt = new Date(now.getTime() + ttlMs);

    this.db.prepare(`
      INSERT OR REPLACE INTO enrichment_http_cache (cache_key, url, extractor_version, data, fetched_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(key, url, extractorVersion, data, now.toISOString(), expiresAt.toISOString(), status);
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM enrichment_http_cache WHERE cache_key = ?').run(key);
  }

  clear(): void {
    this.db.exec('DELETE FROM enrichment_http_cache');
  }

  cleanup(): number {
    const result = this.db.prepare(
      'DELETE FROM enrichment_http_cache WHERE expires_at < ?',
    ).run(new Date().toISOString());
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
