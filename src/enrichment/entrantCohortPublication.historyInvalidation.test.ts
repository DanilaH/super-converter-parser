import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  publishEntrantCohortMetadata,
  type EntrantCohortPublicationSummary,
} from './entrantCohortPublication.js';

const HISTORY_ARTIFACTS = [
  'cohort-history.csv',
  'cohort-history-summary.csv',
  'cohort-history.json',
];
const TRAFFIC_ARTIFACTS = [
  'traffic-evidence.csv',
  'traffic-velocity.csv',
  'traffic-evidence.json',
];
const DEPENDENT_ARTIFACTS = [...HISTORY_ARTIFACTS, ...TRAFFIC_ARTIFACTS];

function summary(changed: boolean): EntrantCohortPublicationSummary {
  return {
    changed,
    version: '1.0.0',
    representativeRevision: 2,
    serpTopN: 10,
    finalistClusterCount: 1,
    uniqueDomainCount: 3,
    observedOccurrenceCount: 4,
    excludedOccurrenceCount: 0,
    weakDomainCount: 1,
    knownDrDomainCount: 2,
    repeatedDomainCount: 1,
    survivorshipWarning: 'observed winners only',
    drThresholds: { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 },
  };
}

async function seed(directory: string): Promise<void> {
  const artifacts = [
    'representative-queries.json',
    'entrant-cohort.json',
    ...DEPENDENT_ARTIFACTS,
    'manifest.json',
    'status.json',
  ];
  const common = {
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    modules: ['clusters'],
    artifacts,
    representativeQueries: { revision: 2 },
    cohortHistory: { entrantFingerprint: 'old' },
    trafficEvidence: { currentEntrantFingerprint: 'old' },
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...common, state: 'completed' }, null, 2) + '\n');
  await writeFile(join(directory, 'status.json'), JSON.stringify({ ...common, status: 'completed' }, null, 2) + '\n');
  for (const file of DEPENDENT_ARTIFACTS) {
    await writeFile(join(directory, file), 'stale');
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('changed entrant publication invalidates cohort history and traffic publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'entrant-dependent-invalidation-'));
  try {
    await seed(directory);
    await publishEntrantCohortMetadata({
      enrichmentDirectory: directory,
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      summary: summary(true),
    });

    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
      artifacts: string[];
      cohortHistory?: unknown;
      trafficEvidence?: unknown;
    };
    assert.equal('cohortHistory' in manifest, false);
    assert.equal('trafficEvidence' in manifest, false);
    for (const file of DEPENDENT_ARTIFACTS) {
      assert.equal(manifest.artifacts.includes(file), false);
      assert.equal(await exists(join(directory, file)), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('identical entrant rerun preserves valid history and traffic publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'entrant-dependent-preserve-'));
  try {
    await seed(directory);
    await publishEntrantCohortMetadata({
      enrichmentDirectory: directory,
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      summary: summary(false),
    });

    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
      artifacts: string[];
      cohortHistory?: unknown;
      trafficEvidence?: unknown;
    };
    assert.equal('cohortHistory' in manifest, true);
    assert.equal('trafficEvidence' in manifest, true);
    for (const file of DEPENDENT_ARTIFACTS) {
      assert.equal(manifest.artifacts.includes(file), true);
      assert.equal(await exists(join(directory, file)), true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
