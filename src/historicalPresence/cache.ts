import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ResearchError } from '../shared/errors.js';
import type { HistoricalPresenceResult } from './types.js';

export const HISTORICAL_PRESENCE_CACHE_SCHEMA_VERSION = 1;
export const HISTORICAL_PRESENCE_CACHE_EXPIRED_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export type CachedHistoricalPresenceEntry = HistoricalPresenceResult & {
  queryVersion: number;
  storedAt: string;
  expiresAt: string;
};

const CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS historical_presence_cache (
  domain TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  query_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  earliest_sampled_capture_at TEXT,
  earliest_sampled_capture_url TEXT,
  earliest_sampled_capture_http_status TEXT,
  earliest_matched_collection_id TEXT,
  earliest_matched_collection_from TEXT,
  earliest_matched_collection_to TEXT,
  history_complete_for_selected_collections INTEGER NOT NULL,
  selected_collection_count INTEGER NOT NULL,
  checked_collection_count INTEGER NOT NULL,
  source_reason TEXT,
  error TEXT,
  fetched_at TEXT NOT NULL,
  request_count INTEGER NOT NULL,
  http_status INTEGER,
  stored_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

export class HistoricalPresenceCache {
  private constructor(
    private readonly db: Database.Database,
    private readonly path: string | null,
  ) {}

  static open(path: string): HistoricalPresenceCache {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const db = new Database(path);
      db.pragma('journal_mode = WAL');
      const cache = new HistoricalPresenceCache(db, path);
      cache.migrate();
      cache.cleanup(Date.now());
      return cache;
    } catch (error) {
      if (error instanceof ResearchError && error.code === 'CACHE_DB_ERROR') throw error;
      throw new ResearchError('CACHE_DB_ERROR', `Failed to open historical-presence cache at "${path}".`, { cause: error });
    }
  }

  static openInMemory(): HistoricalPresenceCache {
    const cache = new HistoricalPresenceCache(new Database(':memory:'), null);
    cache.migrate();
    return cache;
  }

  get version(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const current = this.version;
    if (current > HISTORICAL_PRESENCE_CACHE_SCHEMA_VERSION) {
      throw new ResearchError(
        'CACHE_DB_ERROR',
        `Historical-presence cache is at schema version ${current}, newer than this build supports (${HISTORICAL_PRESENCE_CACHE_SCHEMA_VERSION}). Refusing to open it.`,
      );
    }
    if (current === HISTORICAL_PRESENCE_CACHE_SCHEMA_VERSION) return;
    if (current !== 0) {
      throw new ResearchError('CACHE_DB_ERROR', `Unsupported historical-presence cache migration from version ${current}.`);
    }
    const apply = this.db.transaction(() => {
      this.db.exec(CREATE_SCHEMA);
      this.db.pragma(`user_version = ${HISTORICAL_PRESENCE_CACHE_SCHEMA_VERSION}`);
    });
    try {
      apply();
    } catch (error) {
      throw new ResearchError('CACHE_DB_ERROR', 'Historical-presence cache schema initialization failed.', { cause: error });
    }
  }

  cleanup(nowMs: number): number {
    try {
      const cutoff = new Date(nowMs - HISTORICAL_PRESENCE_CACHE_EXPIRED_GRACE_MS).toISOString();
      return this.db.prepare('DELETE FROM historical_presence_cache WHERE expires_at <= ?').run(cutoff).changes;
    } catch (error) {
      throw new ResearchError('CACHE_DB_ERROR', 'Historical-presence cache cleanup failed.', { cause: error });
    }
  }

  get(domain: string): CachedHistoricalPresenceEntry | null {
    try {
      const row = this.db.prepare('SELECT * FROM historical_presence_cache WHERE domain = ?').get(domain) as
        | Record<string, unknown>
        | undefined;
      if (!row) return null;
      return {
        domain: String(row.domain),
        status: row.status as CachedHistoricalPresenceEntry['status'],
        earliestSampledCaptureAt: nullableString(row.earliest_sampled_capture_at),
        earliestSampledCaptureUrl: nullableString(row.earliest_sampled_capture_url),
        earliestSampledCaptureHttpStatus: nullableString(row.earliest_sampled_capture_http_status),
        earliestMatchedCollectionId: nullableString(row.earliest_matched_collection_id),
        earliestMatchedCollectionFrom: nullableString(row.earliest_matched_collection_from),
        earliestMatchedCollectionTo: nullableString(row.earliest_matched_collection_to),
        historyCompleteForSelectedCollections: Number(row.history_complete_for_selected_collections) !== 0,
        selectedCollectionCount: Number(row.selected_collection_count),
        checkedCollectionCount: Number(row.checked_collection_count),
        source: String(row.provider),
        sourceReason: nullableString(row.source_reason),
        error: nullableString(row.error),
        fetchedAt: String(row.fetched_at),
        requestCount: Number(row.request_count),
        httpStatus: row.http_status === null || row.http_status === undefined ? null : Number(row.http_status),
        queryVersion: Number(row.query_version),
        storedAt: String(row.stored_at),
        expiresAt: String(row.expires_at),
      };
    } catch (error) {
      throw new ResearchError('CACHE_DB_ERROR', `Historical-presence cache read failed for ${domain}.`, { cause: error });
    }
  }

  put(result: HistoricalPresenceResult, queryVersion: number, storedAt: string, ttlMs: number): void {
    try {
      const expiresAt = new Date(Date.parse(storedAt) + ttlMs).toISOString();
      this.db.prepare(`
        INSERT OR REPLACE INTO historical_presence_cache (
          domain, provider, query_version, status,
          earliest_sampled_capture_at, earliest_sampled_capture_url, earliest_sampled_capture_http_status,
          earliest_matched_collection_id, earliest_matched_collection_from, earliest_matched_collection_to,
          history_complete_for_selected_collections, selected_collection_count, checked_collection_count,
          source_reason, error, fetched_at, request_count, http_status, stored_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.domain,
        result.source,
        queryVersion,
        result.status,
        result.earliestSampledCaptureAt,
        result.earliestSampledCaptureUrl,
        result.earliestSampledCaptureHttpStatus,
        result.earliestMatchedCollectionId,
        result.earliestMatchedCollectionFrom,
        result.earliestMatchedCollectionTo,
        result.historyCompleteForSelectedCollections ? 1 : 0,
        result.selectedCollectionCount,
        result.checkedCollectionCount,
        result.sourceReason,
        result.error,
        result.fetchedAt,
        result.requestCount,
        result.httpStatus,
        storedAt,
        expiresAt,
      );
    } catch (error) {
      throw new ResearchError('CACHE_DB_ERROR', `Historical-presence cache write failed for ${result.domain}.`, { cause: error });
    }
  }
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function defaultHistoricalPresenceCachePath(baseCachePath: string): string {
  if (baseCachePath.endsWith('.sqlite')) return baseCachePath.replace(/\.sqlite$/, '.historical-presence.sqlite');
  return `${baseCachePath}.historical-presence.sqlite`;
}

export function historicalPresenceCacheExists(path: string): boolean {
  return existsSync(path);
}
