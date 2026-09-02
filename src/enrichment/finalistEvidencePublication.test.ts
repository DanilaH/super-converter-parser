import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entrantCohortFingerprint } from '../db/cohortHistory.js';
import type { EntrantCohortSnapshot } from '../db/entrantCohorts.js';
import { RunStore } from '../db/store.js';
import {
  FINALIST_EVIDENCE_ARTIFACTS,
  invalidateFinalistEvidencePublication,
  publishFinalistEvidenceMetadata,
  type FinalistEvidencePublicationSummary,
} from './finalistEvidencePublication.js';

function entrant(): EntrantCohortSnapshot {
  const occurrence = {
    keywordIdx: 1,
    position: 1,
    rankingUrl: 'https://example.test/tool',
    registrableDomain: 'example.test',
    normalizedPageIdentity: 'example.test/tool',
    dr: 20,
  };
  return {
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    representativeRevision: 2,
    cohortVersion: '1.0.0',
    serpTopN: 10,
    drThresholds: { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 },
    sourceRunUpdatedAt: '2026-08-29T10:00:00.000Z',
    clusteringUpdatedAt: '2026-08-29T10:05:00.000Z',
    cohorts: [{
      clusterId: 'cluster-1',
      representativeKeywordIds: [1],
      representativeQueryCount: 1,
      version: '1.0.0',
      serpTopN: 10,
      occurrences: [occurrence],
      excludedOccurrences: [],
      domains: [{
        registrableDomain: 'example.test',
        occurrences: [occurrence],
        occurrenceCount: 1,
        bestRank: 1,
        medianRank: 1,
        queryIdsPresent: [1],
        queryCoverage: { numerator: 1, denominator: 1, ratio: 1 },
        rankingUrls: [occurrence.rankingUrl],
        normalizedPageIdentities: ['example.test/tool'],
        pageIdentityCoverage: { numerator: 1, denominator: 1, ratio: 1 },
        samePageRepetition: { repeatedAcrossQueries: false, repeatedPageCount: 0, maxQueriesPerPage: 1 },
        sameDomainDifferentPageRepetition: { repeatedAcrossQueries: false, distinctPageCount: 1 },
        drEvidence: {
          status: 'known',
          value: 20,
          observedValues: [20],
          knownOccurrenceCount: 1,
          occurrenceCount: 1,
          isWeak: true,
        },
      }],
      summary: {
        observedOccurrenceCount: 1,
        excludedOccurrenceCount: 0,
        uniqueDomainCount: 1,
        pageIdentityCoverage: { numerator: 1, denominator: 1, ratio: 1 },
        knownDrDomainCount: 1,
        missingDrDomainCount: 0,
        conflictingDrDomainCount: 0,
        weakDomainCount: 1,
        weakDomainCoverage: { numerator: 1, denominator: 1, ratio: 1 },
        repeatedDomainCount: 0,
        repeatedDomainCoverage: { numerator: 0, denominator: 1, ratio: 0 },
        samePageRepeatedDomainCount: 0,
        differentPageRepeatedDomainCount: 0,
      },
      warnings: [],
    }],
  };
}

function summary(parent: EntrantCohortSnapshot): FinalistEvidencePublicationSummary {
  return {
    version: '1.0.0',
    representativeRevision: parent.representativeRevision,
    entrantFingerprint: entrantCohortFingerprint(parent),
    cohortHistoryFingerprint: null,
    historicalPresenceFingerprint: null,
    finalistCount: 1,
    cohortHistoryAvailableCount: 0,
    importedTrafficSnapshotCount: 0,
    matchedTrafficSnapshotCount: null,
    mismatchedTrafficSnapshotCount: null,
    staleTrafficTargetCount: 0,
    currentHumanDecisionCount: 0,
    staleHumanDecisionCount: 0,
    unrecordedHumanDecisionCount: 1,
    auditFlagCount: 3,
  };
}

