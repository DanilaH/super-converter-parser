import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscoverySurferCollections } from './querySuggestions.js';
import type { StoredRelatedKeyword } from '../db/store.js';

function row(overrides: Partial<StoredRelatedKeyword> = {}): StoredRelatedKeyword {
  return {
    runId: 'run-1',
    parentIdx: 0,
    parentKeyword: 'Business Days Between Dates',
    relatedKeyword: 'business day calculator',
    overlap: 75,
    volume: 12_100,
    selectedForExpansion: false,
    status: 'ok',
    error: null,
    ...overrides,
  };
}

test('rebuilds Surfer suggestions from discovery with source-run provenance', () => {
  const collections = buildDiscoverySurferCollections([
    row(),
    row({ relatedKeyword: 'working days calculator', volume: 8_100 }),
  ]);
  const collection = collections.get(0);
  assert.equal(collection?.status, 'ok');
  assert.equal(collection?.cacheStatus, 'source_run');
  assert.deepEqual(collection?.occurrences.map((item) => [item.parentKeywordIdx, item.rawText, item.volume]), [
    [0, 'business day calculator', 12_100],
    [0, 'working days calculator', 8_100],
  ]);
});

test('keeps distinct source parents even when their display text normalizes identically', () => {
  const collections = buildDiscoverySurferCollections([
    row({ parentIdx: 3, parentKeyword: 'JSON Diff', relatedKeyword: 'json compare' }),
    row({ parentIdx: 4, parentKeyword: ' json   diff ', relatedKeyword: 'json validator' }),
  ]);

  assert.equal(collections.size, 2);
  assert.equal(collections.get(3)?.occurrences[0]?.parentKeywordIdx, 3);
  assert.equal(collections.get(4)?.occurrences[0]?.parentKeywordIdx, 4);
  assert.equal(collections.get(3)?.occurrences[0]?.normalizedParent, 'json diff');
  assert.equal(collections.get(4)?.occurrences[0]?.normalizedParent, 'json diff');
});

test('reuses a truthful discovery empty result but retries discovery errors', () => {
  const empty = buildDiscoverySurferCollections([
    row({ relatedKeyword: '', volume: null, status: 'empty' }),
  ]);
  assert.equal(empty.get(0)?.status, 'empty');

  const errored = buildDiscoverySurferCollections([
    row({ relatedKeyword: '', volume: null, status: 'error', error: 'widget missing' }),
  ]);
  assert.equal(errored.has(0), false);
});
