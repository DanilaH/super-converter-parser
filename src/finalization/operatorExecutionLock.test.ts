import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunStore } from '../db/store.js';
import { acquireResearchExecutionLock } from '../operatorConfig/executionLock.js';
import { writeEnrichmentIndex } from '../outputs/researchLayout.js';
import { acquireFinalizationOperatorExecutionLock } from './operatorExecutionLock.js';

test('direct finalization shares the config-first research execution lock', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'finalization-operator-lock-'));
  const researchDirectory = join(outputRoot, 'research');
  const enrichmentDirectory = join(researchDirectory, 'enrichment');
  const researchId = 'research-1';
  const enrichmentId = 'enrichment-1';
  await mkdir(enrichmentDirectory, { recursive: true });

  const store = RunStore.open(join(enrichmentDirectory, 'enrichment.sqlite'));
  try {
    store.createEnrichmentRun({
      enrichmentId,
      sourceRunId: researchId,
      modules: ['clusters'],
      config: JSON.stringify({}),
      sourceRunDirectory: join(researchDirectory, 'discovery'),
      enrichmentDirectory,
      shortlistKeywords: [],
    });
  } finally {
    store.close();
  }
  await writeEnrichmentIndex(outputRoot, {
    version: 1,
    enrichmentId,
    runId: researchId,
    researchDirectory,
    enrichmentDirectory,
  });

  const releaseConfigFirst = await acquireResearchExecutionLock(outputRoot, researchId);
  try {
    await assert.rejects(
      acquireFinalizationOperatorExecutionLock(outputRoot, enrichmentId),
      /already running/,
    );
  } finally {
    await releaseConfigFirst();
  }

  const releaseDirect = await acquireFinalizationOperatorExecutionLock(outputRoot, enrichmentId);
  await releaseDirect();
  const releaseAgain = await acquireFinalizationOperatorExecutionLock(outputRoot, enrichmentId);
  await releaseAgain();

  await rm(outputRoot, { recursive: true, force: true });
});
