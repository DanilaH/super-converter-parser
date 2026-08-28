import Database from 'better-sqlite3';
import { ResearchError, type ResearchErrorCode } from '../shared/errors.js';
import type { ClusteringConfig, EnrichmentCacheStatus, EnrichmentItemRecord, EnrichmentItemStatus, EnrichmentModuleId, EnrichmentRunRecord, QuerySuggestionCollectionStatus, QuerySuggestionSource } from '../enrichment/types.js';

const VALID_SOURCES: readonly string[] = ['surfer_related', 'google_autocomplete', 'google_related_search', 'google_paa'];
const VALID_STATUSES: readonly string[] = ['ok', 'empty', 'unavailable', 'error'];

function validateOccurrence(
  raw: unknown,
  normalizedSuggestion: string,
): { parentKeyword: string; normalizedParent: string; source: QuerySuggestionSource; market: string; hl: string; gl: string; parserVersion: string; collectionStatus: QuerySuggestionCollectionStatus } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ResearchError('DB_ERROR', `Invalid occurrence for suggestion "${normalizedSuggestion}": expected object, got ${Array.isArray(raw) ? 'array' : raw === null ? 'null' : typeof raw}`);
  }
  const occurrence = raw as Record<string, unknown>;
  const parentKeyword = occurrence.parentKeyword;
  const normalizedParent = occurrence.normalizedParent;
  const source = occurrence.source;
  const market = occurrence.market;
  const hl = occurrence.hl;
  const gl = occurrence.gl;
  const parserVersion = occurrence.parserVersion;
  const collectionStatus = occurrence.collectionStatus;

  if (typeof parentKeyword !== 'string' || parentKeyword.length === 0) {
    throw new ResearchError('DB_ERROR', `Invalid occurrence for suggestion "${normalizedSuggestion}": missing or empty parentKeyword`);
  }
  if (typeof normalizedParent !== 'string' || normalizedParent.length === 0) {
    throw new ResearchError('DB_ERROR', `Invalid occurrence for suggestion "${normalizedSuggestion}": missing or empty normalizedParent`);
  }
  if (typeof source !== 'string' || !VALID_SOURCES.includes(source)) {
    throw new ResearchError('DB_ERROR', `Invalid occurrence for suggestion "${normalizedSuggestion}": invalid source "${String(source)}"`);
  }
  if (typeof market !== 'string') {
    throw new ResearchError('DB_ERROR', `Invalid occurrence for suggestion "${normalizedSuggestion}": invalid market`);
  }
  if (typeof hl !== 'string') {
    throw new ResearchError('DB_ERROR', `Invalid occurrence for suggestion "${normalizedSuggestion}": invalid hl`);
  }
  if (typeof gl !== 'string') {
    throw new ResearchError('DB_ERROR', `Invalid occurrence for suggestion "${normalizedSuggestion}": invalid gl`);
  }
  if (typeof parserVersion !== 'string' || parserVersion.length === 0) {
    throw new ResearchError('DB_ERROR', `Invalid occurrence for suggestion "${normalizedSuggestion}": missing or empty parserVersion`);
  }
  if (typeof collectionStatus !== 'string' || !VALID_STATUSES.includes(collectionStatus)) {
    throw new ResearchError('DB_ERROR', `Invalid occurrence for suggestion "${normalizedSuggestion}": invalid collectionStatus "${String(collectionStatus)}"`);
  }

  return {
    parentKeyword,
    normalizedParent,
    source: source as QuerySuggestionSource,
    market,
    hl,
    gl,
    parserVersion,
    collectionStatus: collectionStatus as QuerySuggestionCollectionStatus,
  };
}

