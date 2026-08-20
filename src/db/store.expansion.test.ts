import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunStore } from './store.js';
import { loadConfig } from '../config/config.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';

const CONFIG = loadConfig({});

function makeStore() {
  const store = RunStore.openInMemory();
  store.createRun({
    runId: 'run-1',
    configSnapshot: CONFIG,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: buildSeedKeywords([{ keyword: 'compare lists', rowNumber: 1 }]),
  });
  return store;
}

test('addKeyword appends a related candidate with the next sequential idx', () => {
  const store = makeStore();
  assert.equal(store.loadKeywords('run-1').length, 1);

  const added = store.addKeyword('run-1', {
    keyword: 'list comparison tool',
    normalizedKeyword: 'list comparison tool',
    sources: [{ type: 'surfer_related', parentKeyword: 'compare lists', overlap: null }],
  });

  assert.equal(added.idx, 1);
  assert.equal(added.id, 'kw-0002');
  assert.equal(added.status, 'pending');
  assert.deepEqual(added.sources, [
    { type: 'surfer_related', parentKeyword: 'compare lists', overlap: null },
  ]);

  const after = store.loadKeywords('run-1');
  assert.equal(after.length, 2);
  assert.equal(after[1]!.keyword, 'list comparison tool');
  store.close();
});

test('addKeyword keeps sequential idx across multiple appends', () => {
  const store = makeStore();
  store.addKeyword('run-1', {
    keyword: 'a',
    normalizedKeyword: 'a',
    sources: [{ type: 'surfer_related', parentKeyword: 'compare lists', overlap: null }],
  });
  const second = store.addKeyword('run-1', {
    keyword: 'b',
    normalizedKeyword: 'b',
    sources: [{ type: 'surfer_related', parentKeyword: 'compare lists', overlap: null }],
  });
  assert.equal(second.idx, 2);
  assert.equal(second.id, 'kw-0003');
  store.close();
});