async function seed(directory: string, parent: EntrantCohortSnapshot): Promise<void> {
  const store = RunStore.open(join(directory, 'enrichment.sqlite'));
  store.close();
  await writeFile(join(directory, 'entrant-cohort.json'), JSON.stringify(parent, null, 2) + '\n');
  const common = {
    enrichmentId: parent.enrichmentId,
    sourceRunId: parent.sourceRunId,
    artifacts: ['entrant-cohort.json'],
    representativeQueries: { revision: parent.representativeRevision },
    entrantCohort: { representativeRevision: parent.representativeRevision },
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...common, state: 'completed' }, null, 2) + '\n');
  await writeFile(join(directory, 'status.json'), JSON.stringify({ ...common, status: 'completed' }, null, 2) + '\n');
}

test('finalist publication advertises matrix artifacts only against the matching parent generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'finalist-publication-'));
  try {
    const parent = entrant();
    await seed(directory, parent);
    await publishFinalistEvidenceMetadata({
      enrichmentDirectory: directory,
      enrichmentId: parent.enrichmentId,
      sourceRunId: parent.sourceRunId,
      summary: summary(parent),
    });

    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
      artifacts: string[];
      finalistEvidence: FinalistEvidencePublicationSummary;
    };
    assert.equal(manifest.finalistEvidence.entrantFingerprint, entrantCohortFingerprint(parent));
    assert.equal(manifest.finalistEvidence.cohortHistoryFingerprint, null);
    assert.equal(manifest.finalistEvidence.historicalPresenceFingerprint, null);
    for (const artifact of FINALIST_EVIDENCE_ARTIFACTS) {
      assert.equal(manifest.artifacts.includes(artifact), true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stale finalist parent fails before manifest or status mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'finalist-publication-stale-'));
  try {
    const parent = entrant();
    await seed(directory, parent);
    const manifestPath = join(directory, 'manifest.json');
    const statusPath = join(directory, 'status.json');
    const originalManifest = await readFile(manifestPath, 'utf8');
    const originalStatus = await readFile(statusPath, 'utf8');

    await assert.rejects(
      () => publishFinalistEvidenceMetadata({
        enrichmentDirectory: directory,
        enrichmentId: parent.enrichmentId,
        sourceRunId: parent.sourceRunId,
        summary: { ...summary(parent), entrantFingerprint: '0'.repeat(64) },
      }),
      /does not match current finalist parent/,
    );
    assert.equal(await readFile(manifestPath, 'utf8'), originalManifest);
    assert.equal(await readFile(statusPath, 'utf8'), originalStatus);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('finalist publication refuses to relabel a matrix built from older deep evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'finalist-publication-deep-race-'));
  try {
    const parent = entrant();
    await seed(directory, parent);
    const manifestPath = join(directory, 'manifest.json');
    const statusPath = join(directory, 'status.json');
    const originalManifest = await readFile(manifestPath, 'utf8');
    const originalStatus = await readFile(statusPath, 'utf8');

    await assert.rejects(
      () => publishFinalistEvidenceMetadata({
        enrichmentDirectory: directory,
        enrichmentId: parent.enrichmentId,
        sourceRunId: parent.sourceRunId,
        summary: { ...summary(parent), cohortHistoryFingerprint: 'matrix-history-parent' },
      }),
      /does not match finalist matrix parent matrix-history-parent/,
    );
    assert.equal(await readFile(manifestPath, 'utf8'), originalManifest);
    assert.equal(await readFile(statusPath, 'utf8'), originalStatus);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('finalist invalidation removes metadata, artifact advertisements and stale files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'finalist-publication-invalidate-'));
  try {
    const parent = entrant();
    await seed(directory, parent);
    await publishFinalistEvidenceMetadata({
      enrichmentDirectory: directory,
      enrichmentId: parent.enrichmentId,
      sourceRunId: parent.sourceRunId,
      summary: summary(parent),
    });
    for (const artifact of FINALIST_EVIDENCE_ARTIFACTS) {
      await writeFile(join(directory, artifact), 'matrix artifact\n');
    }

    await invalidateFinalistEvidencePublication({
      enrichmentDirectory: directory,
      enrichmentId: parent.enrichmentId,
      sourceRunId: parent.sourceRunId,
    });

    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Record<string, unknown> & {
      artifacts: string[];
    };
    assert.equal('finalistEvidence' in manifest, false);
    for (const artifact of FINALIST_EVIDENCE_ARTIFACTS) {
      assert.equal(manifest.artifacts.includes(artifact), false);
      await assert.rejects(() => readFile(join(directory, artifact), 'utf8'), /ENOENT/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
