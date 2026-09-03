import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import type { SerpResult } from '../google/serp.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import {
  allocateResearchLocation,
  resolveRunLocation,
  writeRunIndex,
} from '../outputs/researchLayout.js';
import { withCurrentExpansionAdmission } from '../runs/expansionRuntime.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { prepareResearchAppend, readResearchContainer } from './batches.js';

const INITIAL_RUN_ID = 'run_promotion_initial';

test('append promotes an expansion-only keyword to an explicit pending root in a new generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-batch-promotion-'));
  const initialInput = join(root, 'initial.csv');
  await writeFile(initialInput, 'keyword\njson formatter\n', 'utf8');
  const location = await allocateResearchLocation(
    root,
    'Expansion Promotion',
    new Date('2026-09-03T00:00:00.000Z'),
  );
  const baseConfig = loadConfig({});
  const store = RunStore.open(join(location.discoveryDirectory, 'run.sqlite'));
  store.createRun({
    runId: INITIAL_RUN_ID,
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
      keyword: 'json formatter',
      normalizedKeyword: 'json formatter',
      sourceRows: [2],
    }],
  });

  const rootKeyword = store.loadKeyword(INITIAL_RUN_ID, 0);
  assert.ok(rootKeyword);
  store.commitKeyword(
    INITIAL_RUN_ID,
    { ...rootKeyword, status: 'completed', collectedAt: '2026-09-03T00:01:00.000Z' },
    [],
    'miss',
  );

  const child = store.addKeyword(INITIAL_RUN_ID, {
    keyword: 'json diff',
    normalizedKeyword: 'json diff',
    sources: [{ type: 'surfer_related', parentKeyword: 'json formatter', overlap: 73 }],
  });
  const childSerp: SerpResult = {
    keyword: 'json diff',
    keywordIdx: child.idx,
    position: 1,
    title: 'JSON Diff Tool',
    url: 'https://example.com/json-diff',
    hostname: 'example.com',
    registrableDomain: 'example.com',
    dr: 12,
    drStatus: 'ok',
    drError: null,
    resultType: 'organic',
  };
  store.commitKeyword(
    INITIAL_RUN_ID,
    { ...child, status: 'completed', collectedAt: '2026-09-03T00:02:00.000Z' },
    [childSerp],
    'miss',
  );
  store.recordRelatedKeywords(
    INITIAL_RUN_ID,
    0,
    'json formatter',
    {
      status: 'ok',
      error: null,
      rows: [{ keyword: 'json diff', overlap: 73, volume: 800 }],
    },
    new Set(['json diff']),
  );
  store.recordDomains(
    INITIAL_RUN_ID,
    child.idx,
    child.keyword,
    [childSerp],
    new Map([['example.com', { source: 'fresh' as const, fetchedAt: '2026-09-03T00:02:00.000Z' }]]),
  );
  store.incrementLookups(INITIAL_RUN_ID);
  store.incrementLookups(INITIAL_RUN_ID);
  store.setRunState(INITIAL_RUN_ID, 'completed');
  store.close();

  await writeRunIndex(root, {
    version: 1,
    runId: INITIAL_RUN_ID,
    researchDirectory: location.researchDirectory,
    discoveryDirectory: location.discoveryDirectory,
  });

  const appendInput = join(root, 'append.csv');
  await writeFile(appendInput, 'keyword\njson diff\n', 'utf8');
  const result = await prepareResearchAppend({
    outputRoot: root,
    targetRunId: INITIAL_RUN_ID,
    seedsPath: appendInput,
    seeds: [{ keyword: 'json diff', normalizedKeyword: 'json diff', sourceRows: [2] }],
    now: () => new Date('2026-09-03T01:00:00.000Z'),
  });

  assert.equal(result.changed, true);
  assert.equal(result.addedKeywordCount, 0);
  assert.equal(result.duplicateKeywordCount, 1);
  assert.notEqual(result.currentRunId, INITIAL_RUN_ID);

  const currentLocation = await resolveRunLocation(root, result.currentRunId);
  const promotedStore = RunStore.openReadOnly(join(currentLocation.discoveryDirectory, 'run.sqlite'));
  try {
    const run = promotedStore.loadRun(result.currentRunId);
    assert.ok(run);
    assert.equal(run.state, 'created');
    assert.equal((run.configSnapshot.expansion as { admissionVersion?: string }).admissionVersion, 'v1');

    const keywords = promotedStore.loadKeywords(result.currentRunId);
    assert.deepEqual(
      keywords.map((keyword) => [keyword.normalizedKeyword, keyword.status]),
      [
        ['json formatter', 'completed'],
        ['json diff', 'pending'],
      ],
    );
    assert.deepEqual(keywords[1]?.sources, [{
      type: 'seed',
      rowNumbers: [2],
      batchId: 'batch-0002',
      inputPath: 'batches/batch-0002.csv',
    }]);

    assert.equal(promotedStore.loadSerpRows(result.currentRunId).length, 0);
    assert.equal(promotedStore.loadDomains(result.currentRunId).length, 0);
    const related = promotedStore.loadRelatedKeywords(result.currentRunId);
    assert.equal(related.length, 1);
    assert.equal(related[0]?.parentIdx, 0);
    assert.equal(related[0]?.relatedKeyword, 'json diff');
    assert.equal(related[0]?.selectedForExpansion, false);
  } finally {
    promotedStore.close();
  }

  const originalStore = RunStore.openReadOnly(join(location.discoveryDirectory, 'run.sqlite'));
  try {
    const originalChild = originalStore.loadKeyword(INITIAL_RUN_ID, child.idx);
    assert.ok(originalChild);
    assert.equal(originalChild.status, 'completed');
    assert.equal(originalChild.sources[0]?.type, 'surfer_related');
    assert.equal(originalStore.loadSerpRows(INITIAL_RUN_ID).length, 1);
  } finally {
    originalStore.close();
  }

  const container = await readResearchContainer(location.researchDirectory);
  assert.ok(container);
  assert.equal(container.currentRunId, result.currentRunId);
  assert.equal(container.batches.length, 2);
  assert.equal(container.batches[1]?.addedKeywordCount, 0);
  assert.equal(container.batches[1]?.duplicateKeywordCount, 1);
  assert.deepEqual(container.batches[1]?.newNormalizedKeywords, []);
});
