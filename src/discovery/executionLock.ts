import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { ResearchError } from '../shared/errors.js';

const DISCOVERY_LOCK_DIRECTORY = 'super-converter-parser-locks';

/**
 * Serialize discovery execution for one durable output root without mutating
 * that output root before the discovery core accepts its inputs.
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
  const lockDirectory = join(tmpdir(), DISCOVERY_LOCK_DIRECTORY);
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const absoluteRoot = resolve(outputRoot);
  const canonicalRoot = await canonicalizeOutputRoot(absoluteRoot);
  const lockIdentity = process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot;
  const rootKey = createHash('sha256').update(lockIdentity).digest('hex');
  const lockPath = join(lockDirectory, `discovery-${rootKey}.sqlite`);
  let db: Database.Database | null = null;
  try {
    db = new Database(lockPath, { timeout: 250 });
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
      `Failed to acquire discovery execution lock for output root ${absoluteRoot}.`,
      { cause: error },
    );
  }

  if (db === null) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Failed to initialize discovery execution lock for output root ${absoluteRoot}.`,
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
        'Failed to release discovery execution lock cleanly.',
        { cause: error },
      );
    } finally {
      lockDb.close();
    }
  };
}

async function canonicalizeOutputRoot(absoluteRoot: string): Promise<string> {
  let cursor = absoluteRoot;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const canonicalBase = await realpath(cursor);
      return missingSegments.length === 0
        ? canonicalBase
        : resolve(canonicalBase, ...missingSegments);
    } catch (error) {
      if (!isEnoent(error)) {
        throw new ResearchError(
          'OUTPUT_WRITE_ERROR',
          `Failed to canonicalize discovery output root ${absoluteRoot}.`,
          { cause: error },
        );
      }
    }

    const parent = dirname(cursor);
    if (parent === cursor) return absoluteRoot;
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED');
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
