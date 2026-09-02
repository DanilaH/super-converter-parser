import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { buildPersistedOperatorConfig } from './provenance.js';
import { buildNewResearchPlan, type LoadedOperatorResearchConfig, type ResolvedOperatorContinuation } from './resolve.js';
import { buildExistingResearchPlan } from './planner.js';

function status(overrides: Partial<ResearchStatusWithHistoricalPresence> = {}): ResearchStatusWithHistoricalPresence {
  return {
    version: '1.2.0',
    researchId: 'research-stable',
    label: 'configured',
    researchDirectory: '/tmp/research',
    legacy: false,
    discovery: {
      generation: 2,
      runId: 'run-current',
      state: 'paused',
      createdAt: 'x',
      updatedAt: 'x',
      pauseReason: 'interrupted',
      keywordCounts: { total: 2, pending: 1, running: 0, completed: 1, partial: 0, failed: 0, repairable: 0 },
      qualityWarnings: [],
    },
    enrichments: [],
    currentEnrichmentId: null,
    finalization: {
      state: 'not_started',
      enrichmentId: null,
      finalistCount: 0,
      currentDecisionCount: 0,
      allFinalistsHaveCurrentDecisions: false,
      finalistMatrixPublished: false,
      artifactWarning: null,
    },
    library: { published: false, publicationId: null, publishedAt: null, reason: 'no_current_enrichment', lookupError: null },
    evidenceCoverage: null,
    sampledHistoricalPresence: null,
    nextAction: { code: 'resume_discovery', message: 'legacy projection', command: 'legacy command' },
    ...overrides,
  };
}

function configured(target: 'discovery' | 'enrichment') {
  const config = {
    version: 1 as const,
    research: { label: 'configured', input: { type: 'seeds' as const, path: 'seeds.csv' } },
    workflow: { target },
    ...(target === 'enrichment' ? { enrichment: { modules: ['clusters' as const] } } : {}),
  };
  const loaded = { config, plan: buildNewResearchPlan(config, '/tmp/research.config.json') } as LoadedOperatorResearchConfig;
  return buildPersistedOperatorConfig(loaded);
}

function continuation(action: ResolvedOperatorContinuation['continuation']['action']): ResolvedOperatorContinuation {
  return {
    continuation: { version: 1, researchId: 'research-stable', action } as ResolvedOperatorContinuation['continuation'],
    continuationPath: '/tmp/continuation.json',
    declaredFilePath: 'path' in action
      ? { logicalPath: action.path, resolvedPath: `/tmp/${action.path}` }
      : null,
  };
}

test('paused configured discovery is ready to resume by stable research identity and declares provider work', () => {
  const plan = buildExistingResearchPlan(status(), null, configured('enrichment'));
  assert.deepEqual(plan.stages.map((stage) => [stage.id, stage.state]), [
    ['discovery', 'ready'],
    ['enrichment', 'blocked'],
    ['finalization', 'not_requested'],
  ]);
  assert.equal(plan.expectedStopPoint, 'discovery');
  assert.deepEqual(plan.externalWork, [{
    stage: 'discovery',
    providers: ['google', 'keyword_surfer', 'ahrefs_if_configured'],
  }]);
});

test('repairable terminal discovery is not silently converted into ordinary config-first resume', () => {
  const repairable = status({
    discovery: {
      ...status().discovery,
      state: 'completed_with_errors',
      pauseReason: null,
      keywordCounts: { total: 2, pending: 0, running: 0, completed: 1, partial: 0, failed: 1, repairable: 1 },
    },
  });
  const plan = buildExistingResearchPlan(repairable, null, configured('enrichment'));
  assert.equal(plan.stages[0]?.state, 'blocked');
  assert.equal(plan.expectedStopPoint, 'discovery');
  assert.deepEqual(plan.externalWork, []);
});

test('shortlist continuation is rejected once the current enrichment is already completed', () => {
  const completed = status({
    discovery: {
      ...status().discovery,
      state: 'completed',
      pauseReason: null,
      keywordCounts: { total: 2, pending: 0, running: 0, completed: 2, partial: 0, failed: 0, repairable: 0 },
    },
    enrichments: [{
      enrichmentId: 'enrich-current',
      generation: 1,
      directoryName: 'enrichment',
      sourceRunId: 'run-current',
      state: 'completed',
      createdAt: 'x',
      updatedAt: 'x',
      modules: ['clusters'],
      itemCounts: {},
      error: null,
      isForCurrentDiscovery: true,
      isLatestForCurrentDiscovery: true,
    }],
    currentEnrichmentId: 'enrich-current',
  });
  assert.throws(
    () => buildExistingResearchPlan(
      completed,
      continuation({ type: 'shortlist', path: 'shortlist.csv' }),
      configured('enrichment'),
    ),
    /enrichment evidence scope is immutable after execution advances beyond a resumable state/i,
  );
});
