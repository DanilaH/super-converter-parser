import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { loadConfig } from '../config/config.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import type { SerpResult } from '../google/serp.js';
import { RunStore } from './store.js';
import {
  KEYWORD_RETRY_SCHEMA_VERSION,
  beginFailedKeywordRetries,
  loadKeywordRetryAttempts,
  loadOpenKeywordRetryIndexes,
  reconcileCompletedKeywordRetries,
} from './retryAttempts.js';

const CONFIG = loadConfig({});

function setup(): { store: RunStore; runId: string } {
  const store = RunStore.openInMemory();
  const runId = 'run-retry';
  store.createRun({
    runId,
    configSnapshot: CONFIG,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: buildSeedKeywords([
      { keyword: 'healthy keyword', rowNumber: 1 },
      { keyword: 'failed keyword', rowNumber: 2 },
    ]),
  });
  return { store, runId };
}

function row(keyword: string, keywordIdx: number, domain: string, position = 1): SerpResult {
  return {
    keyword,
    keywordIdx,
    position,
    title: `${domain} title`,
    url: `https://${domain}/${position}`,
    hostname: domain,
    registrableDomain: domain,
    dr: 12,
    drStatus: 'ok',
    drError: null,
    resultType: 'organic',
  };
}

function persistDomain(store: RunStore, runId: string, keywordIdx: number, keyword: string, serpRows: SerpResult[]): void {
  const source = new Map<string, { source: 'fresh'; fetchedAt: string }>();
  for (const serpRow of serpRows) {
    source.set(serpRow.registrableDomain, { source: 'fresh', fetchedAt: '2026-08-29T00:00:00.000Z' });
  }
  store.recordDomains(runId, keywordIdx, keyword, serpRows, source);
}

function seedCompletedAndFailed(store: RunStore, runId: string): void {
  const healthy = store.loadKeyword(runId, 0)!;
  const failed = store.loadKeyword(runId, 1)!;
  const healthyRows = [row('healthy keyword', 0, 'healthy.example')];
  const failedRows = [row('failed keyword', 1, 'stale.example')];

  store.commitKeyword(runId, {
    ...healthy,
    status: 'completed',
    collectedAt: '2026-08-28T10:00:00.000Z',
  }, healthyRows, 'miss');
  persistDomain(store, runId, 0, 'healthy keyword', healthyRows);

  store.commitKeyword(runId, {
    ...failed,
    status: 'failed',
    error: { code: 'GOOGLE_UNAVAILABLE', message: 'old failure' },
    collectedAt: '2026-08-28T10:01:00.000Z',
  }, failedRows, 'miss');
  persistDomain(store, runId, 1, 'failed keyword', failedRows);
  store.setRunState(runId, 'completed_with_errors');
}

test('ordinary reads do not create retry extension schema', () => {
  const { store, runId } = setup();
  const db = (store as unknown as { db: Database.Database }).db;

  assert.deepEqual(loadOpenKeywordRetryIndexes(store, runId), []);
  assert.equal(loadKeywordRetryAttempts(store, runId).length, 0);
  const retryTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'keyword_retry_schema'")
    .get();
  assert.equal(retryTable, undefined);
  store.close();
});

