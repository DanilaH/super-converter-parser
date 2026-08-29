import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config/config.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { RunStore } from '../db/store.js';
import { loadKeywordRetryAttempts, loadOpenKeywordRetryIndexes } from '../db/retryAttempts.js';
import { ResearchError } from '../shared/errors.js';
import { prepareFailedKeywordRetry } from './retryFailed.js';

const CONFIG = loadConfig({});

function makeStore(parserVersions = { surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION }): RunStore {
  const store = RunStore.openInMemory();
  store.createRun({
    runId: 'run-repair-control',
    configSnapshot: CONFIG,
    parserVersions,
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: buildSeedKeywords([{ keyword: 'repair me', rowNumber: 1 }]),
  });
  return store;
}

function markFailed(store: RunStore): void {
  const keyword = store.loadKeyword('run-repair-control', 0)!;
  store.updateKeyword('run-repair-control', {
    ...keyword,
    status: 'failed',
    error: { code: 'GOOGLE_UNAVAILABLE', message: 'failed before repair' },
    collectedAt: '2026-08-28T00:00:00.000Z',
  });
}

test('completed_with_errors can be explicitly reopened and only failed keyword becomes pending', () => {
  const store = makeStore();
  markFailed(store);
  store.setRunState('run-repair-control', 'completed_with_errors');

  const result = prepareFailedKeywordRetry(store, 'run-repair-control');
  assert.deepEqual(result.reopenedKeywordIdxs, [0]);
  assert.deepEqual(result.openKeywordIdxs, [0]);
  assert.equal(result.run.state, 'paused');
  assert.equal(store.loadKeyword('run-repair-control', 0)?.status, 'pending');
  assert.equal(loadKeywordRetryAttempts(store, 'run-repair-control').length, 1);
  store.close();
});

test('re-entering an interrupted repair is idempotent and does not create retry_no 2', () => {
  const store = makeStore();
  markFailed(store);
  store.setRunState('run-repair-control', 'completed_with_errors');

  prepareFailedKeywordRetry(store, 'run-repair-control');
  const resumed = prepareFailedKeywordRetry(store, 'run-repair-control');
  assert.deepEqual(resumed.reopenedKeywordIdxs, []);
  assert.deepEqual(resumed.openKeywordIdxs, [0]);
  assert.deepEqual(loadKeywordRetryAttempts(store, 'run-repair-control').map((attempt) => attempt.retryNo), [1]);
  store.close();
});

test('completed, failed, and cancelled run states cannot be reopened', () => {
  for (const state of ['completed', 'failed', 'cancelled'] as const) {
    const store = makeStore();
    markFailed(store);
    store.setRunState('run-repair-control', state);
    assert.throws(
      () => prepareFailedKeywordRetry(store, 'run-repair-control'),
      (error: unknown) => error instanceof ResearchError && error.code === 'RESUME_TERMINAL_RUN',
    );
    assert.equal(store.loadKeyword('run-repair-control', 0)?.status, 'failed');
    assert.deepEqual(loadOpenKeywordRetryIndexes(store, 'run-repair-control'), []);
    store.close();
  }
});

test('parser mismatch is rejected before any failed checkpoint mutation', () => {
  const store = makeStore({ surfer: 'old-surfer', google: GOOGLE_PARSER_VERSION });
  markFailed(store);
  store.setRunState('run-repair-control', 'completed_with_errors');

  assert.throws(
    () => prepareFailedKeywordRetry(store, 'run-repair-control'),
    (error: unknown) => error instanceof ResearchError && error.code === 'RESUME_PARSER_MISMATCH',
  );
  assert.equal(store.loadKeyword('run-repair-control', 0)?.status, 'failed');
  assert.equal(loadKeywordRetryAttempts(store, 'run-repair-control').length, 0);
  store.close();
});

test('explicit retry fails as input error when there is no failed or open repair checkpoint', () => {
  const store = makeStore();
  const keyword = store.loadKeyword('run-repair-control', 0)!;
  store.updateKeyword('run-repair-control', {
    ...keyword,
    status: 'completed',
    collectedAt: '2026-08-28T00:00:00.000Z',
  });
  store.setRunState('run-repair-control', 'completed_with_errors');

  assert.throws(
    () => prepareFailedKeywordRetry(store, 'run-repair-control'),
    (error: unknown) => error instanceof ResearchError && error.code === 'INPUT_SCHEMA_ERROR',
  );
  assert.equal(loadKeywordRetryAttempts(store, 'run-repair-control').length, 0);
  store.close();
});
