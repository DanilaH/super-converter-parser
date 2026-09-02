import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ResearchError } from '../shared/errors.js';
import { acquireEnrichmentExecutionLock } from './executionLock.js';

test('enrichment execution lock rejects concurrent work for the same generation and is reusable after release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'enrichment-execution-lock-'));
  const enrichmentDirectory = join(root, 'enrichment-1');
  const releaseFirst = await acquireEnrichmentExecutionLock(enrichmentDirectory, 'enrichment-1');
  try {
    await assert.rejects(
      acquireEnrichmentExecutionLock(enrichmentDirectory, 'enrichment-1'),
      (error: unknown) => error instanceof ResearchError
        && error.code === 'OUTPUT_WRITE_ERROR'
        && /already running/i.test(error.message),
    );
  } finally {
    await releaseFirst();
  }

  const releaseSecond = await acquireEnrichmentExecutionLock(enrichmentDirectory, 'enrichment-1');
  await releaseSecond();
});

test('enrichment execution locks are scoped by generation directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'enrichment-execution-lock-scope-'));
  const releaseA = await acquireEnrichmentExecutionLock(join(root, 'enrichment-a'), 'enrichment-a');
  const releaseB = await acquireEnrichmentExecutionLock(join(root, 'enrichment-b'), 'enrichment-b');
  await releaseB();
  await releaseA();
});

test('acquiring an enrichment execution lock does not materialize the enrichment directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'enrichment-execution-lock-no-materialize-'));
  const enrichmentDirectory = join(root, 'missing-enrichment');
  const release = await acquireEnrichmentExecutionLock(enrichmentDirectory, 'enrichment-1');
  try {
    await assert.rejects(access(enrichmentDirectory));
  } finally {
    await release();
  }
});
