import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readResearchContainer } from './batches.js';

test('legacy V1 research batches without promotion accounting remain readable', async () => {
  const researchDirectory = await mkdtemp(join(tmpdir(), 'research-batch-v1-compat-'));
  await writeFile(join(researchDirectory, 'research.json'), `${JSON.stringify({
    version: 1,
    researchId: 'run_legacy_batch',
    label: 'legacy-batch-fixture',
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T01:00:00.000Z',
    currentRunId: 'run_legacy_batch',
    batches: [{
      batchId: 'batch-0001',
      createdAt: '2026-08-30T00:00:00.000Z',
      input: {
        kind: 'seeds',
        originalPath: 'legacy.csv',
        storedPath: null,
      },
      sourceRowCount: 1,
      inputUniqueKeywordCount: 1,
      addedKeywordCount: 1,
      duplicateKeywordCount: 0,
      normalizedKeywords: ['json formatter'],
      newNormalizedKeywords: ['json formatter'],
      resultRunId: 'run_legacy_batch',
    }],
  }, null, 2)}\n`, 'utf8');

  const container = await readResearchContainer(researchDirectory);
  assert.ok(container);
  assert.equal(container.version, 1);
  assert.equal(container.batches.length, 1);
  assert.equal(container.batches[0]?.promotedKeywordCount, undefined);
  assert.equal(container.batches[0]?.promotedNormalizedKeywords, undefined);
});
