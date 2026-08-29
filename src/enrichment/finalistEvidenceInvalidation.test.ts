import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entrantCohortFingerprint } from '../db/cohortHistory.js';
import type { EntrantCohortSnapshot } from '../db/entrantCohorts.js';
import { COHORT_HISTORY_PROJECTION_VERSION } from './cohortHistory.js';
import {
  publishCohortHistoryMetadata,
  type CohortHistoryPublicationSummary,
} from './cohortHistoryPublication.js';
import { publishEntrantCohortMetadata } from './entrantCohortPublication.js';
import { FINALIST_EVIDENCE_ARTIFACTS } from './finalistEvidencePublication.js';
import { publishRepresentativeMetadata } from './representativePublication.js';

const REPRESENTATIVE_CONFIG = {
  targetCount: 5,
  overrides: [],
  setVersion: '1.0.0',
  selectedClusterIds: ['cluster-1'],
};

function entrant(): EntrantCohortSnapshot {
  return {
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    representativeRevision: 2,
    cohortVersion: '1.0.0',
    serpTopN: 10,
    drThresholds: { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 },
    sourceRunUpdatedAt: '2026-08-29T10:00:00.000Z',
    clusteringUpdatedAt: '2026-08-29T10:05:00.000Z',
    cohorts: [],
  };
}

function historySummary(parent: EntrantCohortSnapshot): CohortHistoryPublicationSummary {
  return {
    changed: true,
    version: COHORT_HISTORY_PROJECTION_VERSION,
    entrantRepresentativeRevision: parent.representativeRevision,
    entrantFingerprint: entrantCohortFingerprint(parent),
    finalistClusterCount: 0,
    cohortDomainCount: 0,
    checkedDomainCount: 0,
    omittedDomainCount: 0,
    unobservedDomainCount: 0,
    registrationKnownDomainCount: 0,
    youngDomainCount: 0,
    firstSeenKnownDomainCount: 0,
    recentWebPresenceCount: 0,
    comparableHistoryDomainCount: 0,
    possibleHistoryConflictCount: 0,
    policy: {
      version: COHORT_HISTORY_PROJECTION_VERSION,
      youngDomainMaxAgeDays: 365,
      recentWebPresenceMaxAgeDays: 180,
      repurposeGapMinDays: 1_000,
    },
  };
}

async function seedFinalistFiles(directory: string): Promise<void> {
  for (const artifact of FINALIST_EVIDENCE_ARTIFACTS) {
    await writeFile(join(directory, artifact), 'stale finalist evidence\n');
  }
}

async function assertFinalistRemoved(directory: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Record<string, unknown> & {
    artifacts: string[];
  };
  const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8')) as Record<string, unknown> & {
    artifacts: string[];
  };
  assert.equal('finalistEvidence' in manifest, false);
  assert.equal('finalistEvidence' in status, false);
  for (const artifact of FINALIST_EVIDENCE_ARTIFACTS) {
    assert.equal(manifest.artifacts.includes(artifact), false);
    assert.equal(status.artifacts.includes(artifact), false);
    await assert.rejects(() => readFile(join(directory, artifact), 'utf8'), /ENOENT/);
  }
}

async function seedRepresentativeDriftPublication(directory: string): Promise<void> {
  const artifacts = [
    'keyword-clusters.csv',
    'representative-queries.csv',
    'entrant-cohort.json',
    ...FINALIST_EVIDENCE_ARTIFACTS,
  ];
  const common = {
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    modules: ['clusters'],
    config: { clusters: { algorithmVersion: '2.0.0' } },
    artifacts,
    representativeQueries: { revision: 1 },
    entrantCohort: { representativeRevision: 1 },
    cohortHistory: { version: '1.0.0' },
    trafficEvidence: { version: '1.0.0' },
    finalistEvidence: { version: '1.0.0' },
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...common, state: 'completed' }, null, 2) + '\n');
  await writeFile(join(directory, 'status.json'), JSON.stringify({ ...common, status: 'completed' }, null, 2) + '\n');
  await seedFinalistFiles(directory);
}

