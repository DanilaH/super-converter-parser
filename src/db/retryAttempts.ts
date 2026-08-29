import Database from 'better-sqlite3';
import type { SerpResult } from '../google/serp.js';
import { TERMINAL_KEYWORD_STATUSES, type RunState } from '../runs/run.js';
import { ResearchError } from '../shared/errors.js';
import type { RunStore, StoredKeyword } from './store.js';

export const KEYWORD_RETRY_SCHEMA_VERSION = 1;

export type KeywordRetryAttempt = {
  runId: string;
  keywordIdx: number;
  retryNo: number;
  requestedAt: string;
  completedAt: string | null;
  previousRecord: StoredKeyword;
  previousSerpRows: SerpResult[];
  resultRecord: StoredKeyword | null;
  resultSerpRows: SerpResult[] | null;
};

type StoreWithDb = { db: Database.Database };

type RetryAttemptRow = {
  run_id: string;
  keyword_idx: number;
  retry_no: number;
  requested_at: string;
  completed_at: string | null;
  previous_record: string;
  previous_serp_rows: string;
  result_record: string | null;
  result_serp_rows: string | null;
};

function dbOf(store: RunStore): Database.Database {
  // RunStore intentionally owns the SQLite connection. The retry journal is a
  // feature-owned extension schema in the same run.sqlite; this narrow adapter
  // keeps journal + current-checkpoint changes inside one SQLite transaction.
  // Keep this escape localized until RunStore exposes a public transaction API.
  return (store as unknown as StoreWithDb).db;
}

function retrySchemaExists(store: RunStore): boolean {
  return Boolean(dbOf(store)
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'keyword_retry_schema'")
    .get());
}

function applyKeywordRetrySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS keyword_retry_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
  `);
  const row = db
    .prepare('SELECT version FROM keyword_retry_schema WHERE singleton = 1')
    .get() as { version: number } | undefined;
  if (row && row.version > KEYWORD_RETRY_SCHEMA_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Keyword retry schema version ${row.version} is newer than this build supports (${KEYWORD_RETRY_SCHEMA_VERSION}).`,
    );
  }
  if (!row) {
    db.prepare('INSERT INTO keyword_retry_schema (singleton, version) VALUES (1, ?)')
      .run(KEYWORD_RETRY_SCHEMA_VERSION);
  } else if (row.version < 1) {
    throw new ResearchError('DB_ERROR', `Unsupported keyword retry schema version ${row.version}.`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS keyword_retry_attempts (
      run_id TEXT NOT NULL,
      keyword_idx INTEGER NOT NULL,
      retry_no INTEGER NOT NULL,
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      previous_record TEXT NOT NULL,
      previous_serp_rows TEXT NOT NULL,
      result_record TEXT,
      result_serp_rows TEXT,
      PRIMARY KEY (run_id, keyword_idx, retry_no)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS keyword_retry_attempts_open
      ON keyword_retry_attempts(run_id, keyword_idx)
      WHERE completed_at IS NULL;
  `);
}

export function ensureKeywordRetrySchema(store: RunStore): void {
  const db = dbOf(store);
  db.transaction(() => applyKeywordRetrySchema(db))();
}

function assertRetrySchemaReadable(store: RunStore): boolean {
  if (!retrySchemaExists(store)) return false;
  const row = dbOf(store)
    .prepare('SELECT version FROM keyword_retry_schema WHERE singleton = 1')
    .get() as { version: number } | undefined;
  if (!row || row.version < 1 || row.version > KEYWORD_RETRY_SCHEMA_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Unsupported keyword retry schema version ${row?.version ?? 'missing'}.`,
    );
  }
  return true;
}

function mapAttemptRow(row: RetryAttemptRow): KeywordRetryAttempt {
  return {
    runId: row.run_id,
    keywordIdx: row.keyword_idx,
    retryNo: row.retry_no,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
    previousRecord: JSON.parse(row.previous_record) as StoredKeyword,
    previousSerpRows: JSON.parse(row.previous_serp_rows) as SerpResult[],
    resultRecord: row.result_record === null ? null : JSON.parse(row.result_record) as StoredKeyword,
    resultSerpRows: row.result_serp_rows === null ? null : JSON.parse(row.result_serp_rows) as SerpResult[],
  };
}

