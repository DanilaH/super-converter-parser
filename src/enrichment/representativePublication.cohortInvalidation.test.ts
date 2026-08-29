import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENTRANT_COHORT_ARTIFACTS } from './entrantCohortPublication.js';
import { publishRepresentativeMetadata } from './representativePublication.js';

async function createPublication(directory: string, representativeRevision: number): Promise<void> {
  const artifacts = [
    'keyword-clusters.csv',
    'representative-queries.csv',
    'representative-queries.json',
    ...ENTRANT_COHORT_ARTIFACTS,
    'manifest.json',
    'status.json',
  ];
  const entrantCohort = {
    changed: false,
    version: '1.0.0',
    representativeRevision,
    serpTopN: 10,
    finalistClusterCount: 1,
    uniqueDomainCount: 2,
    observedOccurrenceCount: 3,
    excludedOccurrenceCount: 0,
    weakDomainCount: 1,
    knownDrDomainCount: 2,
    repeatedDomainCount: 1,
    survivorshipWarning: 'warning',
    drThresholds: { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 },
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    modules: ['clusters'],
    config: { clusters: { algorithmVersion: '2.0.0' } },
    artifacts,
    representativeQueries: { revision: representativeRevision },
    entrantCohort,
    state: 'completed',
  }, null, 2) + '\n');
  await writeFile(join(directory, 'status.json'), JSON.stringify({
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    status: 'completed',
    modules: ['clusters'],
    artifacts,
    representativeQueries: { revision: representativeRevision },
    entrantCohort,
  }, null, 2) + '\n');
  await Promise.all(ENTRANT_COHORT_ARTIFACTS.map((name) =>
    writeFile(join(directory, name), `stale ${name}\n`)));
}

function representativeInput(directory: string, revision: number) {
  return {
    enrichmentDirectory: directory,
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    config: {
      targetCount: 5,
      overrides: [],
      setVersion: '1.0.0',
      selectedClusterIds: ['cluster-1'],
    },
    summary: {
      revision,
      changed: true,
      setVersion: '1.0.0',
      targetCount: 5,
      setCount: 1,
      queryCount: 2,
      manualOverrideCount: 0,
    },
  };
}

test('representative revision change removes stale entrant metadata, artifact names and files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'entrant-invalidation-'));
  try {
    await createPublication(directory, 1);
    await publishRepresentativeMetadata(representativeInput(directory, 2));

    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
      artifacts: string[];
      entrantCohort?: unknown;
      representativeQueries: { revision: number };
    };
    const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8')) as {
      artifacts: string[];
      entrantCohort?: unknown;
    };
    assert.equal(manifest.representativeQueries.revision, 2);
    assert.equal(manifest.entrantCohort, undefined);
    assert.equal(status.entrantCohort, undefined);
    for (const artifact of ENTRANT_COHORT_ARTIFACTS) {
      assert.equal(manifest.artifacts.includes(artifact), false);
      assert.equal(status.artifacts.includes(artifact), false);
      await assert.rejects(access(join(directory, artifact)));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unchanged representative revision preserves a current entrant publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'entrant-preserve-'));
  try {
    await createPublication(directory, 2);
    const input = representativeInput(directory, 2);
    input.summary.changed = false;
    await publishRepresentativeMetadata(input);

    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
      artifacts: string[];
      entrantCohort: { representativeRevision: number };
    };
    assert.equal(manifest.entrantCohort.representativeRevision, 2);
    for (const artifact of ENTRANT_COHORT_ARTIFACTS) {
      assert.equal(manifest.artifacts.includes(artifact), true);
      await access(join(directory, artifact));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
