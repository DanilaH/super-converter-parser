import Database from 'better-sqlite3';
import { ResearchError, type ResearchErrorCode } from '../shared/errors.js';
import type { ClusteringConfig, EnrichmentCacheStatus, EnrichmentItemRecord, EnrichmentItemStatus, EnrichmentModuleId, EnrichmentRunRecord, QuerySuggestionSource } from '../enrichment/types.js';

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
import {
  TERMINAL_KEYWORD_STATUSES,
  type KeywordRecord,
  type KeywordSource,
  type MicrosoftSource,
  type KeywordStatus,
  type RunState,
} from '../runs/run.js';

export const SCHEMA_VERSION = 11;

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
  force_refresh: number;
  refresh_keywords: string;
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
  cache_status: string | null;
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
    const db = new Database(path, { readonly: true });
    return new RunStore(db);
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
    addColumnIfMissingLocal(this.db, 'enrichment_runs', 'shortlist_keywords', "TEXT NOT NULL DEFAULT '[]'");
    // Ensure v9 tables exist for databases created before v9.
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
      refreshKeywords: JSON.parse(row.refresh_keywords) as string[],
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
    const rows = this.db
      .prepare(
        `SELECT keyword_idx, position, keyword, title, url, hostname, registrable_domain, dr, dr_status, dr_error, result_type
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
      registrableDomain: row.registrable_domain,
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
      source: string;
      market: string;
      hl: string;
      gl: string;
      parserVersion: string;
      collectionStatus: string;
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
    return rows.map((row) => ({
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
      occurrences: JSON.parse(row.occurrences_json),
    }));
  }

  saveQuerySuggestionSource(
    enrichmentId: string,
    normalizedParent: string,
    source: QuerySuggestionSource,
    status: string,
    error: string | null,
    fetchedAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO enrichment_query_suggestion_sources
          (enrichment_id, normalized_parent, source, status, error, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(enrichmentId, normalizedParent, source, status, error, fetchedAt);
  }

  loadQuerySuggestionSources(enrichmentId: string): Array<{
    normalizedParent: string;
    source: QuerySuggestionSource;
    status: string;
    error: string | null;
    fetchedAt: string;
  }> {
    const rows = this.db
      .prepare(
        'SELECT normalized_parent, source, status, error, fetched_at FROM enrichment_query_suggestion_sources WHERE enrichment_id = ?',
      )
      .all(enrichmentId) as Array<{
      normalized_parent: string;
      source: string;
      status: string;
      error: string | null;
      fetched_at: string;
    }>;
    return rows.map((row) => ({
      normalizedParent: row.normalized_parent,
      source: row.source as QuerySuggestionSource,
      status: row.status,
      error: row.error,
      fetchedAt: row.fetched_at,
    }));
  }

  persistSourceCollectionAtomic(
    enrichmentId: string,
    normalizedParent: string,
    source: QuerySuggestionSource,
    status: string,
    error: string | null,
    fetchedAt: string,
    requestCount: number,
    cacheStatus: EnrichmentCacheStatus,
  ): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO enrichment_query_suggestion_sources
        (enrichment_id, normalized_parent, source, status, error, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const itemStatus = status === 'error' ? 'error' : 'completed';
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
    const now = fetchedAt;
    const tx = this.db.transaction(() => {
      stmt.run(enrichmentId, normalizedParent, source, status, error, fetchedAt);
      itemStmt.run(
        enrichmentId,
        `${source}:${normalizedParent}`,
        itemStatus,
        source === 'surfer_related' ? 'surfer' : 'google',
        now,
        now,
        requestCount,
        fetchedAt,
        cacheStatus,
        error,
      );
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
    cacheStatus: row.cache_status === null ? null : (row.cache_status as StoredKeyword['cacheStatus']),
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