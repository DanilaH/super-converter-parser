import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import type { OperatorResearchConfigV1 } from './contracts.js';
import { buildExistingResearchPlan } from './planner.js';
import { buildPersistedOperatorConfig } from './provenance.js';
import { buildNewResearchPlan, type ResolvedOperatorContinuation } from './resolve.js';

function provenance() {
  const config: OperatorResearchConfigV1 = {
    version: 1,
    research: { label: 'finalization-parent', input: { type: 'seeds', path: 'seeds.csv' } },
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
    plan: buildNewResearchPlan(config, '/tmp/finalization-parent/research.config.json'),
  });
}

function completedWithErrorsStatus(): ResearchStatusWithHistoricalPresence {
  return {
    version: '1.2.0',
    researchId: 'research-1',
    label: 'finalization-parent',
    researchDirectory: '/tmp/output/research-1',
    legacy: false,
    discovery: {
      generation: 1,
      runId: 'research-1',
      state: 'completed_with_errors',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:01.000Z',
      pauseReason: null,
      keywordCounts: {
        total: 3,
        pending: 0,
        running: 0,
        completed: 2,
        partial: 0,
        failed: 1,
        repairable: 0,
      },
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
      state: 'not_started',
      enrichmentId: 'enrichment-1',
      finalistCount: 0,
      currentDecisionCount: 0,
      allFinalistsHaveCurrentDecisions: false,
      finalistMatrixPublished: false,
      artifactWarning: null,
    },
    library: {
      published: false,
      publicationId: null,
      publishedAt: null,
      reason: 'finalization_not_started',
      lookupError: null,
    },
    evidenceCoverage: null,
    nextAction: { code: 'run_finalization', message: 'continue finalization', command: null },
    sampledHistoricalPresence: null,
  };
}

const finalistsContinuation: ResolvedOperatorContinuation = {
  continuation: {
    version: 1,
    researchId: 'research-1',
    action: { type: 'finalists', clusters: ['cluster-1'] },
  },
  continuationPath: '/tmp/finalists-continuation.json',
  declaredFilePath: null,
};

test('completed_with_errors discovery remains usable for enrichment but is blocked as a finalization parent', () => {
  const plan = buildExistingResearchPlan(
    completedWithErrorsStatus(),
    finalistsContinuation,
    provenance(),
  );

  assert.equal(plan.stages.find((stage) => stage.id === 'discovery')?.state, 'already_satisfied');
  assert.equal(plan.stages.find((stage) => stage.id === 'enrichment')?.state, 'already_satisfied');
  const finalization = plan.stages.find((stage) => stage.id === 'finalization');
  assert.equal(finalization?.state, 'blocked');
  assert.match(finalization?.reason ?? '', /exactly completed/);
  assert.equal(plan.unresolvedHumanRequirements.includes('finalist_scope'), false);
  assert.equal(plan.expectedStopPoint, 'finalization');
});
