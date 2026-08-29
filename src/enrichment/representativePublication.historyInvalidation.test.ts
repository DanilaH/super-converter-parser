import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COHORT_HISTORY_ARTIFACTS } from './cohortHistoryPublication.js';
import { ENTRANT_COHORT_ARTIFACTS } from './entrantCohortPublication.js';
import { publishRepresentativeMetadata } from './representativePublication.js';
import { TRAFFIC_EVIDENCE_ARTIFACTS } from './trafficEvidencePublication.js';

const DOWNSTREAM_ARTIFACTS = [
  ...ENTRANT_COHORT_ARTIFACTS,
  ...COHORT_HISTORY_ARTIFACTS,
  ...TRAFFIC_EVIDENCE_ARTIFACTS,
];

async function seed(directory: string): Promise<void> {
  const artifacts = [
    'representative-queries.csv',
    'representative-queries.json',
    ...DOWNSTREAM_ARTIFACTS,
    'manifest.json',
    'status.json',
  ];
  const common = {
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    modules: ['clusters'],
    artifacts,
    representativeQueries: { revision: 1 },
    entrantCohort: { representativeRevision: 1 },
    cohortHistory: { entrantRepresentativeRevision: 1 },
    trafficEvidence: { currentEntrantFingerprint: 'old' },
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    ...common,
    state: 'completed',
    config: { clusters: { algorithmVersion: '2.0.0' } },
  }, null, 2) + '\n');
  await writeFile(join(directory, 'status.json'), JSON.stringify({
    ...common,
    status: 'completed',
  }, null, 2) + '\n');
  for (const artifact of DOWNSTREAM_ARTIFACTS) {
    await writeFile(join(directory, artifact), 'stale');
  }
}

test('representative revision change removes entrant, history and traffic publication transitively', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'representative-traffic-cascade-'));
  try {
    await seed(directory);
    await publishRepresentativeMetadata({
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
        revision: 2,
        changed: true,
        setVersion: '1.0.0',
        targetCount: 5,
        setCount: 1,
        queryCount: 2,
        manualOverrideCount: 0,
      },
    });

    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
      artifacts: string[];
      entrantCohort?: unknown;
      cohortHistory?: unknown;
      trafficEvidence?: unknown;
    };
    assert.equal(manifest.entrantCohort, undefined);
    assert.equal(manifest.cohortHistory, undefined);
    assert.equal(manifest.trafficEvidence, undefined);
    for (const artifact of DOWNSTREAM_ARTIFACTS) {
      assert.equal(manifest.artifacts.includes(artifact), false);
      await assert.rejects(access(join(directory, artifact)));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
