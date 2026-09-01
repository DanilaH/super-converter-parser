import assert from 'node:assert/strict';
import test from 'node:test';
import { TRAFFIC_EVIDENCE_VERSION } from '../enrichment/trafficEvidence.js';
import type { OperatorResearchConfigV1 } from '../operatorConfig/contracts.js';
import { buildPersistedOperatorConfig } from '../operatorConfig/provenance.js';
import { buildNewResearchPlan } from '../operatorConfig/resolve.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import type { FinalistEvidenceRunResult } from './finalistEvidenceRun.js';
import type { LibraryPublicationRunResult } from './libraryPublicationRun.js';
import type { TrafficEvidenceRunResult } from './trafficEvidenceRun.js';
import { runConfiguredFinalization } from './configuredRun.js';

function operatorConfig() {
  const config: OperatorResearchConfigV1 = {
    version: 1,
    research: { label: 'published-traffic', input: { type: 'seeds', path: 'seeds.csv' } },
    workflow: { target: 'finalization' },
    enrichment: { modules: ['clusters'] },
    finalization: {
      historyPolicy: {
        youngDomainMaxAgeDays: 730,
        recentWebPresenceMaxAgeDays: 730,
        repurposeGapMinDays: 365,
      },
    },
  };
  return buildPersistedOperatorConfig({
    config,
    plan: buildNewResearchPlan(config, '/tmp/published-traffic/research.config.json'),
  });
}

function publishedStatus(): ResearchStatusWithHistoricalPresence {
  return {
    version: '1.2.0',
    researchId: 'research-1',
    label: 'published-traffic',
    researchDirectory: '/tmp/output/research-1',
    legacy: false,
    discovery: {
      generation: 1,
      runId: 'research-1',
      state: 'completed',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:01.000Z',
      pauseReason: null,
      keywordCounts: { total: 2, pending: 0, running: 0, completed: 2, partial: 0, failed: 0, repairable: 0 },
      qualityWarnings: [],
    },
    enrichments: [{
      enrichmentId: 'enrichment-1',
      generation: 1,
      directoryName: 'enrichment',
      sourceRunId: 'research-1',
      state: 'completed',
      createdAt: '2026-09-01T00:00:02.000Z',
      updatedAt: '2026-09-01T00:00:03.000Z',
      modules: ['clusters'],
      itemCounts: {},
      error: null,
      isForCurrentDiscovery: true,
      isLatestForCurrentDiscovery: true,
    }],
    currentEnrichmentId: 'enrichment-1',
    finalization: {
      state: 'published',
      enrichmentId: 'enrichment-1',
      finalistCount: 2,
      currentDecisionCount: 2,
      allFinalistsHaveCurrentDecisions: true,
      finalistMatrixPublished: true,
      artifactWarning: null,
    },
    library: {
      published: true,
      publicationId: 'publication-1',
      publishedAt: '2026-09-01T00:00:04.000Z',
      reason: null,
      lookupError: null,
    },
    evidenceCoverage: null,
    nextAction: { code: 'none', message: 'complete', command: null },
    sampledHistoricalPresence: null,
  };
}

function traffic(): TrafficEvidenceRunResult {
  return {
    enrichmentId: 'enrichment-1',
    sourceRunId: 'research-1',
    changed: true,
    importedSnapshotCount: 1,
    currentTargetSnapshotCount: 1,
    matchedSnapshotCount: 1,
    mismatchedSnapshotCount: 0,
    staleTargetSnapshotCount: 0,
    historyCount: 1,
    velocityCount: 0,
    lowBaseWarningCount: 0,
    trafficValueCurrencyMismatchCount: 0,
    inserted: 1,
    duplicates: 0,
    policy: { version: TRAFFIC_EVIDENCE_VERSION, lowBaseOrganicTrafficThreshold: 100 },
    evidencePath: '/tmp/traffic.csv',
    velocityPath: '/tmp/velocity.csv',
    jsonPath: '/tmp/traffic.json',
  };
}

function finalists(): FinalistEvidenceRunResult {
  return {
    enrichmentId: 'enrichment-1',
    sourceRunId: 'research-1',
    representativeRevision: 1,
    entrantFingerprint: 'entrant-fp',
    finalistCount: 2,
    cohortHistoryAvailableCount: 2,
    sampledHistoryCollectedCount: 2,
    importedTrafficSnapshotCount: 1,
    currentHumanDecisionCount: 2,
    staleHumanDecisionCount: 0,
    unrecordedHumanDecisionCount: 0,
    auditFlagCount: 0,
    csvPath: '/tmp/finalists.csv',
    jsonPath: '/tmp/finalists.json',
  };
}

function publication(): LibraryPublicationRunResult {
  return {
    publicationId: 'publication-2',
    changed: true,
    supersedesPublicationId: 'publication-1',
    publicationCount: 2,
    libraryDbPath: '/tmp/library.sqlite',
    libraryJsonPath: '/tmp/library.json',
    libraryArchivePath: '/tmp/library.zip',
  };
}

test('traffic revision after publication avoids full/Common-Crawl rerun and produces a superseding publication', async () => {
  let fullRuns = 0;
  let trafficRuns = 0;
  let finalistRuns = 0;
  let publications = 0;

  const result = await runConfiguredFinalization({
    outputRoot: '/tmp/output',
    researchId: 'research-1',
    researchDirectory: '/tmp/output/research-1',
    enrichmentId: 'enrichment-1',
    operatorConfig: operatorConfig(),
    continuation: {
      continuation: {
        version: 1,
        researchId: 'research-1',
        action: { type: 'traffic', path: 'traffic.csv', lowBaseOrganicTrafficThreshold: 100 },
      },
      continuationPath: '/tmp/continuation.json',
      declaredFilePath: { logicalPath: 'traffic.csv', resolvedPath: '/tmp/traffic.csv' },
    },
    status: publishedStatus(),
    logger: () => undefined,
  }, {
    runFullFinalization: async () => {
      fullRuns += 1;
      throw new Error('published traffic revision must not rerun full finalization');
    },
    runTrafficEvidence: async () => {
      trafficRuns += 1;
      return traffic();
    },
    runFinalistEvidence: async () => {
      finalistRuns += 1;
      return finalists();
    },
    runLibraryPublication: async () => {
      publications += 1;
      return publication();
    },
  });

  assert.equal(result.outcome.kind, 'published');
  assert.equal(result.outcome.kind === 'published' ? result.outcome.publicationId : null, 'publication-2');
  assert.equal(fullRuns, 0);
  assert.equal(trafficRuns, 1);
  assert.equal(finalistRuns, 1);
  assert.equal(publications, 1);
  assert.equal(result.publication?.supersedesPublicationId, 'publication-1');
});
