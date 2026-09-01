import assert from 'node:assert/strict';
import test from 'node:test';
import type { OperatorResearchConfigV1 } from './contracts.js';
import { buildExistingResearchPlan } from './planner.js';
import { buildPersistedOperatorConfig } from './provenance.js';
import { buildNewResearchPlan } from './resolve.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';

function operatorConfig() {
  const config: OperatorResearchConfigV1 = {
    version: 1,
    research: { label: 'finalization-parent-gate', input: { type: 'seeds', path: 'seeds.csv' } },
    workflow: { target: 'finalization' },
    enrichment: { modules: ['clusters'] },
    finalization: {
      representativeCount: 5,
      historyPolicy: {
        youngDomainMaxAgeDays: 730,
        recentWebPresenceMaxAgeDays: 730,
        repurposeGapMinDays: 365,
      },
    },
  };
  return buildPersistedOperatorConfig({
    config,
    plan: buildNewResearchPlan(config, '/tmp/finalization-parent-gate/research.config.json'),
  });
}

function status(): ResearchStatusWithHistoricalPresence {
  return {
    version: '1.2.0',
    researchId: 'research-1',
    label: 'finalization-parent-gate',
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
    nextAction: { code: 'run_finalization', message: 'finalization requires exact completed discovery', command: null },
    sampledHistoricalPresence: null,
  };
}

test('finalization stays blocked when its frozen discovery parent completed with errors', () => {
  const plan = buildExistingResearchPlan(status(), null, operatorConfig());
  const discovery = plan.stages.find((stage) => stage.id === 'discovery');
  const enrichment = plan.stages.find((stage) => stage.id === 'enrichment');
  const finalization = plan.stages.find((stage) => stage.id === 'finalization');

  assert.equal(discovery?.state, 'already_satisfied');
  assert.equal(enrichment?.state, 'already_satisfied');
  assert.equal(finalization?.state, 'blocked');
  assert.match(finalization?.reason ?? '', /exactly completed/);
  assert.equal(plan.expectedStopPoint, 'finalization');
  assert.deepEqual(plan.unresolvedHumanRequirements, []);
  assert.equal(plan.externalWork.length, 0);
});
