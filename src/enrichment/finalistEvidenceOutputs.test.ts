import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeFinalistEvidenceCsv,
  writeFinalistEvidenceJson,
  type FinalistEvidenceArtifact,
} from './finalistEvidenceOutputs.js';
import type { FinalistEvidenceMatrix } from './finalistEvidence.js';

function matrix(): FinalistEvidenceMatrix {
  return {
    version: '1.0.0',
    finalistCount: 1,
    sourceRunQuality: {} as FinalistEvidenceMatrix['sourceRunQuality'],
    staleTrafficTargetCount: 0,
    staleHumanDecisionCount: 0,
    retiredHumanDecisions: [],
    finalists: [{
      clusterId: 'cluster-1',
      canonicalKeyword: 'speaker test',
      representativeKeywordIds: [1, 2],
      evidence: {
        demand: {
          representativeQueryCount: 2,
          volumeCoverage: { numerator: 1, denominator: 2, ratio: 0.5 },
          volumeDistribution: { min: 100, median: 100, max: 100 },
          representativeQueries: [
            { keywordIdx: 1, keyword: 'speaker test', volume: 100 },
            { keywordIdx: 2, keyword: 'audio test', volume: null },
          ],
        },
        serpAccessibility: {
          clusterMemberCount: 2,
          cohesion: null,
          representativeUrlCoverage: { numerator: 8, denominator: 10, ratio: 0.8 },
          entrantDomainCount: 2,
          knownDrDomainCount: 1,
          missingDrDomainCount: 1,
          conflictingDrDomainCount: 0,
          weakDomainCoverage: { numerator: 1, denominator: 1, ratio: 1 },
          repeatedDomainCoverage: { numerator: 1, denominator: 2, ratio: 0.5 },
          pageIdentityCoverage: { numerator: 3, denominator: 4, ratio: 0.75 },
          warnings: ['survivorship bounded SERP evidence'],
        },
        organicTrafficProof: {
          importedSnapshotCount: 1,
          projectionAvailable: true,
          matchedSnapshotCount: 1,
          mismatchedSnapshotCount: 0,
          histories: [],
          warnings: ['low_base_organic_traffic'],
        },
        entrantRepeatability: {
          cohortDomainCount: 2,
          repeatedDomainCount: 1,
          repeatedDomainCoverage: { numerator: 1, denominator: 2, ratio: 0.5 },
          samePageRepeatedDomainCount: 1,
          differentPageRepeatedDomainCount: 0,
          survivorshipWarnings: ['observed entrants only'],
          history: {
            cohortDomainCount: 2,
            checkedDomainCount: 1,
            omittedDomainCount: 1,
            unobservedDomainCount: 0,
            checkedCoverage: { numerator: 1, denominator: 2, ratio: 0.5 },
            registrationKnownDomainCount: 1,
            youngDomainCount: 1,
            youngDomainCoverage: { numerator: 1, denominator: 1, ratio: 1 },
            firstSeenKnownDomainCount: 0,
            recentWebPresenceCount: 0,
            recentWebPresenceCoverage: { numerator: 0, denominator: 0, ratio: null },
            comparableHistoryDomainCount: 0,
            possibleHistoryConflictCount: 0,
            possibleHistoryConflictCoverage: { numerator: 0, denominator: 0, ratio: null },
            registrationStatusCounts: { ok: 1, not_attempted: 1 },
            firstSeenStatusCounts: { unavailable: 1, not_attempted: 1 },
          },
        },
        moat: {
          siteStructureModuleIncluded: true,
          observedDomainCoverage: { numerator: 1, denominator: 2, ratio: 0.5 },
          observedDomains: [],
          warnings: ['descriptive structure only'],
        },
        monetizationGeography: {
          cpcCoverage: { numerator: 1, denominator: 2, ratio: 0.5 },
          cpcDistribution: { min: 1.5, median: 1.5, max: 1.5 },
          representativeQueries: [],
          googleObservationCoverage: { numerator: 2, denominator: 2, ratio: 1 },
          detectedLocationCoverage: { numerator: 1, denominator: 2, ratio: 0.5 },
          geoWarningCount: 1,
          warnings: ['CPC is descriptive only'],
        },
        productFeasibility: {
          automatedAssessment: null,
          warnings: ['human review required'],
        },
      },
      humanDecision: {
        buildDecision: 'watch',
        seoProductRole: 'experimental',
        recordedAt: '2026-08-29T12:00:00.000Z',
        evidenceCurrent: true,
      },
      auditFlags: ['DR_EVIDENCE_INCOMPLETE'],
    }],
  };
}

test('finalist CSV preserves history denominators and warning provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'finalist-outputs-'));
  try {
    const path = join(directory, 'matrix.csv');
    await writeFinalistEvidenceCsv(path, matrix());
    const csv = await readFile(path, 'utf8');

    assert.match(csv, /history_young_numerator,history_young_denominator,history_young_ratio/);
    assert.match(csv, /history_recent_web_presence_numerator,history_recent_web_presence_denominator,history_recent_web_presence_ratio/);
    assert.match(csv, /history_conflict_numerator,history_conflict_denominator,history_conflict_ratio/);
    assert.match(csv, /traffic_warnings/);
    assert.match(csv, /product_feasibility_warnings/);
    assert.match(csv, /low_base_organic_traffic/);
    assert.match(csv, /human review required/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('finalist JSON preserves exact parent generation and matrix state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'finalist-json-'));
  try {
    const path = join(directory, 'matrix.json');
    const artifact: FinalistEvidenceArtifact = {
      version: '1.0.0',
      enrichmentId: 'enr-1',
      sourceRunId: 'run-1',
      representativeRevision: 2,
      entrantFingerprint: 'a'.repeat(64),
      matrix: matrix(),
    };
    await writeFinalistEvidenceJson(path, artifact);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as FinalistEvidenceArtifact;

    assert.equal(parsed.representativeRevision, 2);
    assert.equal(parsed.entrantFingerprint, 'a'.repeat(64));
    assert.deepEqual(
      parsed.matrix.finalists[0]?.evidence.entrantRepeatability.history?.recentWebPresenceCoverage,
      { numerator: 0, denominator: 0, ratio: null },
    );
    assert.equal(parsed.matrix.finalists[0]?.evidence.productFeasibility.automatedAssessment, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