async function seedCurrentEntrantPublication(directory: string, parent: EntrantCohortSnapshot): Promise<void> {
  const artifacts = [
    'representative-queries.csv',
    'entrant-cohort.json',
    ...FINALIST_EVIDENCE_ARTIFACTS,
  ];
  const common = {
    enrichmentId: parent.enrichmentId,
    sourceRunId: parent.sourceRunId,
    modules: ['clusters'],
    config: { clusters: { algorithmVersion: '2.0.0' } },
    artifacts,
    representativeQueries: { revision: parent.representativeRevision },
    entrantCohort: { representativeRevision: parent.representativeRevision },
    finalistEvidence: { version: '1.0.0' },
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...common, state: 'completed' }, null, 2) + '\n');
  await writeFile(join(directory, 'status.json'), JSON.stringify({ ...common, status: 'completed' }, null, 2) + '\n');
  await writeFile(join(directory, 'entrant-cohort.json'), JSON.stringify(parent, null, 2) + '\n');
  await seedFinalistFiles(directory);
}

test('representative drift invalidates published finalist evidence transitively', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'finalist-representative-invalidation-'));
  try {
    await seedRepresentativeDriftPublication(directory);
    await publishRepresentativeMetadata({
      enrichmentDirectory: directory,
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      config: REPRESENTATIVE_CONFIG,
      summary: {
        revision: 2,
        changed: true,
        setVersion: '1.0.0',
        targetCount: 5,
        setCount: 1,
        queryCount: 1,
        manualOverrideCount: 0,
      },
    });

    await assertFinalistRemoved(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('changed entrant cohort invalidates published finalist evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'finalist-entrant-invalidation-'));
  try {
    const parent = entrant();
    await seedCurrentEntrantPublication(directory, parent);
    await publishEntrantCohortMetadata({
      enrichmentDirectory: directory,
      enrichmentId: parent.enrichmentId,
      sourceRunId: parent.sourceRunId,
      summary: {
        changed: true,
        version: parent.cohortVersion,
        representativeRevision: parent.representativeRevision,
        serpTopN: parent.serpTopN,
        finalistClusterCount: 0,
        uniqueDomainCount: 0,
        observedOccurrenceCount: 0,
        excludedOccurrenceCount: 0,
        weakDomainCount: 0,
        knownDrDomainCount: 0,
        repeatedDomainCount: 0,
        survivorshipWarning: 'observed winners only',
        drThresholds: parent.drThresholds,
      },
    });

    await assertFinalistRemoved(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('changed cohort history invalidates published finalist evidence after parent validation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'finalist-history-invalidation-'));
  try {
    const parent = entrant();
    await seedCurrentEntrantPublication(directory, parent);
    await publishCohortHistoryMetadata({
      enrichmentDirectory: directory,
      enrichmentId: parent.enrichmentId,
      sourceRunId: parent.sourceRunId,
      summary: historySummary(parent),
    });

    await assertFinalistRemoved(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stale cohort-history parent fails without invalidating a valid finalist publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'finalist-history-stale-parent-'));
  try {
    const parent = entrant();
    await seedCurrentEntrantPublication(directory, parent);
    const manifestPath = join(directory, 'manifest.json');
    const statusPath = join(directory, 'status.json');
    const originalManifest = await readFile(manifestPath, 'utf8');
    const originalStatus = await readFile(statusPath, 'utf8');

    await assert.rejects(
      () => publishCohortHistoryMetadata({
        enrichmentDirectory: directory,
        enrichmentId: parent.enrichmentId,
        sourceRunId: parent.sourceRunId,
        summary: {
          ...historySummary(parent),
          entrantFingerprint: '0'.repeat(64),
        },
      }),
      /does not match current entrant parent/,
    );

    assert.equal(await readFile(manifestPath, 'utf8'), originalManifest);
    assert.equal(await readFile(statusPath, 'utf8'), originalStatus);
    for (const artifact of FINALIST_EVIDENCE_ARTIFACTS) {
      assert.equal(await readFile(join(directory, artifact), 'utf8'), 'stale finalist evidence\n');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