export function loadKeywordRetryAttempts(store: RunStore, runId: string): KeywordRetryAttempt[] {
  if (!assertRetrySchemaReadable(store)) return [];
  return (dbOf(store)
    .prepare(
      `SELECT * FROM keyword_retry_attempts
       WHERE run_id = ?
       ORDER BY keyword_idx ASC, retry_no ASC`,
    )
    .all(runId) as RetryAttemptRow[]).map(mapAttemptRow);
}

export function loadOpenKeywordRetryIndexes(store: RunStore, runId: string): number[] {
  if (!assertRetrySchemaReadable(store)) return [];
  return (dbOf(store)
    .prepare(
      `SELECT keyword_idx FROM keyword_retry_attempts
       WHERE run_id = ? AND completed_at IS NULL
       ORDER BY keyword_idx ASC`,
    )
    .all(runId) as Array<{ keyword_idx: number }>).map((row) => row.keyword_idx);
}

function reconcileDomainsFromCurrentSerp(db: Database.Database, runId: string): void {
  db.prepare(
    `DELETE FROM domains
     WHERE run_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM serp_rows
         WHERE serp_rows.run_id = domains.run_id
           AND serp_rows.registrable_domain = domains.domain
       )`,
  ).run(runId);

  const domains = db.prepare(
    `SELECT domain, first_seen_keyword_idx
     FROM domains WHERE run_id = ? ORDER BY domain ASC`,
  ).all(runId) as Array<{ domain: string; first_seen_keyword_idx: number }>;
  const rows = db.prepare(
    `SELECT registrable_domain, keyword_idx, keyword, position
     FROM serp_rows
     WHERE run_id = ? AND registrable_domain <> ''
     ORDER BY keyword_idx ASC, position ASC`,
  ).all(runId) as Array<{
    registrable_domain: string;
    keyword_idx: number;
    keyword: string;
    position: number;
  }>;
  const rowsByDomain = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = rowsByDomain.get(row.registrable_domain) ?? [];
    group.push(row);
    rowsByDomain.set(row.registrable_domain, group);
  }
  const update = db.prepare(
    `UPDATE domains
     SET first_seen_keyword = ?, first_seen_keyword_idx = ?, first_seen_position = ?
     WHERE run_id = ? AND domain = ?`,
  );
  for (const domain of domains) {
    const candidates = rowsByDomain.get(domain.domain) ?? [];
    if (candidates.length === 0) continue;
    const preservedOwner = candidates.find((row) => row.keyword_idx === domain.first_seen_keyword_idx);
    const owner = preservedOwner ?? candidates[0]!;
    update.run(owner.keyword, owner.keyword_idx, owner.position, runId, domain.domain);
  }
}

/**
 * Applies a previously validated list of failed keyword indexes. The caller is
 * expected to build the list read-only, complete config/cache/output preflight,
 * then call this function immediately before browser work. All current-state
 * resets and history snapshots commit atomically in one synchronous transaction.
 */
