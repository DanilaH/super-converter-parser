import Database from 'better-sqlite3';
import { ResearchError, type ResearchErrorCode } from '../shared/errors.js';
import type { ResearchConfig } from '../config/config.js';
import type { SeedKeyword } from '../input/seeds/normalize.js';
import type { SerpResult } from '../google/serp.js';
import {
  TERMINAL_KEYWORD_STATUSES,
  type KeywordRecord,
  type KeywordStatus,
  type RunState,
} from '../runs/run.js';

export const SCHEMA_VERSION = 1;

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
];

export type StoredRun = {
  runId: string;
  state: RunState;
  createdAt: string;
  updatedAt: string;
  input: { kind: 'seeds'; path: string };
  configSnapshot: ResearchConfig;
  parserVersions: { surfer: string; google: string };
  lookups: number;
  pauseReason: string | null;
};

export type StoredKeyword = {
  idx: number;
  id: string;
  keyword: string;
  normalizedKeyword: string;
  sources: Array<{ type: 'seed'; rowNumbers: number[] }>;
  status: KeywordStatus;
  surfer: KeywordRecord['surfer'];
  google: KeywordRecord['google'];
  error: { code: ResearchErrorCode; message: string } | null;
  collectedAt: string | null;
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
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      const apply = this.db.transaction(() => {
        this.db.exec(MIGRATIONS[version] as string);
        this.db.pragma(`user_version = ${version + 1}`);
      });
      apply();
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
    input: { kind: 'seeds'; path: string };
    keywords: SeedKeyword[];
  }): void {
    const insertRun = this.db.prepare(
      `INSERT INTO runs (run_id, state, created_at, updated_at, input_kind, input_path, config_snapshot, parser_versions, lookups, pause_reason)
       VALUES (?, 'created', ?, ?, ?, ?, ?, ?, 0, NULL)`,
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
      );
      input.keywords.forEach((seed, index) => {
        insertKeyword.run(
          input.runId,
          index,
          `kw-${String(index + 1).padStart(4, '0')}`,
          seed.keyword,
          seed.normalizedKeyword,
          JSON.stringify([{ type: 'seed', rowNumbers: seed.sourceRows }]),
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
      input: { kind: row.input_kind as 'seeds', path: row.input_path },
      configSnapshot: JSON.parse(row.config_snapshot) as ResearchConfig,
      parserVersions: JSON.parse(row.parser_versions) as { surfer: string; google: string },
      lookups: row.lookups,
      pauseReason: row.pause_reason,
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

  loadSerpRows(runId: string): SerpResult[] {
    const rows = this.db
      .prepare(
        `SELECT keyword_idx, position, keyword, title, url, hostname, result_type
         FROM serp_rows WHERE run_id = ? ORDER BY keyword_idx ASC, position ASC`,
      )
      .all(runId) as Array<{
      keyword_idx: number;
      position: number;
      keyword: string;
      title: string;
      url: string;
      hostname: string;
      result_type: string;
    }>;
    return rows.map((row) => ({
      keyword: row.keyword,
      position: row.position,
      title: row.title,
      url: row.url,
      hostname: row.hostname,
      resultType: row.result_type as SerpResult['resultType'],
    }));
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
      `INSERT INTO serp_rows (run_id, keyword_idx, position, keyword, title, url, hostname, result_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const write = this.db.transaction(() => {
      deleteRows.run(runId, keywordIdx);
      for (const row of rows) {
        insertRow.run(runId, keywordIdx, row.position, row.keyword, row.title, row.url, row.hostname, row.resultType);
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
}

function mapKeywordRow(row: KeywordRow): StoredKeyword {
  return {
    idx: row.idx,
    id: row.id,
    keyword: row.keyword,
    normalizedKeyword: row.normalized_keyword,
    sources: JSON.parse(row.sources) as StoredKeyword['sources'],
    status: row.status as KeywordStatus,
    surfer: row.surfer === null ? null : JSON.parse(row.surfer),
    google: row.google === null ? null : JSON.parse(row.google),
    error: row.error === null ? null : JSON.parse(row.error),
    collectedAt: row.collected_at,
  };
}

export function storedKeywordToRecord(keyword: StoredKeyword): KeywordRecord {
  return {
    id: keyword.id,
    keyword: keyword.keyword,
    normalizedKeyword: keyword.normalizedKeyword,
    sources: keyword.sources,
    surfer: keyword.surfer,
    google: keyword.google,
    status: keyword.status,
    error: keyword.error,
  };
}

export function isTerminalKeywordStatus(status: KeywordStatus): boolean {
  return TERMINAL_KEYWORD_STATUSES.has(status);
}