test('explicit repair snapshots failed checkpoint, clears only its current evidence, and prunes stale domains', () => {
  const { store, runId } = setup();
  seedCompletedAndFailed(store, runId);

  const reopened = beginFailedKeywordRetries(store, runId, '2026-08-29T09:00:00.000Z');
  assert.deepEqual(reopened, [1]);
  assert.equal(store.loadRun(runId)?.state, 'paused');
  assert.equal(store.loadKeyword(runId, 0)?.status, 'completed');

  const repairedCurrent = store.loadKeyword(runId, 1)!;
  assert.equal(repairedCurrent.status, 'pending');
  assert.equal(repairedCurrent.error, null);
  assert.equal(repairedCurrent.google, null);
  assert.equal(repairedCurrent.surfer, null);
  assert.equal(repairedCurrent.collectedAt, null);
  assert.equal(repairedCurrent.cacheStatus, null);
  assert.deepEqual(store.loadSerpRows(runId).map((r) => r.keywordIdx), [0]);
  assert.deepEqual(store.loadDomains(runId).map((d) => d.domain), ['healthy.example']);
  assert.deepEqual(loadOpenKeywordRetryIndexes(store, runId), [1]);

  const attempts = loadKeywordRetryAttempts(store, runId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.retryNo, 1);
  assert.equal(attempts[0]?.completedAt, null);
  assert.equal(attempts[0]?.previousRecord.status, 'failed');
  assert.equal(attempts[0]?.previousRecord.error?.message, 'old failure');
  assert.deepEqual(attempts[0]?.previousSerpRows.map((r) => r.registrableDomain), ['stale.example']);

  const db = (store as unknown as { db: Database.Database }).db;
  const schema = db.prepare('SELECT version FROM keyword_retry_schema WHERE singleton = 1').get() as { version: number };
  assert.equal(schema.version, KEYWORD_RETRY_SCHEMA_VERSION);
  store.close();
});

test('terminal repair checkpoint is recoverably journaled without another retry and replaces stale domain evidence', () => {
  const { store, runId } = setup();
  seedCompletedAndFailed(store, runId);
  beginFailedKeywordRetries(store, runId, '2026-08-29T09:00:00.000Z');

  const pending = store.loadKeyword(runId, 1)!;
  const repairedRows = [row('failed keyword', 1, 'fresh.example')];
  store.commitKeyword(runId, {
    ...pending,
    status: 'completed',
    collectedAt: '2026-08-29T09:05:00.000Z',
  }, repairedRows, 'refreshed');
  persistDomain(store, runId, 1, 'failed keyword', repairedRows);

  // Simulate the crash window after the normal checkpoint commit but before the
  // retry journal close. The durable marker is still open at this point.
  assert.deepEqual(loadOpenKeywordRetryIndexes(store, runId), [1]);
  assert.deepEqual(reconcileCompletedKeywordRetries(store, runId, '2026-08-29T09:06:00.000Z'), [1]);
  assert.deepEqual(loadOpenKeywordRetryIndexes(store, runId), []);

  const attempt = loadKeywordRetryAttempts(store, runId)[0]!;
  assert.equal(attempt.completedAt, '2026-08-29T09:06:00.000Z');
  assert.equal(attempt.resultRecord?.status, 'completed');
  assert.equal(attempt.resultRecord?.cacheStatus, 'refreshed');
  assert.deepEqual(attempt.resultSerpRows?.map((r) => r.registrableDomain), ['fresh.example']);
  assert.deepEqual(store.loadDomains(runId).map((d) => d.domain), ['fresh.example', 'healthy.example']);
  store.close();
});

test('failed repair closes attempt and the next explicit repair gets a monotonic retry number', () => {
  const { store, runId } = setup();
  seedCompletedAndFailed(store, runId);
  beginFailedKeywordRetries(store, runId, '2026-08-29T09:00:00.000Z');

  const pending = store.loadKeyword(runId, 1)!;
  store.commitKeyword(runId, {
    ...pending,
    status: 'failed',
    error: { code: 'GOOGLE_UNAVAILABLE', message: 'repair failed too' },
    collectedAt: '2026-08-29T09:05:00.000Z',
  }, [], 'refreshed');
  assert.deepEqual(reconcileCompletedKeywordRetries(store, runId, '2026-08-29T09:06:00.000Z'), [1]);

  assert.deepEqual(beginFailedKeywordRetries(store, runId, '2026-08-29T09:10:00.000Z'), [1]);
  const attempts = loadKeywordRetryAttempts(store, runId);
  assert.deepEqual(attempts.map((attempt) => attempt.retryNo), [1, 2]);
  assert.equal(attempts[0]?.resultRecord?.status, 'failed');
  assert.equal(attempts[1]?.previousRecord.status, 'failed');
  assert.equal(attempts[1]?.previousRecord.error?.message, 'repair failed too');
  assert.equal(attempts[1]?.completedAt, null);
  store.close();
});