export function applyFailedKeywordRetries(
  store: RunStore,
  runId: string,
  keywordIdxs: readonly number[],
  requestedAt: string = new Date().toISOString(),
): number[] {
  const uniqueIdxs = [...new Set(keywordIdxs)].sort((a, b) => a - b);
  if (uniqueIdxs.length === 0) return [];

  const db = dbOf(store);
  const apply = db.transaction(() => {
    // Prepare extension-table statements only after the table is known to exist.
    // Fresh runs have never created this feature-owned schema before their first
    // explicit repair.
    applyKeywordRetrySchema(db);
    const nextRetryNo = db.prepare(
      `SELECT COALESCE(MAX(retry_no), 0) + 1 AS retry_no
       FROM keyword_retry_attempts WHERE run_id = ? AND keyword_idx = ?`,
    );
    const openAttempt = db.prepare(
      `SELECT retry_no FROM keyword_retry_attempts
       WHERE run_id = ? AND keyword_idx = ? AND completed_at IS NULL`,
    );
    const insertAttempt = db.prepare(
      `INSERT INTO keyword_retry_attempts
        (run_id, keyword_idx, retry_no, requested_at, previous_record, previous_serp_rows)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const resetKeyword = db.prepare(
      `UPDATE keywords
       SET status = 'pending', surfer = NULL, google = NULL, error = NULL,
           collected_at = NULL, cache_status = NULL
       WHERE run_id = ? AND idx = ? AND status = 'failed'`,
    );
    const deleteSerp = db.prepare('DELETE FROM serp_rows WHERE run_id = ? AND keyword_idx = ?');
    const updateRun = db.prepare(
      `UPDATE runs
       SET state = 'paused', updated_at = ?, pause_reason = ?
       WHERE run_id = ?`,
    );
    const currentSerpRows = store.loadSerpRows(runId);
    const reopened: number[] = [];

    for (const keywordIdx of uniqueIdxs) {
      if (!Number.isInteger(keywordIdx) || keywordIdx < 0) {
        throw new ResearchError('DB_ERROR', `Invalid failed-keyword repair index ${keywordIdx}.`);
      }
      const keyword = store.loadKeyword(runId, keywordIdx);
      if (!keyword || keyword.status !== 'failed') {
        throw new ResearchError(
          'DB_ERROR',
          `Keyword ${keywordIdx} in run "${runId}" is no longer failed; refusing to apply a stale repair plan.`,
        );
      }
      if (openAttempt.get(runId, keywordIdx)) {
        throw new ResearchError(
          'DB_ERROR',
          `Keyword ${keywordIdx} in run "${runId}" already has an open retry attempt.`,
        );
      }

      const retryNo = (nextRetryNo.get(runId, keywordIdx) as { retry_no: number }).retry_no;
      const previousSerpRows = currentSerpRows.filter((row) => row.keywordIdx === keywordIdx);
      insertAttempt.run(
        runId,
        keywordIdx,
        retryNo,
        requestedAt,
        JSON.stringify(keyword),
        JSON.stringify(previousSerpRows),
      );
      const reset = resetKeyword.run(runId, keywordIdx);
      if (reset.changes !== 1) {
        throw new ResearchError(
          'DB_ERROR',
          `Failed to reopen keyword ${keywordIdx} in run "${runId}" for repair.`,
        );
      }
      deleteSerp.run(runId, keywordIdx);
      reopened.push(keywordIdx);
    }

    reconcileDomainsFromCurrentSerp(db, runId);
    updateRun.run(requestedAt, 'Explicit failed-keyword repair prepared.', runId);
    return reopened;
  });

  return apply();
}

/**
 * Closes journal rows whose current keyword checkpoint is already terminal.
 * This is deliberately recoverable rather than coupled to commitKeyword(): if
 * the process dies after the normal checkpoint commit but before journal close,
 * the next CLI resume closes the attempt from durable current state without a
 * second browser request.
 */
export function reconcileCompletedKeywordRetries(
  store: RunStore,
  runId: string,
  completedAt: string = new Date().toISOString(),
): number[] {
  if (!assertRetrySchemaReadable(store)) return [];
  const db = dbOf(store);
  const open = loadOpenKeywordRetryIndexes(store, runId);
  if (open.length === 0) return [];
  const keywords = new Map(store.loadKeywords(runId).map((keyword) => [keyword.idx, keyword]));
  const serpRows = store.loadSerpRows(runId);
  const close = db.prepare(
    `UPDATE keyword_retry_attempts
     SET completed_at = ?, result_record = ?, result_serp_rows = ?
     WHERE run_id = ? AND keyword_idx = ? AND completed_at IS NULL`,
  );
  const closed: number[] = [];

  const tx = db.transaction(() => {
    for (const keywordIdx of open) {
      const keyword = keywords.get(keywordIdx);
      if (!keyword || !TERMINAL_KEYWORD_STATUSES.has(keyword.status)) continue;
      const resultRows = serpRows.filter((row) => row.keywordIdx === keywordIdx);
      close.run(
        completedAt,
        JSON.stringify(keyword),
        JSON.stringify(resultRows),
        runId,
        keywordIdx,
      );
      closed.push(keywordIdx);
    }
    // An interrupted commit can leave recordDomains() ahead of the keyword/SERP
    // checkpoint. While any repair is open, rebuild aggregate membership from
    // the current SERP source of truth even if no journal row closed this call.
    reconcileDomainsFromCurrentSerp(db, runId);
  });
  tx();
  return closed;
}

export function isRetryRepairStateEligible(state: RunState): boolean {
  return state === 'created' || state === 'running' || state === 'paused' || state === 'completed_with_errors';
}
