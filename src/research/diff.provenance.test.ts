import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import type { SerpResult } from '../google/serp.js';
import {
  allocateResearchLocation,
  resolveRunLocation,
  writeRunIndex,
} from '../outputs/researchLayout.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { renderResearchGenerationDiff } from '../cli/researchDiff.js';
import { prepareResearchAppend } from './batches.js';
import { buildResearchGenerationDiff } from './diff.js';

const INITIAL_RUN_ID = 'run_diff_provenance_initial';

function completeKeyword(store: RunStore, runId: string, idx: number): void {
  const keyword = store.loadKeyword(runId, idx);
  assert.ok(keyword);
  store.commitKeyword(
    runId,
    {
      ...keyword,
      status: 'completed',
      surfer: {
        volume: 100,
        cpc: 1,
        market: 'US',
        fetchedAt: '2026-09-03T00:00:00.000Z',
      },
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: `https://google.com/search?q=${idx}`,
        detectedLocation: null,
        geoWarning: false,
        serpStatus: 'empty',
        serpError: null,
      },
      error: null,
      collectedAt: '2026-09-03T00:00:00.000Z',
    },
    [] as SerpResult[],
    'miss',
  );
}

test('discovery diff exposes expansion-child promotion even when keyword/status/coverage are unchanged', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'research-diff-provenance-'));
  const inputPath = join(outputRoot, 'initial.csv');
  await writeFile(inputPath, 'keyword\nalpha tool\n', 'utf8');
  const location = await allocateResearchLocation(
    outputRoot,
    'Diff Provenance Fixture',
    new Date('2026-09-03T00:00:00.000Z'),
  );
  const store = RunStore.open(join(location.discoveryDirectory, 'run.sqlite'));
  store.createRun({
    runId: INITIAL_RUN_ID,
    configSnapshot: loadConfig({}),
    parserVersions: {
      surfer: SURFER_PARSER_VERSION,
      google: GOOGLE_PARSER_VERSION,
    },
    input: { kind: 'seeds', path: inputPath },
    keywords: [{
      keyword: 'alpha tool',
      normalizedKeyword: 'alpha tool',
      sourceRows: [2],
    }],
  });
  completeKeyword(store, INITIAL_RUN_ID, 0);
  const child = store.addKeyword(INITIAL_RUN_ID, {
    keyword: 'alpha checker',
    normalizedKeyword: 'alpha checker',
    sources: [{
      type: 'surfer_related',
      parentKeyword: 'alpha tool',
      overlap: 70,
    }],
  });
  completeKeyword(store, INITIAL_RUN_ID, child.idx);
  store.recordRelatedKeywords(
    INITIAL_RUN_ID,
    0,
    'alpha tool',
    {
      status: 'ok',
      error: null,
      rows: [{ keyword: 'alpha checker', overlap: 70, volume: 500 }],
    },
    new Set(['alpha checker']),
  );
  store.setRunState(INITIAL_RUN_ID, 'completed');
  store.close();

  await writeRunIndex(outputRoot, {
    version: 1,
    runId: INITIAL_RUN_ID,
    researchDirectory: location.researchDirectory,
    discoveryDirectory: location.discoveryDirectory,
  });

  const appendPath = join(outputRoot, 'append.csv');
  await writeFile(appendPath, 'keyword\nalpha checker\n', 'utf8');
  const append = await prepareResearchAppend({
    outputRoot,
    targetRunId: INITIAL_RUN_ID,
    seedsPath: appendPath,
    seeds: [{
      keyword: 'alpha checker',
      normalizedKeyword: 'alpha checker',
      sourceRows: [2],
    }],
    now: () => new Date('2026-09-03T01:00:00.000Z'),
  });
  assert.equal(append.changed, true);
  assert.equal(append.addedKeywordCount, 0);
  assert.equal(append.duplicateKeywordCount, 1);

  const current = await resolveRunLocation(outputRoot, append.currentRunId);
  const promotedStore = RunStore.open(join(current.discoveryDirectory, 'run.sqlite'));
  try {
    const promoted = promotedStore.loadKeywords(append.currentRunId)
      .find((keyword) => keyword.normalizedKeyword === 'alpha checker');
    assert.ok(promoted);
    assert.equal(promoted.status, 'pending');
    completeKeyword(promotedStore, append.currentRunId, promoted.idx);
    promotedStore.setRunState(append.currentRunId, 'completed');
  } finally {
    promotedStore.close();
  }

  const diff = await buildResearchGenerationDiff({
    outputRoot,
    targetRunId: INITIAL_RUN_ID,
    from: 'discovery:1',
    to: 'discovery:2',
  });

  assert.equal(diff.version, '1.1.0');
  assert.deepEqual(diff.discovery?.keywords.added, []);
  assert.deepEqual(diff.discovery?.keywords.removed, []);
  assert.deepEqual(diff.discovery?.keywords.statusChanges, []);
  assert.deepEqual(diff.discovery?.googleSerpCoverage, {
    from: { numerator: 2, denominator: 2, ratio: 1 },
    to: { numerator: 2, denominator: 2, ratio: 1 },
  });
  assert.deepEqual(diff.discovery?.keywords.provenanceChanges, [{
    normalizedKeyword: 'alpha checker',
    keyword: 'alpha checker',
    from: {
      role: 'depth_one_child',
      sourceTypes: ['surfer_related'],
      seedBatchIds: [],
      relatedParents: ['alpha tool'],
    },
    to: {
      role: 'root',
      sourceTypes: ['seed'],
      seedBatchIds: ['batch-0002'],
      relatedParents: [],
    },
  }]);

  const rendered = renderResearchGenerationDiff(diff);
  assert.match(rendered, /Provenance changes: 1/);
  assert.match(rendered, /alpha checker/);
  assert.match(rendered, /depth_one_child/);
  assert.match(rendered, /root/);
  assert.match(rendered, /batch-0002/);
});
