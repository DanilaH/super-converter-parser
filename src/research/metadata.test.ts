import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RESEARCH_CONTAINER_FILE, type ResearchContainer } from './batches.js';
import { updateResearchDisplayLabel } from './metadata.js';

const container: ResearchContainer = {
  version: 1,
  researchId: 'research-1',
  label: 'Old label',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  currentRunId: 'run-2',
  batches: [
    {
      batchId: 'batch-0001',
      createdAt: '2026-09-01T00:00:00.000Z',
      input: { kind: 'seeds', originalPath: '/input/one.csv', storedPath: null },
      sourceRowCount: 2,
      inputUniqueKeywordCount: 2,
      addedKeywordCount: 2,
      duplicateKeywordCount: 0,
      promotedKeywordCount: 0,
      normalizedKeywords: ['alpha', 'beta'],
      newNormalizedKeywords: ['alpha', 'beta'],
      promotedNormalizedKeywords: [],
      resultRunId: 'research-1',
    },
    {
      batchId: 'batch-0002',
      createdAt: '2026-09-02T00:00:00.000Z',
      input: { kind: 'seeds', originalPath: '/input/two.csv', storedPath: 'batches/batch-0002.csv' },
      sourceRowCount: 1,
      inputUniqueKeywordCount: 1,
      addedKeywordCount: 1,
      duplicateKeywordCount: 0,
      promotedKeywordCount: 0,
      normalizedKeywords: ['gamma'],
      newNormalizedKeywords: ['gamma'],
      promotedNormalizedKeywords: [],
      resultRunId: 'run-2',
    },
  ],
};

test('display label update changes only label and updatedAt in the managed container', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-label-'));
  try {
    await writeFile(join(directory, RESEARCH_CONTAINER_FILE), `${JSON.stringify(container, null, 2)}\n`, 'utf8');
    const result = await updateResearchDisplayLabel(directory, 'New label', new Date('2026-09-08T12:00:00.000Z'));
    assert.equal(result.changed, true);
    assert.equal(result.previousLabel, 'Old label');
    assert.equal(result.label, 'New label');
    assert.equal(result.researchId, 'research-1');

    const persisted = JSON.parse(await readFile(join(directory, RESEARCH_CONTAINER_FILE), 'utf8')) as ResearchContainer;
    assert.deepEqual(persisted, {
      ...container,
      label: 'New label',
      updatedAt: '2026-09-08T12:00:00.000Z',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('idempotent display label update does not rewrite updatedAt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-label-idempotent-'));
  try {
    const original = `${JSON.stringify(container, null, 2)}\n`;
    await writeFile(join(directory, RESEARCH_CONTAINER_FILE), original, 'utf8');
    const result = await updateResearchDisplayLabel(directory, 'Old label', new Date('2030-01-01T00:00:00.000Z'));
    assert.equal(result.changed, false);
    assert.equal(result.updatedAt, container.updatedAt);
    assert.equal(await readFile(join(directory, RESEARCH_CONTAINER_FILE), 'utf8'), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
