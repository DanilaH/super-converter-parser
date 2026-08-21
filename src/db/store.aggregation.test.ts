import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunStore } from './store.js';
import { loadConfig } from '../config/config.js';

const CONFIG = loadConfig({});

function makeStore(runId = 'run-agg'): RunStore {
  const store = RunStore.openInMemory();
  store.createRun({
    runId,
    configSnapshot: CONFIG,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: [],
  });
  return store;
}

test('related keywords persist and replaying a parent is idempotent', () => {
  const store = makeStore();
  const outcome = {
    status: 'ok' as const,
    error: null,
    rows: [
      { keyword: 'r1', overlap: 1, volume: 100 },
      { keyword: 'r2', overlap: 2, volume: 200 },
    ],
  };
  store.recordRelatedKeywords('run-agg', 0, 'parent', outcome, new Set(['r2']));
  let loaded = store.loadRelatedKeywords('run-agg');
  assert.equal(loaded.length, 2);
  assert.equal(loaded.find((r) => r.relatedKeyword === 'r2')!.selectedForExpansion, true);
  assert.equal(loaded.find((r) => r.relatedKeyword === 'r1')!.selectedForExpansion, false);

  // Replay the same parent with a different selection: updated, no duplicates.
  store.recordRelatedKeywords('run-agg', 0, 'parent', outcome, new Set(['r1']));
  loaded = store.loadRelatedKeywords('run-agg');
  assert.equal(loaded.length, 2, 'no duplicate rows after replay');
  assert.equal(loaded.find((r) => r.relatedKeyword === 'r1')!.selectedForExpansion, true);
  assert.equal(loaded.find((r) => r.relatedKeyword === 'r2')!.selectedForExpansion, false);
  store.close();
});

test('empty related outcome persists a verdict row; not_attempted is skipped', () => {
  const store = makeStore();
  store.recordRelatedKeywords('run-agg', 1, 'p2', { status: 'empty', error: null, rows: [] }, new Set());
  let loaded = store.loadRelatedKeywords('run-agg');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.status, 'empty');
  assert.equal(loaded[0]!.relatedKeyword, '');

  store.recordRelatedKeywords('run-agg', 1, 'p2', { status: 'not_attempted', error: null, rows: [] }, new Set());
  loaded = store.loadRelatedKeywords('run-agg');
  assert.equal(loaded.length, 1, 'not_attempted does not persist a row');
  store.close();
});

test('domains persist uniquely, keep earliest first-seen, and update DR on replay', () => {
  const store = makeStore();
  const src = new Map<string, { source: 'cache' | 'fresh'; fetchedAt: string }>([
    ['a.com', { source: 'fresh', fetchedAt: '2026-01-01T00:00:00.000Z' }],
  ]);
  store.recordDomains('run-agg', 0, [{ registrableDomain: 'a.com', dr: 50, drStatus: 'ok', position: 2 }], src);
  store.recordDomains('run-agg', 1, [{ registrableDomain: 'a.com', dr: 80, drStatus: 'ok', position: 1 }], src);
  let loaded = store.loadDomains('run-agg');
  assert.equal(loaded.length, 1, 'unique domain across two keywords');
  const a = loaded[0]!;
  assert.equal(a.dr, 80, 'DR updates to the latest value');
  assert.equal(a.firstSeenKeywordIdx, 0, 'earliest surface keyword preserved');
  assert.equal(a.firstSeenPosition, 2, 'earliest surface position preserved');

  // Replay keyword 0: still one row, no duplicate.
  store.recordDomains('run-agg', 0, [{ registrableDomain: 'a.com', dr: 50, drStatus: 'ok', position: 2 }], src);
  loaded = store.loadDomains('run-agg');
  assert.equal(loaded.length, 1, 'no duplicate after replay');
  assert.equal(a.firstSeenKeywordIdx, 0);
  store.close();
});
