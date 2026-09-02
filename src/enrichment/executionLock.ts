import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { ResearchError } from '../shared/errors.js';

const ENRICHMENT_LOCK_DIRECTORY = 'super-converter-parser-locks';

/**
 * Serialize execution for one durable enrichment generation.
 *
 * The lock lives outside the enrichment directory so acquiring it never creates
 * or mutates research artifacts. SQLite owns stale-lock recovery: process death
 * closes the connection and releases the transaction lock automatically, while
 * the tiny lock DB may remain for reuse.
 */
export async function acquireEnrichmentExecutionLock(
  enrichmentDirectory: string,
  enrichmentId: string,
): Promise<() => Promise<void>> {
  const lockDirectory = join(tmpdir(), ENRICHMENT_LOCK_DIRECTORY);
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const absoluteDirectory = resolve(enrichmentDirectory);
  const lockIdentity = process.platform === 'win32'
    ? absoluteDirectory.toLowerCase()
    : absoluteDirectory;
  const enrichmentKey = createHash('sha256').update(lockIdentity).digest('hex');
  const lockPath = join(lockDirectory, `enrichment-${enrichmentKey}.sqlite`);

  let db: Database.Database | null = null;
  try {
    db = new Database(lockPath, { timeout: 250 });
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 250');
    db.exec(`
      CREATE TABLE IF NOT EXISTS enrichment_execution_lock_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO enrichment_execution_lock_metadata (singleton, schema_version)
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
        `Another enrichment execution is already running for enrichment ${enrichmentId}. Retry after it finishes.`,
        { cause: error },
      );
    }
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Failed to acquire enrichment execution lock for enrichment ${enrichmentId}.`,
      { cause: error },
    );
  }

  if (db === null) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Failed to initialize enrichment execution lock for enrichment ${enrichmentId}.`,
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
        // Connection may already have lost its transaction; close below.
      }
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        `Failed to release enrichment execution lock for enrichment ${enrichmentId}.`,
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
