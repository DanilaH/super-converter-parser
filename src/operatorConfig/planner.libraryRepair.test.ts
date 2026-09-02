import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import type { PersistedOperatorConfigV1 } from './provenance.js';
import { buildExistingResearchPlan } from './planner.js';

function status(derivedSnapshotsCurrent: boolean): ResearchStatusWithHistoricalPresence {
  return {
    version: '1.2.0',
    researchId: 'research-1',
    label: 'library-repair',
    researchDirectory: '/tmp/research-1',
    legacy: false,
    discovery: {
      generation: 1,
      runId: 'research-1',
      state: 'completed',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:01.000Z',
      pauseReason: null,
      keywordCounts: { total: 5, pending: 0, running: 0, completed: 5, partial: 0, failed: 0, repairable: 0 },
      qualityWarnings: [],
    },
    enrichments: [{
      enrichmentId: 'enrichment-1',
      generation: 1,
      directoryName: 'enrichment',
      sourceRunId: 'research-1',
      state: 'completed',
      createdAt: '2026-09-02T00:00:02.000Z',
      updatedAt: '2026-09-02T00:00:03.000Z',
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
      finalistCount: 1,
      currentDecisionCount: 1,
      allFinalistsHaveCurrentDecisions: true,
      finalistMatrixPublished: true,
      artifactWarning: null,
    },
    library: {
      published: true,
      publicationId: 'pub-current',
      publishedAt: '2026-09-02T00:00:04.000Z',
      reason: null,
      lookupError: null,
      derivedSnapshotsCurrent,
      derivedSnapshotWarning: derivedSnapshotsCurrent ? null : 'library.zip is stale',
    },
    evidenceCoverage: null,
    nextAction: { code: 'none', message: 'complete', command: null },
    sampledHistoricalPresence: null,
  };
}

const operatorConfig = {
  effectiveConfigFingerprint: 'config-fingerprint',
  stageFingerprints: {
    discovery: 'discovery-fingerprint',
    enrichment: 'enrichment-fingerprint',
    finalization: 'finalization-fingerprint',
  },
  semantics: {
    workflow: { target: 'finalization' },
    enrichment: { modules: ['clusters'] },
  },
} as unknown as PersistedOperatorConfigV1;

test('planner reopens only the local publication step when durable publication exists but derived snapshots are stale', () => {
  const plan = buildExistingResearchPlan(status(false), null, operatorConfig);
  const finalization = plan.stages.find((stage) => stage.id === 'finalization');
  assert.equal(finalization?.state, 'ready');
  assert.match(finalization?.reason ?? '', /derived library\.json\/library\.zip snapshots require idempotent repair/);
  assert.equal(plan.expectedStopPoint, 'finalization');
  assert.equal(plan.durableState.libraryPublished, true);
  assert.equal(plan.externalWork.some((work) => work.providers.length > 0), false);

  const healthy = buildExistingResearchPlan(status(true), null, operatorConfig);
  assert.equal(healthy.stages.find((stage) => stage.id === 'finalization')?.state, 'already_satisfied');
  assert.equal(healthy.expectedStopPoint, 'complete');
});
