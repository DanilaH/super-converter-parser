import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ResearchError } from '../shared/errors.js';
import { acquirePublishLock } from './publishLock.js';

test('SQLite publish lock rejects a concurrent publisher and releases cleanly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'library-lock-live-'));
  const release = await acquirePublishLock(directory);

  await assert.rejects(
    () => acquirePublishLock(directory),
    (error: unknown) =>
      error instanceof ResearchError
      && error.code === 'OUTPUT_WRITE_ERROR'
      && error.message.includes('already running'),
  );

  await release();
  // Release is deliberately idempotent so CLI cleanup cannot double-close.
  await release();

  const releaseAgain = await acquirePublishLock(directory);
  await releaseAgain();
});

test('a leftover lock database without an active process lock is reusable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'library-lock-reuse-'));
  const lockPath = join(directory, '.publish-lock.sqlite');
  const oldProcess = new Database(lockPath);
  oldProcess.exec(`
    CREATE TABLE publish_lock_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL
    );
    INSERT INTO publish_lock_metadata (singleton, schema_version) VALUES (1, 1);
    BEGIN EXCLUSIVE;
  `);
  // Closing the connection models process termination: the OS/SQLite lock is
  // released even though the database file remains on disk.
  oldProcess.close();

  const release = await acquirePublishLock(directory);
  await release();
});
