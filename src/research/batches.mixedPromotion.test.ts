import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { GOOGLE_PARSER_VERSION, type SerpResult } from '../google/serp.js';
import {
  allocateResearchLocation,
  resolveRunLocation,
  writeRunIndex,
} from '../outputs/researchLayout.js';
import { withCurrentExpansionAdmission } from '../runs/expansionRuntime.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { prepareResearchAppend } from './batches.js';

const RESEARCH_ID = 'run_mixed_promotion_initial';

function completeKeyword(store: RunStore, runId: string, idx: number): void {
  const keyword = store.loadKeyword(runId, idx);
  assert.ok(keyword);
  store.commitKeyword(
    runId,
    {
      ...keyword,
      status: 'completed',
      collectedAt: '2026-09-03T00:05:00.000Z',
    },
    [] as SerpResult[],
    'miss',
  );
}

test('append promotes a historical mixed surfer_related + seed child using current engine role', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'research-mixed-promotion-'));
  const initialInput = join(outputRoot, 'initial.csv');
  await writeFile(initialInput, 'keyword\nalpha tool\n', 'utf8');
  const location = await allocateResearchLocation(
    outputRoot,
    'Mixed Promotion Fixture',
    new Date('2026-09-03T00:00:00.000Z'),
  );
  const baseConfig = loadConfig({});
  const store = RunStore.open(join(location.discoveryDirectory, 'run.sqlite'));
  store.createRun({
    runId: RESEARCH_ID,
    configSnapshot: {
      ...baseConfig,
      expansion: withCurrentExpansionAdmission(baseConfig.expansion),
    },
    parserVersions: {
      surfer: SURFER_PARSER_VERSION,
      google: GOOGLE_PARSER_VERSION,
    },
    input: { kind: 'seeds', path: initialInput },
    keywords: [{
      keyword: 'alpha tool',
      normalizedKeyword: 'alpha tool',
      sourceRows: [2],
    }],
  });
  completeKeyword(store, RESEARCH_ID, 0);
  const mixedChild = store.addKeyword(RESEARCH_ID, {
    keyword: 'alpha checker',
    normalizedKeyword: 'alpha checker',
    sources: [
      { type: 'surfer_related', parentKeyword: 'alpha tool', overlap: 70 },
      {
        type: 'seed',
        rowNumbers: [2],
        batchId: 'batch-0002',
        inputPath: 'batches/batch-0002.csv',
      },
    ],
  });
  completeKeyword(store, RESEARCH_ID, mixedChild.idx);
  store.recordRelatedKeywords(
    RESEARCH_ID,
    0,
    'alpha tool',
    {
      status: 'ok',
      error: null,
      rows: [{ keyword: 'alpha checker', overlap: 70, volume: 500 }],
    },
    new Set(['alpha checker']),
  );
  store.setRunState(RESEARCH_ID, 'completed');
  store.close();

  await writeRunIndex(outputRoot, {
    version: 1,
    runId: RESEARCH_ID,
    researchDirectory: location.researchDirectory,
    discoveryDirectory: location.discoveryDirectory,
  });
  await writeFile(join(location.researchDirectory, 'research.json'), `${JSON.stringify({
    version: 1,
    researchId: RESEARCH_ID,
    label: 'mixed-promotion-fixture',
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:10:00.000Z',
    currentRunId: RESEARCH_ID,
    batches: [
      {
        batchId: 'batch-0001',
        createdAt: '2026-09-03T00:00:00.000Z',
        input: { kind: 'seeds', originalPath: initialInput, storedPath: null },
        sourceRowCount: 1,
        inputUniqueKeywordCount: 1,
        addedKeywordCount: 1,
        duplicateKeywordCount: 0,
        normalizedKeywords: ['alpha tool'],
        newNormalizedKeywords: ['alpha tool'],
        resultRunId: RESEARCH_ID,
      },
      {
        batchId: 'batch-0002',
        createdAt: '2026-09-03T00:05:00.000Z',
        input: { kind: 'seeds', originalPath: 'historical.csv', storedPath: 'batches/batch-0002.csv' },
        sourceRowCount: 2,
        inputUniqueKeywordCount: 2,
        addedKeywordCount: 1,
        duplicateKeywordCount: 1,
        normalizedKeywords: ['alpha checker', 'historical new root'],
        newNormalizedKeywords: ['historical new root'],
        resultRunId: RESEARCH_ID,
      },
    ],
  }, null, 2)}\n`, 'utf8');

  const appendInput = join(outputRoot, 'append.csv');
  await writeFile(appendInput, 'keyword\nalpha checker\n', 'utf8');
  const result = await prepareResearchAppend({
    outputRoot,
    targetRunId: RESEARCH_ID,
    seedsPath: appendInput,
    seeds: [{
      keyword: 'alpha checker',
      normalizedKeyword: 'alpha checker',
      sourceRows: [2],
    }],
    now: () => new Date('2026-09-03T01:00:00.000Z'),
  });

  assert.equal(result.changed, true);
  assert.equal(result.addedKeywordCount, 0);
  assert.equal(result.duplicateKeywordCount, 1);
  assert.notEqual(result.currentRunId, RESEARCH_ID);

  const current = await resolveRunLocation(outputRoot, result.currentRunId);
  const promotedStore = RunStore.openReadOnly(join(current.discoveryDirectory, 'run.sqlite'));
  try {
    const promoted = promotedStore.loadKeywords(result.currentRunId)
      .find((keyword) => keyword.normalizedKeyword === 'alpha checker');
    assert.ok(promoted);
    assert.equal(promoted.status, 'pending');
    assert.deepEqual(promoted.sources, [{
      type: 'seed',
      rowNumbers: [2],
      batchId: 'batch-0003',
      inputPath: 'batches/batch-0003.csv',
    }]);
    const related = promotedStore.loadRelatedKeywords(result.currentRunId);
    assert.equal(related.length, 1);
    assert.equal(related[0]?.relatedKeyword, 'alpha checker');
    assert.equal(related[0]?.selectedForExpansion, false);
  } finally {
    promotedStore.close();
  }

  const originalStore = RunStore.openReadOnly(join(location.discoveryDirectory, 'run.sqlite'));
  try {
    const original = originalStore.loadKeyword(RESEARCH_ID, mixedChild.idx);
    assert.ok(original);
    assert.deepEqual(original.sources.map((source) => source.type), ['surfer_related', 'seed']);
    assert.equal(original.status, 'completed');
  } finally {
    originalStore.close();
  }
});
