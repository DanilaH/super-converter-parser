import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { acquireResearchExecutionLock } from '../operatorConfig/executionLock.js';
import { allocateResearchLocation, writeRunIndex } from '../outputs/researchLayout.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { ResearchError } from '../shared/errors.js';
import { acquireResearchAppendLock } from './appendLock.js';
import { RESEARCH_CONTAINER_FILE } from './batches.js';

const RUN_ID = 'append_lock_initial';

test('append lock serializes with config execution lock and releases cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-append-lock-'));
  const location = await allocateResearchLocation(root, 'Append Lock', new Date('2026-09-03T00:00:00.000Z'));
  const store = RunStore.open(join(location.discoveryDirectory, 'run.sqlite'));
  store.createRun({
    runId: RUN_ID,
    configSnapshot: loadConfig({}),
    parserVersions: { surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION },
    input: { kind: 'seeds', path: join(root, 'input.csv') },
    keywords: [{ keyword: 'json formatter', normalizedKeyword: 'json formatter', sourceRows: [2] }],
  });
  store.setRunState(RUN_ID, 'completed');
  store.close();
  await writeRunIndex(root, {
    version: 1,
    runId: RUN_ID,
    researchDirectory: location.researchDirectory,
    discoveryDirectory: location.discoveryDirectory,
  });

  const releaseConfig = await acquireResearchExecutionLock(root, RUN_ID);
  await assert.rejects(
    () => acquireResearchAppendLock(root, RUN_ID),
    (error: unknown) =>
      error instanceof ResearchError
      && error.code === 'OUTPUT_WRITE_ERROR'
      && error.message.includes('config-driven execution'),
  );
  await releaseConfig();

  const appendLock = await acquireResearchAppendLock(root, RUN_ID);
  assert.equal(appendLock.researchId, RUN_ID);
  assert.equal(appendLock.researchDirectory, location.researchDirectory);
  await assert.rejects(
    () => acquireResearchExecutionLock(root, RUN_ID),
    (error: unknown) =>
      error instanceof ResearchError
      && error.code === 'OUTPUT_WRITE_ERROR'
      && error.message.includes('config-driven execution'),
  );
  await appendLock.release();
  await appendLock.release();

  const releaseConfigAgain = await acquireResearchExecutionLock(root, RUN_ID);
  await releaseConfigAgain();
});

test('append through a generated run id resolves the stable research execution identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-append-stable-lock-'));
  const location = await allocateResearchLocation(root, 'Stable Append Lock', new Date('2026-09-03T00:00:00.000Z'));
  const generatedRunId = 'append_lock_generated';
  const generatedDiscovery = join(location.researchDirectory, 'discovery-02');
  await mkdir(generatedDiscovery);
  const store = RunStore.open(join(generatedDiscovery, 'run.sqlite'));
  store.createRun({
    runId: generatedRunId,
    configSnapshot: loadConfig({}),
    parserVersions: { surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION },
    input: { kind: 'seeds', path: join(root, 'input.csv') },
    keywords: [],
  });
  store.setRunState(generatedRunId, 'completed');
  store.close();
  await writeRunIndex(root, {
    version: 1,
    runId: generatedRunId,
    researchDirectory: location.researchDirectory,
    discoveryDirectory: generatedDiscovery,
  });
  await writeFile(join(location.researchDirectory, RESEARCH_CONTAINER_FILE), `${JSON.stringify({
    version: 1,
    researchId: RUN_ID,
    label: 'Stable Append Lock',
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:01:00.000Z',
    currentRunId: generatedRunId,
    batches: [
      {
        batchId: 'batch-0001',
        createdAt: '2026-09-03T00:00:00.000Z',
        input: { kind: 'seeds', originalPath: 'initial.csv', storedPath: null },
        sourceRowCount: 0,
        inputUniqueKeywordCount: 0,
        addedKeywordCount: 0,
        duplicateKeywordCount: 0,
        normalizedKeywords: [],
        newNormalizedKeywords: [],
        resultRunId: RUN_ID,
      },
      {
        batchId: 'batch-0002',
        createdAt: '2026-09-03T00:01:00.000Z',
        input: { kind: 'seeds', originalPath: 'append.csv', storedPath: null },
        sourceRowCount: 0,
        inputUniqueKeywordCount: 0,
        addedKeywordCount: 0,
        duplicateKeywordCount: 0,
        normalizedKeywords: [],
        newNormalizedKeywords: [],
        resultRunId: generatedRunId,
      },
    ],
  }, null, 2)}\n`, 'utf8');

  const releaseConfig = await acquireResearchExecutionLock(root, RUN_ID);
  await assert.rejects(
    () => acquireResearchAppendLock(root, generatedRunId),
    (error: unknown) =>
      error instanceof ResearchError
      && error.code === 'OUTPUT_WRITE_ERROR'
      && error.message.includes(`research ${RUN_ID}`),
  );
  await releaseConfig();

  const appendLock = await acquireResearchAppendLock(root, generatedRunId);
  assert.equal(appendLock.researchId, RUN_ID);
  await appendLock.release();
});
