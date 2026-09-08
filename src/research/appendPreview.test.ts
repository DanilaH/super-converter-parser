import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { allocateResearchLocation, writeRunIndex } from '../outputs/researchLayout.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { previewResearchAppend } from './appendPreview.js';
import { prepareResearchAppend, RESEARCH_CONTAINER_FILE, type ResearchContainer } from './batches.js';

const RUN_ID = 'run_append_preview';

test('read-only append preview matches authoritative commit classification for new, known, and promoted roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-append-preview-'));
  try {
    const location = await allocateResearchLocation(root, 'Append Preview', new Date('2026-09-08T00:00:00.000Z'));
    const initialInput = join(root, 'initial.csv');
    await writeFile(initialInput, 'keyword\njson formatter\n', 'utf8');

    const store = RunStore.open(join(location.discoveryDirectory, 'run.sqlite'));
    const config = loadConfig({});
    store.createRun({
      runId: RUN_ID,
      configSnapshot: config,
      parserVersions: { surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION },
      input: { kind: 'seeds', path: initialInput },
      keywords: [{ keyword: 'json formatter', normalizedKeyword: 'json formatter', sourceRows: [2] }],
    });
    const rootKeyword = store.loadKeyword(RUN_ID, 0);
    assert.ok(rootKeyword);
    store.commitKeyword(RUN_ID, { ...rootKeyword, status: 'completed', collectedAt: '2026-09-08T00:01:00.000Z' }, [], 'miss');
    const child = store.addKeyword(RUN_ID, {
      keyword: 'json diff',
      normalizedKeyword: 'json diff',
      sources: [{ type: 'surfer_related', parentKeyword: 'json formatter', overlap: 70 }],
    });
    store.commitKeyword(RUN_ID, { ...child, status: 'completed', collectedAt: '2026-09-08T00:02:00.000Z' }, [], 'miss');
    store.setRunState(RUN_ID, 'completed');
    store.close();

    await writeRunIndex(root, {
      version: 1,
      runId: RUN_ID,
      researchDirectory: location.researchDirectory,
      discoveryDirectory: location.discoveryDirectory,
    });
    const container: ResearchContainer = {
      version: 1,
      researchId: RUN_ID,
      label: 'Append Preview',
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
      currentRunId: RUN_ID,
      batches: [{
        batchId: 'batch-0001',
        createdAt: '2026-09-08T00:00:00.000Z',
        input: { kind: 'seeds', originalPath: initialInput, storedPath: null },
        sourceRowCount: 1,
        inputUniqueKeywordCount: 1,
        addedKeywordCount: 1,
        duplicateKeywordCount: 0,
        promotedKeywordCount: 0,
        normalizedKeywords: ['json formatter'],
        newNormalizedKeywords: ['json formatter'],
        promotedNormalizedKeywords: [],
        resultRunId: RUN_ID,
      }],
    };
    await writeFile(join(location.researchDirectory, RESEARCH_CONTAINER_FILE), `${JSON.stringify(container, null, 2)}\n`, 'utf8');

    const seeds = [
      { keyword: 'json formatter', normalizedKeyword: 'json formatter', sourceRows: [2] },
      { keyword: 'json diff', normalizedKeyword: 'json diff', sourceRows: [3] },
      { keyword: 'yaml formatter', normalizedKeyword: 'yaml formatter', sourceRows: [4] },
    ];
    const preview = await previewResearchAppend({ outputRoot: root, targetRunId: RUN_ID, seeds });
    assert.equal(preview.researchId, RUN_ID);
    assert.equal(preview.currentRunId, RUN_ID);
    assert.equal(preview.batchId, 'batch-0002');
    assert.equal(preview.inputUniqueKeywordCount, 3);
    assert.equal(preview.addedKeywordCount, 1);
    assert.equal(preview.duplicateKeywordCount, 2);
    assert.equal(preview.promotedKeywordCount, 1);
    assert.deepEqual(preview.promotedNormalizedKeywords, ['json diff']);
    assert.equal(preview.changed, true);

    const appendInput = join(root, 'append.csv');
    await writeFile(appendInput, 'keyword\njson formatter\njson diff\nyaml formatter\n', 'utf8');
    const committed = await prepareResearchAppend({
      outputRoot: root,
      targetRunId: RUN_ID,
      seedsPath: appendInput,
      seeds,
      now: () => new Date('2026-09-08T01:00:00.000Z'),
    });
    assert.deepEqual(
      {
        batchId: committed.batchId,
        inputUniqueKeywordCount: committed.inputUniqueKeywordCount,
        addedKeywordCount: committed.addedKeywordCount,
        duplicateKeywordCount: committed.duplicateKeywordCount,
        promotedKeywordCount: committed.promotedKeywordCount,
        promotedNormalizedKeywords: committed.promotedNormalizedKeywords,
        changed: committed.changed,
      },
      {
        batchId: preview.batchId,
        inputUniqueKeywordCount: preview.inputUniqueKeywordCount,
        addedKeywordCount: preview.addedKeywordCount,
        duplicateKeywordCount: preview.duplicateKeywordCount,
        promotedKeywordCount: preview.promotedKeywordCount,
        promotedNormalizedKeywords: preview.promotedNormalizedKeywords,
        changed: preview.changed,
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('append preview fails closed when indexed research has no managed container', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-append-preview-unmanaged-'));
  try {
    const location = await allocateResearchLocation(root, 'Unmanaged', new Date('2026-09-08T00:00:00.000Z'));
    const store = RunStore.open(join(location.discoveryDirectory, 'run.sqlite'));
    const config = loadConfig({});
    store.createRun({
      runId: RUN_ID,
      configSnapshot: config,
      parserVersions: { surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION },
      input: { kind: 'seeds', path: 'input.csv' },
      keywords: [],
    });
    store.setRunState(RUN_ID, 'completed');
    store.close();
    await writeRunIndex(root, {
      version: 1,
      runId: RUN_ID,
      researchDirectory: location.researchDirectory,
      discoveryDirectory: location.discoveryDirectory,
    });

    await assert.rejects(
      () => previewResearchAppend({
        outputRoot: root,
        targetRunId: RUN_ID,
        seeds: [{ keyword: 'alpha', normalizedKeyword: 'alpha', sourceRows: [2] }],
      }),
      /no managed research container/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
