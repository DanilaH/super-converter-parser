import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ResearchError } from '../shared/errors.js';

const DISCOVERY_LOCK_DB_FILE = 'discovery-execution.sqlite';

/**
 * Serialize discovery execution for one durable output root.
 *
 * Discovery uses shared browser/provider resources and resume recovery resets
 * persisted `running` keyword checkpoints to `pending`. Without one execution
 * boundary, a second process can mistake a still-live checkpoint for crash
 * residue and collect the same run concurrently. SQLite supplies OS-backed
 * crash recovery: process death releases the transaction lock automatically.
 */
export async function acquireDiscoveryExecutionLock(
  outputRoot: string,
): Promise<() => Promise<void>> {
  const lockDirectory = join(outputRoot, 'index', 'locks');
  await mkdir(lockDirectory, { recursive: true });
  const lockPath = join(lockDirectory, DISCOVERY_LOCK_DB_FILE);
  let db: Database.Database | null = null;
  try {
    db = new Database(lockPath);
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 250');
    db.exec(`
      CREATE TABLE IF NOT EXISTS discovery_execution_lock_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO discovery_execution_lock_metadata (singleton, schema_version)
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
        'Another discovery execution is already running for this output root. Retry after it finishes.',
        { cause: error },
      );
    }
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Failed to acquire discovery execution lock: ${lockPath}`,
      { cause: error },
    );
  }

  if (db === null) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to initialize discovery execution lock: ${lockPath}`);
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
        'Failed to release discovery execution lock cleanly.',
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
