import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchError } from '../shared/errors.js';
import { readResearchContainer } from './batches.js';

function container(currentRunId: string, latestResultRunId: string) {
  return {
    version: 1,
    researchId: 'run-initial',
    label: 'Container head test',
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T01:00:00.000Z',
    currentRunId,
    batches: [
      {
        batchId: 'batch-0001',
        createdAt: '2026-09-03T00:00:00.000Z',
        input: { kind: 'seeds', originalPath: 'initial.csv', storedPath: null },
        sourceRowCount: 1,
        inputUniqueKeywordCount: 1,
        addedKeywordCount: 1,
        duplicateKeywordCount: 0,
        normalizedKeywords: ['json formatter'],
        newNormalizedKeywords: ['json formatter'],
        resultRunId: 'run-initial',
      },
      {
        batchId: 'batch-0002',
        createdAt: '2026-09-03T01:00:00.000Z',
        input: { kind: 'seeds', originalPath: 'append.csv', storedPath: null },
        sourceRowCount: 1,
        inputUniqueKeywordCount: 1,
        addedKeywordCount: 1,
        duplicateKeywordCount: 0,
        normalizedKeywords: ['xml formatter'],
        newNormalizedKeywords: ['xml formatter'],
        resultRunId: latestResultRunId,
      },
    ],
  };
}

async function writeContainer(researchDirectory: string, value: unknown): Promise<void> {
  await writeFile(join(researchDirectory, 'research.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('research container accepts stable initial identity and a current run matching the latest batch result', async () => {
  const researchDirectory = await mkdtemp(join(tmpdir(), 'research-container-head-current-'));
  await writeContainer(researchDirectory, container('run-current', 'run-current'));

  const loaded = await readResearchContainer(researchDirectory);
  assert.equal(loaded?.researchId, 'run-initial');
  assert.equal(loaded?.currentRunId, 'run-current');
  assert.equal(loaded?.batches[0]?.resultRunId, 'run-initial');
  assert.equal(loaded?.batches[1]?.resultRunId, 'run-current');
});

test('research container rejects a changed stable research id instead of changing execution-lock identity', async () => {
  const researchDirectory = await mkdtemp(join(tmpdir(), 'research-container-id-stale-'));
  const value = container('run-current', 'run-current');
  value.researchId = 'run-spoofed';
  await writeContainer(researchDirectory, value);

  await assert.rejects(
    () => readResearchContainer(researchDirectory),
    (error: unknown) =>
      error instanceof ResearchError
      && error.code === 'OUTPUT_WRITE_ERROR'
      && /Research ID run-spoofed does not match initial batch result run-initial/.test(error.message),
  );
});

test('research container rejects a stale currentRunId instead of rolling lineage back to an older generation', async () => {
  const researchDirectory = await mkdtemp(join(tmpdir(), 'research-container-head-stale-'));
  await writeContainer(researchDirectory, container('run-initial', 'run-current'));

  await assert.rejects(
    () => readResearchContainer(researchDirectory),
    (error: unknown) =>
      error instanceof ResearchError
      && error.code === 'OUTPUT_WRITE_ERROR'
      && /current run run-initial does not match latest batch result run-current/.test(error.message),
  );
});

test('research container rejects an empty batch ledger because it cannot establish a current generation', async () => {
  const researchDirectory = await mkdtemp(join(tmpdir(), 'research-container-head-empty-'));
  const value = container('run-current', 'run-current');
  value.batches = [];
  await writeContainer(researchDirectory, value);

  await assert.rejects(
    () => readResearchContainer(researchDirectory),
    (error: unknown) =>
      error instanceof ResearchError
      && error.code === 'OUTPUT_WRITE_ERROR'
      && /has no valid latest batch result/.test(error.message),
  );
});
