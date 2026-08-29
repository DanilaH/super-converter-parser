import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entrantCohortFingerprint } from '../db/cohortHistory.js';
import type { EntrantCohortSnapshot } from '../db/entrantCohorts.js';
import {
  TRAFFIC_EVIDENCE_VERSION,
  type TrafficEvidencePolicy,
} from './trafficEvidence.js';
import {
  publishTrafficEvidenceMetadata,
  TRAFFIC_EVIDENCE_ARTIFACTS,
  type TrafficEvidencePublicationSummary,
} from './trafficEvidencePublication.js';

const POLICY: TrafficEvidencePolicy = {
  version: TRAFFIC_EVIDENCE_VERSION,
  lowBaseOrganicTrafficThreshold: 100,
};

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

function summary(fingerprint: string): TrafficEvidencePublicationSummary {
  return {
    version: TRAFFIC_EVIDENCE_VERSION,
    currentEntrantFingerprint: fingerprint,
    importedSnapshotCount: 2,
    currentTargetSnapshotCount: 2,
    matchedSnapshotCount: 2,
    mismatchedSnapshotCount: 0,
    staleTargetSnapshotCount: 0,
    historyCount: 1,
    velocityCount: 1,
    lowBaseWarningCount: 0,
    trafficValueCurrencyMismatchCount: 0,
    policy: POLICY,
  };
}

async function seed(directory: string, parent: EntrantCohortSnapshot): Promise<void> {
  const artifacts = ['entrant-cohort.json', 'manifest.json', 'status.json'];
  await writeFile(join(directory, 'entrant-cohort.json'), JSON.stringify({
    ...parent,
    finalistClusterCount: parent.cohorts.length,
  }, null, 2) + '\n');
  const common = {
    enrichmentId: parent.enrichmentId,
    sourceRunId: parent.sourceRunId,
    artifacts,
    entrantCohort: { representativeRevision: parent.representativeRevision },
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...common, state: 'completed' }, null, 2) + '\n');
  await writeFile(join(directory, 'status.json'), JSON.stringify({ ...common, status: 'completed' }, null, 2) + '\n');
}

test('traffic publication advertises artifacts only against the matching entrant parent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traffic-publication-'));
  try {
    const parent = entrant();
    const fingerprint = entrantCohortFingerprint(parent);
    await seed(directory, parent);
    await publishTrafficEvidenceMetadata({
      enrichmentDirectory: directory,
      enrichmentId: parent.enrichmentId,
      sourceRunId: parent.sourceRunId,
      summary: summary(fingerprint),
    });

    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
      artifacts: string[];
      trafficEvidence: TrafficEvidencePublicationSummary;
    };
    assert.equal(manifest.trafficEvidence.currentEntrantFingerprint, fingerprint);
    for (const artifact of TRAFFIC_EVIDENCE_ARTIFACTS) {
      assert.equal(manifest.artifacts.includes(artifact), true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stale entrant fingerprint rejects traffic publication without mutating manifest or status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'traffic-publication-stale-'));
  try {
    const parent = entrant();
    await seed(directory, parent);
    const manifestPath = join(directory, 'manifest.json');
    const statusPath = join(directory, 'status.json');
    const originalManifest = await readFile(manifestPath, 'utf8');
    const originalStatus = await readFile(statusPath, 'utf8');

    await assert.rejects(
      () => publishTrafficEvidenceMetadata({
        enrichmentDirectory: directory,
        enrichmentId: parent.enrichmentId,
        sourceRunId: parent.sourceRunId,
        summary: summary('0'.repeat(64)),
      }),
      /does not match current traffic parent/,
    );
    assert.equal(await readFile(manifestPath, 'utf8'), originalManifest);
    assert.equal(await readFile(statusPath, 'utf8'), originalStatus);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
