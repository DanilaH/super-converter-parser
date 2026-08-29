import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../config/config.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import type { SerpResult } from '../google/serp.js';
import { RunStore } from './store.js';
import {
  beginFailedKeywordRetries,
  loadKeywordRetryAttempts,
} from './retryAttempts.js';

const CONFIG = loadConfig({});

function row(): SerpResult {
  return {
    keyword: 'failed keyword',
    keywordIdx: 0,
    position: 1,
    title: 'old result',
    url: 'https://old.example/tool',
    hostname: 'old.example',
    registrableDomain: 'old.example',
    dr: null,
    drStatus: null,
    drError: null,
    resultType: 'organic',
  };
}

test('closing a prepared repair before publication restores the durable run exactly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'retry-rollback-'));
  const dbPath = join(directory, 'run.sqlite');
  const runId = 'run-rollback';

  const store = RunStore.open(dbPath);
  store.createRun({
    runId,
    configSnapshot: CONFIG,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: buildSeedKeywords([{ keyword: 'failed keyword', rowNumber: 1 }]),
  });
  const keyword = store.loadKeyword(runId, 0)!;
  store.commitKeyword(runId, {
    ...keyword,
    status: 'failed',
    error: { code: 'GOOGLE_UNAVAILABLE', message: 'original failure' },
    collectedAt: '2026-08-28T10:00:00.000Z',
  }, [row()], 'miss');
  store.setRunState(runId, 'completed_with_errors');

  const reopened = beginFailedKeywordRetries(store, runId, '2026-08-29T09:00:00.000Z');
  assert.deepEqual(reopened, [0]);
  assert.equal(store.loadRun(runId)?.state, 'paused');
  assert.equal(store.loadKeyword(runId, 0)?.status, 'pending');
  assert.equal(loadKeywordRetryAttempts(store, runId).length, 1);

  // Simulates any config/cache/output preflight failure in the CLI. No public
  // open-attempt read occurred, so the prepared transaction is still uncommitted.
  store.close();

  const reopenedStore = RunStore.open(dbPath);
  assert.equal(reopenedStore.loadRun(runId)?.state, 'completed_with_errors');
  const restored = reopenedStore.loadKeyword(runId, 0)!;
  assert.equal(restored.status, 'failed');
  assert.equal(restored.error?.message, 'original failure');
  assert.equal(restored.collectedAt, '2026-08-28T10:00:00.000Z');
  assert.equal(restored.cacheStatus, 'miss');
  assert.deepEqual(reopenedStore.loadSerpRows(runId).map((item) => item.registrableDomain), ['old.example']);

  // Extension schema was created inside the staged transaction as well, so a
  // rejected repair does not mutate even database metadata.
  const db = (reopenedStore as unknown as { db: Database.Database }).db;
  const retryTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'keyword_retry_schema'")
    .get();
  assert.equal(retryTable, undefined);
  reopenedStore.close();
});
