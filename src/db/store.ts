import Database from 'better-sqlite3';
import { ResearchError, type ResearchErrorCode } from '../shared/errors.js';
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

export const SCHEMA_VERSION = 3;

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
  ALTER TABLE serp_rows ADD COLUMN registrable_domain TEXT NOT NULL DEFAULT '';
  ALTER TABLE serp_rows ADD COLUMN dr REAL;
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
        `SELECT keyword_idx, position, keyword, title, url, hostname, registrable_domain, dr, result_type
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
      result_type: string;
    }>;
    return rows.map((row) => ({
      keyword: row.keyword,
      position: row.position,
      title: row.title,
      url: row.url,
      hostname: row.hostname,
      registrableDomain: row.registrable_domain,
      dr: row.dr,
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
      `INSERT INTO serp_rows (run_id, keyword_idx, position, keyword, title, url, hostname, registrable_domain, dr, result_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      `INSERT INTO serp_rows (run_id, keyword_idx, position, keyword, title, url, hostname, registrable_domain, dr, result_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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