import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ResearchError } from '../shared/errors.js';

const LOCK_DB_FILE = '.publish-lock.sqlite';

/**
 * Serialize the complete library publication, including derived
 * library.json/library.zip writes.
 *
 * A dedicated SQLite database is used only as an OS-backed advisory lock. This
 * avoids stale lock-file reclamation entirely: when a publisher process exits or
 * crashes, SQLite/OS releases the transaction lock automatically. The small lock
 * database file may remain on disk and is harmless.
 */
export async function acquirePublishLock(
  libraryDirectory: string,
): Promise<() => Promise<void>> {
  await mkdir(libraryDirectory, { recursive: true });
  const lockPath = join(libraryDirectory, LOCK_DB_FILE);
  let db: Database.Database | null = null;
  try {
    db = new Database(lockPath);
    db.pragma('journal_mode = DELETE');
    // Fail quickly instead of making a second agent appear hung behind a long
    // master-ZIP rebuild. The operator can retry after the active publish ends.
    db.pragma('busy_timeout = 250');
    db.exec(`
      CREATE TABLE IF NOT EXISTS publish_lock_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO publish_lock_metadata (singleton, schema_version)
      VALUES (1, 1);
    `);
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Preserve the original lock-acquisition error.
    }
    if (isSqliteBusy(error)) {
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        'Another research-library publication is already running. Retry after it finishes.',
        { cause: error },
      );
    }
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Failed to acquire research-library publish lock: ${lockPath}`,
      { cause: error },
    );
  }

  if (db === null) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Failed to initialize research-library publish lock: ${lockPath}`,
    );
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
        // The connection may already have lost its transaction; close below.
      }
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        'Failed to release research-library publish lock cleanly.',
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
