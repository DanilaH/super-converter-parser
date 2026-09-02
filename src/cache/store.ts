import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ResearchError } from '../shared/errors.js';
import type { CacheIdentity } from './keys.js';
import type { SerpResult } from '../google/serp.js';
import type { KeywordRecord, KeywordStatus } from '../runs/run.js';
import type { RdapRegistrationStatus } from '../rdap/types.js';
import type { FirstSeenStatus } from '../firstseen/types.js';

export const CACHE_SCHEMA_VERSION = 8;

// Query version for first-seen facts. Bump when query semantics change so that
// stale results from an older query contract are invalidated on next access.
// v1: exact match (default CDX scope). v2: matchType=domain.
export const FIRST_SEEN_QUERY_VERSION = 2;

// Rows that expired less than this long ago survive an open-time cleanup so
// the next run can still classify them as expired (real expired accounting
// across reopen). Only rows that have been dead for longer are purged; every
// expired row that a run actually observes is consumed by the refresh that
// overwrites it.
export const EXPIRED_ENTRY_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

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
  // The status of legacy v2 rows is unknowable (v2 could not distinguish an
  // empty expansion from a failure), so pretending they are all 'ok' would
  // fabricate provenance. They are invalidated instead: dropped inside the
  // same transaction so the next expansion is refetched under the new
  // contract. Freshly created databases reach v3 with an empty table.
  `
  ALTER TABLE related_cache ADD COLUMN status TEXT NOT NULL DEFAULT 'ok';
  ALTER TABLE related_cache ADD COLUMN error TEXT;
  DELETE FROM related_cache;
  `,
  // v4: SERP cache rows carry the registrable domain so a cached keyword can be
  // re-enriched with Ahrefs DR from the domain cache without re-crawling.
  `
  ALTER TABLE serp_cache ADD COLUMN registrable_domain TEXT NOT NULL DEFAULT '';
  `,
  // v5: domain-age enrichment cache. Stores the resolved registration date
  // (RDAP) and first-seen date plus their statuses so each fact carries its own
  // TTL, but the row expires at the freshest-facts-first minimum. Registration
  // and first-seen are separate facts and never alias one another.
   `
   CREATE TABLE domain_age_cache (
     domain TEXT PRIMARY KEY,
     registration_date TEXT,
     registration_status TEXT NOT NULL,
     registration_rule TEXT NOT NULL DEFAULT '',
     registration_is_redacted INTEGER NOT NULL DEFAULT 0,
     first_seen_date TEXT,
     first_seen_status TEXT NOT NULL,
     first_seen_source TEXT NOT NULL DEFAULT '',
     error TEXT,
     stored_at TEXT NOT NULL,
     expires_at TEXT NOT NULL
   );
   `,
   // v6: split the single-row TTL/expiry into independent RDAP vs first-seen
   // freshness so a short first-seen TTL no longer forces a refetch of a valid
   // 180-day registration fact. Each source now carries its own fetchedAt/
   // expiresAt/error/requestCount/httpStatus; the row-level expires_at becomes the
   // min of the two (for cleanup). Legacy v5 rows are back-filled from the combined
   // columns so they remain consumable; they are refreshed under the per-source
   // contract on next access.
   `
   CREATE TABLE IF NOT EXISTS domain_age_cache (
     domain TEXT PRIMARY KEY,
     registration_date TEXT,
     registration_status TEXT NOT NULL,
     registration_rule TEXT NOT NULL DEFAULT '',
     registration_is_redacted INTEGER NOT NULL DEFAULT 0,
     first_seen_date TEXT,
     first_seen_status TEXT NOT NULL,
     first_seen_source TEXT NOT NULL DEFAULT '',
     error TEXT,
     stored_at TEXT NOT NULL,
     expires_at TEXT NOT NULL
   );
   ALTER TABLE domain_age_cache ADD COLUMN registration_fetched_at TEXT;
   ALTER TABLE domain_age_cache ADD COLUMN registration_expires_at TEXT;
   ALTER TABLE domain_age_cache ADD COLUMN registration_error TEXT;
   ALTER TABLE domain_age_cache ADD COLUMN registration_request_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE domain_age_cache ADD COLUMN registration_http_status INTEGER;
   ALTER TABLE domain_age_cache ADD COLUMN first_seen_fetched_at TEXT;
   ALTER TABLE domain_age_cache ADD COLUMN first_seen_expires_at TEXT;
   ALTER TABLE domain_age_cache ADD COLUMN first_seen_error TEXT;
   ALTER TABLE domain_age_cache ADD COLUMN first_seen_request_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE domain_age_cache ADD COLUMN first_seen_http_status INTEGER;
   ALTER TABLE domain_age_cache ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
   UPDATE domain_age_cache
      SET registration_fetched_at = stored_at,
          registration_expires_at = expires_at,
          registration_error = error,
          first_seen_fetched_at = stored_at,
          first_seen_expires_at = expires_at,
          first_seen_error = error,
          updated_at = stored_at
     WHERE registration_expires_at IS NULL;
    `,
    // v7: add first_seen_query_version + first_seen_events + first_seen_source_reason
    // + registration_events so query-semantics changes invalidate stale first-seen
    // facts and full provenance survives cache round-trips. Stale-version first-seen
    // rows are back-filled as expired so they are refreshed under the current contract.
    `
    ALTER TABLE domain_age_cache ADD COLUMN first_seen_query_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE domain_age_cache ADD COLUMN first_seen_events TEXT NOT NULL DEFAULT '';
    ALTER TABLE domain_age_cache ADD COLUMN first_seen_source_reason TEXT;
    ALTER TABLE domain_age_cache ADD COLUMN registration_events TEXT NOT NULL DEFAULT '';
    UPDATE domain_age_cache
       SET first_seen_query_version = CASE WHEN first_seen_expires_at IS NULL THEN 0 ELSE 1 END,
           first_seen_events = '',
           first_seen_source_reason = NULL,
           registration_events = ''
     WHERE first_seen_query_version = 0;
    `,
  // v8: query-suggestion collection cache. One row per (source + parent keyword
  // + market/hl/gl + parser version) so a resume or a fresh enrichment run does
  // not re-hit the browser for an already-collected parent/source. Status is
  // ok/empty/error so a genuinely empty or failed collection is cacheable and
  // distinguishable from "never fetched".
  `
  CREATE TABLE IF NOT EXISTS suggestion_cache (
    cache_key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    normalized_parent TEXT NOT NULL,
    identity TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    suggestions_json TEXT NOT NULL DEFAULT '[]',
    stored_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
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

export type CachedDomainAgeEntry = {
  domain: string;
  // Registration fact (RDAP). Independent TTL/provenance from first-seen.
  registrationDate: string | null;
  registrationStatus: RdapRegistrationStatus;
  registrationRule: string;
  registrationIsRedacted: boolean;
  registrationFetchedAt: string | null;
  registrationExpiresAt: string | null;
  registrationError: string | null;
  registrationRequestCount: number;
  registrationHttpStatus: number | null;
  // First-seen fact (first-seen provider). Independent TTL/provenance.
  firstSeenDate: string | null;
  firstSeenStatus: FirstSeenStatus | 'not_attempted';
  firstSeenSource: string;
  firstSeenFetchedAt: string | null;
  firstSeenExpiresAt: string | null;
  firstSeenError: string | null;
  firstSeenRequestCount: number;
  firstSeenHttpStatus: number | null;
  // Query version of the first-seen fact (for invalidation on semantics change).
  firstSeenQueryVersion: number;
  // Raw first-seen/sourceReason for full provenance round-trip.
  firstSeenEvents: string;
  firstSeenSourceReason: string | null;
  // Raw RDAP registration events for full provenance round-trip.
  registrationEvents: string;
  // Aggregate error (union of both sources) for convenience; null when both are clean.
  error: string | null;
  storedAt: string;
  expiresAt: string;
};

export type DomainAgeTtlSettings = {
  rdapOkMs: number;
  rdapNotFoundMs: number;
  rdapUnsupportedMs: number;
  rdapErrorMs: number;
  firstSeenOkMs: number;
  firstSeenErrorMs: number;
  firstSeenUnavailableMs: number;
};

export type CachedSuggestionStatus = 'ok' | 'empty' | 'error' | 'unavailable';

export type CachedSuggestionRow = {
  text: string;
  volume: number | null;
  cpc: number | null;
  ordinal: number | null;
};

export type CachedSuggestionEntry = {
  cacheKey: string;
  source: string;
  normalizedParent: string;
  identity: CacheIdentity;
  parserVersion: string;
  status: CachedSuggestionStatus;
  error: string | null;
  suggestions: CachedSuggestionRow[];
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
  /** Domain-age enrichment cache (registration date via RDAP + first-seen). */
  domainAge: DomainAgeTtlSettings;
  suggestionOkMs: number;
  suggestionEmptyMs: number;
  suggestionErrorMs: number;
};

export type CachedSuggestionStatusTtl = CachedSuggestionStatus;

export function ttlMsForSuggestionStatus(
  status: CachedSuggestionStatus,
  ttl: CacheTtlSettings,
): number {
  switch (status) {
    case 'ok':
      return ttl.suggestionOkMs;
    case 'empty':
      return ttl.suggestionEmptyMs;
    case 'error':
    case 'unavailable':
      return ttl.suggestionErrorMs;
  }
}

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

export function ttlMsForRdapStatus(status: RdapRegistrationStatus, ttl: DomainAgeTtlSettings): number {
  switch (status) {
    case 'ok':
      return ttl.rdapOkMs;
    case 'not_found':
      return ttl.rdapNotFoundMs;
    case 'unsupported':
      return ttl.rdapUnsupportedMs;
    case 'error':
      return ttl.rdapErrorMs;
    case 'not_attempted':
      return ttl.rdapErrorMs;
  }
}

export function ttlMsForFirstSeenStatus(status: FirstSeenStatus, ttl: DomainAgeTtlSettings): number {
  switch (status) {
    case 'ok':
    case 'not_found':
      return ttl.firstSeenOkMs;
    case 'error':
      return ttl.firstSeenErrorMs;
    case 'unavailable':
    case 'not_attempted':
      return ttl.firstSeenUnavailableMs;
  }
}

// The cache row expires when its NEXT-to-expire fact expires, so a stale fact
// is refreshed even when its sibling fact is still fresh. A first-seen fact
// that is 'unavailable' (no provider configured) will not change without a
// config change, so it is excluded from the minimum: only the registration TTL
// governs refresh in that case. 'not_attempted' (first-seen never run this row)
// likewise defers to the registration TTL alone.
export function ttlMsForDomainAgeEntry(
  regStatus: RdapRegistrationStatus,
  firstSeenStatus: FirstSeenStatus | 'not_attempted',
  ttl: DomainAgeTtlSettings,
): number {
  const regTtl = ttlMsForRdapStatus(regStatus, ttl);
  if (firstSeenStatus === 'not_attempted' || firstSeenStatus === 'unavailable') {
    return regTtl;
  }
  // 'not_found' is a stable fact (no snapshots), use ok TTL.
  if (firstSeenStatus === 'not_found') {
    return Math.min(regTtl, ttl.firstSeenOkMs);
  }
  return Math.min(regTtl, ttlMsForFirstSeenStatus(firstSeenStatus, ttl));
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
  registrable_domain: string;
  result_type: string;
};

// The narrow surface the engine depends on, so tests can substitute a fake
// without opening a real database. Related-cache methods are optional: runs
// without expansion never touch them, and lightweight fakes can omit them.
export interface KeywordCache {
  getKeyword(cacheKey: string): CachedKeywordEntry | null;
  putKeyword(entry: CachedKeywordEntry): void;
  getRelated?(cacheKey: string): CachedRelatedEntry | null;
  putRelated?(
    entry: Omit<CachedRelatedEntry, 'storedAt' | 'expiresAt'>,
    storedAt: string,
    ttlMs: number,
  ): void;
  getDomainAge?(domain: string): CachedDomainAgeEntry | null;
  putDomainAge?(
    domain: string,
    entry: Omit<CachedDomainAgeEntry, 'domain' | 'storedAt' | 'expiresAt'>,
    storedAt: string,
  ): void;
}

// Narrow surface for query-suggestion collection caching. The real CacheStore
// implements it structurally; tests can substitute an in-memory fake without
// opening the shared cache database.
export interface SuggestionCache {
  getSuggestion(cacheKey: string): CachedSuggestionEntry | null;
  putSuggestion(
    entry: Omit<CachedSuggestionEntry, 'storedAt' | 'expiresAt'>,
    storedAt: string,
    ttlMs: number,
  ): void;
}

// Validates the related-entry contract enforced by putRelated: status, rows,
// and error must form exactly one of the three legal combinations. Returns a
// human-readable description of the violation, or null when the entry is valid.
function describeInvalidRelatedEntry(
  entry: Omit<CachedRelatedEntry, 'storedAt' | 'expiresAt'>,
): string | null {
  const hasRows = entry.rows.length > 0;
  const hasError = entry.error !== null && entry.error.length > 0;
  switch (entry.status) {
    case 'ok':
      if (!hasRows) return 'status "ok" must carry at least one row.';
      if (entry.error !== null) return 'status "ok" must have error=null.';
      return null;
    case 'empty':
      if (hasRows) return 'status "empty" must carry no rows.';
      if (entry.error !== null) return 'status "empty" must have error=null.';
      return null;
    case 'error':
      if (hasRows) return 'status "error" must carry no rows.';
      if (!hasError) return 'status "error" must carry a non-empty error message.';
      return null;
    default:
      return `unknown status "${entry.status}".`;
  }
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
  // An existing CACHE_DB_ERROR (e.g. a related-entry validation failure) is
  // preserved as-is instead of being re-wrapped into a generic message.
  private wrap<T>(operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ResearchError && error.code === 'CACHE_DB_ERROR') throw error;
      throw new ResearchError(
        'CACHE_DB_ERROR',
        `Cache store "${operation}" failed.`,
        { cause: error },
      );
    }
  }

  // Removes rows that have been dead for longer than EXPIRED_ENTRY_GRACE_MS
  // (and orphaned SERP rows whose keyword entry is gone). Rows that expired
  // more recently survive so the next run can still classify them as expired
  // at resolution time instead of reporting a provenance-less plain miss.
  // Called on open; the correctness of the cache never depends on it.
  cleanup(now: number): number {
    return this.wrap('cleanup', () => {
      const cutoff = new Date(now - EXPIRED_ENTRY_GRACE_MS).toISOString();
      let deleted = 0;
      const purge = this.db.transaction(() => {
        const keywordResult = this.db.prepare('DELETE FROM keyword_cache WHERE expires_at <= ?').run(cutoff);
        deleted += keywordResult.changes;
        const orphanSerp = this.db
          .prepare(
            'DELETE FROM serp_cache WHERE cache_key NOT IN (SELECT cache_key FROM keyword_cache)',
          )
          .run();
        deleted += orphanSerp.changes;
        const relatedResult = this.db.prepare('DELETE FROM related_cache WHERE expires_at <= ?').run(cutoff);
        deleted += relatedResult.changes;
        const domainResult = this.db.prepare('DELETE FROM domain_cache WHERE expires_at <= ?').run(cutoff);
        deleted += domainResult.changes;
        // domain_age_cache lifecycle policy:
        // - Legacy v5 rows (registration_expires_at IS NULL): always purge; they are
        //   refreshed under the per-source contract on next access. Since v6+ always
        //   computes a non-NULL per-source expiry on write, a NULL here unambiguously
        //   identifies a legacy row that must be re-fetched.
        // - Both sources have expiry set: purge when BOTH are stale.
        // - One source NULL + other stale: purge. A NULL expiry marks a stable fact
        //   (unavailable/unconfigured first-seen, or error registration). It cannot
        //   change without a config change, so once the sibling expires the row is
        //   dead weight.
        const ageResult = this.db
          .prepare(
            `DELETE FROM domain_age_cache
              WHERE registration_expires_at IS NULL AND first_seen_expires_at IS NULL
                 OR registration_expires_at IS NOT NULL AND first_seen_expires_at IS NOT NULL
                    AND registration_expires_at <= ? AND first_seen_expires_at <= ?
                 OR registration_expires_at IS NULL AND first_seen_expires_at IS NOT NULL
                    AND first_seen_expires_at <= ?
                 OR registration_expires_at IS NOT NULL AND first_seen_expires_at IS NULL
                    AND registration_expires_at <= ?`,
          )
          .run(cutoff, cutoff, cutoff, cutoff);
        deleted += ageResult.changes;
        const suggestionResult = this.db.prepare('DELETE FROM suggestion_cache WHERE expires_at <= ?').run(cutoff);
        deleted += suggestionResult.changes;
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
        registrableDomain: item.registrable_domain,
        dr: null,
        drStatus: null,
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
        `INSERT INTO serp_cache (cache_key, position, keyword, title, url, hostname, result_type, registrable_domain)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
            row.registrableDomain,
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
  // derives the expiry so callers can never store mismatched timestamps. The
  // status contract is enforced before anything is written: 'ok' must carry at
  // least one row and error=null; 'empty' must carry no rows and error=null;
  // 'error' must carry no rows and a non-empty message. Any other combination
  // raises CACHE_DB_ERROR instead of being persisted as a placeholder that
  // would look like a successful expansion. An 'ok' entry stores one row per
  // related keyword; 'empty'/'error' store a single placeholder row carrying
  // status and error, so the state is cacheable and observable.
  putRelated(
    entry: Omit<CachedRelatedEntry, 'storedAt' | 'expiresAt'>,
    storedAt: string,
    ttlMs: number,
  ): void {
    this.wrap('putRelated', () => {
      const invalid = describeInvalidRelatedEntry(entry);
      if (invalid !== null) {
        throw new ResearchError('CACHE_DB_ERROR', `Invalid related cache entry: ${invalid}`);
      }
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

  getDomainAge(domain: string): CachedDomainAgeEntry | null {
    return this.wrap('getDomainAge', () => {
      const row = this.db
        .prepare('SELECT * FROM domain_age_cache WHERE domain = ?')
        .get(domain) as
        | {
            domain: string;
            registration_date: string | null;
            registration_status: string;
            registration_rule: string;
            registration_is_redacted: number;
            registration_fetched_at: string | null;
            registration_expires_at: string | null;
            registration_error: string | null;
            registration_request_count: number;
            registration_http_status: number | null;
            first_seen_date: string | null;
            first_seen_status: string;
            first_seen_source: string;
            first_seen_fetched_at: string | null;
            first_seen_expires_at: string | null;
            first_seen_error: string | null;
            first_seen_request_count: number;
            first_seen_http_status: number | null;
            first_seen_query_version: number;
            first_seen_events: string;
            first_seen_source_reason: string | null;
            registration_events: string;
            error: string | null;
            stored_at: string;
            expires_at: string | null;
            updated_at: string;
          }
        | undefined;
      if (!row) return null;
      // If the first-seen query version doesn't match the current contract, the
      // stored first-seen fact is stale (e.g. exact vs domain match). Report it
      // as expired so the caller re-fetches under the current semantics.
      const firstSeenStale = row.first_seen_query_version !== FIRST_SEEN_QUERY_VERSION;
      return {
        domain: row.domain,
        registrationDate: row.registration_date,
        registrationStatus: row.registration_status as RdapRegistrationStatus,
        registrationRule: row.registration_rule,
        registrationIsRedacted: row.registration_is_redacted !== 0,
        registrationFetchedAt: row.registration_fetched_at,
        registrationExpiresAt: row.registration_expires_at,
        registrationError: row.registration_error,
        registrationRequestCount: row.registration_request_count,
        registrationHttpStatus: row.registration_http_status,
        firstSeenDate: row.first_seen_date,
        firstSeenStatus: (row.first_seen_status as FirstSeenStatus | 'not_attempted'),
        firstSeenSource: row.first_seen_source,
        firstSeenFetchedAt: row.first_seen_fetched_at,
        firstSeenExpiresAt: firstSeenStale ? null : row.first_seen_expires_at,
        firstSeenError: row.first_seen_error,
        firstSeenRequestCount: row.first_seen_request_count,
        firstSeenHttpStatus: row.first_seen_http_status,
        firstSeenQueryVersion: row.first_seen_query_version,
        firstSeenEvents: row.first_seen_events,
        firstSeenSourceReason: row.first_seen_source_reason,
        registrationEvents: row.registration_events,
        error: row.error,
        storedAt: row.stored_at,
        expiresAt: row.expires_at ?? '',
      };
    });
  }

  putDomainAge(
    domain: string,
    entry: Omit<CachedDomainAgeEntry, 'domain' | 'storedAt' | 'expiresAt'>,
    storedAt: string,
  ): void {
    this.wrap('putDomainAge', () => {
      // Row-level expiry is the minimum of the two independent source expiries so
      // cleanup purges the row only once both facts are stale. A NULL source
      // expiry (e.g. an unavailable fact that never expires on its own) is ignored
      // when computing the minimum.
      const regExpires = entry.registrationExpiresAt ? Date.parse(entry.registrationExpiresAt) : Number.POSITIVE_INFINITY;
      const fsExpires = entry.firstSeenExpiresAt ? Date.parse(entry.firstSeenExpiresAt) : Number.POSITIVE_INFINITY;
      const rowExpires = Math.min(regExpires, fsExpires);
      const expiresAt = Number.isFinite(rowExpires) ? new Date(rowExpires).toISOString() : '';
      const now = new Date().toISOString();
      this.db
        .prepare(
           `INSERT OR REPLACE INTO domain_age_cache
             (domain, registration_date, registration_status, registration_rule,
              registration_is_redacted, registration_fetched_at, registration_expires_at,
              registration_error, registration_request_count, registration_http_status,
              first_seen_date, first_seen_status, first_seen_source, first_seen_fetched_at,
              first_seen_expires_at, first_seen_error, first_seen_request_count,
              first_seen_http_status, first_seen_query_version, first_seen_events,
              first_seen_source_reason, registration_events, error, stored_at, expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          domain,
          entry.registrationDate,
          entry.registrationStatus,
          entry.registrationRule,
          entry.registrationIsRedacted ? 1 : 0,
          entry.registrationFetchedAt,
          entry.registrationExpiresAt,
          entry.registrationError,
          entry.registrationRequestCount,
          entry.registrationHttpStatus,
          entry.firstSeenDate,
          entry.firstSeenStatus,
          entry.firstSeenSource,
          entry.firstSeenFetchedAt,
          entry.firstSeenExpiresAt,
          entry.firstSeenError,
          entry.firstSeenRequestCount,
          entry.firstSeenHttpStatus,
          entry.firstSeenQueryVersion,
          entry.firstSeenEvents,
          entry.firstSeenSourceReason,
          entry.registrationEvents,
          entry.error,
          storedAt,
          expiresAt,
          now,
        );
    });
  }

  getSuggestion(cacheKey: string): CachedSuggestionEntry | null {
    return this.wrap('getSuggestion', () => {
      const row = this.db
        .prepare('SELECT * FROM suggestion_cache WHERE cache_key = ?')
        .get(cacheKey) as
        | {
            cache_key: string;
            source: string;
            normalized_parent: string;
            identity: string;
            parser_version: string;
            status: string;
            error: string | null;
            suggestions_json: string;
            stored_at: string;
            expires_at: string;
          }
        | undefined;
      if (!row) return null;
      return {
        cacheKey: row.cache_key,
        source: row.source,
        normalizedParent: row.normalized_parent,
        identity: JSON.parse(row.identity) as CacheIdentity,
        parserVersion: row.parser_version,
        status: row.status as CachedSuggestionStatus,
        error: row.error,
        suggestions: JSON.parse(row.suggestions_json) as CachedSuggestionRow[],
        storedAt: row.stored_at,
        expiresAt: row.expires_at,
      };
    });
  }

  putSuggestion(
    entry: Omit<CachedSuggestionEntry, 'storedAt' | 'expiresAt'>,
    storedAt: string,
    ttlMs: number,
  ): void {
    this.wrap('putSuggestion', () => {
      const expiresAt = new Date(Date.parse(storedAt) + ttlMs).toISOString();
      this.db
        .prepare(
          `INSERT OR REPLACE INTO suggestion_cache
            (cache_key, source, normalized_parent, identity, parser_version, status, error, suggestions_json, stored_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.cacheKey,
          entry.source,
          entry.normalizedParent,
          JSON.stringify(entry.identity),
          entry.parserVersion,
          entry.status,
          entry.error,
          JSON.stringify(entry.suggestions),
          storedAt,
          expiresAt,
        );
    });
  }
}
