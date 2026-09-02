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

const entrant: EntrantCohortSnapshot = {
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

const summary: CohortHistoryPublicationSummary = {
  changed: true,
  version: COHORT_HISTORY_PROJECTION_VERSION,
  snapshotFingerprint: 'cohort-history-current',
  entrantRepresentativeRevision: 2,
  entrantFingerprint: entrantCohortFingerprint(entrant),
  finalistClusterCount: 1,
  cohortDomainCount: 10,
  checkedDomainCount: 6,
  omittedDomainCount: 2,
  unobservedDomainCount: 2,
  registrationKnownDomainCount: 4,
  youngDomainCount: 2,
  firstSeenKnownDomainCount: 3,
  recentWebPresenceCount: 1,
  comparableHistoryDomainCount: 2,
  possibleHistoryConflictCount: 1,
  policy: {
    version: COHORT_HISTORY_PROJECTION_VERSION,
    youngDomainMaxAgeDays: 365,
    recentWebPresenceMaxAgeDays: 180,
    repurposeGapMinDays: 1_000,
  },
};

async function seedPublication(directory: string): Promise<void> {
  const artifacts = [
    'keyword-clusters.csv',
    'representative-queries.json',
    'entrant-cohort.json',
    'manifest.json',
    'status.json',
  ];
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    modules: ['clusters'],
    artifacts,
    state: 'completed',
    representativeQueries: { revision: 2 },
    entrantCohort: { representativeRevision: 2 },
  }, null, 2) + '\n');
  await writeFile(join(directory, 'status.json'), JSON.stringify({
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    status: 'completed',
    modules: ['clusters'],
    artifacts,
    representativeQueries: { revision: 2 },
    entrantCohort: { representativeRevision: 2 },
  }, null, 2) + '\n');
  await writeFile(join(directory, 'entrant-cohort.json'), JSON.stringify({
    ...entrant,
    finalistClusterCount: entrant.cohorts.length,
  }, null, 2) + '\n');
}

test('history publication binds metadata to exact public entrant parent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'history-publication-'));
  try {
    await seedPublication(directory);
    await publishCohortHistoryMetadata({
      enrichmentDirectory: directory,
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      summary,
    });

    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
      artifacts: string[];
      cohortHistory: CohortHistoryPublicationSummary;
      entrantCohort: { representativeRevision: number };
    };
    assert.equal(manifest.entrantCohort.representativeRevision, 2);
    assert.deepEqual(manifest.cohortHistory, summary);
    for (const artifact of ['cohort-history.csv', 'cohort-history-summary.csv', 'cohort-history.json']) {
      assert.equal(manifest.artifacts.includes(artifact), true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('history publication refuses stale public entrant content even when revision matches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'history-publication-stale-'));
  try {
    await seedPublication(directory);
    const staleEntrant = {
      ...entrant,
      sourceRunUpdatedAt: '2026-08-29T11:00:00.000Z',
      finalistClusterCount: 0,
    };
    await writeFile(join(directory, 'entrant-cohort.json'), JSON.stringify(staleEntrant, null, 2) + '\n');

    await assert.rejects(
      publishCohortHistoryMetadata({
        enrichmentDirectory: directory,
        enrichmentId: 'enr-1',
        sourceRunId: 'source-1',
        summary,
      }),
      /does not match current entrant parent/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('history publication refuses mismatched entrant revision in public metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'history-publication-revision-'));
  try {
    await seedPublication(directory);
    const manifestPath = join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.entrantCohort = { representativeRevision: 1 };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    await assert.rejects(
      publishCohortHistoryMetadata({
        enrichmentDirectory: directory,
        enrichmentId: 'enr-1',
        sourceRunId: 'source-1',
        summary,
      }),
      /representative revision 1 does not match current parent 2/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
