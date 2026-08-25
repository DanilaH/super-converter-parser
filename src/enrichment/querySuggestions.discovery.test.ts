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
  const collection = collections.get('business days between dates');
  assert.equal(collection?.status, 'ok');
  assert.equal(collection?.cacheStatus, 'source_run');
  assert.deepEqual(collection?.occurrences.map((item) => [item.rawText, item.volume]), [
    ['business day calculator', 12_100],
    ['working days calculator', 8_100],
  ]);
});

test('reuses a truthful discovery empty result but retries discovery errors', () => {
  const empty = buildDiscoverySurferCollections([
    row({ relatedKeyword: '', volume: null, status: 'empty' }),
  ]);
  assert.equal(empty.get('business days between dates')?.status, 'empty');

  const errored = buildDiscoverySurferCollections([
    row({ relatedKeyword: '', volume: null, status: 'error', error: 'widget missing' }),
  ]);
  assert.equal(errored.has('business days between dates'), false);
});
