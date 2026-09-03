import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchError } from '../shared/errors.js';
import { readResearchContainer } from './batches.js';

function container(currentRunId: string, resultRunId: string) {
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
        resultRunId,
      },
    ],
  };
}

async function writeContainer(researchDirectory: string, value: unknown): Promise<void> {
  await writeFile(join(researchDirectory, 'research.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('research container accepts a current run matching the latest durable batch result', async () => {
  const researchDirectory = await mkdtemp(join(tmpdir(), 'research-container-head-current-'));
  await writeContainer(researchDirectory, container('run-current', 'run-current'));

  const loaded = await readResearchContainer(researchDirectory);
  assert.equal(loaded?.currentRunId, 'run-current');
  assert.equal(loaded?.batches[0]?.resultRunId, 'run-current');
});

test('research container rejects a stale currentRunId instead of rolling lineage back to an older generation', async () => {
  const researchDirectory = await mkdtemp(join(tmpdir(), 'research-container-head-stale-'));
  await writeContainer(researchDirectory, container('run-old', 'run-current'));

  await assert.rejects(
    () => readResearchContainer(researchDirectory),
    (error: unknown) =>
      error instanceof ResearchError
      && error.code === 'OUTPUT_WRITE_ERROR'
      && /current run run-old does not match latest batch result run-current/.test(error.message),
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
