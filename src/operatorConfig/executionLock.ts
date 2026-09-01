import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ResearchError } from '../shared/errors.js';

/**
 * Serialize config-driven continuation for one stable research identity.
 *
 * The lock lives outside the research directory so it never becomes a research
 * artifact or enters results.zip. SQLite owns stale-lock recovery: a crashed
 * process releases the transaction lock automatically, while the tiny lock DB
 * may remain for reuse.
 */
export async function acquireResearchExecutionLock(
  outputRoot: string,
  researchId: string,
): Promise<() => Promise<void>> {
  if (!/^[A-Za-z0-9_-]+$/.test(researchId)) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Invalid research ID: ${researchId}`);
  }

  const lockDirectory = join(outputRoot, 'index', 'locks');
  await mkdir(lockDirectory, { recursive: true });
  const lockPath = join(lockDirectory, `research-${researchId}.sqlite`);
  let db: Database.Database | null = null;
  try {
    db = new Database(lockPath);
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 250');
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_execution_lock_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO research_execution_lock_metadata (singleton, schema_version)
      VALUES (1, 1);
    `);
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Preserve the acquisition failure.
    }
    if (isSqliteBusy(error)) {
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        `Another config-driven execution for research ${researchId} is already running. Retry after it finishes.`,
        { cause: error },
      );
    }
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Failed to acquire config-driven execution lock for research ${researchId}.`,
      { cause: error },
    );
  }

  if (db === null) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to initialize execution lock for research ${researchId}.`);
  }

  const lockDb = db;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      lockDb.exec('COMMIT');
    } catch (error) {
      try {
        lockDb.exec('ROLLBACK');
      } catch {
        // Connection may already have lost its transaction; close below.
      }
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        `Failed to release config-driven execution lock for research ${researchId}.`,
        { cause: error },
      );
    } finally {
      lockDb.close();
    }
  };
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED');
}