// Helper: add a column to a table only if it does not already exist.
// SQLite's ALTER TABLE ADD COLUMN does not support IF NOT EXISTS in the
// better-sqlite3 build, so we check pragma table_info first.
function addColumnIfMissingLocal(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const exists = rows.some((r) => r.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
import type { ResearchConfig } from '../config/config.js';
import type { SeedKeyword } from '../input/seeds/normalize.js';
import { aggregateMicrosoft, type MicrosoftKeyword } from '../input/microsoft/normalize.js';
import type { SerpResult } from '../google/serp.js';
import { registrableDomain } from '../domains/normalize.js';
import {
  TERMINAL_KEYWORD_STATUSES,
  type KeywordRecord,
  type KeywordSource,
  type MicrosoftSource,
  type KeywordStatus,
  type RunState,
} from '../runs/run.js';

export const SCHEMA_VERSION = 15;

// Index i is applied when the database is at version i.
// Never edit an applied migration; append a new one.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    input_kind TEXT NOT NULL,
    input_path TEXT NOT NULL,
    config_snapshot TEXT NOT NULL,
    parser_versions TEXT NOT NULL,
    lookups INTEGER NOT NULL DEFAULT 0,
    pause_reason TEXT
  );

  CREATE TABLE keywords (
    run_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    id TEXT NOT NULL,
    keyword TEXT NOT NULL,
    normalized_keyword TEXT NOT NULL,
    sources TEXT NOT NULL,
    status TEXT NOT NULL,
    surfer TEXT,
    google TEXT,
    error TEXT,
    collected_at TEXT,
    PRIMARY KEY (run_id, idx)
  );

  CREATE TABLE serp_rows (
    run_id TEXT NOT NULL,
    keyword_idx INTEGER NOT NULL,
    position INTEGER NOT NULL,
    keyword TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    hostname TEXT NOT NULL,
    result_type TEXT NOT NULL,
    registrable_domain TEXT NOT NULL DEFAULT '',
    dr REAL,
    dr_status TEXT,
    dr_error TEXT,
    PRIMARY KEY (run_id, keyword_idx, position)
  );
  `,
  // v2: cache-refresh semantics and per-keyword cache provenance. Terminal
  // keywords of pre-cache (v1) runs were collected fresh, never from the
  // cache: they are marked 'miss' inside the same transaction so cache
  // accounting stays complete after the migration (the buckets sum to the
  // processed count). Pending/running keywords stay NULL: they are resolved
  // under the real cache contract when the run resumes.
  `
  ALTER TABLE runs ADD COLUMN force_refresh INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN refresh_keywords TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE keywords ADD COLUMN cache_status TEXT;
  UPDATE keywords SET cache_status = 'miss' WHERE status IN ('completed', 'partial', 'failed');
  `,
  // v3: persist registrable domain and Ahrefs DR alongside each SERP row so
  // domain-level analysis survives without re-crawling the SERP.
  `
  SELECT 1;
  `,
  // v4: persist the DR lookup outcome so completedDomains counts every resolved
  // domain (ok / not_found / error), not only the ones with a numeric DR.
  `
  SELECT 1;
  `,
  // v5: persist run-level provenance for observed related keywords and unique
  // domains so aggregation, scoring, and the full output suite are reproducible
  // from run.sqlite alone (not from the mutable cross-run cache). Replaying a
  // completed keyword must not duplicate rows: related_keywords is keyed on
  // (run_id, parent_idx, related_keyword) and domains on (run_id, domain).
  `
  CREATE TABLE related_keywords (
    run_id TEXT NOT NULL,
    parent_idx INTEGER NOT NULL,
    parent_keyword TEXT NOT NULL,
    related_keyword TEXT NOT NULL,
    overlap INTEGER,
    volume INTEGER,
    selected_for_expansion INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error TEXT,
    PRIMARY KEY (run_id, parent_idx, related_keyword)
  );

  CREATE TABLE domains (
    run_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    dr REAL,
    status TEXT NOT NULL,
    error TEXT,
    source TEXT NOT NULL,
    fetched_at TEXT,
    first_seen_keyword_idx INTEGER NOT NULL,
    first_seen_position INTEGER NOT NULL,
    PRIMARY KEY (run_id, domain)
  );
  `,
  // v6: persist the real first-seen keyword text (not only its index) so the
  // domains output is self-describing, and allow the 'not_attempted' DR status
  // plus a 'none' source so observed domains survive an Ahrefs skip with honest
  // provenance.
  `
  ALTER TABLE domains ADD COLUMN first_seen_keyword TEXT NOT NULL DEFAULT '';
  `,
  // v7: persist the per-row Ahrefs error code (incl. the systemic marker) so
  // SERP rows carry the exact error provenance after a systemic auth failure.
  `
  SELECT 1;
  `,
  // v8: enrichment runs (clustering and future modules). An enrichment run
  // references a source discovery run but never rewrites it. Module/item state
  // is persisted for resume/checkpoint.
  `
  CREATE TABLE IF NOT EXISTS enrichment_runs (
    enrichment_id TEXT PRIMARY KEY,
    source_run_id TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    modules TEXT NOT NULL,
    config TEXT NOT NULL,
    source_run_directory TEXT NOT NULL,
    enrichment_directory TEXT NOT NULL,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS enrichment_items (
    enrichment_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    module TEXT NOT NULL,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    payload TEXT,
    PRIMARY KEY (enrichment_id, item_id, module)
  );

  CREATE TABLE IF NOT EXISTS keyword_clusters (
    enrichment_id TEXT NOT NULL,
    cluster_id TEXT NOT NULL,
    canonical_keyword TEXT NOT NULL,
    member_count INTEGER NOT NULL,
    median_volume REAL,
    average_volume REAL,
    members TEXT NOT NULL,
    representative_domains TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (enrichment_id, cluster_id)
  );
  `,
  // v9: complete enrichment contract — fetched_at/cache_status on items,
  // shortlist snapshot on runs, pairwise comparison and exclusion tables.
  // Note: ALTER TABLE ADD COLUMN IF NOT EXISTS is not supported in this SQLite build;
  // columns are added via addColumnIfMissingLocal in migrate().
  `
  CREATE TABLE IF NOT EXISTS enrichment_pairs (
    enrichment_id TEXT NOT NULL,
    keyword_a TEXT NOT NULL,
    keyword_b TEXT NOT NULL,
    intersection_count INTEGER NOT NULL,
    union_count INTEGER NOT NULL,
    jaccard REAL NOT NULL,
    shared_domains TEXT NOT NULL,
    is_edge INTEGER NOT NULL,
    PRIMARY KEY (enrichment_id, keyword_a, keyword_b)
  );

  CREATE TABLE IF NOT EXISTS enrichment_exclusions (
    enrichment_id TEXT NOT NULL,
    keyword TEXT NOT NULL,
    normalized_keyword TEXT NOT NULL,
    reason TEXT NOT NULL,
    serp_size INTEGER NOT NULL,
    PRIMARY KEY (enrichment_id, keyword)
  );
  `,
  // v10: query-suggestions collection (TASK-013). One row per collected
  // suggestion, deduped on normalized_suggestion but retaining every
  // (parent_keyword, source) occurrence in occurrences_json. Status is the
  // per-collection truth (ok/empty/unavailable/error) so an absent source is
  // never rewritten as a successful invented row.
  `
  CREATE TABLE IF NOT EXISTS enrichment_query_suggestions (
    enrichment_id TEXT NOT NULL,
    normalized_suggestion TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    volume INTEGER,
    cpc REAL,
    ordinal INTEGER,
    market TEXT NOT NULL,
    hl TEXT NOT NULL,
    gl TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    collection_status TEXT NOT NULL,
    occurrences_json TEXT NOT NULL,
    PRIMARY KEY (enrichment_id, normalized_suggestion)
  );
  `,
  // v11: per-(parent, source) collection result. Preserves zero-row states
  // (empty/unavailable/error) that the deduped suggestion table cannot represent
  // because it only stores rows for suggestions that were actually found.
  `
  CREATE TABLE IF NOT EXISTS enrichment_query_suggestion_sources (
    enrichment_id TEXT NOT NULL,
    normalized_parent TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (enrichment_id, normalized_parent, source)
  );
  `,
  // v12: add accounting/provenance columns to per-(parent, source) records.
  `
  ALTER TABLE enrichment_query_suggestion_sources ADD COLUMN cache_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE enrichment_query_suggestion_sources ADD COLUMN request_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE enrichment_query_suggestion_sources ADD COLUMN market TEXT NOT NULL DEFAULT '';
  ALTER TABLE enrichment_query_suggestion_sources ADD COLUMN hl TEXT NOT NULL DEFAULT '';
  ALTER TABLE enrichment_query_suggestion_sources ADD COLUMN gl TEXT NOT NULL DEFAULT '';
  ALTER TABLE enrichment_query_suggestion_sources ADD COLUMN parser_version TEXT NOT NULL DEFAULT '';
  `,
  // v13: ranking-page inspection and bounded site-structure snapshot records.
  // Each enrichment run can inspect multiple URLs/pages and domains.
  `
  CREATE TABLE IF NOT EXISTS enrichment_pages (
    enrichment_id TEXT NOT NULL,
    url TEXT NOT NULL,
    final_url TEXT NOT NULL,
    redirect_count INTEGER NOT NULL,
    redirect_chain TEXT NOT NULL,
    http_status INTEGER,
    content_type TEXT,
    fetch_status TEXT NOT NULL,
    fetch_error TEXT,
    fetched_at TEXT NOT NULL,
    cache_status TEXT NOT NULL,
    title TEXT,
    meta_description TEXT,
    h1 TEXT,
    canonical TEXT,
    language TEXT,
    word_count INTEGER,
    forms TEXT NOT NULL,
    structured_data_types TEXT NOT NULL,
    source_keywords TEXT NOT NULL,
    source_positions TEXT NOT NULL,
    PRIMARY KEY (enrichment_id, url)
  );

  CREATE TABLE IF NOT EXISTS enrichment_site_structure (
    enrichment_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    homepage_status TEXT NOT NULL,
    homepage_http_status INTEGER,
    robots_status TEXT NOT NULL,
    robots_http_status INTEGER,
    robots_url TEXT,
    sitemap_urls_from_robots TEXT NOT NULL,
    sitemap_fallback_url TEXT,
    sitemap_type TEXT NOT NULL,
    declared_sitemap_count INTEGER NOT NULL,
    discovered_url_count INTEGER NOT NULL,
    sampled_urls TEXT NOT NULL,
    sampled_utility_urls TEXT NOT NULL DEFAULT '[]',
    errors TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    cache_status TEXT NOT NULL,
    source_keywords TEXT NOT NULL DEFAULT '[]',
    source_best_position INTEGER,
    PRIMARY KEY (enrichment_id, domain)
  );
  `,
  // v14: per-target checkpoint/resume for pages and site_structure modules.
  // Each URL/domain target tracks its own status and data, enabling resume
  // without re-fetching completed targets and correct terminal module state.
  `
  CREATE TABLE IF NOT EXISTS enrichment_page_targets (
    enrichment_id TEXT NOT NULL,
    url TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT,
    error TEXT,
    fetched_at TEXT,
    cache_status TEXT NOT NULL DEFAULT 'none',
    source_keywords TEXT NOT NULL DEFAULT '[]',
    source_positions TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (enrichment_id, url)
  );

  CREATE TABLE IF NOT EXISTS enrichment_site_structure_targets (
    enrichment_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT,
    error TEXT,
    fetched_at TEXT,
    cache_status TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (enrichment_id, domain)
  );
  `,
  // v15: diagnostic confidence flag for successful static page inspections
  // that appear to contain only a JavaScript application shell.
  `
  ALTER TABLE enrichment_pages ADD COLUMN possibly_js_rendered INTEGER NOT NULL DEFAULT 0;
  `,
];

export type StoredRun = {
  runId: string;
  state: RunState;
  createdAt: string;
  updatedAt: string;
  input: { kind: 'seeds' | 'microsoft'; path: string };
  configSnapshot: ResearchConfig;
  parserVersions: { surfer: string; google: string };
  lookups: number;
  pauseReason: string | null;
  forceRefresh: boolean;
  refreshKeywords: string[];
};

export type CacheStatus = 'hit' | 'miss' | 'expired' | 'refreshed';

export type StoredKeyword = {
  idx: number;
  id: string;
  keyword: string;
  normalizedKeyword: string;
  sources: KeywordSource[];
  status: KeywordStatus;
  surfer: KeywordRecord['surfer'];
  google: KeywordRecord['google'];
  error: { code: ResearchErrorCode; message: string } | null;
  collectedAt: string | null;
  cacheStatus: CacheStatus | null;
};

// One observed related keyword for a parent keyword. Persisted at the run level
// so expansion provenance survives without the cross-run related cache.
export type StoredRelatedKeyword = {
  runId: string;
  parentIdx: number;
  parentKeyword: string;
  relatedKeyword: string;
  overlap: number | null;
  volume: number | null;
  selectedForExpansion: boolean;
  status: 'ok' | 'empty' | 'error';
  error: string | null;
};

// One unique domain observed across the run, with its Ahrefs DR outcome and
// provenance (whether the value came from the domain cache or a fresh lookup).
export type StoredDomain = {
  runId: string;
  domain: string;
  dr: number | null;
  status: 'ok' | 'not_found' | 'error' | 'not_attempted';
  error: string | null;
  source: 'cache' | 'fresh' | 'none';
  fetchedAt: string | null;
  firstSeenKeyword: string;
  firstSeenKeywordIdx: number;
  firstSeenPosition: number;
};

type RunRow = {
  run_id: string;
  state: string;
  created_at: string;
  updated_at: string;
  input_kind: string;
  input_path: string;
  config_snapshot: string;
  parser_versions: string;
  lookups: number;
  pause_reason: string | null;
  force_refresh?: number;
  refresh_keywords?: string;
};

type KeywordRow = {
  run_id: string;
  idx: number;
  id: string;
  keyword: string;
  normalized_keyword: string;
  sources: string;
  status: string;
  surfer: string | null;
  google: string | null;
  error: string | null;
  collected_at: string | null;
  cache_status?: string | null;
};

export class RunStore {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static open(path: string): RunStore {
    try {
      const db = new Database(path);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      const store = new RunStore(db);
      store.migrate();
      return store;
    } catch (error) {
      // Internal failures already carry the specific message (e.g. a refused
      // future schema version); keep them as-is instead of double-wrapping
      // them into the generic open error.
      if (error instanceof ResearchError && error.code === 'DB_ERROR') throw error;
      throw new ResearchError(
        'DB_ERROR',
        `Failed to open run store at "${path}".`,
        { cause: error },
      );
    }
  }

  static openInMemory(): RunStore {
    const store = new RunStore(new Database(':memory:'));
    store.migrate();
    return store;
  }

  static openReadOnly(path: string): RunStore {
    let db: Database.Database | null = null;
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
      const store = new RunStore(db);
      store.assertReadableDiscoverySchema();
      return store;
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Preserve the original open/compatibility error.
      }
      if (error instanceof ResearchError && error.code === 'DB_ERROR') throw error;
      throw new ResearchError(
        'DB_ERROR',
        `Failed to open run store read-only at "${path}".`,
        { cause: error },
      );
    }
  }

  private tableColumns(table: 'runs' | 'keywords' | 'serp_rows' | 'related_keywords'): Set<string> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  }

  private assertReadableDiscoverySchema(): void {
    const current = this.version;
    if (current < 1) {
      throw new ResearchError(
        'DB_ERROR',
        `Run store schema version ${current} predates the supported discovery schema (v1).`,
      );
    }
    if (current > SCHEMA_VERSION) {
      throw new ResearchError(
        'DB_ERROR',
        `Run store is at schema version ${current}, newer than this build supports (${SCHEMA_VERSION}). Refusing read-only access.`,
      );
    }

    const required: Record<'runs' | 'keywords' | 'serp_rows', readonly string[]> = {
      runs: [
        'run_id', 'state', 'created_at', 'updated_at', 'input_kind', 'input_path',
        'config_snapshot', 'parser_versions', 'lookups', 'pause_reason',
      ],
      keywords: [
        'run_id', 'idx', 'id', 'keyword', 'normalized_keyword', 'sources', 'status',
        'surfer', 'google', 'error', 'collected_at',
      ],
      serp_rows: [
        'run_id', 'keyword_idx', 'position', 'keyword', 'title', 'url', 'hostname', 'result_type',
      ],
    };

    const missing: string[] = [];
    for (const table of ['runs', 'keywords', 'serp_rows'] as const) {
      const columns = this.tableColumns(table);
      for (const column of required[table]) {
        if (!columns.has(column)) missing.push(`${table}.${column}`);
      }
    }
    if (missing.length > 0) {
      throw new ResearchError(
        'DB_ERROR',
        `Run store schema v${current} is not a readable discovery source; missing required columns: ${missing.join(', ')}.`,
      );
    }
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    if (current > MIGRATIONS.length) {
      throw new ResearchError(
        'DB_ERROR',
        `Run store is at schema version ${current}, newer than this build supports (${MIGRATIONS.length}). Refusing to open it.`,
      );
    }
    if (current === MIGRATIONS.length) return;
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      try {
        const apply = this.db.transaction(() => {
          this.db.exec(MIGRATIONS[version] as string);
          this.db.pragma(`user_version = ${version + 1}`);
        });
        apply();
      } catch (error) {
        throw new ResearchError(
          'DB_ERROR',
          `Run store schema migration v${version + 1} failed; the database was left at v${current}.`,
          { cause: error },
        );
      }
    }
    // v3/v4/v7/v9 columns are now part of the CREATE TABLE for fresh databases,
    // but existing databases may still be missing them.
    // addColumnIfMissingLocal is idempotent and safe to run after migrations.
    const serpDynamic: Array<[string, string]> = [
      ['registrable_domain', "TEXT NOT NULL DEFAULT ''"],
      ['dr', 'REAL'],
      ['dr_status', 'TEXT'],
      ['dr_error', 'TEXT'],
    ];
    for (const [column, definition] of serpDynamic) {
      addColumnIfMissingLocal(this.db, 'serp_rows', column, definition);
    }
    const enrichmentItemDynamic: Array<[string, string]> = [
      ['fetched_at', 'TEXT'],
      ['cache_status', "TEXT NOT NULL DEFAULT 'none'"],
    ];
    for (const [column, definition] of enrichmentItemDynamic) {
      addColumnIfMissingLocal(this.db, 'enrichment_items', column, definition);
    }
    addColumnIfMissingLocal(this.db, 'enrichment_pages', 'possibly_js_rendered', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissingLocal(this.db, 'enrichment_runs', 'shortlist_keywords', "TEXT NOT NULL DEFAULT '[]'");
    const siteStructureDynamic: Array<[string, string]> = [
      ['homepage_http_status', 'INTEGER'],
      ['robots_http_status', 'INTEGER'],
      ['sampled_utility_urls', "TEXT NOT NULL DEFAULT '[]'"],
      ['source_keywords', "TEXT NOT NULL DEFAULT '[]'"],
      ['source_best_position', 'INTEGER'],
    ];
    for (const [column, definition] of siteStructureDynamic) {
      addColumnIfMissingLocal(this.db, 'enrichment_site_structure', column, definition);
    }
    // Ensure v9/v10 tables exist for databases created before those versions.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS enrichment_pairs (
        enrichment_id TEXT NOT NULL,
        keyword_a TEXT NOT NULL,
        keyword_b TEXT NOT NULL,
        intersection_count INTEGER NOT NULL,
        union_count INTEGER NOT NULL,
        jaccard REAL NOT NULL,
        shared_domains TEXT NOT NULL,
        is_edge INTEGER NOT NULL,
        PRIMARY KEY (enrichment_id, keyword_a, keyword_b)
      );
      CREATE TABLE IF NOT EXISTS enrichment_exclusions (
        enrichment_id TEXT NOT NULL,
        keyword TEXT NOT NULL,
        normalized_keyword TEXT NOT NULL,
        reason TEXT NOT NULL,
        serp_size INTEGER NOT NULL,
        PRIMARY KEY (enrichment_id, keyword)
      );
      CREATE TABLE IF NOT EXISTS enrichment_pages (
        enrichment_id TEXT NOT NULL,
        url TEXT NOT NULL,
        final_url TEXT NOT NULL,
        redirect_count INTEGER NOT NULL,
        redirect_chain TEXT NOT NULL,
        http_status INTEGER,
        content_type TEXT,
        fetch_status TEXT NOT NULL,
        fetch_error TEXT,
        fetched_at TEXT NOT NULL,
        cache_status TEXT NOT NULL,
        title TEXT,
        meta_description TEXT,
        h1 TEXT,
        canonical TEXT,
        language TEXT,
        word_count INTEGER,
        forms TEXT NOT NULL,
        structured_data_types TEXT NOT NULL,
        source_keywords TEXT NOT NULL,
        source_positions TEXT NOT NULL,
        PRIMARY KEY (enrichment_id, url)
      );
      CREATE TABLE IF NOT EXISTS enrichment_site_structure (
        enrichment_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        homepage_status TEXT NOT NULL,
        homepage_http_status INTEGER,
        robots_status TEXT NOT NULL,
        robots_http_status INTEGER,
        robots_url TEXT,
        sitemap_urls_from_robots TEXT NOT NULL,
        sitemap_fallback_url TEXT,
        sitemap_type TEXT NOT NULL,
        declared_sitemap_count INTEGER NOT NULL,
        discovered_url_count INTEGER NOT NULL,
        sampled_urls TEXT NOT NULL,
        sampled_utility_urls TEXT NOT NULL DEFAULT '[]',
        errors TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        cache_status TEXT NOT NULL,
        source_keywords TEXT NOT NULL DEFAULT '[]',
        source_best_position INTEGER,
        PRIMARY KEY (enrichment_id, domain)
      );
      CREATE TABLE IF NOT EXISTS enrichment_page_targets (
        enrichment_id TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT,
        error TEXT,
        fetched_at TEXT,
        cache_status TEXT NOT NULL DEFAULT 'none',
        source_keywords TEXT NOT NULL DEFAULT '[]',
        source_positions TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (enrichment_id, url)
      );
      CREATE TABLE IF NOT EXISTS enrichment_site_structure_targets (
        enrichment_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT,
        error TEXT,
        fetched_at TEXT,
        cache_status TEXT NOT NULL DEFAULT 'none',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (enrichment_id, domain)
      );
    `);
  }

  get version(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  close(): void {
    this.db.close();
  }

  createRun(input: {
    runId: string;
    configSnapshot: ResearchConfig;
    parserVersions: { surfer: string; google: string };
    input: { kind: 'seeds' | 'microsoft'; path: string };
    keywords: SeedKeyword[] | MicrosoftKeyword[];
    forceRefresh?: boolean;
    refreshKeywords?: string[];
  }): void {
    const insertRun = this.db.prepare(
      `INSERT INTO runs (run_id, state, created_at, updated_at, input_kind, input_path, config_snapshot, parser_versions, lookups, pause_reason, force_refresh, refresh_keywords)
       VALUES (?, 'created', ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    );
    const insertKeyword = this.db.prepare(
      `INSERT INTO keywords (run_id, idx, id, keyword, normalized_keyword, sources, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    );

    const now = new Date().toISOString();
    const write = this.db.transaction(() => {
      insertRun.run(
        input.runId,
        now,
        now,
        input.input.kind,
        input.input.path,
        JSON.stringify(input.configSnapshot),
        JSON.stringify(input.parserVersions),
        input.forceRefresh === true ? 1 : 0,
        JSON.stringify(input.refreshKeywords ?? []),
      );
      input.keywords.forEach((item, index) => {
        const id = `kw-${String(index + 1).padStart(4, '0')}`;
        let sourcesJson: string;
        if (input.input.kind === 'microsoft') {
          const microsoft = item as MicrosoftKeyword;
          sourcesJson = JSON.stringify(
            microsoft.occurrences.map((occurrence) => ({ type: 'microsoft', ...occurrence })),
          );
        } else {
          const seed = item as SeedKeyword;
          sourcesJson = JSON.stringify([{ type: 'seed', rowNumbers: seed.sourceRows }]);
        }
        insertKeyword.run(
          input.runId,
          index,
          id,
          item.keyword,
          item.normalizedKeyword,
          sourcesJson,
        );
      });
    });
    write();
  }

  loadRun(runId: string): StoredRun | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as
      | RunRow
      | undefined;
    if (!row) return null;
    return {
      runId: row.run_id,
      state: row.state as RunState,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      input: { kind: row.input_kind as 'seeds' | 'microsoft', path: row.input_path },
      configSnapshot: JSON.parse(row.config_snapshot) as ResearchConfig,
      parserVersions: JSON.parse(row.parser_versions) as { surfer: string; google: string },
      lookups: row.lookups,
      pauseReason: row.pause_reason,
      forceRefresh: row.force_refresh === 1,
      refreshKeywords:
        row.refresh_keywords === undefined ? [] : JSON.parse(row.refresh_keywords) as string[],
    };
  }

  loadKeywords(runId: string): StoredKeyword[] {
    const rows = this.db
      .prepare('SELECT * FROM keywords WHERE run_id = ? ORDER BY idx ASC')
      .all(runId) as KeywordRow[];
    return rows.map(mapKeywordRow);
  }

  loadKeyword(runId: string, idx: number): StoredKeyword | null {
    const row = this.db
      .prepare('SELECT * FROM keywords WHERE run_id = ? AND idx = ?')
      .get(runId, idx) as KeywordRow | undefined;
    return row ? mapKeywordRow(row) : null;
  }

  // Appends an expansion candidate (e.g. a Surfer-related keyword) to an already
  // created run. The new row gets the next sequential idx so ordering and
  // resume behavior stay consistent with seed rows. Returns the persisted row.
  addKeyword(
    runId: string,
    keyword: { keyword: string; normalizedKeyword: string; sources: KeywordSource[] },
  ): StoredKeyword {
    const nextIdx = (
      this.db
        .prepare('SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM keywords WHERE run_id = ?')
        .get(runId) as { next: number }
    ).next;

    const id = `kw-${String(nextIdx + 1).padStart(4, '0')}`;
    const insert = this.db.prepare(
      `INSERT INTO keywords (run_id, idx, id, keyword, normalized_keyword, sources, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    );
    insert.run(
      runId,
      nextIdx,
      id,
      keyword.keyword,
      keyword.normalizedKeyword,
      JSON.stringify(keyword.sources),
    );
    return this.loadKeyword(runId, nextIdx)!;
  }

  loadSerpRows(runId: string): SerpResult[] {
    // Historical discovery stores are opened read-only and therefore cannot be
    // migrated just to satisfy newer derived SERP columns. Select compatible
    // aliases for columns added after v1, then reconstruct only the missing
    // registrable-domain value from the immutable hostname/URL evidence.
    const columns = this.tableColumns('serp_rows');
    const hasRegistrableDomainColumn = columns.has('registrable_domain');
    const registrableDomainExpr = hasRegistrableDomainColumn
      ? 'registrable_domain'
      : "'' AS registrable_domain";
    const drExpr = columns.has('dr') ? 'dr' : 'NULL AS dr';
    const drStatusExpr = columns.has('dr_status') ? 'dr_status' : 'NULL AS dr_status';
    const drErrorExpr = columns.has('dr_error') ? 'dr_error' : 'NULL AS dr_error';
    const rows = this.db
      .prepare(
        `SELECT keyword_idx, position, keyword, title, url, hostname,
                ${registrableDomainExpr}, ${drExpr}, ${drStatusExpr}, ${drErrorExpr}, result_type
         FROM serp_rows WHERE run_id = ? ORDER BY keyword_idx ASC, position ASC`,
      )
      .all(runId) as Array<{
      keyword_idx: number;
      position: number;
      keyword: string;
      title: string;
      url: string;
      hostname: string;
      registrable_domain: string;
      dr: number | null;
      dr_status: string | null;
      dr_error: string | null;
      result_type: string;
    }>;
    return rows.map((row) => ({
      keyword: row.keyword,
      keywordIdx: row.keyword_idx,
      position: row.position,
      title: row.title,
      url: row.url,
      hostname: row.hostname,
      registrableDomain: hasRegistrableDomainColumn
        ? row.registrable_domain
        : deriveHistoricalRegistrableDomain(row.hostname, row.url),
      dr: row.dr,
      drStatus: (row.dr_status as SerpResult['drStatus']) ?? null,
      drError: row.dr_error ?? null,
      resultType: row.result_type as SerpResult['resultType'],
    }));
  }

  // Organic result counts per keyword, read from the run checkpoint (the
  // same rows that serp.json/serp.csv publish), never from cache state.
  loadSerpRowCounts(runId: string): Array<{ keywordIdx: number; count: number }> {
    return this.db
      .prepare(
        `SELECT keyword_idx AS keywordIdx, COUNT(*) AS count
         FROM serp_rows WHERE run_id = ? GROUP BY keyword_idx`,
      )
      .all(runId) as Array<{ keywordIdx: number; count: number }>;
  }

  updateKeyword(runId: string, keyword: StoredKeyword): void {
    this.db
      .prepare(
        `UPDATE keywords
         SET status = ?, surfer = ?, google = ?, error = ?, collected_at = ?
         WHERE run_id = ? AND idx = ?`,
      )
      .run(
        keyword.status,
        keyword.surfer === null ? null : JSON.stringify(keyword.surfer),
        keyword.google === null ? null : JSON.stringify(keyword.google),
        keyword.error === null ? null : JSON.stringify(keyword.error),
        keyword.collectedAt,
        runId,
        keyword.idx,
      );
  }

  replaceSerpRows(runId: string, keywordIdx: number, rows: SerpResult[]): void {
    const deleteRows = this.db.prepare(
      'DELETE FROM serp_rows WHERE run_id = ? AND keyword_idx = ?',
    );
    const insertRow = this.db.prepare(
      `INSERT INTO serp_rows (run_id, keyword_idx, position, keyword, title, url, hostname, registrable_domain, dr, dr_status, dr_error, result_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const write = this.db.transaction(() => {
      deleteRows.run(runId, keywordIdx);
      for (const row of rows) {
        insertRow.run(
          runId,
          keywordIdx,
          row.position,
          row.keyword,
          row.title,
          row.url,
          row.hostname,
          row.registrableDomain,
          row.dr,
          row.drStatus,
          row.drError ?? null,
          row.resultType,
        );
      }
    });
    write();
  }

  // Persists a collected keyword and its SERP rows in a single SQLite
  // transaction so a checkpoint can never split keyword data from its rows.
  commitKeyword(
    runId: string,
    keyword: StoredKeyword,
    serpRows: SerpResult[],
    cacheStatus: StoredKeyword['cacheStatus'] = null,
  ): void {
    const updateKeyword = this.db.prepare(
      `UPDATE keywords
       SET status = ?, surfer = ?, google = ?, error = ?, collected_at = ?, cache_status = ?
       WHERE run_id = ? AND idx = ?`,
    );
    const deleteRows = this.db.prepare(
      'DELETE FROM serp_rows WHERE run_id = ? AND keyword_idx = ?',
    );
    const insertRow = this.db.prepare(
      `INSERT INTO serp_rows (run_id, keyword_idx, position, keyword, title, url, hostname, registrable_domain, dr, dr_status, dr_error, result_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const write = this.db.transaction(() => {
      updateKeyword.run(
        keyword.status,
        keyword.surfer === null ? null : JSON.stringify(keyword.surfer),
        keyword.google === null ? null : JSON.stringify(keyword.google),
        keyword.error === null ? null : JSON.stringify(keyword.error),
        keyword.collectedAt,
        cacheStatus,
        runId,
        keyword.idx,
      );
      deleteRows.run(runId, keyword.idx);
      for (const row of serpRows) {
        insertRow.run(
          runId,
          keyword.idx,
          row.position,
          row.keyword,
          row.title,
          row.url,
          row.hostname,
          row.registrableDomain,
          row.dr,
          row.drStatus,
          row.drError ?? null,
          row.resultType,
        );
      }
    });
    write();
  }

  setRunState(
    runId: string,
    state: RunState,
    options: { pauseReason?: string | null; updatedAt?: string } = {},
  ): void {
    const updatedAt = options.updatedAt ?? new Date().toISOString();
    const pauseReason = options.pauseReason === undefined ? null : options.pauseReason;
    this.db
      .prepare('UPDATE runs SET state = ?, updated_at = ?, pause_reason = ? WHERE run_id = ?')
      .run(state, updatedAt, pauseReason, runId);
  }

  incrementLookups(runId: string): number {
    this.db
      .prepare('UPDATE runs SET lookups = lookups + 1 WHERE run_id = ?')
      .run(runId);
    const row = this.db.prepare('SELECT lookups FROM runs WHERE run_id = ?').get(runId) as {
      lookups: number;
    };
    return row.lookups;
  }

  markStaleRunningAsPending(runId: string): number {
    const result = this.db
      .prepare("UPDATE keywords SET status = 'pending' WHERE run_id = ? AND status = 'running'")
      .run(runId);
    return result.changes;
  }

  // Persists the run's cache-refresh semantics so a paused forced-refresh run
  // resumes with the same semantics even without the original flags.
  setRunCacheRefresh(runId: string, forceRefresh: boolean, refreshKeywords: string[]): void {
    this.db
      .prepare('UPDATE runs SET force_refresh = ?, refresh_keywords = ? WHERE run_id = ?')
      .run(forceRefresh ? 1 : 0, JSON.stringify(refreshKeywords), runId);
  }

  // Persists the observed related keywords for one parent keyword. Idempotent:
  // replaying a completed keyword deletes its prior rows and re-inserts, so no
  // duplicates accumulate (PK also guards against double inserts).
  recordRelatedKeywords(
    runId: string,
    parentIdx: number,
    parentKeyword: string,
    outcome: {
      status: 'ok' | 'empty' | 'error' | 'not_attempted';
      error: string | null;
      rows: Array<{ keyword: string; overlap: number | null; volume: number | null }>;
    },
    selected: ReadonlySet<string>,
  ): void {
    // 'not_attempted' is a collection-internal state, never a persisted verdict.
    if (outcome.status === 'not_attempted') return;
    const deleteRows = this.db.prepare(
      'DELETE FROM related_keywords WHERE run_id = ? AND parent_idx = ?',
    );
    const insertRow = this.db.prepare(
      `INSERT OR REPLACE INTO related_keywords
         (run_id, parent_idx, parent_keyword, related_keyword, overlap, volume, selected_for_expansion, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const write = this.db.transaction(() => {
      deleteRows.run(runId, parentIdx);
      if (outcome.status === 'ok') {
        for (const row of outcome.rows) {
          insertRow.run(
            runId,
            parentIdx,
            parentKeyword,
            row.keyword,
            row.overlap,
            row.volume,
            selected.has(row.keyword) ? 1 : 0,
            'ok',
            null,
          );
        }
      } else {
        insertRow.run(runId, parentIdx, parentKeyword, '', null, null, 0, outcome.status, outcome.error);
      }
    });
    write();
  }

  loadRelatedKeywords(runId: string): StoredRelatedKeyword[] {
    // v1-v4 discovery stores predate persisted related-keyword provenance.
    // In read-only enrichment that absence means there is no reusable source-run
    // Surfer collection; callers may collect the source normally instead.
    if (this.tableColumns('related_keywords').size === 0) return [];
    return (
      this.db
        .prepare(
          'SELECT * FROM related_keywords WHERE run_id = ? ORDER BY parent_idx ASC, related_keyword ASC',
        )
        .all(runId) as Array<{
        run_id: string;
        parent_idx: number;
        parent_keyword: string;
        related_keyword: string;
        overlap: number | null;
        volume: number | null;
        selected_for_expansion: number;
        status: string;
        error: string | null;
      }>
    ).map((row) => ({
      runId: row.run_id,
      parentIdx: row.parent_idx,
      parentKeyword: row.parent_keyword,
      relatedKeyword: row.related_keyword,
      overlap: row.overlap,
      volume: row.volume,
      selectedForExpansion: row.selected_for_expansion === 1,
      status: row.status as StoredRelatedKeyword['status'],
      error: row.error,
    }));
  }

  // Persists the unique domains observed in one keyword's SERP rows. The first
  // occurrence (lowest position) for a domain within this keyword is its
  // representative DR source. On conflict the original first-seen
  // keyword/position is preserved while DR/status/source/fetched_at are updated,
  // so a domain keeps the earliest keyword that surfaced it.
  recordDomains(
    runId: string,
    keywordIdx: number,
    keyword: string,
    serpRows: Array<{
      registrableDomain: string;
      dr: number | null;
      drStatus: 'ok' | 'not_found' | 'error' | 'not_attempted' | null;
      drError?: string | null;
      position: number;
    }>,
    sourceByDomain: Map<string, { source: 'cache' | 'fresh' | 'none'; fetchedAt: string | null }>,
  ): void {
    const firstPosition = new Map<string, number>();
    for (const row of serpRows) {
      const domain = row.registrableDomain;
      if (!domain) continue;
      const existing = firstPosition.get(domain);
      if (existing === undefined || row.position < existing) firstPosition.set(domain, row.position);
    }

    const upsert = this.db.prepare(
      `INSERT INTO domains (run_id, domain, dr, status, error, source, fetched_at, first_seen_keyword, first_seen_keyword_idx, first_seen_position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, domain) DO UPDATE SET
         dr = excluded.dr,
         status = excluded.status,
         error = CASE WHEN domains.source = 'fresh' AND excluded.source IN ('cache', 'none') THEN domains.error ELSE excluded.error END,
         source = CASE WHEN domains.source = 'fresh' AND excluded.source IN ('cache', 'none') THEN 'fresh' ELSE excluded.source END,
         fetched_at = excluded.fetched_at`,
    );

    const write = this.db.transaction(() => {
      for (const row of serpRows) {
        const domain = row.registrableDomain;
        // Persist every observed domain. A null drStatus means the row was never
        // offered for enrichment; 'not_attempted' means Ahrefs was skipped.
        if (!domain || row.drStatus === null) continue;
        const meta = sourceByDomain.get(domain);
        upsert.run(
          runId,
          domain,
          row.dr,
          row.drStatus,
          row.drError ?? null,
          meta?.source ?? 'none',
          meta?.fetchedAt ?? null,
          keyword,
          keywordIdx,
          firstPosition.get(domain) ?? row.position,
        );
      }
    });
    write();
  }

  loadDomains(runId: string): StoredDomain[] {
    return (
      this.db
        .prepare('SELECT * FROM domains WHERE run_id = ? ORDER BY domain ASC')
        .all(runId) as Array<{
        run_id: string;
        domain: string;
        dr: number | null;
        status: string;
        error: string | null;
        source: string;
        fetched_at: string | null;
        first_seen_keyword: string;
        first_seen_keyword_idx: number;
        first_seen_position: number;
      }>
    ).map((row) => ({
      runId: row.run_id,
      domain: row.domain,
      dr: row.dr,
      status: row.status as StoredDomain['status'],
      error: row.error,
      source: row.source as StoredDomain['source'],
      fetchedAt: row.fetched_at,
      firstSeenKeyword: row.first_seen_keyword,
      firstSeenKeywordIdx: row.first_seen_keyword_idx,
      firstSeenPosition: row.first_seen_position,
    }));
  }

  createEnrichmentRun(record: {
    enrichmentId: string;
    sourceRunId: string;
    modules: string[];
    config: string;
    sourceRunDirectory: string;
    enrichmentDirectory: string;
    shortlistKeywords?: string[];
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO enrichment_runs
         (enrichment_id, source_run_id, state, created_at, updated_at, modules, config, source_run_directory, enrichment_directory, shortlist_keywords, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.enrichmentId,
        record.sourceRunId,
        'created',
        now,
        now,
        JSON.stringify(record.modules),
        record.config,
        record.sourceRunDirectory,
        record.enrichmentDirectory,
        JSON.stringify(record.shortlistKeywords ?? []),
        null,
      );
  }

  setEnrichmentState(enrichmentId: string, state: string, error: string | null = null): void {
    this.db
      .prepare('UPDATE enrichment_runs SET state = ?, updated_at = ?, error = ? WHERE enrichment_id = ?')
      .run(state, new Date().toISOString(), error, enrichmentId);
  }

  resetRunningEnrichmentItems(enrichmentId: string): number {
    const result = this.db
      .prepare(
        `UPDATE enrichment_items
         SET status = 'pending', updated_at = ?, fetched_at = NULL, error = NULL
         WHERE enrichment_id = ? AND status = 'running'`,
      )
      .run(new Date().toISOString(), enrichmentId);
    return result.changes;
  }

  upsertEnrichmentItem(item: {
    enrichmentId: string;
    itemId: string;
    module: string;
    status: string;
    source: string;
    requestCount?: number;
    fetchedAt?: string | null;
    cacheStatus?: string;
    error?: string | null;
    payload?: string | null;
  }): void {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT request_count FROM enrichment_items WHERE enrichment_id = ? AND item_id = ? AND module = ?')
      .get(item.enrichmentId, item.itemId, item.module) as { request_count: number } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE enrichment_items
           SET status = ?, updated_at = ?, request_count = ?, fetched_at = ?, cache_status = ?, error = ?, payload = ?
           WHERE enrichment_id = ? AND item_id = ? AND module = ?`,
        )
        .run(
          item.status,
          now,
          item.requestCount ?? existing.request_count,
          item.fetchedAt ?? null,
          item.cacheStatus ?? 'none',
          item.error ?? null,
          item.payload ?? null,
          item.enrichmentId,
          item.itemId,
          item.module,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO enrichment_items
           (enrichment_id, item_id, module, status, source, created_at, updated_at, request_count, fetched_at, cache_status, error, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.enrichmentId,
          item.itemId,
          item.module,
          item.status,
          item.source,
          now,
          now,
          item.requestCount ?? 0,
          item.fetchedAt ?? null,
          item.cacheStatus ?? 'none',
          item.error ?? null,
          item.payload ?? null,
        );
    }
  }

  loadEnrichmentItems(enrichmentId: string): EnrichmentItemRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM enrichment_items WHERE enrichment_id = ?')
      .all(enrichmentId) as Array<{
      enrichment_id: string;
      item_id: string;
      module: string;
      status: string;
      source: string;
      created_at: string;
      updated_at: string;
      request_count: number;
      fetched_at: string | null;
      cache_status: string | null;
      error: string | null;
      payload: string | null;
    }>;
    return rows.map((row) => ({
      enrichmentId: row.enrichment_id,
      itemId: row.item_id,
      module: row.module as EnrichmentItemRecord['module'],
      status: row.status as EnrichmentItemStatus,
      source: row.source as EnrichmentItemRecord['source'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      requestCount: row.request_count,
      fetchedAt: row.fetched_at,
      cacheStatus: (row.cache_status as EnrichmentItemRecord['cacheStatus']) ?? 'none',
      error: row.error,
      payload: row.payload,
    }));
  }

  saveKeywordClusters(
    enrichmentId: string,
    clusters: Array<{
      clusterId: string;
      canonicalKeyword: string;
      members: { keyword: string; normalizedKeyword: string; volume: number | null; serpSize: number }[];
      representativeDomains: string[];
      medianVolume: number | null;
      averageVolume: number | null;
      algorithmVersion: string;
      config: ClusteringConfig;
    }>,
  ): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO keyword_clusters
       (enrichment_id, cluster_id, canonical_keyword, member_count, median_volume, average_volume, members, representative_domains, algorithm_version, config, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const deleteExisting = this.db.prepare(
      'DELETE FROM keyword_clusters WHERE enrichment_id = ?',
    );
    const tx = this.db.transaction(() => {
      deleteExisting.run(enrichmentId);
      for (const c of clusters) {
        stmt.run(
          enrichmentId,
          c.clusterId,
          c.canonicalKeyword,
          c.members.length,
          c.medianVolume,
          c.averageVolume,
          JSON.stringify(c.members),
          JSON.stringify(c.representativeDomains),
          c.algorithmVersion,
          JSON.stringify(c.config),
          now,
        );
      }
    });
    tx();
  }

  loadKeywordClusters(enrichmentId: string): Array<{
    clusterId: string;
    canonicalKeyword: string;
    memberCount: number;
    medianVolume: number | null;
    averageVolume: number | null;
    members: { keyword: string; normalizedKeyword: string; volume: number | null; serpSize: number }[];
    representativeDomains: string[];
    algorithmVersion: string;
    config: ClusteringConfig;
  }> {
    const rows = this.db
      .prepare('SELECT * FROM keyword_clusters WHERE enrichment_id = ? ORDER BY cluster_id')
      .all(enrichmentId) as Array<{
      cluster_id: string;
      canonical_keyword: string;
      member_count: number;
      median_volume: number | null;
      average_volume: number | null;
      members: string;
      representative_domains: string;
      algorithm_version: string;
      config: string;
    }>;
    return rows.map((row) => ({
      clusterId: row.cluster_id,
      canonicalKeyword: row.canonical_keyword,
      memberCount: row.member_count,
      medianVolume: row.median_volume,
      averageVolume: row.average_volume,
      members: JSON.parse(row.members),
      representativeDomains: JSON.parse(row.representative_domains),
      algorithmVersion: row.algorithm_version,
      config: JSON.parse(row.config),
    }));
  }


  saveEnrichmentPairs(
    enrichmentId: string,
    pairs: Array<{
      keywordA: string;
      keywordB: string;
      intersectionCount: number;
      unionCount: number;
      jaccard: number;
      sharedDomains: string[];
      isEdge: boolean;
    }>,
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO enrichment_pairs
       (enrichment_id, keyword_a, keyword_b, intersection_count, union_count, jaccard, shared_domains, is_edge)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const deleteExisting = this.db.prepare(
      'DELETE FROM enrichment_pairs WHERE enrichment_id = ?',
    );
    const tx = this.db.transaction(() => {
      deleteExisting.run(enrichmentId);
      for (const p of pairs) {
        stmt.run(
          enrichmentId,
          p.keywordA < p.keywordB ? p.keywordA : p.keywordB,
          p.keywordA < p.keywordB ? p.keywordB : p.keywordA,
          p.intersectionCount,
          p.unionCount,
          p.jaccard,
          JSON.stringify(p.sharedDomains),
          p.isEdge ? 1 : 0,
        );
      }
    });
    tx();
  }

  loadEnrichmentPairs(enrichmentId: string): Array<{
    keywordA: string;
    keywordB: string;
    intersectionCount: number;
    unionCount: number;
    jaccard: number;
    sharedDomains: string[];
    isEdge: boolean;
  }> {
    const rows = this.db
      .prepare('SELECT * FROM enrichment_pairs WHERE enrichment_id = ? ORDER BY keyword_a, keyword_b')
      .all(enrichmentId) as Array<{
      keyword_a: string;
      keyword_b: string;
      intersection_count: number;
      union_count: number;
      jaccard: number;
      shared_domains: string;
      is_edge: number;
    }>;
    return rows.map((row) => ({
      keywordA: row.keyword_a,
      keywordB: row.keyword_b,
      intersectionCount: row.intersection_count,
      unionCount: row.union_count,
      jaccard: row.jaccard,
      sharedDomains: JSON.parse(row.shared_domains),
      isEdge: row.is_edge === 1,
    }));
  }

  saveEnrichmentExclusions(
    enrichmentId: string,
    exclusions: Array<{
      keyword: string;
      normalizedKeyword: string;
      reason: string;
      serpSize: number;
    }>,
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO enrichment_exclusions
       (enrichment_id, keyword, normalized_keyword, reason, serp_size)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const deleteExisting = this.db.prepare(
      'DELETE FROM enrichment_exclusions WHERE enrichment_id = ?',
    );
    const tx = this.db.transaction(() => {
      deleteExisting.run(enrichmentId);
      for (const e of exclusions) {
        stmt.run(enrichmentId, e.keyword, e.normalizedKeyword, e.reason, e.serpSize);
      }
    });
    tx();
  }

  loadEnrichmentExclusions(enrichmentId: string): Array<{
    keyword: string;
    normalizedKeyword: string;
    reason: string;
    serpSize: number;
  }> {
    const rows = this.db
      .prepare('SELECT * FROM enrichment_exclusions WHERE enrichment_id = ? ORDER BY keyword')
      .all(enrichmentId) as Array<{
      keyword: string;
      normalized_keyword: string;
      reason: string;
      serp_size: number;
    }>;
    return rows.map((row) => ({
      keyword: row.keyword,
      normalizedKeyword: row.normalized_keyword,
      reason: row.reason,
      serpSize: row.serp_size,
    }));
  }

  // Persists the deduped query-suggestion set. Each row is keyed by the
  // normalized suggestion and carries every retaining (parent, source) occurrence
  // in occurrences_json. Existing rows for the enrichment are replaced wholesale.
  saveQuerySuggestions(
    enrichmentId: string,
    suggestions: Array<{
      normalizedSuggestion: string;
      rawText: string;
      volume: number | null;
      cpc: number | null;
      ordinal: number | null;
      market: string;
      hl: string;
      gl: string;
      parserVersion: string;
      collectionStatus: string;
      occurrences: Array<{
        parentKeyword: string;
        normalizedParent: string;
        source: string;
        market: string;
        hl: string;
        gl: string;
        parserVersion: string;
        collectionStatus: string;
      }>;
    }>,
  ): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO enrichment_query_suggestions
        (enrichment_id, normalized_suggestion, raw_text, volume, cpc, ordinal, market, hl, gl, parser_version, collection_status, occurrences_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const deleteExisting = this.db.prepare(
      'DELETE FROM enrichment_query_suggestions WHERE enrichment_id = ?',
    );
    const tx = this.db.transaction(() => {
      deleteExisting.run(enrichmentId);
      for (const s of suggestions) {
        stmt.run(
          enrichmentId,
          s.normalizedSuggestion,
          s.rawText,
          s.volume,
          s.cpc,
          s.ordinal,
          s.market,
          s.hl,
          s.gl,
          s.parserVersion,
          s.collectionStatus,
          JSON.stringify(s.occurrences),
        );
      }
    });
    tx();
  }

  loadQuerySuggestions(enrichmentId: string): Array<{
    normalizedSuggestion: string;
    rawText: string;
    volume: number | null;
    cpc: number | null;
    ordinal: number | null;
    market: string;
    hl: string;
    gl: string;
    parserVersion: string;
    collectionStatus: string;
    occurrences: Array<{
      parentKeyword: string;
      normalizedParent: string;
      source: QuerySuggestionSource;
      market: string;
      hl: string;
      gl: string;
      parserVersion: string;
      collectionStatus: QuerySuggestionCollectionStatus;
    }>;
  }> {
    const rows = this.db
      .prepare('SELECT * FROM enrichment_query_suggestions WHERE enrichment_id = ? ORDER BY normalized_suggestion')
      .all(enrichmentId) as Array<{
      normalized_suggestion: string;
      raw_text: string;
      volume: number | null;
      cpc: number | null;
      ordinal: number | null;
      market: string;
      hl: string;
      gl: string;
      parser_version: string;
      collection_status: string;
      occurrences_json: string;
    }>;
    return rows.map((row) => {
      let rawOccurrences: Array<Record<string, unknown>>;
      try {
        rawOccurrences = JSON.parse(row.occurrences_json) as Array<Record<string, unknown>>;
        if (!Array.isArray(rawOccurrences)) {
          throw new ResearchError('DB_ERROR', `Corrupt occurrences_json for suggestion "${row.normalized_suggestion}"`);
        }
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw new ResearchError('DB_ERROR', `Corrupt occurrences_json for suggestion "${row.normalized_suggestion}": ${error instanceof Error ? error.message : String(error)}`);
      }
      const occurrences = rawOccurrences.map((raw) => validateOccurrence(raw, row.normalized_suggestion));
      return {
        normalizedSuggestion: row.normalized_suggestion,
        rawText: row.raw_text,
        volume: row.volume,
        cpc: row.cpc,
        ordinal: row.ordinal,
        market: row.market,
        hl: row.hl,
        gl: row.gl,
        parserVersion: row.parser_version,
        collectionStatus: row.collection_status,
        occurrences,
      };
    });
  }

  saveQuerySuggestionSource(
    enrichmentId: string,
    normalizedParent: string,
    source: QuerySuggestionSource,
    status: string,
    error: string | null,
    fetchedAt: string,
    cacheStatus: string = 'none',
    requestCount: number = 0,
    market: string = '',
    hl: string = '',
    gl: string = '',
    parserVersion: string = '',
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO enrichment_query_suggestion_sources
          (enrichment_id, normalized_parent, source, status, error, fetched_at, cache_status, request_count, market, hl, gl, parser_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(enrichmentId, normalizedParent, source, status, error, fetchedAt, cacheStatus, requestCount, market, hl, gl, parserVersion);
  }

  loadQuerySuggestionSources(enrichmentId: string): Array<{
    normalizedParent: string;
    source: QuerySuggestionSource;
    status: string;
    error: string | null;
    fetchedAt: string;
    cacheStatus: string;
    requestCount: number;
    market: string;
    hl: string;
    gl: string;
    parserVersion: string;
  }> {
    const rows = this.db
      .prepare(
        'SELECT normalized_parent, source, status, error, fetched_at, cache_status, request_count, market, hl, gl, parser_version FROM enrichment_query_suggestion_sources WHERE enrichment_id = ?',
      )
      .all(enrichmentId) as Array<{
      normalized_parent: string;
      source: string;
      status: string;
      error: string | null;
      fetched_at: string;
      cache_status: string;
      request_count: number;
      market: string;
      hl: string;
      gl: string;
      parser_version: string;
    }>;
    return rows.map((row) => ({
      normalizedParent: row.normalized_parent,
      source: row.source as QuerySuggestionSource,
      status: row.status,
      error: row.error,
      fetchedAt: row.fetched_at,
      cacheStatus: row.cache_status,
      requestCount: row.request_count,
      market: row.market,
      hl: row.hl,
      gl: row.gl,
      parserVersion: row.parser_version,
    }));
  }

  persistParentAtomic(
    enrichmentId: string,
    normalizedParent: string,
    market: string,
    hl: string,
    gl: string,
    sourceResults: Array<{
      source: QuerySuggestionSource;
      status: string;
      error: string | null;
      fetchedAt: string;
      requestCount: number;
      cacheStatus: string;
      parserVersion: string;
    }>,
    suggestions: Array<{
      normalizedSuggestion: string;
      rawText: string;
      volume: number | null;
      cpc: number | null;
      ordinal: number | null;
      collectionStatus: string;
      occurrences: Array<{
        parentKeyword: string;
        normalizedParent: string;
        source: string;
        market: string;
        hl: string;
        gl: string;
        parserVersion: string;
        collectionStatus: string;
      }>;
    }>,
  ): void {
    const sourceStmt = this.db.prepare(
      `INSERT OR REPLACE INTO enrichment_query_suggestion_sources
        (enrichment_id, normalized_parent, source, status, error, fetched_at, cache_status, request_count, market, hl, gl, parser_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const itemStmt = this.db.prepare(
      `INSERT INTO enrichment_items
        (enrichment_id, item_id, module, status, source, created_at, updated_at, request_count, fetched_at, cache_status, error, payload)
       VALUES (?, ?, 'query_suggestions', ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(enrichment_id, item_id, module) DO UPDATE SET
         status = excluded.status,
         updated_at = excluded.updated_at,
         request_count = request_count + excluded.request_count,
         fetched_at = excluded.fetched_at,
         cache_status = excluded.cache_status,
         error = excluded.error`,
    );
    const suggestionReadStmt = this.db.prepare(
      'SELECT raw_text, volume, cpc, ordinal, parser_version, occurrences_json FROM enrichment_query_suggestions WHERE enrichment_id = ? AND normalized_suggestion = ?',
    );
    const suggestionWriteStmt = this.db.prepare(
      `INSERT OR REPLACE INTO enrichment_query_suggestions
        (enrichment_id, normalized_suggestion, raw_text, volume, cpc, ordinal, market, hl, gl, parser_version, collection_status, occurrences_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    const parserVersionBySource = new Map(sourceResults.map((sr) => [sr.source, sr.parserVersion]));
    const defaultParserVersion = sourceResults[0]?.parserVersion ?? '';
    const tx = this.db.transaction(() => {
      for (const sr of sourceResults) {
        sourceStmt.run(
          enrichmentId,
          normalizedParent,
          sr.source,
          sr.status,
          sr.error,
          sr.fetchedAt,
          sr.cacheStatus,
          sr.requestCount,
          market,
          hl,
          gl,
          sr.parserVersion,
        );
        const itemStatus = sr.status === 'error' ? 'error' : 'completed';
        itemStmt.run(
          enrichmentId,
          `${sr.source}:${normalizedParent}`,
          itemStatus,
          sr.source === 'surfer_related' ? 'surfer' : 'google',
          now,
          now,
          sr.requestCount,
          sr.fetchedAt,
          sr.cacheStatus,
          sr.error,
        );
      }
      for (const s of suggestions) {
        const existing = suggestionReadStmt.get(enrichmentId, s.normalizedSuggestion) as
          | { raw_text: string; volume: number | null; cpc: number | null; ordinal: number | null; parser_version: string; occurrences_json: string }
          | undefined;
        let mergedOccurrences: Array<Record<string, unknown>> = [...s.occurrences];
        if (existing) {
          let existingOccurrences: Array<Record<string, unknown>>;
          try {
            existingOccurrences = JSON.parse(existing.occurrences_json) as Array<Record<string, unknown>>;
          } catch {
            throw new ResearchError('DB_ERROR', `Corrupt occurrences_json for suggestion "${s.normalizedSuggestion}" in enrichment "${enrichmentId}"`);
          }
          if (!Array.isArray(existingOccurrences)) {
            throw new ResearchError('DB_ERROR', `Corrupt occurrences_json for suggestion "${s.normalizedSuggestion}" in enrichment "${enrichmentId}": expected array`);
          }
          const seen = new Set(s.occurrences.map((o) => `${o.normalizedParent}:${o.source}`));
          for (const eo of existingOccurrences) {
            const key = `${String(eo.normalizedParent)}:${String(eo.source)}`;
            if (!seen.has(key)) {
              mergedOccurrences = [...mergedOccurrences, eo];
              seen.add(key);
            }
          }
        }
        const parserVersion = s.occurrences[0]?.source
          ? parserVersionBySource.get(s.occurrences[0].source as QuerySuggestionSource) ?? defaultParserVersion
          : defaultParserVersion;
        const mergedRawText = existing?.raw_text ?? s.rawText;
        const mergedVolume = existing?.volume ?? s.volume ?? null;
        const mergedCpc = existing?.cpc ?? s.cpc ?? null;
        const mergedOrdinal = existing?.ordinal ?? s.ordinal ?? null;
        const mergedParserVersion = existing?.parser_version || parserVersion;
        suggestionWriteStmt.run(
          enrichmentId,
          s.normalizedSuggestion,
          mergedRawText,
          mergedVolume,
          mergedCpc,
          mergedOrdinal,
          s.occurrences[0]?.market ?? market,
          s.occurrences[0]?.hl ?? hl,
          s.occurrences[0]?.gl ?? gl,
          mergedParserVersion,
          s.collectionStatus,
          JSON.stringify(mergedOccurrences),
        );
      }
    });
    tx();
  }

  loadEnrichmentRun(enrichmentId: string): EnrichmentRunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM enrichment_runs WHERE enrichment_id = ?')
      .get(enrichmentId) as
      | {
          enrichment_id: string;
          source_run_id: string;
          state: string;
          created_at: string;
          updated_at: string;
          modules: string;
          config: string;
          source_run_directory: string;
          enrichment_directory: string;
          shortlist_keywords: string;
          error: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      enrichmentId: row.enrichment_id,
      sourceRunId: row.source_run_id,
      state: row.state as EnrichmentRunRecord['state'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      modules: JSON.parse(row.modules) as EnrichmentModuleId[],
      config: JSON.parse(row.config) as EnrichmentRunRecord['config'],
      sourceRunDirectory: row.source_run_directory,
      enrichmentDirectory: row.enrichment_directory,
      shortlistKeywords: JSON.parse(row.shortlist_keywords),
      error: row.error,
    };
  }

  saveEnrichmentPages(
    enrichmentId: string,
    pages: Array<{
      url: string;
      finalUrl: string;
      redirectCount: number;
      redirectChain: string;
      httpStatus: number;
      contentType: string | null;
      fetchStatus: string;
      fetchError: string | null;
      fetchedAt: string;
      cacheStatus: string;
      title: string | null;
      metaDescription: string | null;
      h1: string | null;
      canonical: string | null;
      language: string | null;
      wordCount: number | null;
      possiblyJsRendered: boolean;
      forms: string;
      structuredDataTypes: string;
      sourceKeywords: string;
      sourcePositions: string;
    }>,
  ): void {
    const deleteExisting = this.db.prepare('DELETE FROM enrichment_pages WHERE enrichment_id = ?');
    const stmt = this.db.prepare(
      `INSERT INTO enrichment_pages (
        enrichment_id, url, final_url, redirect_count, redirect_chain,
        http_status, content_type, fetch_status, fetch_error, fetched_at, cache_status,
        title, meta_description, h1, canonical, language, word_count, possibly_js_rendered,
        forms, structured_data_types, source_keywords, source_positions
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.db.transaction(() => {
      deleteExisting.run(enrichmentId);
      for (const p of pages) {
        stmt.run(
          enrichmentId, p.url, p.finalUrl, p.redirectCount, p.redirectChain,
          p.httpStatus, p.contentType, p.fetchStatus, p.fetchError, p.fetchedAt, p.cacheStatus,
          p.title, p.metaDescription, p.h1, p.canonical, p.language, p.wordCount, p.possiblyJsRendered ? 1 : 0,
          p.forms, p.structuredDataTypes, p.sourceKeywords, p.sourcePositions,
        );
      }
    });
    tx();
  }

  loadEnrichmentPages(enrichmentId: string): Array<{
    url: string;
    finalUrl: string;
    redirectCount: number;
    redirectChain: string;
    httpStatus: number;
    contentType: string | null;
    fetchStatus: string;
    fetchError: string | null;
    fetchedAt: string;
    cacheStatus: string;
    title: string | null;
    metaDescription: string | null;
    h1: string | null;
    canonical: string | null;
    language: string | null;
    wordCount: number | null;
    possiblyJsRendered: boolean;
    forms: string;
    structuredDataTypes: string;
    sourceKeywords: string;
    sourcePositions: string;
  }> {
    const rows = this.db
      .prepare('SELECT * FROM enrichment_pages WHERE enrichment_id = ? ORDER BY url')
      .all(enrichmentId) as Array<{
      url: string;
      final_url: string;
      redirect_count: number;
      redirect_chain: string;
      http_status: number;
      content_type: string | null;
      fetch_status: string;
      fetch_error: string | null;
      fetched_at: string;
      cache_status: string;
      title: string | null;
      meta_description: string | null;
      h1: string | null;
      canonical: string | null;
      language: string | null;
      word_count: number | null;
      possibly_js_rendered: number;
      forms: string;
      structured_data_types: string;
      source_keywords: string;
      source_positions: string;
    }>;
    return rows.map((row) => ({
      url: row.url,
      finalUrl: row.final_url,
      redirectCount: row.redirect_count,
      redirectChain: row.redirect_chain,
      httpStatus: row.http_status,
      contentType: row.content_type,
      fetchStatus: row.fetch_status,
      fetchError: row.fetch_error,
      fetchedAt: row.fetched_at,
      cacheStatus: row.cache_status,
      title: row.title,
      metaDescription: row.meta_description,
      h1: row.h1,
      canonical: row.canonical,
      language: row.language,
      wordCount: row.word_count,
      possiblyJsRendered: row.possibly_js_rendered === 1,
      forms: row.forms,
      structuredDataTypes: row.structured_data_types,
      sourceKeywords: row.source_keywords,
      sourcePositions: row.source_positions,
    }));
  }

  saveEnrichmentSiteStructure(
    enrichmentId: string,
    records: Array<{
      domain: string;
      homepageStatus: string;
      homepageHttpStatus: number | null;
      robotsStatus: string;
      robotsHttpStatus: number | null;
      robotsUrl: string | null;
      sitemapUrlsFromRobots: string;
      sitemapFallbackUrl: string | null;
      sitemapType: string;
      declaredSitemapCount: number;
      discoveredUrlCount: number;
      sampledUrls: string;
      sampledUtilityUrls: string;
      errors: string;
      fetchedAt: string;
      cacheStatus: string;
      sourceKeywords: string;
      sourceBestPosition: number | null;
    }>,
  ): void {
    const deleteExisting = this.db.prepare('DELETE FROM enrichment_site_structure WHERE enrichment_id = ?');
    const stmt = this.db.prepare(
      `INSERT INTO enrichment_site_structure (
        enrichment_id, domain, homepage_status, homepage_http_status, robots_status, robots_http_status, robots_url,
        sitemap_urls_from_robots, sitemap_fallback_url, sitemap_type,
        declared_sitemap_count, discovered_url_count, sampled_urls, sampled_utility_urls, errors,
        fetched_at, cache_status, source_keywords, source_best_position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.db.transaction(() => {
      deleteExisting.run(enrichmentId);
      for (const r of records) {
        stmt.run(
          enrichmentId, r.domain, r.homepageStatus, r.homepageHttpStatus, r.robotsStatus, r.robotsHttpStatus, r.robotsUrl,
          r.sitemapUrlsFromRobots, r.sitemapFallbackUrl, r.sitemapType,
          r.declaredSitemapCount, r.discoveredUrlCount, r.sampledUrls, r.sampledUtilityUrls, r.errors,
          r.fetchedAt, r.cacheStatus, r.sourceKeywords, r.sourceBestPosition,
        );
      }
    });
    tx();
  }

  loadEnrichmentSiteStructure(enrichmentId: string): Array<{
    domain: string;
    homepageStatus: string;
    homepageHttpStatus: number | null;
    robotsStatus: string;
    robotsHttpStatus: number | null;
    robotsUrl: string | null;
    sitemapUrlsFromRobots: string[];
    sitemapFallbackUrl: string | null;
    sitemapType: string;
    declaredSitemapCount: number;
    discoveredUrlCount: number;
    sampledUrls: string[];
    sampledUtilityUrls: string[];
    errors: Array<{ url: string; error: string }>;
    fetchedAt: string;
    cacheStatus: string;
    sourceKeywords: string[];
    sourceBestPosition: number | null;
  }> {
    const rows = this.db
      .prepare('SELECT * FROM enrichment_site_structure WHERE enrichment_id = ? ORDER BY domain')
      .all(enrichmentId) as Array<{
      domain: string;
      homepage_status: string;
      homepage_http_status: number | null;
      robots_status: string;
      robots_http_status: number | null;
      robots_url: string | null;
      sitemap_urls_from_robots: string;
      sitemap_fallback_url: string | null;
      sitemap_type: string;
      declared_sitemap_count: number;
      discovered_url_count: number;
      sampled_urls: string;
      sampled_utility_urls: string;
      errors: string;
      fetched_at: string;
      cache_status: string;
      source_keywords: string;
      source_best_position: number | null;
    }>;
    return rows.map((row): {
      domain: string;
      homepageStatus: string;
      homepageHttpStatus: number | null;
      robotsStatus: string;
      robotsHttpStatus: number | null;
      robotsUrl: string | null;
      sitemapUrlsFromRobots: string[];
      sitemapFallbackUrl: string | null;
      sitemapType: string;
      declaredSitemapCount: number;
      discoveredUrlCount: number;
      sampledUrls: string[];
      sampledUtilityUrls: string[];
      errors: Array<{ url: string; error: string }>;
      fetchedAt: string;
      cacheStatus: string;
      sourceKeywords: string[];
      sourceBestPosition: number | null;
    } => ({
      domain: row.domain,
      homepageStatus: row.homepage_status,
      homepageHttpStatus: row.homepage_http_status,
      robotsStatus: row.robots_status,
      robotsHttpStatus: row.robots_http_status,
      robotsUrl: row.robots_url,
      sitemapUrlsFromRobots: JSON.parse(row.sitemap_urls_from_robots),
      sitemapFallbackUrl: row.sitemap_fallback_url,
      sitemapType: row.sitemap_type,
      declaredSitemapCount: row.declared_sitemap_count,
      discoveredUrlCount: row.discovered_url_count,
      sampledUrls: JSON.parse(row.sampled_urls),
      sampledUtilityUrls: JSON.parse(row.sampled_utility_urls),
      errors: JSON.parse(row.errors),
      fetchedAt: row.fetched_at,
      cacheStatus: row.cache_status,
      sourceKeywords: JSON.parse(row.source_keywords),
      sourceBestPosition: row.source_best_position,
    }));
  }

  upsertPageTarget(
    enrichmentId: string,
    target: {
      url: string;
      status: 'pending' | 'running' | 'completed' | 'error';
      data?: string | null;
      error?: string | null;
      fetchedAt?: string | null;
      cacheStatus?: string;
      sourceKeywords?: string;
      sourcePositions?: string;
    },
  ): void {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT created_at FROM enrichment_page_targets WHERE enrichment_id = ? AND url = ?')
      .get(enrichmentId, target.url) as { created_at: string } | undefined;

    this.db.prepare(`
      INSERT INTO enrichment_page_targets
        (enrichment_id, url, status, data, error, fetched_at, cache_status, source_keywords, source_positions, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(enrichment_id, url) DO UPDATE SET
        status = excluded.status,
        data = excluded.data,
        error = excluded.error,
        fetched_at = excluded.fetched_at,
        cache_status = excluded.cache_status,
        source_keywords = excluded.source_keywords,
        source_positions = excluded.source_positions,
        updated_at = excluded.updated_at
    `).run(
      enrichmentId,
      target.url,
      target.status,
      target.data ?? null,
      target.error ?? null,
      target.fetchedAt ?? null,
      target.cacheStatus ?? 'none',
      target.sourceKeywords ?? '[]',
      target.sourcePositions ?? '[]',
      existing?.created_at ?? now,
      now,
    );
  }

  loadPageTargets(enrichmentId: string): Array<{
    url: string;
    status: string;
    data: string | null;
    error: string | null;
    fetchedAt: string | null;
    cacheStatus: string;
    sourceKeywords: string;
    sourcePositions: string;
  }> {
    const rows = this.db
      .prepare('SELECT * FROM enrichment_page_targets WHERE enrichment_id = ? ORDER BY url')
      .all(enrichmentId) as Array<{
      url: string;
      status: string;
      data: string | null;
      error: string | null;
      fetched_at: string | null;
      cache_status: string;
      source_keywords: string;
      source_positions: string;
    }>;
    return rows.map((row) => ({
      url: row.url,
      status: row.status,
      data: row.data,
      error: row.error,
      fetchedAt: row.fetched_at,
      cacheStatus: row.cache_status,
      sourceKeywords: row.source_keywords,
      sourcePositions: row.source_positions,
    }));
  }

  getPageTargetStatus(enrichmentId: string): { total: number; completed: number; pending: number; error: number } {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) as cnt FROM enrichment_page_targets WHERE enrichment_id = ? GROUP BY status')
      .all(enrichmentId) as Array<{ status: string; cnt: number }>;
    let total = 0;
    let completed = 0;
    let pending = 0;
    let error = 0;
    for (const row of rows) {
      total += row.cnt;
      if (row.status === 'completed') completed += row.cnt;
      else if (row.status === 'error') error += row.cnt;
      else pending += row.cnt;
    }
    return { total, completed, pending, error };
  }

  upsertSiteStructureTarget(
    enrichmentId: string,
    target: {
      domain: string;
      status: 'pending' | 'running' | 'completed' | 'error';
      data?: string | null;
      error?: string | null;
      fetchedAt?: string | null;
      cacheStatus?: string;
    },
  ): void {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT created_at FROM enrichment_site_structure_targets WHERE enrichment_id = ? AND domain = ?')
      .get(enrichmentId, target.domain) as { created_at: string } | undefined;

    this.db.prepare(`
      INSERT INTO enrichment_site_structure_targets
        (enrichment_id, domain, status, data, error, fetched_at, cache_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(enrichment_id, domain) DO UPDATE SET
        status = excluded.status,
        data = excluded.data,
        error = excluded.error,
        fetched_at = excluded.fetched_at,
        cache_status = excluded.cache_status,
        updated_at = excluded.updated_at
    `).run(
      enrichmentId,
      target.domain,
      target.status,
      target.data ?? null,
      target.error ?? null,
      target.fetchedAt ?? null,
      target.cacheStatus ?? 'none',
      existing?.created_at ?? now,
      now,
    );
  }

  loadSiteStructureTargets(enrichmentId: string): Array<{
    domain: string;
    status: string;
    data: string | null;
    error: string | null;
    fetchedAt: string | null;
    cacheStatus: string;
  }> {
    const rows = this.db
      .prepare('SELECT * FROM enrichment_site_structure_targets WHERE enrichment_id = ? ORDER BY domain')
      .all(enrichmentId) as Array<{
      domain: string;
      status: string;
      data: string | null;
      error: string | null;
      fetched_at: string | null;
      cache_status: string;
    }>;
    return rows.map((row) => ({
      domain: row.domain,
      status: row.status,
      data: row.data,
      error: row.error,
      fetchedAt: row.fetched_at,
      cacheStatus: row.cache_status,
    }));
  }

  getSiteStructureTargetStatus(enrichmentId: string): { total: number; completed: number; pending: number; error: number } {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) as cnt FROM enrichment_site_structure_targets WHERE enrichment_id = ? GROUP BY status')
      .all(enrichmentId) as Array<{ status: string; cnt: number }>;
    let total = 0;
    let completed = 0;
    let pending = 0;
    let error = 0;
    for (const row of rows) {
      total += row.cnt;
      if (row.status === 'completed') completed += row.cnt;
      else if (row.status === 'error') error += row.cnt;
      else pending += row.cnt;
    }
    return { total, completed, pending, error };
  }

  insertPageTargetIfAbsent(
    enrichmentId: string,
    target: {
      url: string;
      status: 'pending';
      sourceKeywords: string;
      sourcePositions: string;
    },
  ): boolean {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT url FROM enrichment_page_targets WHERE enrichment_id = ? AND url = ?')
      .get(enrichmentId, target.url);
    if (existing) return false;

    this.db.prepare(`
      INSERT INTO enrichment_page_targets
        (enrichment_id, url, status, data, error, fetched_at, cache_status, source_keywords, source_positions, created_at, updated_at)
      VALUES (?, ?, ?, NULL, NULL, NULL, 'none', ?, ?, ?, ?)
    `).run(
      enrichmentId,
      target.url,
      target.status,
      target.sourceKeywords,
      target.sourcePositions,
      now,
      now,
    );
    return true;
  }

  insertSiteStructureTargetIfAbsent(
    enrichmentId: string,
    target: {
      domain: string;
      status: 'pending';
    },
  ): boolean {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT domain FROM enrichment_site_structure_targets WHERE enrichment_id = ? AND domain = ?')
      .get(enrichmentId, target.domain);
    if (existing) return false;

    this.db.prepare(`
      INSERT INTO enrichment_site_structure_targets
        (enrichment_id, domain, status, data, error, fetched_at, cache_status, created_at, updated_at)
      VALUES (?, ?, ?, NULL, NULL, NULL, 'none', ?, ?)
    `).run(
      enrichmentId,
      target.domain,
      target.status,
      now,
      now,
    );
    return true;
  }
}

function deriveHistoricalRegistrableDomain(hostname: string, url: string): string {
  const fromHostname = registrableDomain(hostname);
  if (fromHostname) return fromHostname;
  try {
    return registrableDomain(new URL(url).hostname) ?? '';
  } catch {
    return '';
  }
}

function mapKeywordRow(row: KeywordRow): StoredKeyword {
  return {
    idx: row.idx,
    id: row.id,
    keyword: row.keyword,
    normalizedKeyword: row.normalized_keyword,
    sources: JSON.parse(row.sources) as KeywordSource[],
    status: row.status as KeywordStatus,
    surfer: row.surfer === null ? null : JSON.parse(row.surfer),
    google: row.google === null ? null : JSON.parse(row.google),
    error: row.error === null ? null : JSON.parse(row.error),
    collectedAt: row.collected_at,
    cacheStatus: row.cache_status == null ? null : (row.cache_status as StoredKeyword['cacheStatus']),
  };
}

export function storedKeywordToRecord(keyword: StoredKeyword): KeywordRecord {
  const microsoftSources = keyword.sources.filter(
    (source): source is MicrosoftSource => source.type === 'microsoft',
  );
  // The aggregated Microsoft signal is derived deterministically from the
  // preserved occurrences, so a load/resume round-trip reproduces the same
  // value without storing a separate aggregate column.
  const microsoft = microsoftSources.length > 0 ? aggregateMicrosoft(microsoftSources) : null;
  return {
    id: keyword.id,
    keyword: keyword.keyword,
    normalizedKeyword: keyword.normalizedKeyword,
    sources: keyword.sources,
    microsoft,
    surfer: keyword.surfer,
    google: keyword.google,
    status: keyword.status,
    error: keyword.error,
  };
}

export function isTerminalKeywordStatus(status: KeywordStatus): boolean {
  return TERMINAL_KEYWORD_STATUSES.has(status);
}
