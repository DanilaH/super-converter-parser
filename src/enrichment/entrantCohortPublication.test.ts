import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishEntrantCohortMetadata } from './entrantCohortPublication.js';

const SUMMARY = {
  changed: true,
  version: '1.0.0',
  representativeRevision: 2,
  serpTopN: 10,
  finalistClusterCount: 2,
  rankingOccurrenceCount: 30,
  excludedRankingOccurrenceCount: 1,
  clusterDomainMembershipCount: 14,
  globalUniqueDomainCount: 11,
  crossClusterDomainCount: 2,
  knownDrDomainMembershipCount: 10,
  weakDomainMembershipCount: 4,
  withinClusterRepeatedDomainMembershipCount: 5,
  survivorshipWarning: 'observed winners only',
  drThresholds: {
    veryWeakMax: 10,
    weakMax: 30,
    strongMin: 60,
    strongMax: 75,
  },
};

async function createPublication(directory: string): Promise<void> {
  const artifacts = [
    'keyword-clusters.csv',
    'representative-queries.csv',
    'manifest.json',
    'status.json',
  ];
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    modules: ['clusters'],
    config: { clusters: { algorithmVersion: '2.0.0' } },
    artifacts,
    state: 'completed',
    representativeQueries: { revision: 2 },
  }, null, 2) + '\n');
  await writeFile(join(directory, 'status.json'), JSON.stringify({
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    status: 'completed',
    modules: ['clusters'],
    artifacts,
    representativeQueries: { revision: 2 },
  }, null, 2) + '\n');
}

test('entrant publication adds all cohort artifacts without erasing representative metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'entrant-publication-'));
  try {
    await createPublication(directory);
    await publishEntrantCohortMetadata({
      enrichmentDirectory: directory,
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      summary: SUMMARY,
    });

    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
      artifacts: string[];
      representativeQueries: { revision: number };
      entrantCohort: typeof SUMMARY;
    };
    assert.equal(manifest.representativeQueries.revision, 2);
    assert.deepEqual(manifest.entrantCohort, SUMMARY);
    assert.equal(manifest.artifacts.includes('entrant-cohort.csv'), true);
    assert.equal(manifest.artifacts.includes('entrant-cohort-occurrences.csv'), true);
    assert.equal(manifest.artifacts.includes('entrant-cohort.json'), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('entrant publication is idempotent and does not duplicate artifact names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'entrant-publication-repeat-'));
  try {
    await createPublication(directory);
    const input = {
      enrichmentDirectory: directory,
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      summary: SUMMARY,
    };
    await publishEntrantCohortMetadata(input);
    await publishEntrantCohortMetadata(input);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
      artifacts: string[];
    };
    for (const artifact of ['entrant-cohort.csv', 'entrant-cohort-occurrences.csv', 'entrant-cohort.json']) {
      assert.equal(manifest.artifacts.filter((name) => name === artifact).length, 1);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('entrant publication refuses a mismatched source identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'entrant-publication-mismatch-'));
  try {
    await createPublication(directory);
    await assert.rejects(
      publishEntrantCohortMetadata({
        enrichmentDirectory: directory,
        enrichmentId: 'enr-1',
        sourceRunId: 'wrong-source',
        summary: SUMMARY,
      }),
      /does not belong to enrichment/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
