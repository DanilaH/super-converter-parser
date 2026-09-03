import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import { materializeExpansionFrontier } from './expansionFrontier.js';

function createStore(seedKeywords: string[]): { store: RunStore; runId: string } {
  const store = RunStore.openInMemory();
  const runId = 'expansion-frontier-test';
  store.createRun({
    runId,
    configSnapshot: loadConfig({}),
    parserVersions: { surfer: 'test', google: 'test' },
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: buildSeedKeywords(seedKeywords.map((keyword, index) => ({ keyword, rowNumber: index + 1 }))),
  });
  return { store, runId };
}

function recordRelated(
  store: RunStore,
  runId: string,
  parentIdx: number,
  parentKeyword: string,
  rows: Array<{ keyword: string; overlap: number | null; volume: number | null }>,
): void {
  store.recordRelatedKeywords(
    runId,
    parentIdx,
    parentKeyword,
    { status: 'ok', error: null, rows },
    new Set(),
  );
}

test('frontier rejects generic single-token heads, enforces the global budget, and is idempotent', async () => {
  const originals = Array.from({ length: 20 }, (_, index) => `seed utility ${index}`);
  const { store, runId } = createStore(originals);
  const runDirectory = await mkdtemp(join(tmpdir(), 'expansion-frontier-'));
  const config = {
    ...loadConfig({}),
    expansion: { ...loadConfig({}).expansion, enabled: true },
  };

  for (let parentIdx = 0; parentIdx < originals.length; parentIdx += 1) {
    const rows = [
      { keyword: 'sheets', overlap: 100, volume: 1_000_000 },
      { keyword: `specific utility candidate ${parentIdx}`, overlap: 80, volume: 10_000 - parentIdx },
    ];
    if (parentIdx < 10) {
      rows.push({
        keyword: `second utility candidate ${parentIdx}`,
        overlap: 70,
        volume: 5_000 - parentIdx,
      });
    }
    recordRelated(store, runId, parentIdx, originals[parentIdx]!, rows);
  }

  const first = await materializeExpansionFrontier({ store, runId, runDirectory, config });
  assert.equal(first.admission.budget, 25);
  assert.equal(first.addedKeywords.length, 25);
  assert.ok(!store.loadKeywords(runId).some((keyword) => keyword.normalizedKeyword === 'sheets'));
  assert.equal(
    store.loadRelatedKeywords(runId).filter((row) => row.selectedForExpansion).length >= 25,
    true,
  );

  const second = await materializeExpansionFrontier({ store, runId, runDirectory, config });
  assert.equal(second.committedBeforeCount, 25);
  assert.equal(second.addedKeywords.length, 0);
  assert.equal(
    store.loadKeywords(runId).filter((keyword) => keyword.sources.some((source) => source.type === 'surfer_related')).length,
    25,
  );

  const report = JSON.parse(await readFile(join(runDirectory, 'expansion-admission.json'), 'utf8')) as {
    budget: number;
    finalSelectedCount: number;
    decisions: Array<{ normalizedKeyword: string; selectedFinal: boolean; reason: string }>;
  };
  assert.equal(report.budget, 25);
  assert.equal(report.finalSelectedCount, 25);
  const sheets = report.decisions.find((decision) => decision.normalizedKeyword === 'sheets');
  assert.equal(sheets?.selectedFinal, false);
  assert.equal(sheets?.reason, 'single_token');
  store.close();
});

test('frontier preserves committed expansion and only fills remaining budget slots', async () => {
  const originals = ['alpha utility seed', 'beta utility seed'];
  const { store, runId } = createStore(originals);
  const runDirectory = await mkdtemp(join(tmpdir(), 'expansion-frontier-monotonic-'));
  const config = {
    ...loadConfig({}),
    expansion: { ...loadConfig({}).expansion, enabled: true },
  };

  store.addKeyword(runId, {
    keyword: 'committed old utility',
    normalizedKeyword: 'committed old utility',
    sources: [{ type: 'surfer_related', parentKeyword: originals[0]!, overlap: 1 }],
  });
  recordRelated(store, runId, 0, originals[0]!, [
    { keyword: 'new best utility', overlap: 100, volume: 100_000 },
    { keyword: 'new second utility', overlap: 90, volume: 90_000 },
  ]);
  recordRelated(store, runId, 1, originals[1]!, [
    { keyword: 'new third utility', overlap: 80, volume: 80_000 },
  ]);

  const result = await materializeExpansionFrontier({ store, runId, runDirectory, config });
  assert.equal(result.admission.budget, 3);
  assert.equal(result.committedBeforeCount, 1);
  assert.equal(result.addedKeywords.length, 2);

  const expanded = store.loadKeywords(runId)
    .filter((keyword) => keyword.sources.some((source) => source.type === 'surfer_related'))
    .map((keyword) => keyword.normalizedKeyword);
  assert.equal(expanded.length, 3);
  assert.ok(expanded.includes('committed old utility'));
  assert.ok(expanded.includes('new best utility'));
  assert.ok(expanded.includes('new second utility'));
  assert.ok(!expanded.includes('new third utility'));
  store.close();
});
