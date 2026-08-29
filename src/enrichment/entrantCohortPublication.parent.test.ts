import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishEntrantCohortMetadata } from './entrantCohortPublication.js';

const SUMMARY = {
  changed: true,
  version: '1.0.0',
  representativeRevision: 2,
  serpTopN: 10,
  finalistClusterCount: 1,
  uniqueDomainCount: 1,
  observedOccurrenceCount: 2,
  excludedOccurrenceCount: 0,
  weakDomainCount: 1,
  knownDrDomainCount: 1,
  repeatedDomainCount: 1,
  survivorshipWarning: 'observed winners only',
  drThresholds: {
    veryWeakMax: 10,
    weakMax: 30,
    strongMin: 60,
    strongMax: 75,
  },
};

async function writePublication(directory: string, manifestRevision: number, statusRevision: number): Promise<void> {
  const artifacts = ['representative-queries.csv', 'representative-queries.json', 'manifest.json', 'status.json'];
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    state: 'completed',
    artifacts,
    representativeQueries: { revision: manifestRevision },
  }));
  await writeFile(join(directory, 'status.json'), JSON.stringify({
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    status: 'completed',
    artifacts,
    representativeQueries: { revision: statusRevision },
  }));
}

test('entrant publication rejects stale manifest representative revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'entrant-parent-manifest-'));
  try {
    await writePublication(directory, 1, 2);
    await assert.rejects(
      publishEntrantCohortMetadata({
        enrichmentDirectory: directory,
        enrichmentId: 'enr-1',
        sourceRunId: 'source-1',
        summary: SUMMARY,
      }),
      /manifest\.json representative revision 1 does not match entrant cohort revision 2/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('entrant publication rejects stale status representative revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'entrant-parent-status-'));
  try {
    await writePublication(directory, 2, 1);
    await assert.rejects(
      publishEntrantCohortMetadata({
        enrichmentDirectory: directory,
        enrichmentId: 'enr-1',
        sourceRunId: 'source-1',
        summary: SUMMARY,
      }),
      /status\.json representative revision 1 does not match entrant cohort revision 2/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
